//! An operational connection to one unit (K4, K5, K6, K34, N1, N2).
//!
//! [`open`] verifies that the unit at a discovered `vdp` port is online and
//! still has the expected identity, and reads its System firmware, within one
//! connection budget. The returned [`Connection`] owns a worker thread that
//! sends admitted requests one at a time in admission order, and a reader
//! thread that receives frames for it. Each request completes exactly once
//! through the callback it was submitted with.
//!
//! A response deadline, a lost or closed link, an oversized frame and a
//! partially sent request end the connection: the active request completes
//! with its evidence, waiting requests complete unsent with the same cause,
//! and later submissions are refused as `not_connected`. Nothing is resent.

use crate::discovery::{get, lost_notification, system_firmware, SystemFirmware};
use crate::frame::{self, FrameReader, ReadError, MAX_FRAME_BYTES};
use crate::lifecycle::{Cause, Control, Failure, Phase};
use crate::link::{Budget, Link};
use crate::request::{
    Evidence, Outcome, ReadValue, Request, RequestCause, RequestFailure, RequestPhase,
};
use crate::wire::{self, Inbound, PostVerdict, Reply, ReplyKey, WriteValue};
use serde_json::Value;
use std::collections::VecDeque;
use std::io::{ErrorKind, Write};
use std::net::{Shutdown, TcpStream};
use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread::{self, JoinHandle, ThreadId};
use std::time::{Duration, Instant};

/// Waiting requests, excluding the active one (K6).
pub const MAX_WAITING_REQUESTS: usize = 64;
/// Total encoded bytes of waiting requests (K6).
pub const MAX_WAITING_BYTES: usize = 4 << 20;

/// Longest a write blocks before its deadline is checked again.
const WRITE_POLL: Duration = Duration::from_millis(50);
/// Longest the reader blocks before checking whether it should stop.
const READ_POLL: Duration = Duration::from_millis(100);

static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

/// The consumer's deadlines for one connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectionOptions {
    /// Opening: connecting, the identity check and the firmware read.
    pub connect_deadline: Duration,
    /// Each opening request's send deadline and, once sent, its response
    /// deadline.
    pub handshake_request_deadline: Duration,
    /// From submitting a request until it is completely written, queue
    /// waiting included.
    pub send_deadline: Duration,
    /// From a request being completely written until its reply.
    pub response_deadline: Duration,
}

type Done = Box<dyn FnOnce(Outcome) + Send>;

struct Item {
    owner: u64,
    request: Request,
    frame: Vec<u8>,
    key: ReplyKey,
    submitted: Instant,
    done: Done,
}

#[derive(Default)]
struct State {
    waiting: VecDeque<Item>,
    waiting_bytes: usize,
    closing: bool,
    /// Whether the worker holds a request it has not yet settled.
    active: bool,
    terminal: Option<RequestCause>,
    cancelled_owners: Vec<u64>,
    next_owner: u64,
}

