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

use crate::delivery::{BatchTicket, NotificationBatch, NotificationRecord, Queue};
use crate::discovery::{get, lost_notification, system_firmware, SystemFirmware};
use crate::frame::{self, FrameReader, ReadError, MAX_FRAME_BYTES};
use crate::lifecycle::{
    Cause, Cleanup, CleanupState, Control, Failure, LifecycleFailure, LifecycleOutcome, Phase,
};
use crate::link::{Budget, Link};
use crate::request::{
    Evidence, Outcome, ReadValue, Request, RequestCause, RequestFailure, RequestPhase,
};
use crate::subscription::{Ledger, StartRefusal, SubscriptionAddress, TokenId, Verdict};
use crate::wire::{self, Inbound, Notification, PostVerdict, Reply, ReplyKey, WriteValue};
use serde_json::Value;
use std::collections::VecDeque;
use std::io::{ErrorKind, Write};
use std::net::{Shutdown, TcpStream};
use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread::{self, JoinHandle, ThreadId};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    ledger: Ledger,
    /// Subscription lifecycle work, run one job at a time ahead of requests.
    jobs: VecDeque<Job>,
    /// Releases asked for and not yet settled, one per token.
    releases: Vec<Release>,
}

/// One release of a token and every caller waiting on it.
struct Release {
    token: TokenId,
    waiting: Vec<LifecycleDone>,
    /// Whether a job is carrying it out; a close leaves those to finish.
    running: bool,
}

type LifecycleDone = Box<dyn FnOnce(LifecycleOutcome) + Send>;

enum Job {
    Activate {
        token: TokenId,
        owner: u64,
        done: LifecycleDone,
    },
    Release {
        token: TokenId,
    },
}

/// A subscription token on its connection (K37). Admission is local;
/// [`Subscription::activate`] registers its addresses and
/// [`Subscription::release`] gives them up.
pub struct Subscription {
    token: TokenId,
    shared: Weak<Shared>,
    events: Sender<Event>,
}

struct Shared {
    state: Mutex<State>,
    /// The end of the link as the reader detected it. The reader records it
    /// before reporting it, and the worker starts each write while holding
    /// this lock, so a write never starts after the end is recorded.
    link_end: Mutex<Option<RequestCause>>,
    /// Signalled when the worker settles its active request.
    settled: Condvar,
    /// Notifications waiting for the application (K6), when it takes them.
    notifications: Option<Mutex<Queue>>,
    /// Signalled when a batch can be formed or delivery must stop.
    deliverable: Condvar,
    delivery_stop: AtomicBool,
    generation: u64,
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
    Frame(Received),
    ReadFailed(RequestCause),
}

/// One JSON frame as the reader received it.
struct Received {
    message: Value,
    /// Bytes before its LF: what a notification from it is charged (K6).
    len: usize,
    /// PC receipt time, milliseconds since the Unix epoch.
    received_at_ms: i64,
}

/// Receives each notification batch; acknowledge it with
/// [`Connection::adopt_notifications`] once its records are adopted.
pub type NotificationHandler = Arc<dyn Fn(NotificationBatch) + Send + Sync>;

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
    delivery: Mutex<Option<JoinHandle<()>>>,
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
    /// Threads the close waits for, which must not wait for the close.
    exempt: Mutex<Vec<ThreadId>>,
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
/// `expected_id`, and reads its System firmware. Notifications are not
/// delivered; see [`open_with`].
pub fn open(
    port: u16,
    expected_id: &str,
    options: &ConnectionOptions,
    control: &Control,
) -> Result<Connection, Failure> {
    open_with(port, expected_id, options, control, None)
}

/// Like [`open`], delivering notifications for the connection's tokens to
/// `notifications`, which is installed before any request can be submitted.
pub fn open_with(
    port: u16,
    expected_id: &str,
    options: &ConnectionOptions,
    control: &Control,
    notifications: Option<NotificationHandler>,
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
    Connection::start(sock, reader, firmware, options, notifications)
        .map_err(|_| Failure::cause(Cause::InternalError, Phase::Connect))
}

