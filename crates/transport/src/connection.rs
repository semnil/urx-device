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
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::thread::{self, JoinHandle};
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
    terminal: Option<RequestCause>,
    cancelled_owners: Vec<u64>,
    next_owner: u64,
}

struct Shared {
    state: Mutex<State>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

enum Event {
    Wake,
    Frame(Value),
    ReadFailed(RequestCause),
}

/// An open connection to one unit.
pub struct Connection {
    generation: u64,
    firmware: SystemFirmware,
    shared: Arc<Shared>,
    events: Sender<Event>,
    sock: TcpStream,
    reader_stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
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
        });
        let (events, inbox) = mpsc::channel();
        let reader_stop = Arc::new(AtomicBool::new(false));
        let reader_thread = {
            let sock = sock.try_clone()?;
            let events = events.clone();
            let stop = Arc::clone(&reader_stop);
            thread::spawn(move || read_frames(sock, reader, events, stop))
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
            sock,
            reader_stop,
            worker: Some(worker_thread),
            reader: Some(reader_thread),
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

    /// Refuses new work, completes waiting requests unsent as
    /// `not_connected`, lets the active request settle, then stops both
    /// threads and closes the socket.
    pub fn close(mut self) {
        self.shut();
    }

    fn shut(&mut self) {
        let waiting = {
            let mut state = self.shared.lock();
            state.closing = true;
            state.waiting_bytes = 0;
            std::mem::take(&mut state.waiting)
        };
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
        let _ = self.events.send(Event::Wake);
        if let Some(worker) = self.worker.take() {
            // Closing from a completion callback runs on the worker itself,
            // which cannot wait for its own end: it stops on its own once
            // the callback returns and it finds the connection closing.
            if worker.thread().id() != thread::current().id() {
                let _ = worker.join();
            }
        }
        self.reader_stop.store(true, Ordering::SeqCst);
        let _ = self.sock.shutdown(Shutdown::Both);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if self.worker.is_some() || self.reader.is_some() {
            self.shut();
        }
    }
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
) {
    if sock.set_read_timeout(Some(READ_POLL)).is_err() {
        let _ = events.send(Event::ReadFailed(RequestCause::ConnectionLost));
        return;
    }
    while !stop.load(Ordering::SeqCst) {
        match reader.read_frame(&mut sock) {
            Ok(Some(frame)) => {
                if let Some(json) = frame.json {
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
        let next = {
            let mut state = shared.lock();
            if state.closing && state.waiting.is_empty() {
                return;
            }
            let item = state.waiting.pop_front();
            if let Some(item) = &item {
                state.waiting_bytes -= item.frame.len();
            }
            item
        };
        let fatal = match next {
            Some(item) => {
                let (outcome, fatal) = execute(&mut sock, &inbox, &shared, &options, &item);
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
    if let Err((cause, written)) = write_frame(sock, frame, send_end) {
        let evidence = if written == 0 {
            Evidence::NotSent
        } else {
            Evidence::Unconfirmed
        };
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

/// Writes `frame` by `end`. On failure, the cause and how many bytes went out.
fn write_frame(
    sock: &mut TcpStream,
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
        match sock.write(&frame[written..]) {
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