struct Shared {
    state: Mutex<State>,
    /// The end of the link as the reader detected it. The reader records it
    /// before reporting it, and the worker starts each write while holding
    /// this lock, so a write never starts after the end is recorded.
    link_end: Mutex<Option<RequestCause>>,
    /// Signalled when the worker settles its active request.
    settled: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn link_end(&self) -> MutexGuard<'_, Option<RequestCause>> {
        self.link_end
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

enum Event {
    Wake,
    Frame(Value),
    ReadFailed(RequestCause),
}

/// An open connection to one unit. It is shared by reference: closing takes
/// `&self`, and every call to [`Connection::close`] joins the same close.
pub struct Connection {
    generation: u64,
    firmware: SystemFirmware,
    shared: Arc<Shared>,
    events: Sender<Event>,
    /// Taken and dropped by the close, so no descriptor outlives it.
    sock: Mutex<Option<TcpStream>>,
    reader_stop: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
    /// Kept apart from the handle, which a close takes.
    worker_id: ThreadId,
    reader: Mutex<Option<JoinHandle<()>>>,
    close: Arc<CloseCell>,
}

/// The one close of a connection, shared with the helper that finishes a
/// close started from a completion callback.
struct CloseCell {
    state: Mutex<CloseState>,
    done: Condvar,
    /// The thread running the close, whose own callbacks must not wait for it.
    closer: Mutex<Option<ThreadId>>,
}

impl CloseCell {
    fn record(&self, outcome: CloseOutcome) {
        *lock(&self.state) = CloseState::Done(outcome);
        self.done.notify_all();
    }
}

/// How a close ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseOutcome {
    /// Both threads finished and the socket is closed.
    Closed,
    /// Called on a thread the close cannot wait for: the worker, from a
    /// completion callback, or the closing thread itself. Closing has started
    /// and finishes without this call; callers on other threads wait for and
    /// receive the final outcome.
    Started,
    /// The worker or the reader did not finish within the teardown budget.
    /// The connection
    /// is unusable; its socket is shut down and its threads are left to end.
    Incomplete(Failure),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloseState {
    Open,
    Closing,
    Done(CloseOutcome),
}

/// The owner of one logical operation's requests. Cancelling it completes
/// its waiting requests unsent; a request already sent settles normally.
pub struct Operation {
    id: u64,
    shared: Weak<Shared>,
}

/// Opens the unit at `port`, which must report `online` with identity
/// `expected_id`, and reads its System firmware.
pub fn open(
    port: u16,
    expected_id: &str,
    options: &ConnectionOptions,
    control: &Control,
) -> Result<Connection, Failure> {
    let budget = Budget::starting_now(options.connect_deadline, Cause::ConnectTimeout);
    let deadline = options.handshake_request_deadline;
    let mut link = Link::connect(port, &budget, Phase::Connect, control)?;
    link.set_phase(Phase::Identity);
    let synchronize = get(
        &mut link,
        wire::Request::GetSynchronize,
        false,
        deadline,
        &budget,
        Phase::Identity,
    )?;
    let invalid = Failure::cause(Cause::InvalidResponse, Phase::Identity);
    let status = synchronize
        .get("sync_status")
        .and_then(Value::as_str)
        .filter(|status| !status.is_empty())
        .ok_or(invalid)?;
    if status != "online" {
        return Err(Failure::cause(Cause::DeviceNotFound, Phase::Identity));
    }
    let id = synchronize
        .get("usb_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or(Failure::cause(Cause::IdentityError, Phase::Identity))?;
    if id != expected_id {
        return Err(Failure::cause(Cause::DeviceNotFound, Phase::Identity));
    }
    let device = get(
        &mut link,
        wire::Request::GetDevice,
        true,
        deadline,
        &budget,
        Phase::Identity,
    )?;
    let firmware = system_firmware(&device).ok_or(invalid)?;
    let (sock, reader) = link.into_parts();
    Connection::start(sock, reader, firmware, options)
        .map_err(|_| Failure::cause(Cause::InternalError, Phase::Connect))
}

impl Connection {
    fn start(
        sock: TcpStream,
        reader: FrameReader,
        firmware: SystemFirmware,
        options: &ConnectionOptions,
    ) -> std::io::Result<Connection> {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            link_end: Mutex::new(None),
            settled: Condvar::new(),
        });
        let (events, inbox) = mpsc::channel();
        let reader_stop = Arc::new(AtomicBool::new(false));
        let reader_thread = {
            let sock = sock.try_clone()?;
            let events = events.clone();
            let stop = Arc::clone(&reader_stop);
            let shared = Arc::clone(&shared);
            thread::spawn(move || read_frames(sock, reader, events, stop, shared))
        };
        let worker_thread = {
            let sock = sock.try_clone()?;
            let shared = Arc::clone(&shared);
            let options = *options;
            thread::spawn(move || serve(sock, inbox, shared, options))
        };
        Ok(Connection {
            generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
            firmware,
            shared,
            events,
            sock: Mutex::new(Some(sock)),
            reader_stop,
            worker_id: worker_thread.thread().id(),
            worker: Mutex::new(Some(worker_thread)),
            reader: Mutex::new(Some(reader_thread)),
            close: Arc::new(CloseCell {
                state: Mutex::new(CloseState::Open),
                done: Condvar::new(),
                closer: Mutex::new(None),
            }),
        })
    }

    /// A number unique to this connection within the process.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The System firmware read while opening.
    pub fn firmware(&self) -> &SystemFirmware {
        &self.firmware
    }

    /// The cause that ended the connection, if one has.
    pub fn terminal(&self) -> Option<RequestCause> {
        self.shared.lock().terminal
    }

    /// A new operation owner, or `not_connected` once the connection is
    /// closing or has ended.
    pub fn create_operation(&self) -> Result<Operation, RequestFailure> {
        let mut state = self.shared.lock();
        if state.closing || state.terminal.is_some() {
            return Err(RequestFailure::Cause {
                code: RequestCause::NotConnected,
                phase: RequestPhase::Admission,
            });
        }
        state.next_owner += 1;
        Ok(Operation {
            id: state.next_owner,
            shared: Arc::downgrade(&self.shared),
        })
    }