impl Connection {
    fn start(
        sock: TcpStream,
        reader: FrameReader,
        firmware: SystemFirmware,
        options: &ConnectionOptions,
        notifications: Option<NotificationHandler>,
    ) -> std::io::Result<Connection> {
        let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            link_end: Mutex::new(None),
            settled: Condvar::new(),
            notifications: notifications.as_ref().map(|_| Mutex::new(Queue::new())),
            deliverable: Condvar::new(),
            delivery_stop: AtomicBool::new(false),
            generation,
        });
        let delivery_thread = notifications.map(|handler| {
            let shared = Arc::clone(&shared);
            thread::spawn(move || deliver_notifications(&shared, &handler))
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
            generation,
            delivery: Mutex::new(delivery_thread),
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
                exempt: Mutex::new(Vec::new()),
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

    /// Acknowledges the notification batch `ticket` once its records are
    /// adopted, releasing their budget and the next batch. A stale or
    /// repeated ticket changes nothing and returns false.
    pub fn adopt_notifications(&self, ticket: BatchTicket) -> bool {
        let Some(queue) = &self.shared.notifications else {
            return false;
        };
        let adopted = lock(queue).adopt(ticket);
        if adopted {
            self.shared.deliverable.notify_all();
        }
        adopted
    }

    /// Admits a subscription token for `addresses` without any device
    /// traffic (K11). It receives notifications for them from now on; its
    /// registrations start with [`Subscription::activate`].
    pub fn prepare_subscription(
        &self,
        addresses: &[SubscriptionAddress],
    ) -> Result<Subscription, LifecycleFailure> {
        let mut state = self.shared.lock();
        let refused = |code| LifecycleFailure {
            failure: Failure::cause(code, Phase::Admission),
            cleanup: Cleanup::COMPLETE,
        };
        if state.closing || state.terminal.is_some() {
            return Err(refused(Cause::NotConnected));
        }
        let token = state
            .ledger
            .admit(addresses)
            .map_err(|_| refused(Cause::PreconditionFailed))?;
        Ok(Subscription {
            token,
            shared: Arc::downgrade(&self.shared),
            events: self.events.clone(),
        })
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
        let waiting = {
            let mut close = lock(&self.close.state);
            loop {
                match *close {
                    CloseState::Open => break,
                    CloseState::Done(outcome) => return outcome,
                    CloseState::Closing => {
                        if self.must_not_wait() {
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
            // The close becomes visible to other callers only together with
            // the refusal of new work and of unstarted writes: the send gate
            // and the state are updated before the close lock is released.
            let _gate = self.shared.link_end();
            let mut state = self.shared.lock();
            state.closing = true;
            *close = CloseState::Closing;
            lock(&self.close.exempt).push(thread::current().id());
            take_pending(&mut state)
        };
        let _ = self.events.send(Event::Wake);
        // Waiting requests complete on their own thread, which the close
        // waits for within the budget; a close called from one of their
        // callbacks returns `Started` instead of waiting for itself.
        let delivery = (!waiting.is_empty()).then(|| {
            let (go, ready) = mpsc::channel::<()>();
            let handle = thread::spawn(move || {
                let _ = ready.recv();
                waiting.complete(RequestCause::NotConnected);
            });
            lock(&self.close.exempt).push(handle.thread().id());
            let _ = go.send(());
            handle
        });
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
        self.shared.delivery_stop.store(true, Ordering::SeqCst);
        self.shared.deliverable.notify_all();
        let threads = [
            delivery,
            lock(&self.worker).take(),
            lock(&self.reader).take(),
            lock(&self.delivery).take(),
        ];
        if self.on_worker() {
            // A completion callback cannot wait for the worker it runs on; a
            // helper waits for the threads within the same budget.
            let cell = Arc::clone(&self.close);
            thread::spawn(move || cell.record(wait_for(threads, end)));
            return CloseOutcome::Started;
        }
        let outcome = wait_for(threads, end);
        self.close.record(outcome);
        outcome
    }

    /// Whether this thread is one the close waits for: the worker, the
    /// thread running the close, or the one delivering waiting outcomes.
    fn must_not_wait(&self) -> bool {
        let me = thread::current().id();
        self.on_worker() || lock(&self.close.exempt).contains(&me)
    }

    fn on_worker(&self) -> bool {
        self.worker_id == thread::current().id()
    }
}

/// `Closed` only when every thread has been joined before `end`; otherwise
/// `Incomplete`, even if the threads finish later. The joins run on their own
/// thread, so a thread whose exit (its thread-local destructors included)
/// does not finish cannot hold this past `end`.
fn wait_for(threads: [Option<JoinHandle<()>>; 4], end: Instant) -> CloseOutcome {
    let incomplete =
        CloseOutcome::Incomplete(Failure::cause(Cause::TeardownTimeout, Phase::Teardown));
    let (joined, all_joined) = mpsc::channel();
    thread::spawn(move || {
        for thread in threads.into_iter().flatten() {
            let _ = thread.join();
        }
        let _ = joined.send(());
    });
    let remaining = end.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return incomplete;
    }
    match all_joined.recv_timeout(remaining) {
        // Read after the joins: they completed no later than this reading.
        Ok(()) if Instant::now() < end => CloseOutcome::Closed,
        _ => incomplete,
    }
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

impl Subscription {
    pub fn token(&self) -> TokenId {
        self.token
    }

    /// Registers the token's addresses one at a time, each verdict checked
    /// before the next request (K9), as work of `operation`. `done` receives
    /// success once every needed registration is accepted, or the first
    /// failure with its cleanup: what this attempt registered alone is
    /// unregistered again, and a cleanup that fails ends the connection.
    /// Cancelling `operation`, or releasing the token, stops the unsent
    /// registrations.
    pub fn activate(
        &self,
        operation: &Operation,
        done: impl FnOnce(LifecycleOutcome) + Send + 'static,
    ) {
        let Some(shared) = self.shared.upgrade() else {
            return done(Err(not_connected(Phase::Subscription)));
        };
        let mut state = shared.lock();
        let ours = operation.shared.ptr_eq(&self.shared);
        if !ours || state.closing || state.terminal.is_some() {
            drop(state);
            return done(Err(not_connected(Phase::Subscription)));
        }
        state.jobs.push_back(Job::Activate {
            token: self.token,
            owner: operation.id,
            done: Box::new(done),
        });
        drop(state);
        let _ = self.events.send(Event::Wake);
    }

    /// Releases the token. A token never activated is released without
    /// traffic; otherwise the addresses it was the last holder of are
    /// unregistered, and a failure ends the connection. A release during the
    /// token's activation stops it first. Repeated calls share one release.
    pub fn release(&self, done: impl FnOnce(LifecycleOutcome) + Send + 'static) {
        let Some(shared) = self.shared.upgrade() else {
            return done(Err(not_connected(Phase::Subscription)));
        };
        // Ordered with the start of every write (see write_frame): a
        // registration of this token not yet started will not start. The
        // check below and the queueing are one step under the state lock, so
        // an end or a close either comes first and refuses this release or
        // comes after and completes it.
        let gate = shared.link_end();
        let mut state = shared.lock();
        if state.closing || state.terminal.is_some() {
            // The callback runs with neither lock held: it may release,
            // cancel or close in turn.
            drop(state);
            drop(gate);
            return done(Err(not_connected(Phase::Subscription)));
        }
        let done: LifecycleDone = Box::new(done);
        if let Some(release) = state.releases.iter_mut().find(|r| r.token == self.token) {
            release.waiting.push(done);
            return;
        }
        state.releases.push(Release {
            token: self.token,
            waiting: vec![done],
            running: false,
        });
        state.jobs.push_back(Job::Release { token: self.token });
        drop(state);
        drop(gate);
        let _ = self.events.send(Event::Wake);
    }
}

fn not_connected(phase: Phase) -> LifecycleFailure {
    LifecycleFailure {
        failure: Failure::cause(Cause::NotConnected, phase),
        cleanup: Cleanup {
            state: CleanupState::ConnectionClosed,
            failure: None,
        },
    }
}

fn lifecycle_cause(cause: RequestCause) -> Cause {
    match cause {
        RequestCause::SendTimeout => Cause::SendTimeout,
        RequestCause::ResponseTimeout => Cause::ResponseTimeout,
        RequestCause::TeardownTimeout => Cause::TeardownTimeout,
        RequestCause::DeviceRejected => Cause::DeviceRejected,
        RequestCause::InvalidResponse => Cause::InvalidResponse,
        RequestCause::ConnectionLost => Cause::ConnectionLost,
        RequestCause::NotConnected => Cause::NotConnected,
        RequestCause::PreconditionFailed => Cause::PreconditionFailed,
        RequestCause::InvalidInput
        | RequestCause::NotificationOverflow
        | RequestCause::InternalError => Cause::InternalError,
    }
}

fn deliver_lifecycle(done: LifecycleDone, outcome: LifecycleOutcome) {
    let _ = panic::catch_unwind(AssertUnwindSafe(move || done(outcome)));
}

impl Operation {
    /// Completes this owner's waiting requests unsent as cancelled, and
    /// refuses its later submissions the same way. Idempotent.
    pub fn cancel(&self) {
        let Some(shared) = self.shared.upgrade() else {
            return;
        };
        let cancelled = {
            // Ordered with the start of every write (see write_frame).
            let _gate = shared.link_end();
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

/// Queues the notification in `received` for the tokens eligible now, when
/// the application takes notifications and any token is eligible. A record
/// that does not fit the budget ends the connection (K6).
fn route(shared: &Shared, received: Received) -> Option<RequestCause> {
    let queue = shared.notifications.as_ref()?;
    let payload = Inbound::new(received.message).notification()?;
    let recipients = {
        let state = shared.lock();
        match &payload {
            Notification::Numeric { address, .. } | Notification::Text { address, .. } => state
                .ledger
                .recipients(SubscriptionAddress::Parameter(*address))
                .to_vec(),
            Notification::Meter { address, .. } => state
                .ledger
                .recipients(SubscriptionAddress::Meter(*address))
                .to_vec(),
            Notification::BulkChange => state.ledger.parameter_holders(),
        }
    };
    if recipients.is_empty() {
        return None;
    }
    let record = NotificationRecord {
        recipients,
        received_at_ms: received.received_at_ms,
        payload,
    };
    let pushed = lock(queue).push(record, received.len);
    shared.deliverable.notify_all();
    pushed.err().map(|_| RequestCause::NotificationOverflow)
}

/// The delivery thread: hands one batch at a time to `handler` and waits
/// for its acknowledgment before the next, until the connection closes.
fn deliver_notifications(shared: &Shared, handler: &NotificationHandler) {
    let Some(queue) = &shared.notifications else {
        return;
    };
    loop {
        let batch = {
            let mut queue = lock(queue);
            loop {
                if shared.delivery_stop.load(Ordering::SeqCst) {
                    return;
                }
                if let Some(batch) = queue.next_batch(shared.generation) {
                    break batch;
                }
                queue = shared
                    .deliverable
                    .wait(queue)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        };
        let _ = panic::catch_unwind(AssertUnwindSafe(|| handler(batch)));
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
                    let received = Received {
                        message: json,
                        len: frame.len,
                        received_at_ms: now_ms(),
                    };
                    if events.send(Event::Frame(received)).is_err() {
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
        let job = {
            let mut state = shared.lock();
            let job = state.jobs.pop_front();
            state.active |= job.is_some();
            job
        };
        if let Some(job) = job {
            let (deliveries, fatal) = run_job(&mut sock, &inbox, &shared, &options, job);
            let ended = fatal.map(|cause| mark_ended(&shared, cause));
            {
                shared.lock().active = false;
                shared.settled.notify_all();
            }
            for (done, outcome) in deliveries {
                deliver_lifecycle(done, outcome);
            }
            if let (Some(cause), Some(ended)) = (fatal, ended) {
                finish(&mut sock, ended, cause);
                return;
            }
            continue;
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
                Ok(Event::Frame(received)) => {
                    if lost_notification(&received.message) {
                        Some(RequestCause::ConnectionLost)
                    } else {
                        route(&shared, received)
                    }
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
fn mark_ended(shared: &Shared, cause: RequestCause) -> Taken {
    let mut state = shared.lock();
    state.terminal.get_or_insert(cause);
    take_pending(&mut state)
}

/// What an end or a close takes from the state: waiting requests, pending
/// lifecycle jobs and the callers waiting on releases.
struct Taken {
    waiting: VecDeque<Item>,
    jobs: VecDeque<Job>,
    releases: Vec<Release>,
}

/// Takes what has not started. A release a job is carrying out stays: that
/// job delivers its result to every caller waiting on it.
fn take_pending(state: &mut State) -> Taken {
    state.waiting_bytes = 0;
    let (running, releases) = std::mem::take(&mut state.releases)
        .into_iter()
        .partition(|release| release.running);
    state.releases = running;
    Taken {
        waiting: std::mem::take(&mut state.waiting),
        jobs: std::mem::take(&mut state.jobs),
        releases,
    }
}

impl Taken {
    fn is_empty(&self) -> bool {
        self.waiting.is_empty() && self.jobs.is_empty() && self.releases.is_empty()
    }

    /// Completes everything taken without sending anything: requests unsent
    /// with `cause`, lifecycle calls as not connected.
    fn complete(self, cause: RequestCause) {
        for item in self.waiting {
            deliver(
                item.done,
                Outcome::failed(cause, RequestPhase::Admission, Evidence::NotSent),
            );
        }
        for job in self.jobs {
            if let Job::Activate { done, .. } = job {
                deliver_lifecycle(done, Err(not_connected(Phase::Subscription)));
            }
        }
        for release in self.releases {
            for done in release.waiting {
                deliver_lifecycle(done, Err(not_connected(Phase::Subscription)));
            }
        }
    }
}

/// Closes the socket and completes what was taken with `cause`.
fn finish(sock: &mut TcpStream, taken: Taken, cause: RequestCause) {
    let _ = sock.shutdown(Shutdown::Both);
    taken.complete(cause);
}

/// The outcomes a lifecycle job settled, to deliver once the end (if any) is
/// recorded.
type Deliveries = Vec<(LifecycleDone, LifecycleOutcome)>;

/// Runs one lifecycle job. Returns its settled outcomes and the cause that
/// ends the connection, if any.
fn run_job(
    sock: &mut TcpStream,
    inbox: &Receiver<Event>,
    shared: &Shared,
    options: &ConnectionOptions,
    job: Job,
) -> (Deliveries, Option<RequestCause>) {
    let mut io = Io {
        sock,
        inbox,
        shared,
        options,
    };
    match job {
        Job::Activate { token, owner, done } => {
            let activation = io.activate(token, owner);
            let mut deliveries = vec![(done, activation.outcome)];
            // An activation that a release stopped carried out that release:
            // its callers receive the cleanup's result.
            if activation.released {
                let released = match activation.outcome {
                    Err(failure) if failure.cleanup.state != CleanupState::Complete => {
                        Err(LifecycleFailure {
                            failure: failure.cleanup.failure.unwrap_or(failure.failure),
                            cleanup: failure.cleanup,
                        })
                    }
                    _ => Ok(()),
                };
                let waiting = io.settle_release(token);
                deliveries.extend(waiting.into_iter().map(|done| (done, released)));
            }
            (deliveries, activation.ends)
        }
        Job::Release { token } => {
            if !io.claim_release(token) {
                // An activation already carried this release out.
                return (Vec::new(), None);
            }
            let (outcome, fatal) = io.release(token);
            let waiting = io.settle_release(token);
            (
                waiting.into_iter().map(|done| (done, outcome)).collect(),
                fatal,
            )
        }
    }
}

/// The worker's socket and state, for one lifecycle job.
struct Io<'a> {
    sock: &'a mut TcpStream,
    inbox: &'a Receiver<Event>,
    shared: &'a Shared,
    options: &'a ConnectionOptions,
}

/// How an activation ended.
struct Activation {
    outcome: LifecycleOutcome,
    /// The cause that ends the connection, if any.
    ends: Option<RequestCause>,
    /// Whether a release stopped it, so that it carried the release out.
    released: bool,
}

/// What one registration or unregistration POST established.
#[derive(Debug, Clone, Copy)]
enum Posted {
    Accepted,
    /// Not accepted; `verdict` is what it leaves at Device Center.
    Refused {
        verdict: Verdict,
        cause: RequestCause,
        /// Whether it ends the connection by itself.
        ends: bool,
    },
    /// Not started, because the operation was cancelled or the release asked.
    Stopped,
}

impl Io<'_> {
    /// Marks `token`'s release as being carried out; false when there is
    /// none left to carry out.
    fn claim_release(&mut self, token: TokenId) -> bool {
        let mut state = self.shared.lock();
        match state.releases.iter_mut().find(|r| r.token == token) {
            Some(release) => {
                release.running = true;
                true
            }
            None => false,
        }
    }

    /// Ends `token`'s release and returns every caller waiting on it.
    fn settle_release(&mut self, token: TokenId) -> Vec<LifecycleDone> {
        let mut state = self.shared.lock();
        match state.releases.iter().position(|r| r.token == token) {
            Some(index) => state.releases.swap_remove(index).waiting,
            None => Vec::new(),
        }
    }

    /// One registration or unregistration POST. With `stop`, it does not
    /// start once `stop` holds for the state.
    fn post(&mut self, request: wire::Request, stop: &dyn Fn(&State) -> bool) -> Posted {
        let refused = |verdict, cause, ends| Posted::Refused {
            verdict,
            cause,
            ends,
        };
        let Ok(frame) = frame::encode(&request.message()) else {
            return refused(Verdict::Rejected, RequestCause::InternalError, false);
        };
        let key = request.reply_key();
        let send_end = Instant::now() + self.options.send_deadline;
        let unstarted = |state: &State| {
            if state.closing {
                Some(Stop::Closing)
            } else if stop(state) {
                Some(Stop::Cancelled)
            } else {
                None
            }
        };
        let outbound = Outbound {
            frame: &frame,
            key: &key,
            send_end,
            unstarted: &unstarted,
        };
        match exchange(self.sock, self.inbox, self.shared, self.options, outbound) {
            Ok(inbound) => {
                let reply = inbound
                    .reply(&key)
                    .expect("exchange returns the matching reply");
                match reply.post_verdict() {
                    PostVerdict::Accepted => Posted::Accepted,
                    PostVerdict::Rejected(_) => {
                        refused(Verdict::Rejected, RequestCause::DeviceRejected, false)
                    }
                    PostVerdict::Malformed => {
                        refused(Verdict::Unknown, RequestCause::InvalidResponse, false)
                    }
                }
            }
            Err(failed) => match failed.failure {
                RequestFailure::Cancelled { .. } => Posted::Stopped,
                RequestFailure::Cause { code, .. } => {
                    let verdict = if failed.evidence == Evidence::NotSent {
                        Verdict::Rejected
                    } else {
                        Verdict::Unknown
                    };
                    refused(verdict, code, failed.ends.is_some())
                }
            },
        }
    }

    fn activate(&mut self, token: TokenId, owner: u64) -> Activation {
        let stopped = |state: &State| {
            state.cancelled_owners.contains(&owner)
                || state.releases.iter().any(|r| r.token == token)
        };
        let done = |outcome, ends, released| Activation {
            outcome,
            ends,
            released,
        };
        let needed = match self.shared.lock().ledger.start(token) {
            Ok(needed) => needed,
            Err(StartRefusal::Busy) | Err(StartRefusal::Unusable) => {
                return done(Err(not_connected(Phase::Subscription)), None, false)
            }
            Err(StartRefusal::Gone) => {
                let failure = LifecycleFailure {
                    failure: Failure::cause(Cause::PreconditionFailed, Phase::Subscription),
                    cleanup: Cleanup::COMPLETE,
                };
                return done(Err(failure), None, false);
            }
        };
        let mut failure = None;
        for address in needed {
            if stopped(&self.shared.lock()) {
                failure = Some((
                    Failure::Cancelled {
                        phase: Phase::Subscription,
                    },
                    None,
                ));
                break;
            }
            match self.post(register(address), &stopped) {
                Posted::Accepted => {
                    self.shared
                        .lock()
                        .ledger
                        .registered(address, Verdict::Accepted);
                }
                Posted::Stopped => {
                    failure = Some((
                        Failure::Cancelled {
                            phase: Phase::Subscription,
                        },
                        None,
                    ));
                    break;
                }
                Posted::Refused {
                    verdict,
                    cause,
                    ends,
                } => {
                    self.shared.lock().ledger.registered(address, verdict);
                    let failed = Failure::cause(lifecycle_cause(cause), Phase::Subscription);
                    failure = Some((failed, ends.then_some(cause)));
                    break;
                }
            }
        }
        let Some((failure, ends)) = failure else {
            let mut state = self.shared.lock();
            state.ledger.activate(token);
            if state.ledger.is_active(token) {
                return done(Ok(()), None, false);
            }
            drop(state);
            let failure = LifecycleFailure {
                failure: Failure::cause(Cause::PreconditionFailed, Phase::Subscription),
                cleanup: Cleanup::COMPLETE,
            };
            return done(Err(failure), None, false);
        };
        // A failed activation's cleanup is the token's release: it is
        // recorded as running before any unregistration, so a release asked
        // for before or during the cleanup joins it and receives its result.
        {
            let mut state = self.shared.lock();
            match state.releases.iter_mut().find(|r| r.token == token) {
                Some(release) => release.running = true,
                None => state.releases.push(Release {
                    token,
                    waiting: Vec::new(),
                    running: true,
                }),
            }
        }
        let released = true;
        if let Some(cause) = ends {
            // The connection ends, which releases what this attempt owned.
            let cleanup = Cleanup {
                state: CleanupState::ConnectionClosed,
                failure: None,
            };
            return done(
                Err(LifecycleFailure { failure, cleanup }),
                Some(cause),
                released,
            );
        }
        let (cleanup, ends) = self.unregister_owned(token);
        done(Err(LifecycleFailure { failure, cleanup }), ends, released)
    }

    fn release(&mut self, token: TokenId) -> (LifecycleOutcome, Option<RequestCause>) {
        let (cleanup, ends) = self.unregister_owned(token);
        match cleanup.failure {
            None => (Ok(()), ends),
            Some(failure) => (Err(LifecycleFailure { failure, cleanup }), ends),
        }
    }

    /// Ends `token`'s ownership and unregisters what it was the last holder
    /// of, once each. A failure stops the rest and ends the connection (K10).
    fn unregister_owned(&mut self, token: TokenId) -> (Cleanup, Option<RequestCause>) {
        let addresses = self.shared.lock().ledger.begin_release(token);
        for address in addresses {
            let posted = self.post(unregister(address), &|_| false);
            let (verdict, cause) = match posted {
                Posted::Accepted => (Verdict::Accepted, None),
                Posted::Refused { verdict, cause, .. } => (verdict, Some(cause)),
                Posted::Stopped => (Verdict::Rejected, Some(RequestCause::NotConnected)),
            };
            self.shared.lock().ledger.unregistered(address, verdict);
            if let Some(cause) = cause {
                self.shared.lock().ledger.finish(token);
                let failure = Failure::cause(lifecycle_cause(cause), Phase::Subscription);
                let cleanup = Cleanup {
                    state: CleanupState::ConnectionClosed,
                    failure: Some(failure),
                };
                return (cleanup, Some(cause));
            }
        }
        self.shared.lock().ledger.finish(token);
        (Cleanup::COMPLETE, None)
    }
}

fn register(address: SubscriptionAddress) -> wire::Request {
    match address {
        SubscriptionAddress::Parameter(address) => wire::Request::RegisterParameter(address),
        SubscriptionAddress::Meter(address) => wire::Request::RegisterMeter(address),
    }
}

fn unregister(address: SubscriptionAddress) -> wire::Request {
    match address {
        SubscriptionAddress::Parameter(address) => wire::Request::UnregisterParameter(address),
        SubscriptionAddress::Meter(address) => wire::Request::UnregisterMeter(address),
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
    let unstarted = |state: &State| {
        if state.closing {
            Some(Stop::Closing)
        } else if state.cancelled_owners.contains(owner) {
            Some(Stop::Cancelled)
        } else {
            None
        }
    };
    let outbound = Outbound {
        frame,
        key,
        send_end,
        unstarted: &unstarted,
    };
    match exchange(sock, inbox, shared, options, outbound) {
        Ok(inbound) => {
            let reply = inbound
                .reply(key)
                .expect("exchange returns the matching reply");
            (decode(request, reply), None)
        }
        Err(failed) => (
            Outcome::Failure {
                failure: failed.failure,
                evidence: failed.evidence,
            },
            failed.ends,
        ),
    }
}

/// Why one request/reply exchange produced no reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Failed {
    failure: RequestFailure,
    evidence: Evidence,
    /// The cause that ends the connection, if this failure does.
    ends: Option<RequestCause>,
}

impl Failed {
    fn new(cause: RequestCause, phase: RequestPhase, evidence: Evidence, ends: bool) -> Self {
        Failed {
            failure: RequestFailure::Cause { code: cause, phase },
            evidence,
            ends: ends.then_some(cause),
        }
    }

    fn cancelled() -> Self {
        Failed {
            failure: RequestFailure::Cancelled {
                phase: RequestPhase::Admission,
            },
            evidence: Evidence::NotSent,
            ends: None,
        }
    }
}

/// Writes `frame` by `send_end` and awaits the frame `key` matches, within
/// the response deadline from the end of the write.
/// One frame to send and how to recognise its reply.
struct Outbound<'a> {
    frame: &'a [u8],
    key: &'a ReplyKey,
    send_end: Instant,
    /// Whether a frame not yet started must not start.
    unstarted: &'a dyn Fn(&State) -> Option<Stop>,
}

fn exchange(
    sock: &mut TcpStream,
    inbox: &Receiver<Event>,
    shared: &Shared,
    options: &ConnectionOptions,
    outbound: Outbound<'_>,
) -> Result<Inbound, Failed> {
    let Outbound {
        frame,
        key,
        send_end,
        unstarted,
    } = outbound;
    if Instant::now() >= send_end {
        return Err(Failed::new(
            RequestCause::SendTimeout,
            RequestPhase::Admission,
            Evidence::NotSent,
            false,
        ));
    }
    match write_frame(sock, shared, frame, send_end, unstarted) {
        Ok(()) => {}
        Err(WriteError::Stopped(Stop::Closing)) => {
            return Err(Failed::new(
                RequestCause::NotConnected,
                RequestPhase::Admission,
                Evidence::NotSent,
                false,
            ))
        }
        Err(WriteError::Stopped(Stop::Cancelled)) => return Err(Failed::cancelled()),
        Err(WriteError::Failed { cause, written }) => {
            let evidence = if written == 0 {
                Evidence::NotSent
            } else {
                Evidence::Unconfirmed
            };
            // A frame cut short leaves the stream unusable; an untouched one does not.
            let ends = written > 0 || cause != RequestCause::SendTimeout;
            return Err(Failed::new(cause, RequestPhase::Send, evidence, ends));
        }
    }
    let response_end = Instant::now() + options.response_deadline;
    let unconfirmed = |cause| {
        Err(Failed::new(
            cause,
            RequestPhase::Response,
            Evidence::Unconfirmed,
            true,
        ))
    };
    loop {
        let remaining = response_end.saturating_duration_since(Instant::now());
        let event = if remaining.is_zero() {
            Err(RecvTimeoutError::Timeout)
        } else {
            inbox.recv_timeout(remaining)
        };
        match event {
            Ok(Event::Frame(received)) => {
                if lost_notification(&received.message) {
                    return unconfirmed(RequestCause::ConnectionLost);
                }
                let inbound = Inbound::new(received.message.clone());
                if inbound.reply(key).is_some() {
                    return Ok(inbound);
                }
                if let Some(cause) = route(shared, received) {
                    return unconfirmed(cause);
                }
            }
            Ok(Event::Wake) => {}
            Ok(Event::ReadFailed(cause)) => return unconfirmed(cause),
            Err(RecvTimeoutError::Timeout) => return unconfirmed(RequestCause::ResponseTimeout),
            Err(RecvTimeoutError::Disconnected) => return unconfirmed(RequestCause::InternalError),
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
    unstarted: &dyn Fn(&State) -> Option<Stop>,
) -> Result<(), WriteError> {
    debug_assert!(frame.len() <= MAX_FRAME_BYTES + 1);
    let mut written = 0;
    while written < frame.len() {
        let failed = |cause| Err(WriteError::Failed { cause, written });
        let remaining = end.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return failed(RequestCause::SendTimeout);
        }
        if sock
            .set_write_timeout(Some(remaining.min(WRITE_POLL)))
            .is_err()
        {
            return failed(RequestCause::ConnectionLost);
        }
        // Held across the write: the reader cannot record an end, and a
        // close, a cancellation or a release cannot be accepted, between
        // this check and the start of the write.
        let link_end = shared.link_end();
        if let Some(cause) = *link_end {
            return failed(cause);
        }
        if written == 0 {
            if let Some(stop) = unstarted(&shared.lock()) {
                return Err(WriteError::Stopped(stop));
            }
        }
        let outcome = sock.write(&frame[written..]);
        drop(link_end);
        match outcome {
            Ok(0) => return failed(RequestCause::ConnectionLost),
            Ok(n) => written += n,
            Err(e)
                if matches!(
                    e.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) => {}
            Err(_) => return failed(RequestCause::ConnectionLost),
        }
    }
    Ok(())
}

/// Why a frame whose first byte had not gone out was not started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    /// The connection began closing.
    Closing,
    /// Its operation was cancelled, or its token's release was asked for.
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WriteError {
    /// Not started: nothing was sent.
    Stopped(Stop),
    /// Failed after `written` bytes.
    Failed { cause: RequestCause, written: usize },
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