    /// Admits `request` for `operation`, or completes it at once, unsent,
    /// when it cannot be admitted. `done` runs exactly once, on the worker
    /// thread or, for a refusal, on this thread.
    pub fn submit(
        &self,
        operation: &Operation,
        request: Request,
        done: impl FnOnce(Outcome) + Send + 'static,
    ) {
        let refuse = |code, phase| Outcome::failed(code, phase, Evidence::NotSent);
        let message = message_of(&request);
        let frame = match frame::encode(&message) {
            Ok(frame) => frame,
            Err(_) => return done(refuse(RequestCause::InvalidInput, RequestPhase::Validation)),
        };
        let mut state = self.shared.lock();
        let ours = operation.shared.ptr_eq(&Arc::downgrade(&self.shared));
        if !ours || state.closing || state.terminal.is_some() {
            drop(state);
            return done(refuse(RequestCause::NotConnected, RequestPhase::Admission));
        }
        if state.cancelled_owners.contains(&operation.id) {
            drop(state);
            return done(Outcome::Failure {
                failure: RequestFailure::Cancelled {
                    phase: RequestPhase::Admission,
                },
                evidence: Evidence::NotSent,
            });
        }
        if state.waiting.len() >= MAX_WAITING_REQUESTS
            || state.waiting_bytes + frame.len() > MAX_WAITING_BYTES
        {
            drop(state);
            return done(refuse(
                RequestCause::PreconditionFailed,
                RequestPhase::Admission,
            ));
        }
        state.waiting_bytes += frame.len();
        state.waiting.push_back(Item {
            owner: operation.id,
            key: key_of(&request),
            request,
            frame,
            submitted: Instant::now(),
            done: Box::new(done),
        });
        drop(state);
        let _ = self.events.send(Event::Wake);
    }

    /// Closes the connection. In order: new submissions and any request not
    /// yet started on the wire are refused, waiting requests complete unsent
    /// as `not_connected` (on a separate thread, so their callbacks never hold
    /// the close up), the request already being sent settles under its own
    /// deadlines, and then, within `teardown`, the socket is shut down and
    /// released and both threads must finish. Repeated and concurrent calls
    /// share the first call's close and its outcome; none starts a second
    /// shutdown or sends anything.
    pub fn close(&self, teardown: Duration) -> CloseOutcome {
        {
            let mut close = lock(&self.close.state);
            loop {
                match *close {
                    CloseState::Open => {
                        *close = CloseState::Closing;
                        *lock(&self.close.closer) = Some(thread::current().id());
                        break;
                    }
                    CloseState::Done(outcome) => return outcome,
                    CloseState::Closing => {
                        let me = thread::current().id();
                        if self.on_worker() || *lock(&self.close.closer) == Some(me) {
                            return CloseOutcome::Started;
                        }
                        close = self
                            .close
                            .done
                            .wait(close)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                    }
                }
            }
        }
        // Taken with the send gate held: a write not yet started cannot start
        // after this, and no request is admitted from here on.
        let waiting = {
            let _gate = self.shared.link_end();
            let mut state = self.shared.lock();
            state.closing = true;
            state.waiting_bytes = 0;
            std::mem::take(&mut state.waiting)
        };
        let _ = self.events.send(Event::Wake);
        if !waiting.is_empty() {
            thread::spawn(move || {
                for item in waiting {
                    deliver(
                        item.done,
                        Outcome::failed(
                            RequestCause::NotConnected,
                            RequestPhase::Admission,
                            Evidence::NotSent,
                        ),
                    );
                }
            });
        }
        {
            let mut state = self.shared.lock();
            while state.active {
                state = self
                    .shared
                    .settled
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        }
        let end = Instant::now() + teardown;
        self.reader_stop.store(true, Ordering::SeqCst);
        if let Some(sock) = lock(&self.sock).take() {
            let _ = sock.shutdown(Shutdown::Both);
        }
        let threads = [lock(&self.worker).take(), lock(&self.reader).take()];
        if self.on_worker() {
            // A completion callback cannot wait for the worker it runs on; a
            // helper waits for both threads within the same budget.
            let cell = Arc::clone(&self.close);
            thread::spawn(move || cell.record(wait_for(threads, end)));
            return CloseOutcome::Started;
        }
        let outcome = wait_for(threads, end);
        self.close.record(outcome);
        outcome
    }

    fn on_worker(&self) -> bool {
        self.worker_id == thread::current().id()
    }
}

/// `Closed` once every thread has finished by `end`; otherwise `Incomplete`.
fn wait_for(threads: [Option<JoinHandle<()>>; 2], end: Instant) -> CloseOutcome {
    for thread in threads.into_iter().flatten() {
        while !thread.is_finished() {
            if Instant::now() >= end {
                return CloseOutcome::Incomplete(Failure::cause(
                    Cause::TeardownTimeout,
                    Phase::Teardown,
                ));
            }
            thread::sleep(Duration::from_millis(1));
        }
        let _ = thread.join();
    }
    CloseOutcome::Closed
}

/// Teardown budget a dropped connection uses when it was never closed.
const DROP_TEARDOWN: Duration = Duration::from_secs(2);

impl Drop for Connection {
    fn drop(&mut self) {
        if matches!(*lock(&self.close.state), CloseState::Open) {
            self.close(DROP_TEARDOWN);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Operation {
    /// Completes this owner's waiting requests unsent as cancelled, and
    /// refuses its later submissions the same way. Idempotent.
    pub fn cancel(&self) {
        let Some(shared) = self.shared.upgrade() else {
            return;
        };
        let cancelled = {
            let mut state = shared.lock();
            if !state.cancelled_owners.contains(&self.id) {
                state.cancelled_owners.push(self.id);
            }
            let (mine, others): (VecDeque<Item>, VecDeque<Item>) =
                std::mem::take(&mut state.waiting)
                    .into_iter()
                    .partition(|item| item.owner == self.id);
            state.waiting = others;
            state.waiting_bytes = state.waiting.iter().map(|item| item.frame.len()).sum();
            mine
        };
        for item in cancelled {
            deliver(
                item.done,
                Outcome::Failure {
                    failure: RequestFailure::Cancelled {
                        phase: RequestPhase::Admission,
                    },
                    evidence: Evidence::NotSent,
                },
            );
        }
    }
}

/// Runs one completion callback. A callback that panics is contained, so
/// every other admitted request still completes and the connection still
/// shuts down.
fn deliver(done: Done, outcome: Outcome) {
    let _ = panic::catch_unwind(AssertUnwindSafe(move || done(outcome)));
}

fn message_of(request: &Request) -> Value {
    wire_request(request).message()
}

fn key_of(request: &Request) -> ReplyKey {
    wire_request(request).reply_key()
}

fn wire_request(request: &Request) -> wire::Request {
    match request {
        Request::GetNumeric(address) | Request::GetText(address) | Request::GetName(address) => {
            wire::Request::GetParameter(*address)
        }
        Request::SetNumeric(address, value) => {
            wire::Request::SetParameter(*address, WriteValue::Integer(*value))
        }
        Request::SetText(address, value) => {
            wire::Request::SetParameter(*address, WriteValue::Text(value.clone()))
        }
    }
}

/// Receives frames until told to stop or the link fails.
fn read_frames(
    mut sock: TcpStream,
    mut reader: FrameReader,
    events: Sender<Event>,
    stop: Arc<AtomicBool>,
    shared: Arc<Shared>,
) {
    let record = |cause| {
        shared.link_end().get_or_insert(cause);
    };
    if sock.set_read_timeout(Some(READ_POLL)).is_err() {
        record(RequestCause::ConnectionLost);
        let _ = events.send(Event::ReadFailed(RequestCause::ConnectionLost));
        return;
    }
    while !stop.load(Ordering::SeqCst) {
        match reader.read_frame(&mut sock) {
            Ok(Some(frame)) => {
                if let Some(json) = frame.json {
                    if lost_notification(&json) {
                        record(RequestCause::ConnectionLost);
                    }
                    if events.send(Event::Frame(json)).is_err() {
                        return;
                    }
                }
            }
            Ok(None) => {}
            Err(error) => {
                if !stop.load(Ordering::SeqCst) {
                    let cause = match error {
                        ReadError::Oversized { .. } => RequestCause::InvalidResponse,
                        ReadError::Closed | ReadError::Io(_) => RequestCause::ConnectionLost,
                    };
                    record(cause);
                    let _ = events.send(Event::ReadFailed(cause));
                }
                return;
            }
        }
    }
}

/// The worker: runs admitted requests one at a time until the connection
/// closes or ends.
fn serve(
    mut sock: TcpStream,
    inbox: Receiver<Event>,
    shared: Arc<Shared>,
    options: ConnectionOptions,
) {
    loop {
        let reported = *shared.link_end();
        if let Some(cause) = reported {
            let waiting = mark_ended(&shared, cause);
            finish(&mut sock, waiting, cause);
            return;
        }
        let next = {
            let mut state = shared.lock();
            if state.closing && state.waiting.is_empty() {
                return;
            }
            let item = state.waiting.pop_front();
            if let Some(item) = &item {
                state.waiting_bytes -= item.frame.len();
                state.active = true;
            }
            item
        };
        let fatal = match next {
            Some(item) => {
                let (outcome, fatal) = execute(&mut sock, &inbox, &shared, &options, &item);
                shared.lock().active = false;
                shared.settled.notify_all();
                // The end is recorded, and the waiting requests taken with it,
                // before the outcome is delivered: whoever receives it sees
                // the ended state, and nothing it does can change how the
                // waiting requests end.
                let waiting = fatal.map(|cause| mark_ended(&shared, cause));
                deliver(item.done, outcome);
                if let (Some(cause), Some(waiting)) = (fatal, waiting) {
                    finish(&mut sock, waiting, cause);
                    return;
                }
                None
            }
            None => match inbox.recv() {
                Ok(Event::Wake) => None,
                Ok(Event::Frame(message)) => {
                    lost_notification(&message).then_some(RequestCause::ConnectionLost)
                }
                Ok(Event::ReadFailed(cause)) => Some(cause),
                Err(_) => return,
            },
        };
        if let Some(cause) = fatal {
            let waiting = mark_ended(&shared, cause);
            finish(&mut sock, waiting, cause);
            return;
        }
    }
}

/// Records `cause` as the end of the connection and takes the waiting
/// requests in the same step, so that no later cancellation or close changes
/// how they end.
fn mark_ended(shared: &Shared, cause: RequestCause) -> VecDeque<Item> {
    let mut state = shared.lock();
    state.terminal.get_or_insert(cause);
    state.waiting_bytes = 0;
    std::mem::take(&mut state.waiting)
}

/// Closes the socket and completes `waiting` unsent with `cause`.
fn finish(sock: &mut TcpStream, waiting: VecDeque<Item>, cause: RequestCause) {
    let _ = sock.shutdown(Shutdown::Both);
    for item in waiting {
        deliver(
            item.done,
            Outcome::failed(cause, RequestPhase::Admission, Evidence::NotSent),
        );
    }
}

/// Sends `item` and awaits its reply. Returns the item's outcome, and the
/// cause that ends the connection, if any.
fn execute(
    sock: &mut TcpStream,
    inbox: &Receiver<Event>,
    shared: &Shared,
    options: &ConnectionOptions,
    item: &Item,
) -> (Outcome, Option<RequestCause>) {
    let Item {
        owner,
        request,
        frame,
        key,
        submitted,
        ..
    } = item;
    if shared.lock().cancelled_owners.contains(owner) {
        return (
            Outcome::Failure {
                failure: RequestFailure::Cancelled {
                    phase: RequestPhase::Admission,
                },
                evidence: Evidence::NotSent,
            },
            None,
        );
    }
    let send_end = *submitted + options.send_deadline;
    if Instant::now() >= send_end {
        return (
            Outcome::failed(
                RequestCause::SendTimeout,
                RequestPhase::Admission,
                Evidence::NotSent,
            ),
            None,
        );
    }
    if let Err((cause, written)) = write_frame(sock, shared, frame, send_end) {
        let evidence = if written == 0 {
            Evidence::NotSent
        } else {
            Evidence::Unconfirmed
        };
        if cause == RequestCause::NotConnected {
            // The connection began closing before this request's first byte.
            return (
                Outcome::failed(cause, RequestPhase::Admission, evidence),
                None,
            );
        }
        // A frame cut short leaves the stream unusable; an untouched one does not.
        return (
            Outcome::failed(cause, RequestPhase::Send, evidence),
            (written > 0 || cause != RequestCause::SendTimeout).then_some(cause),
        );
    }
    let response_end = Instant::now() + options.response_deadline;
    loop {
        let remaining = response_end.saturating_duration_since(Instant::now());
        let event = if remaining.is_zero() {
            Err(RecvTimeoutError::Timeout)
        } else {
            inbox.recv_timeout(remaining)
        };
        match event {
            Ok(Event::Frame(message)) => {
                if lost_notification(&message) {
                    return (
                        Outcome::failed(
                            RequestCause::ConnectionLost,
                            RequestPhase::Response,
                            Evidence::Unconfirmed,
                        ),
                        Some(RequestCause::ConnectionLost),
                    );
                }
                let inbound = Inbound::new(message);
                if let Some(reply) = inbound.reply(key) {
                    return (decode(request, reply), None);
                }
            }
            Ok(Event::Wake) => {}
            Ok(Event::ReadFailed(cause)) => {
                return (
                    Outcome::failed(cause, RequestPhase::Response, Evidence::Unconfirmed),
                    Some(cause),
                );
            }
            Err(RecvTimeoutError::Timeout) => {
                return (
                    Outcome::failed(
                        RequestCause::ResponseTimeout,
                        RequestPhase::Response,
                        Evidence::Unconfirmed,
                    ),
                    Some(RequestCause::ResponseTimeout),
                );
            }
            Err(RecvTimeoutError::Disconnected) => {
                return (
                    Outcome::failed(
                        RequestCause::InternalError,
                        RequestPhase::Response,
                        Evidence::Unconfirmed,
                    ),
                    Some(RequestCause::InternalError),
                );
            }
        }
    }
}

/// The two socket calls a write makes, so tests can stand in for the socket.
trait Outgoing {
    fn set_write_timeout(&self, timeout: Option<Duration>) -> std::io::Result<()>;
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize>;
}

impl Outgoing for TcpStream {
    fn set_write_timeout(&self, timeout: Option<Duration>) -> std::io::Result<()> {
        TcpStream::set_write_timeout(self, timeout)
    }

    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        Write::write(self, bytes)
    }
}

/// Writes `frame` by `end`, starting no write once the reader has recorded
/// the link's end. On failure, the cause and how many bytes went out.
fn write_frame<O: Outgoing>(
    sock: &mut O,
    shared: &Shared,
    frame: &[u8],
    end: Instant,
) -> Result<(), (RequestCause, usize)> {
    debug_assert!(frame.len() <= MAX_FRAME_BYTES + 1);
    let mut written = 0;
    while written < frame.len() {
        let remaining = end.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err((RequestCause::SendTimeout, written));
        }
        if sock
            .set_write_timeout(Some(remaining.min(WRITE_POLL)))
            .is_err()
        {
            return Err((RequestCause::ConnectionLost, written));
        }
        // Held across the write: the reader cannot record an end between
        // this check and the start of the write.
        let link_end = shared.link_end();
        if let Some(cause) = *link_end {
            return Err((cause, written));
        }
        if written == 0 && shared.lock().closing {
            return Err((RequestCause::NotConnected, 0));
        }
        let outcome = sock.write(&frame[written..]);
        drop(link_end);
        match outcome {
            Ok(0) => return Err((RequestCause::ConnectionLost, written)),
            Ok(n) => written += n,
            Err(e)
                if matches!(
                    e.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) => {}
            Err(_) => return Err((RequestCause::ConnectionLost, written)),
        }
    }
    Ok(())
}

/// The outcome a matching reply gives `request`.
fn decode(request: &Request, reply: Reply<'_>) -> Outcome {
    let invalid = || {
        Outcome::failed(
            RequestCause::InvalidResponse,
            RequestPhase::Response,
            Evidence::Unconfirmed,
        )
    };
    let verdict = reply.post_verdict();
    if let PostVerdict::Rejected(code) = verdict {
        return Outcome::failed(
            RequestCause::DeviceRejected,
            RequestPhase::Response,
            Evidence::Rejected(code),
        );
    }
    if request.is_write() {
        return match verdict {
            PostVerdict::Accepted => Outcome::Success {
                value: None,
                evidence: Evidence::Accepted,
            },
            _ => invalid(),
        };
    }
    let value = match request {
        Request::GetNumeric(_) => reply.numeric_value().map(ReadValue::Numeric),
        Request::GetText(_) => reply
            .text_value()
            .map(|text| ReadValue::Text(text.to_string())),
        Request::GetName(_) => reply.name_value().map(ReadValue::Name),
        Request::SetNumeric(..) | Request::SetText(..) => unreachable!("writes are decoded above"),
    };
    match value {
        Ok(value) => Outcome::Success {
            value: Some(value),
            evidence: Evidence::Read,
        },
        Err(_) => invalid(),
    }
}

#[cfg(test)]
mod tests;
