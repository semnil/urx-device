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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread::{self, JoinHandle, ThreadId};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Waiting requests, excluding the active one (K6). A request that expired
/// while a reply was held counts until its completion has run.
pub const MAX_WAITING_REQUESTS: usize = 64;
/// Total encoded bytes of waiting requests, counted the same way (K6).
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

/// How a link that ended as `connection_lost` was lost (R1-L-A). The request
/// cause stays `connection_lost`; this tells a consumer which wording fits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkLoss {
    /// Device Center reported the unit lost.
    UnitLost,
    /// The peer closed the stream.
    PeerClosed,
    /// The socket failed with this error.
    SocketError(ErrorKind),
}

type Done = Box<dyn FnOnce(Outcome, ResultAdoption) + Send>;

/// The acknowledgment of one app-issued request's completion (K6, K37):
/// until it is adopted, the request keeps the connection's single wire
/// slot, and the worker starts nothing after it. Completions that leave no
/// result in the slot (refused, unsent or ended) carry one that adopts
/// nothing.
pub struct ResultAdoption {
    shared: Weak<Shared>,
    id: u64,
}

impl ResultAdoption {
    fn none() -> Self {
        ResultAdoption {
            shared: Weak::new(),
            id: 0,
        }
    }

    /// Releases the slot once the result is adopted. Returns false when it
    /// holds no result (anymore) on its own connection.
    pub fn adopt(self) -> bool {
        let Some(shared) = self.shared.upgrade() else {
            return false;
        };
        let mut state = shared.lock();
        match &mut state.result {
            Some(held) if held.id == self.id && !held.adopted => {
                held.adopted = true;
                drop(state);
                shared.advance.notify_all();
                true
            }
            _ => false,
        }
    }
}

/// The completion in the wire slot, awaiting its adoption.
struct HeldResult {
    id: u64,
    adopted: bool,
}

struct Item {
    owner: u64,
    /// Its owner's cancellation, held by the owner and by its work still
    /// to run, and by nothing else.
    cancelled: Arc<AtomicBool>,
    request: Request,
    frame: Vec<u8>,
    key: ReplyKey,
    submitted: Instant,
    /// Asked before the first byte, when the request was submitted with one.
    gate: Option<SendGate>,
    done: Done,
}

#[derive(Default)]
struct State {
    waiting: VecDeque<Item>,
    waiting_bytes: usize,
    closing: bool,
    /// Whether the worker holds a request it has not yet settled.
    active: bool,
    /// Whether the worker runs a lifecycle job: a close lets it finish, its
    /// started cleanup included, before the teardown budget starts.
    job: bool,
    terminal: Option<RequestCause>,
    next_owner: u64,
    ledger: Ledger,
    /// Subscription lifecycle work, run one job at a time ahead of requests.
    jobs: VecDeque<Job>,
    /// Releases asked for and not yet settled, one per token.
    releases: Vec<Release>,
    /// The end recorded in `Shared::link_end`, mirrored for the waits that
    /// hold the state lock (K12).
    ended: Option<RequestCause>,
    /// Notification records acknowledged when the end was recorded: a held
    /// reply whose cutoff they reach was released before the end (K12).
    ended_adopted: u64,
    /// When the close's teardown budget ends; set once the request being sent
    /// has settled, which starts the worker's unregistrations (N2).
    teardown_end: Option<Instant>,
    /// The worker's unregistration of the remaining ownership, once done:
    /// its failure, if any.
    teardown: Option<Option<Failure>>,
    /// The first failure of an owned cleanup's unregistration determined
    /// after the close was marked: the close reports it (K37).
    close_cleanup_failure: Option<Failure>,
    /// The app-issued completion holding the wire slot.
    result: Option<HeldResult>,
    next_result: u64,
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
        /// The activating owner's cancellation.
        cancelled: Arc<AtomicBool>,
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
    /// How the link was lost, recorded before a `connection_lost` end is
    /// (R1-L-A). The first one recorded stands.
    loss: Mutex<Option<LinkLoss>>,
    /// What the reader and the writer are doing on the socket, and whether
    /// either met a reset: how a lost connection was lost is decided with
    /// both their accounts in.
    ops: Mutex<SocketOps>,
    /// Signalled, with `ops`, when an operation ends or the reader stops.
    ops_changed: Condvar,
    /// Signalled when the worker settles its active request.
    settled: Condvar,
    /// Signalled, with the state lock, when what a held result waits for may
    /// have changed: a notification or result adoption, an end, a close.
    advance: Condvar,
    /// Requests that expired while a reply was held, and the threads that
    /// complete them, so their callbacks hold up neither the worker nor each
    /// other.
    expiry: Arc<Expiry>,
    /// Notifications waiting for the application (K6), when it takes them.
    notifications: Option<Mutex<Queue>>,
    /// Signalled when a batch can be formed or delivery must stop.
    deliverable: Condvar,
    delivery_stop: AtomicBool,
    /// The registration and unregistration frames written whole (R1-C-A),
    /// and the parameter reads and writes.
    sent_registrations: AtomicU64,
    sent_unregistrations: AtomicU64,
    sent_gets: AtomicU64,
    sent_sets: AtomicU64,
    /// Holds the next sent request's response deadline from starting until
    /// signalled, for a case that closes while that request is on the wire.
    #[cfg(test)]
    response_gate: Mutex<Option<Receiver<()>>>,
    /// Holds the next request's write between its last check and its first
    /// byte, with the end gate held, until signalled.
    #[cfg(test)]
    first_byte_gate: Mutex<Option<Receiver<()>>>,
    /// Holds the next frame taken out of the buffer, with the end gate held,
    /// before it is routed, when a receipt observer watches, until signalled.
    #[cfg(test)]
    receipt_gate: Mutex<Option<Receiver<()>>>,
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
    /// The reader stopped queueing notifications — an overflow, or a failed
    /// receipt observer — and goes on reading: the connection ends with the
    /// cause, and the reply to the request on the wire is still awaited
    /// within its deadline and kept as evidence.
    QueueingStopped(RequestCause),
}

/// One JSON frame as the reader received it.
struct Received {
    message: Value,
    /// Bytes before its LF: what a notification from it is charged (K6).
    len: usize,
    /// PC receipt time, milliseconds since the Unix epoch.
    received_at_ms: i64,
    /// Notification records queued before it (K12's receive cutoff).
    cutoff: u64,
}

/// Receives each notification batch; acknowledge it with
/// [`Connection::adopt_notifications`] once its records are adopted.
pub type NotificationHandler = Arc<dyn Fn(NotificationBatch) + Send + Sync>;

/// Shown each notification record as it is queued for delivery; see [`open_observed`].
pub type ReceiptObserver = Arc<dyn Fn(&NotificationRecord) + Send + Sync>;

/// Asked whether a request may go out, just before its first byte; see
/// [`Connection::submit_gated`].
pub type SendGate = Box<dyn Fn() -> bool + Send>;

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
    /// Kept apart from the handles, which a close takes.
    worker_id: ThreadId,
    delivery_id: Option<ThreadId>,
    reader_id: ThreadId,
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

/// The frames a connection has written whole, by kind
/// (`Connection::sent_frames`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SentFrames {
    pub registrations: u64,
    pub unregistrations: u64,
    /// Parameter reads: a numeric, text or name get.
    pub gets: u64,
    /// Parameter writes: a numeric or text set.
    pub sets: u64,
}

/// How a close ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseOutcome {
    /// The remaining ownership was unregistered, every thread finished and
    /// the socket is closed.
    Closed,
    /// Called on a thread the close cannot wait for: the worker, from a
    /// completion callback, or the closing thread itself. Closing has started
    /// and finishes without this call; callers on other threads wait for and
    /// receive the final outcome.
    Started,
    /// Every thread finished and the socket is closed, but a required
    /// unregistration of the remaining ownership failed (K37's
    /// `connection_closed` cleanup with its failure).
    Failed(Failure),
    /// The teardown did not finish within its budget: its unregistrations
    /// or a thread. The connection is unusable; its socket is shut down and
    /// its threads are left to end.
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
/// What the connection keeps of its cancellation goes with the owner and
/// the work it left: nothing of it accumulates on the connection.
pub struct Operation {
    id: u64,
    shared: Weak<Shared>,
    /// Set, under the connection's state lock, by `cancel`.
    cancelled: Arc<AtomicBool>,
}

/// Why an opening or a discovery failed: its failure and, when it ended as
/// `connection_lost`, how the link was lost if that is known (R1-O-A,
/// R1-D-A).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkFailure {
    pub failure: Failure,
    pub lost_link: Option<LinkLoss>,
}

impl From<Failure> for LinkFailure {
    fn from(failure: Failure) -> Self {
        LinkFailure {
            failure,
            lost_link: None,
        }
    }
}

/// Opens the unit at `port`, which must report `online` with identity
/// `expected_id`, and reads its System firmware. Notifications are not
/// delivered; see [`open_with`].
pub fn open(
    port: u16,
    expected_id: &str,
    options: &ConnectionOptions,
    control: &Control,
) -> Result<Connection, LinkFailure> {
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
) -> Result<Connection, LinkFailure> {
    open_delivering(port, expected_id, options, control, notifications, None)
}

/// Like [`open_with`], also showing `at_receipt` each notification record as
/// it is queued for `notifications`: on the reader thread, in receive order,
/// before the delivery can hand the record on, however long the delivery
/// waits for an acknowledgment. It sees exactly the records that are queued —
/// not a frame dropped for want of a recipient, nor one past the delivery
/// budget (K6), nor any after an overflow. It is called under the gate a
/// write's first byte starts under, so a send gate (`Connection::submit_gated`)
/// sees what it took from every record received before that byte. It must
/// return promptly and must not call into the connection: the reader receives
/// nothing, replies included, and no write starts, until it returns. If it panics, nothing more is queued and the
/// connection ends with `internal_error`; as after an overflow, the reply to
/// the request on the wire is still awaited and kept as evidence. The reader
/// thread holds it and drops it once that thread ends, by the time the
/// connection is closed.
pub fn open_observed(
    port: u16,
    expected_id: &str,
    options: &ConnectionOptions,
    control: &Control,
    notifications: NotificationHandler,
    at_receipt: ReceiptObserver,
) -> Result<Connection, LinkFailure> {
    open_delivering(
        port,
        expected_id,
        options,
        control,
        Some(notifications),
        Some(at_receipt),
    )
}

fn open_delivering(
    port: u16,
    expected_id: &str,
    options: &ConnectionOptions,
    control: &Control,
    notifications: Option<NotificationHandler>,
    at_receipt: Option<ReceiptObserver>,
) -> Result<Connection, LinkFailure> {
    let budget = Budget::starting_now(options.connect_deadline, Cause::ConnectTimeout);
    let mut link = Link::connect(port, &budget, Phase::Connect, control)?;
    link.set_phase(Phase::Identity);
    let firmware = identify(&mut link, expected_id, options, &budget)
        .map_err(|failure| link.failed(failure))?;
    let (sock, reader) = link.into_parts();
    Connection::start(sock, reader, firmware, options, notifications, at_receipt)
        .map_err(|_| Failure::cause(Cause::InternalError, Phase::Connect).into())
}

/// The opening's reads: the unit must report `online` with identity
/// `expected_id`; then its System firmware, as read.
fn identify(
    link: &mut Link<'_>,
    expected_id: &str,
    options: &ConnectionOptions,
    budget: &Budget,
) -> Result<SystemFirmware, Failure> {
    let deadline = options.handshake_request_deadline;
    let synchronize = get(
        link,
        wire::Request::GetSynchronize,
        false,
        deadline,
        budget,
        Phase::Identity,
    )?;
    // An empty status is a status other than `online` (R1-S-A).
    let status = synchronize
        .get("sync_status")
        .and_then(Value::as_str)
        .ok_or(Failure::cause(Cause::InvalidResponse, Phase::Identity))?;
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
        link,
        wire::Request::GetDevice,
        true,
        deadline,
        budget,
        Phase::Identity,
    )?;
    Ok(system_firmware(&device))
}

impl Connection {
    fn start(
        sock: TcpStream,
        reader: FrameReader,
        firmware: SystemFirmware,
        options: &ConnectionOptions,
        notifications: Option<NotificationHandler>,
        at_receipt: Option<ReceiptObserver>,
    ) -> std::io::Result<Connection> {
        // A failure leaves nothing running: the clones come before any thread
        // starts, and a thread that cannot be started stops those that did.
        let reader_sock = sock.try_clone()?;
        let worker_sock = sock.try_clone()?;
        let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            link_end: Mutex::new(None),
            loss: Mutex::new(None),
            ops: Mutex::new(SocketOps {
                reading: true,
                ..SocketOps::default()
            }),
            ops_changed: Condvar::new(),
            settled: Condvar::new(),
            advance: Condvar::new(),
            expiry: Arc::new(Expiry::default()),
            notifications: notifications
                .as_ref()
                .map(|_| Mutex::new(Queue::new(generation))),
            deliverable: Condvar::new(),
            delivery_stop: AtomicBool::new(false),
            sent_registrations: AtomicU64::new(0),
            sent_unregistrations: AtomicU64::new(0),
            sent_gets: AtomicU64::new(0),
            sent_sets: AtomicU64::new(0),
            #[cfg(test)]
            response_gate: Mutex::new(None),
            #[cfg(test)]
            first_byte_gate: Mutex::new(None),
            #[cfg(test)]
            receipt_gate: Mutex::new(None),
        });
        let (events, inbox) = mpsc::channel();
        let reader_stop = Arc::new(AtomicBool::new(false));
        // Held by the reader thread, which shows it each record it queues, so
        // the transport lets go of it once that thread ends.
        let at_receipt = at_receipt.filter(|_| notifications.is_some());
        // A thread that cannot be started fails the opening; the ones already
        // started are stopped and waited for first, so nothing is left running.
        let abandon = |started: Vec<JoinHandle<()>>| {
            reader_stop.store(true, Ordering::SeqCst);
            let _ = sock.shutdown(Shutdown::Both);
            match &shared.notifications {
                Some(queue) => {
                    let _queue = lock(queue);
                    shared.delivery_stop.store(true, Ordering::SeqCst);
                }
                None => shared.delivery_stop.store(true, Ordering::SeqCst),
            }
            shared.deliverable.notify_all();
            for thread in started {
                let _ = thread.join();
            }
        };
        let spawner = &shared.expiry.spawner;
        let delivery_thread = match notifications.map(|handler| {
            let shared = Arc::clone(&shared);
            let events = events.clone();
            spawner.spawn(move || deliver_notifications(&shared, &handler, &events))
        }) {
            Some(Ok(thread)) => Some(thread),
            Some(Err(error)) => return Err(error),
            None => None,
        };
        let reader_thread = {
            let sock = reader_sock;
            let events = events.clone();
            let stop = Arc::clone(&reader_stop);
            let shared = Arc::clone(&shared);
            match spawner.spawn(move || read_frames(sock, reader, events, stop, shared, at_receipt))
            {
                Ok(thread) => thread,
                Err(error) => {
                    abandon(delivery_thread.into_iter().collect());
                    return Err(error);
                }
            }
        };
        let worker_thread = {
            let sock = worker_sock;
            let shared = Arc::clone(&shared);
            let options = *options;
            match spawner.spawn(move || serve(sock, inbox, shared, options)) {
                Ok(thread) => thread,
                Err(error) => {
                    abandon(delivery_thread.into_iter().chain([reader_thread]).collect());
                    return Err(error);
                }
            }
        };
        Ok(Connection {
            generation,
            delivery_id: delivery_thread.as_ref().map(|handle| handle.thread().id()),
            reader_id: reader_thread.thread().id(),
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

    /// How the link was lost, once the connection's recorded end is
    /// `connection_lost` and the way it was lost is known (R1-L-A). The end
    /// is recorded before any request, lifecycle call or close is handed it,
    /// so this answers from inside that callback and after that close.
    pub fn lost_link(&self) -> Option<LinkLoss> {
        let ended = self.shared.lock().ended;
        if ended != Some(RequestCause::ConnectionLost) {
            return None;
        }
        *lock(&self.shared.loss)
    }

    /// The registration, unregistration, parameter read and parameter write
    /// frames this connection has written whole, since it opened (R1-C-A):
    /// what a registration, a release, a close or a request sent, whether it
    /// then succeeded or failed, its answer still awaited included. A frame
    /// cut short is not counted, and nor is one that never started (a request
    /// refused before it was sent). The opening's own reads are not counted.
    pub fn sent_frames(&self) -> SentFrames {
        // Under the gate every write holds while it counts its frame: the
        // figures are read at one moment, and a frame written whole before
        // this call is in them.
        let _gate = self.shared.link_end();
        SentFrames {
            registrations: self.shared.sent_registrations.load(Ordering::SeqCst),
            unregistrations: self.shared.sent_unregistrations.load(Ordering::SeqCst),
            gets: self.shared.sent_gets.load(Ordering::SeqCst),
            sets: self.shared.sent_sets.load(Ordering::SeqCst),
        }
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
            cancelled: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Admits `request` for `operation`, or completes it at once, unsent,
    /// when it cannot be admitted. `done` runs exactly once, on the worker
    /// thread or, for a refusal, on this thread. A result received from the
    /// unit is passed only after every notification received before it is
    /// adopted (K12), and it holds the wire slot until its
    /// [`ResultAdoption`] is adopted (K6).
    pub fn submit(
        &self,
        operation: &Operation,
        request: Request,
        done: impl FnOnce(Outcome, ResultAdoption) + Send + 'static,
    ) {
        self.admit(operation, request, None, done);
    }

    /// Like [`Connection::submit`], also asking `gate` whether the request
    /// may go out just before its first byte would: on the worker thread,
    /// under the gate a receipt observer is called under (`open_observed`),
    /// so it sees every record received before that byte, and none received
    /// after. It is asked again before each try at the first byte — a try a
    /// transient socket error ends sends nothing — and never once a byte is
    /// out, so it reads the current state rather than consuming a permit. A
    /// refusal, or a panic in it, completes the request unsent as
    /// `precondition_failed` at admission, and the connection goes on. It
    /// must return promptly and must not call into the connection; it is let
    /// go outside the connection's locks, however the request ends.
    pub fn submit_gated(
        &self,
        operation: &Operation,
        request: Request,
        gate: SendGate,
        done: impl FnOnce(Outcome, ResultAdoption) + Send + 'static,
    ) {
        self.admit(operation, request, Some(gate), done);
    }

    fn admit(
        &self,
        operation: &Operation,
        request: Request,
        gate: Option<SendGate>,
        done: impl FnOnce(Outcome, ResultAdoption) + Send + 'static,
    ) {
        let refuse = |code, phase| Outcome::failed(code, phase, Evidence::NotSent);
        let message = message_of(&request);
        let frame = match frame::encode(&message) {
            Ok(frame) => frame,
            Err(_) => {
                return done(
                    refuse(RequestCause::InvalidInput, RequestPhase::Validation),
                    ResultAdoption::none(),
                )
            }
        };
        let mut state = self.shared.lock();
        let ours = operation.shared.ptr_eq(&Arc::downgrade(&self.shared));
        if !ours || state.closing || state.terminal.is_some() {
            drop(state);
            return done(
                refuse(RequestCause::NotConnected, RequestPhase::Admission),
                ResultAdoption::none(),
            );
        }
        if operation.cancelled.load(Ordering::SeqCst) {
            drop(state);
            let cancelled = Outcome::Failure {
                failure: RequestFailure::Cancelled {
                    phase: RequestPhase::Admission,
                },
                evidence: Evidence::NotSent,
            };
            return done(cancelled, ResultAdoption::none());
        }
        let (expiring, expiring_bytes) = self.shared.expiry.charged();
        if state.waiting.len() + expiring >= MAX_WAITING_REQUESTS
            || state.waiting_bytes + expiring_bytes + frame.len() > MAX_WAITING_BYTES
        {
            drop(state);
            return done(
                refuse(RequestCause::PreconditionFailed, RequestPhase::Admission),
                ResultAdoption::none(),
            );
        }
        // Its completing thread is held from now on, so that its expiry or a
        // close never has to run `done` on the worker or the closing thread.
        let Ok(reservation) = self.shared.expiry.reserve() else {
            drop(state);
            return done(
                refuse(RequestCause::InternalError, RequestPhase::Admission),
                ResultAdoption::none(),
            );
        };
        state.waiting_bytes += frame.len();
        state.waiting.push_back(Item {
            owner: operation.id,
            cancelled: Arc::clone(&operation.cancelled),
            key: key_of(&request),
            request,
            frame,
            submitted: Instant::now(),
            gate,
            done: Box::new(move |outcome, adoption| {
                let _reserved = reservation;
                done(outcome, adoption);
            }),
        });
        drop(state);
        // A held result's wait tracks the earliest send deadline.
        self.shared.advance.notify_all();
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
            // Taken after the queue changed, so a held result checking it
            // under the state lock either sees the change or is woken.
            drop(self.shared.lock());
            self.shared.advance.notify_all();
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

    /// Closes the connection. In order:
    ///
    /// 1. New submissions and any request not yet started on the wire are
    ///    refused. Waiting requests and lifecycle calls not yet started
    ///    complete unsent as `not_connected`. Their callbacks run on a
    ///    separate thread, so they do not delay the steps below; the close
    ///    waits for that thread within `teardown`, like the others.
    /// 2. The request already being sent settles under its own deadlines. A
    ///    lifecycle call already running goes on to its end: its remaining
    ///    registrations stop, but its owned cleanup (a release, or the
    ///    cleanup of a failed or cancelled activation) sends its
    ///    unregistrations under their own deadlines, not `teardown`.
    /// 3. Only then does `teardown` start. Within it, the worker unregisters
    ///    every address the connection may still have registered (once
    ///    each, stopping at the first failure; nothing once the link has
    ///    ended), and the socket is shut down and released and the threads
    ///    must finish.
    ///
    /// So a close may take longer than `teardown` by the cleanup running when
    /// it was called. The outcome is `Closed` when every unregistration was
    /// accepted (or none was needed) and every thread finished within
    /// `teardown`; `Failed` when an unregistration failed (the teardown's or
    /// a cleanup's after this call) and every thread still finished within
    /// it; and `Incomplete(teardown_timeout)` whenever the budget ran out,
    /// in the unregistrations or waiting for a thread (a callback that has
    /// not returned included), whether or not an unregistration failed.
    /// Repeated and concurrent calls share the first call's close and its
    /// outcome; none starts a second shutdown or sends anything more.
    pub fn close(&self, teardown: Duration) -> CloseOutcome {
        {
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
            let gate = self.shared.link_end();
            let mut state = self.shared.lock();
            state.closing = true;
            *close = CloseState::Closing;
            lock(&self.close.exempt).push(thread::current().id());
            // An end already recorded is how the waiting requests end.
            let cause = gate.unwrap_or(RequestCause::NotConnected);
            // What waits completes on the threads held for it at admission,
            // which the close waits for within the budget; a close called from
            // one of their callbacks returns `Started` instead of waiting for
            // itself. Handed over in the step that takes it, so an end that
            // stops the threads meanwhile finds it queued, and they run it
            // first.
            self.shared
                .expiry
                .hand(take_pending(&mut state).completions(cause));
        };
        #[cfg(test)]
        if let Some(taken) = CLOSE_TAKEN.with(|hook| hook.borrow_mut().take()) {
            taken();
        }
        // After the close is marked, no hold queues another expired request.
        self.shared.expiry.stop();
        // A held result stops waiting for the application.
        self.shared.advance.notify_all();
        let _ = self.events.send(Event::Wake);
        {
            let mut state = self.shared.lock();
            while state.active || state.job {
                state = self
                    .shared
                    .settled
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        }
        // The teardown budget starts now (N2): the worker unregisters the
        // remaining ownership within it.
        let end = Instant::now() + teardown;
        self.shared.lock().teardown_end = Some(end);
        self.shared.advance.notify_all();
        let _ = self.events.send(Event::Wake);
        let rest = Teardown {
            shared: Arc::clone(&self.shared),
            reader_stop: Arc::clone(&self.reader_stop),
            sock: lock(&self.sock).take(),
            threads: [
                lock(&self.worker).take(),
                lock(&self.reader).take(),
                lock(&self.delivery).take(),
            ],
            end,
        };
        if self.on_own_thread() {
            // A completion or delivery callback, or the reader dropping a
            // receipt observer that held the last reference, cannot wait for
            // the thread it runs on; a helper finishes the close within the
            // same budget.
            let cell = Arc::clone(&self.close);
            let slot = Arc::new(Mutex::new(Some(rest)));
            let taken = Arc::clone(&slot);
            let helper = self.shared.expiry.spawner.spawn(move || {
                if let Some(rest) = lock(&taken).take() {
                    cell.record(rest.finish());
                }
            });
            if helper.is_ok() {
                return CloseOutcome::Started;
            }
            // Without a helper the close cannot wait here: it stops what it
            // can and records that it could not finish.
            let outcome = lock(&slot)
                .take()
                .map_or(CloseOutcome::Started, Teardown::abandon);
            self.close.record(outcome);
            return outcome;
        }
        let outcome = rest.finish();
        self.close.record(outcome);
        outcome
    }

    /// Whether this thread is one the close waits for: the worker, the
    /// notification delivery thread, the reader, a completing thread, or the
    /// thread running the close.
    fn must_not_wait(&self) -> bool {
        let me = thread::current().id();
        self.on_own_thread() || lock(&self.close.exempt).contains(&me)
    }

    /// Whether this is the worker, the notification delivery thread, the
    /// reader or a completing thread (an expired request's, or what a close
    /// took).
    fn on_own_thread(&self) -> bool {
        let me = thread::current().id();
        self.worker_id == me
            || self.delivery_id == Some(me)
            || self.reader_id == me
            || lock(&self.shared.expiry.pool).ids.contains(&me)
    }
}

/// The rest of a close once the worker has the teardown budget.
struct Teardown {
    shared: Arc<Shared>,
    reader_stop: Arc<AtomicBool>,
    sock: Option<TcpStream>,
    threads: [Option<JoinHandle<()>>; 3],
    end: Instant,
}

impl Teardown {
    /// What a close does with no thread to finish on: it stops the threads
    /// and shuts the socket down without waiting for either, and could not
    /// finish.
    fn abandon(self) -> CloseOutcome {
        self.reader_stop.store(true, Ordering::SeqCst);
        if let Some(sock) = self.sock {
            let _ = sock.shutdown(Shutdown::Both);
        }
        match &self.shared.notifications {
            Some(queue) => {
                let _queue = lock(queue);
                self.shared.delivery_stop.store(true, Ordering::SeqCst);
            }
            None => self.shared.delivery_stop.store(true, Ordering::SeqCst),
        }
        self.shared.deliverable.notify_all();
        CloseOutcome::Incomplete(Failure::cause(Cause::InternalError, Phase::Teardown))
    }

    /// Waits, within the budget, for the worker's unregistrations (or the
    /// connection's end), then shuts the socket down and waits for the
    /// threads.
    fn finish(self) -> CloseOutcome {
        let unregistered = {
            let mut state = self.shared.lock();
            loop {
                // A cleanup that failed after the close was marked comes
                // first: the worker's teardown follows it.
                if let Some(failure) = state.teardown {
                    break Some(state.close_cleanup_failure.or(failure));
                }
                if state.terminal.is_some() {
                    break Some(state.close_cleanup_failure);
                }
                let remaining = self.end.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break None;
                }
                state = self
                    .shared
                    .settled
                    .wait_timeout(state, remaining)
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0;
            }
        };
        self.reader_stop.store(true, Ordering::SeqCst);
        if let Some(sock) = self.sock {
            let _ = sock.shutdown(Shutdown::Both);
        }
        // Under the queue lock, so the delivery thread cannot miss it
        // between checking it and waiting.
        match &self.shared.notifications {
            Some(queue) => {
                let _queue = lock(queue);
                self.shared.delivery_stop.store(true, Ordering::SeqCst);
            }
            None => self.shared.delivery_stop.store(true, Ordering::SeqCst),
        }
        self.shared.deliverable.notify_all();
        let joined = wait_for(self.threads, &self.shared.expiry, self.end);
        match (unregistered, joined) {
            (None, _) => {
                CloseOutcome::Incomplete(Failure::cause(Cause::TeardownTimeout, Phase::Teardown))
            }
            // The budget ran out in the worker's unregistrations.
            (
                Some(Some(
                    failure @ Failure::Cause {
                        code: Cause::TeardownTimeout,
                        ..
                    },
                )),
                _,
            ) => CloseOutcome::Incomplete(failure),
            (Some(Some(failure)), CloseOutcome::Closed) => CloseOutcome::Failed(failure),
            (Some(_), joined) => joined,
        }
    }
}

/// `Closed` only when every thread has been joined before `end`; otherwise
/// `Incomplete`, even if the threads finish later. The joins run on their own
/// thread, so a thread whose exit (its thread-local destructors included)
/// does not finish cannot hold this past `end`.
fn wait_for<const N: usize>(
    threads: [Option<JoinHandle<()>>; N],
    expiry: &Arc<Expiry>,
    end: Instant,
) -> CloseOutcome {
    let incomplete =
        CloseOutcome::Incomplete(Failure::cause(Cause::TeardownTimeout, Phase::Teardown));
    let (joined, all_joined) = mpsc::channel();
    let joining = Arc::clone(expiry);
    let joiner = expiry.spawner.spawn(move || {
        for thread in threads.into_iter().flatten() {
            let _ = thread.join();
        }
        // Taken once the close is marked: no admission, and so no completing
        // thread, follows it. Their identities stay recorded, so a close from
        // one never waits for itself.
        let expiries = {
            let mut pool = lock(&joining.pool);
            let mut threads = std::mem::take(&mut pool.threads);
            threads.append(&mut pool.retired);
            threads
        };
        for thread in expiries {
            let _ = thread.join();
        }
        let _ = joined.send(());
    });
    // Without a thread to join on, the threads cannot be waited for within
    // the budget: they are let go, and the close could not finish.
    if joiner.is_err() {
        return CloseOutcome::Incomplete(Failure::cause(Cause::InternalError, Phase::Teardown));
    }
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
        let Ok(reservation) = shared.expiry.reserve() else {
            drop(state);
            return done(Err(no_completing_thread()));
        };
        state.jobs.push_back(Job::Activate {
            token: self.token,
            cancelled: Arc::clone(&operation.cancelled),
            done: Box::new(move |outcome| {
                let _reserved = reservation;
                done(outcome);
            }),
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
        let Ok(reservation) = shared.expiry.reserve() else {
            drop(state);
            drop(gate);
            return done(Err(no_completing_thread()));
        };
        let done: LifecycleDone = Box::new(move |outcome| {
            let _reserved = reservation;
            done(outcome);
        });
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

/// A lifecycle call refused because no thread could be held to complete it.
fn no_completing_thread() -> LifecycleFailure {
    LifecycleFailure {
        failure: Failure::cause(Cause::InternalError, Phase::Subscription),
        cleanup: Cleanup::COMPLETE,
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
        RequestCause::NotificationOverflow => Cause::NotificationOverflow,
        RequestCause::InvalidInput | RequestCause::InternalError => Cause::InternalError,
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
        let (cancelled, ended) = {
            // Ordered with the start of every write (see write_frame).
            let gate = shared.link_end();
            let mut state = shared.lock();
            self.cancelled.store(true, Ordering::SeqCst);
            let (mine, others): (VecDeque<Item>, VecDeque<Item>) =
                std::mem::take(&mut state.waiting)
                    .into_iter()
                    .partition(|item| item.owner == self.id);
            state.waiting = others;
            state.waiting_bytes = state.waiting.iter().map(|item| item.frame.len()).sum();
            (mine, *gate)
        };
        for item in cancelled {
            // Once the end is recorded, the waiting requests end with it.
            let outcome = match ended {
                Some(cause) => Outcome::failed(cause, RequestPhase::Admission, Evidence::NotSent),
                None => Outcome::Failure {
                    failure: RequestFailure::Cancelled {
                        phase: RequestPhase::Admission,
                    },
                    evidence: Evidence::NotSent,
                },
            };
            deliver(item.done, outcome, ResultAdoption::none());
        }
    }
}

fn is_unsent(outcome: &Outcome) -> bool {
    matches!(
        outcome,
        Outcome::Failure {
            evidence: Evidence::NotSent,
            ..
        }
    )
}

#[cfg(test)]
impl Connection {
    /// `submit`, adopting the result as soon as `done` has returned.
    pub(crate) fn submit_adopted(
        &self,
        operation: &Operation,
        request: Request,
        done: impl FnOnce(Outcome) + Send + 'static,
    ) {
        self.submit(operation, request, move |outcome, adoption| {
            done(outcome);
            adoption.adopt();
        });
    }
}

/// The worker's part of a close: once the close gives the teardown budget,
/// unregister the remaining ownership unless the connection already ended,
/// and report the result to the close.
fn tear_down(
    sock: &mut TcpStream,
    inbox: &Receiver<Event>,
    shared: &Shared,
    options: &ConnectionOptions,
) {
    let end = {
        let mut state = shared.lock();
        loop {
            if let Some(end) = state.teardown_end {
                break end;
            }
            state = shared
                .advance
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    };
    // An end recorded meanwhile leaves nothing to unregister on this link.
    let ended = shared.link_end().is_some();
    let failure = if ended {
        None
    } else {
        let mut io = Io {
            sock,
            inbox,
            shared,
            options,
            teardown: Some(end),
        };
        io.unregister_remaining()
    };
    shared.lock().teardown = Some(failure);
    shared.settled.notify_all();
}

/// Starts the connection's threads. A thread the system cannot create is an
/// error each caller handles, never a panic: an opening fails, and a close or
/// a completion goes on without the thread.
#[derive(Default)]
pub(crate) struct Spawner {
    /// Refuses every thread, for a case that stands in for the system.
    #[cfg(test)]
    pub(crate) refuse: AtomicBool,
}

#[cfg(test)]
thread_local! {
    /// Refuses the threads started from this thread once this many more have
    /// started, for a case that stands in for the system.
    pub(crate) static REFUSE_SPAWN: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
    /// Runs once a close on this thread has taken what waits, for a case that
    /// ends the connection at that point.
    pub(crate) static CLOSE_TAKEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    /// Counts the threads started from this thread that have not yet
    /// finished, for a case that checks none is left running.
    pub(crate) static RUNNING: std::cell::RefCell<Option<Arc<std::sync::atomic::AtomicUsize>>> =
        const { std::cell::RefCell::new(None) };
}

/// One thread counted in [`RUNNING`], until it finishes or never starts.
#[cfg(test)]
struct Running(Arc<std::sync::atomic::AtomicUsize>);

#[cfg(test)]
impl Drop for Running {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Spawner {
    pub(crate) fn spawn(
        &self,
        f: impl FnOnce() + Send + 'static,
    ) -> std::io::Result<JoinHandle<()>> {
        #[cfg(test)]
        if self.refuse.load(Ordering::SeqCst)
            || REFUSE_SPAWN.with(|left| match left.get() {
                Some(0) => true,
                Some(n) => {
                    left.set(Some(n - 1));
                    false
                }
                None => false,
            })
        {
            return Err(std::io::Error::new(
                ErrorKind::WouldBlock,
                "thread creation refused",
            ));
        }
        #[cfg(test)]
        if let Some(running) = RUNNING.with(|running| running.borrow().clone()) {
            // Counted before the thread starts, so it cannot be missed.
            running.fetch_add(1, Ordering::SeqCst);
            let counted = Running(running);
            return thread::Builder::new().spawn(move || {
                let _counted = counted;
                f();
            });
        }
        thread::Builder::new().spawn(f)
    }
}

/// The threads that complete admitted callbacks off the worker: a request
/// that expired during a hold, and what a close takes (K5, K6). Each admitted
/// callback holds one of them from its admission until it has run, so that
/// none has to run on the worker or on the closing thread, and a blocked one
/// delays no other.
#[derive(Default)]
struct Expiry {
    pool: Mutex<ExpiryPool>,
    /// Signalled when a completion is handed over or the threads must stop.
    ready: Condvar,
    spawner: Spawner,
    /// Admitted callbacks not yet run; there are never fewer threads alive.
    reserved: Arc<AtomicUsize>,
}

/// A callback handed to the completing threads.
type Completion = Box<dyn FnOnce() + Send>;

/// One completion handed over, and the bytes an expired request keeps
/// charged until it has run.
struct Entry {
    run: Completion,
    charged_bytes: Option<usize>,
}

#[derive(Default)]
struct ExpiryPool {
    queue: VecDeque<Entry>,
    /// Expired requests whose completion has not run, and their bytes: they
    /// stay charged to the waiting-request limits until then.
    charged: usize,
    charged_bytes: usize,
    /// Threads started that have not ended.
    alive: usize,
    threads: Vec<JoinHandle<()>>,
    /// Threads that ended after lingering, until a later one or the close
    /// joins them.
    retired: Vec<JoinHandle<()>>,
    /// Whether a retiring thread is joining the ones retired before it; no
    /// other retires meanwhile, and the threads stay to be reused.
    reaping: bool,
    /// Identities of the threads not yet joined, so a close from one — its
    /// exit's thread-local destructors included — never waits for itself.
    ids: Vec<ThreadId>,
    stopping: bool,
}

/// How long a completing thread more than the reserved callbacks need waits
/// for work before it ends.
#[cfg(not(test))]
const LINGER: Duration = Duration::from_secs(1);
#[cfg(test)]
const LINGER: Duration = Duration::from_millis(250);

/// One admitted callback's hold on a completing thread, until the callback
/// has run or is dropped.
struct Reservation(Arc<AtomicUsize>);

impl Drop for Reservation {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Expiry {
    /// Holds a completing thread for one admitted callback, starting one when
    /// fewer are alive than callbacks reserved. A thread the system cannot
    /// start refuses the admission.
    fn reserve(self: &Arc<Self>) -> std::io::Result<Reservation> {
        let mut pool = lock(&self.pool);
        let reserved = self.reserved.fetch_add(1, Ordering::SeqCst) + 1;
        let reservation = Reservation(Arc::clone(&self.reserved));
        if pool.alive < reserved {
            let expiry = Arc::clone(self);
            // Registered before it can run: it waits for this lock first.
            let thread = self.spawner.spawn(move || expiry.complete())?;
            pool.alive += 1;
            pool.ids.push(thread.thread().id());
            pool.threads.push(thread);
        }
        Ok(reservation)
    }

    /// Queues expired requests for their held threads. Every queued or
    /// running completion is charged, so the requests stay within the
    /// waiting-request limit.
    fn queue(&self, expired: VecDeque<Item>) {
        let mut pool = lock(&self.pool);
        for item in expired {
            let bytes = item.frame.len();
            pool.charged += 1;
            pool.charged_bytes += bytes;
            // Its gate goes with it and is let go on its thread, outside the locks it was taken under.
            let Item { gate, done, .. } = item;
            pool.queue.push_back(Entry {
                run: Box::new(move || {
                    drop(gate);
                    let timeout = Outcome::failed(
                        RequestCause::SendTimeout,
                        RequestPhase::Admission,
                        Evidence::NotSent,
                    );
                    deliver(done, timeout, ResultAdoption::none());
                }),
                charged_bytes: Some(bytes),
            });
        }
        drop(pool);
        self.ready.notify_all();
    }

    /// Hands what a close took to the held threads.
    fn hand(&self, completions: Vec<Completion>) {
        if completions.is_empty() {
            return;
        }
        let mut pool = lock(&self.pool);
        pool.queue.extend(completions.into_iter().map(|run| Entry {
            run,
            charged_bytes: None,
        }));
        drop(pool);
        self.ready.notify_all();
    }

    /// One completing thread: runs what is handed over until told to stop
    /// with nothing left, or until it has waited [`LINGER`] with more
    /// threads alive than callbacks reserved.
    fn complete(&self) {
        let mut pool = lock(&self.pool);
        loop {
            if let Some(entry) = pool.queue.pop_front() {
                drop(pool);
                (entry.run)();
                pool = lock(&self.pool);
                if let Some(bytes) = entry.charged_bytes {
                    pool.charged -= 1;
                    pool.charged_bytes -= bytes;
                }
                continue;
            }
            if pool.stopping {
                pool.alive -= 1;
                return;
            }
            let (next, waited) = self
                .ready
                .wait_timeout(pool, LINGER)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            pool = next;
            if waited.timed_out()
                && pool.queue.is_empty()
                && !pool.stopping
                && !pool.reaping
                && pool.alive > self.reserved.load(Ordering::SeqCst)
            {
                pool.alive -= 1;
                // Retires itself, for a later thread or the close to join, and
                // joins the threads retired before it, off every admission and
                // close. One thread at a time does: while it waits for one
                // whose exit does not finish, the others stay and are reused,
                // so the connection keeps no more threads than that.
                let me = thread::current().id();
                let earlier = std::mem::take(&mut pool.retired);
                if let Some(at) = pool.threads.iter().position(|t| t.thread().id() == me) {
                    let own = pool.threads.swap_remove(at);
                    pool.retired.push(own);
                }
                pool.reaping = true;
                drop(pool);
                for thread in earlier {
                    let id = thread.thread().id();
                    let _ = thread.join();
                    lock(&self.pool).ids.retain(|known| *known != id);
                }
                lock(&self.pool).reaping = false;
                return;
            }
        }
    }

    /// Lets the threads end once nothing is queued; no hold follows.
    fn stop(&self) {
        lock(&self.pool).stopping = true;
        self.ready.notify_all();
    }

    fn charged(&self) -> (usize, usize) {
        let pool = lock(&self.pool);
        (pool.charged, pool.charged_bytes)
    }
}

/// Runs one completion callback. A callback that panics is contained, so
/// every other admitted request still completes and the connection still
/// shuts down.
/// Returns false when the callback panicked.
fn deliver(done: Done, outcome: Outcome, adoption: ResultAdoption) -> bool {
    panic::catch_unwind(AssertUnwindSafe(move || done(outcome, adoption))).is_ok()
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

/// What [`route`] did with a received frame.
enum Routed {
    /// Not a notification: the worker takes it.
    NotNotification,
    Queued,
    /// A notification no token is eligible for, or the application takes none.
    Dropped,
    /// A notification beyond the delivery budget (K6).
    Overflow,
    /// The receipt observer panicked on a notification, which is not queued.
    ObserverFailed,
}

/// Decides, at receipt, which tokens a notification frame is for, and
/// queues it for them within the budget (K6), showing it to `at_receipt`
/// first. Once `accepting` is false (after an overflow or a failed
/// observer), notifications are no longer queued.
fn route(
    shared: &Shared,
    received: &Received,
    accepting: bool,
    at_receipt: Option<&ReceiptObserver>,
    received_under: Option<MutexGuard<'_, Option<RequestCause>>>,
) -> Routed {
    let Some(payload) = Inbound::new(received.message.clone()).notification() else {
        return Routed::NotNotification;
    };
    let Some(queue) = shared.notifications.as_ref().filter(|_| accepting) else {
        return Routed::Dropped;
    };
    // With an observer, the notification is shown under the end gate it was received under, so a
    // send gate sees it if, and only if, it was received before that write's first byte
    // (`Connection::submit_gated`).
    let gate = at_receipt.map(|_| received_under.unwrap_or_else(|| shared.link_end()));
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
        return Routed::Dropped;
    }
    let record = NotificationRecord {
        recipients,
        received_at_ms: received.received_at_ms,
        payload,
    };
    if let Some(observe) = at_receipt {
        // Only this thread queues, and nothing else adds to what the queue
        // retains, so a record that fits now still fits once it is seen.
        if !lock(queue).fits(received.len) {
            return Routed::Overflow;
        }
        if panic::catch_unwind(AssertUnwindSafe(|| observe(&record))).is_err() {
            return Routed::ObserverFailed;
        }
    }
    drop(gate);
    let pushed = lock(queue).push(record, received.len);
    shared.deliverable.notify_all();
    match pushed {
        Ok(()) => Routed::Queued,
        Err(_) => Routed::Overflow,
    }
}

/// The delivery thread: hands one batch at a time to `handler` and waits
/// for its acknowledgment before the next, until the connection closes.
fn deliver_notifications(shared: &Shared, handler: &NotificationHandler, events: &Sender<Event>) {
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
                if let Some(batch) = queue.next_batch() {
                    break batch;
                }
                queue = shared
                    .deliverable
                    .wait(queue)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        };
        if panic::catch_unwind(AssertUnwindSafe(|| handler(batch))).is_err() {
            // The application can no longer adopt notifications: the
            // connection ends, and delivery stops.
            record_end(shared, RequestCause::InternalError);
            let _ = events.send(Event::ReadFailed(RequestCause::InternalError));
            return;
        }
    }
}

/// Receives frames until told to stop or the link fails, showing each
/// queued notification to `at_receipt`, which it drops on the way out.
fn read_frames(
    sock: TcpStream,
    reader: FrameReader,
    events: Sender<Event>,
    stop: Arc<AtomicBool>,
    shared: Arc<Shared>,
    at_receipt: Option<ReceiptObserver>,
) {
    read_until_stopped(sock, reader, &events, &stop, &shared, at_receipt.as_ref());
    // Whatever the reader met is reported by now, or never will be.
    lock(&shared.ops).reading = false;
    shared.ops_changed.notify_all();
    // Last: the observer can hold the last reference to the connection, and
    // the close its drop starts waits for what the reader's end lets go.
    drop(at_receipt);
}

/// The reader's loop (`read_frames`).
fn read_until_stopped(
    mut sock: TcpStream,
    mut reader: FrameReader,
    events: &Sender<Event>,
    stop: &AtomicBool,
    shared: &Arc<Shared>,
    at_receipt: Option<&ReceiptObserver>,
) {
    let shared = Arc::clone(shared);
    let record = |cause| {
        record_end(&shared, cause);
    };
    // After an overflow or a failed receipt observer, replies to a request
    // already sent still arrive; further notifications are not queued, even
    // once budget is released.
    let mut queueing = true;
    begin_op(&shared, Side::Reader);
    let set = sock
        .set_read_timeout(Some(READ_POLL))
        .map_err(|error| crate::link::pending_or(&sock, error));
    end_op(
        &shared,
        Side::Reader,
        set.as_ref().err().map(std::io::Error::kind),
    );
    if let Err(error) = set {
        note_socket_loss(&shared, Side::Reader, LinkLoss::SocketError(error.kind()));
        record(RequestCause::ConnectionLost);
        let _ = events.send(Event::ReadFailed(RequestCause::ConnectionLost));
        return;
    }
    while !stop.load(Ordering::SeqCst) {
        // A frame is received when it is taken out of the buffer complete: with a receipt
        // observer, under the end gate a write's first byte starts under, so the reader and the
        // writer order a receipt and a first byte alike (`Connection::submit_gated`). The wait for
        // input stays outside it.
        let mut gate = at_receipt.map(|_| shared.link_end());
        let read = match reader.take_frame() {
            Ok(None) => {
                drop(gate.take());
                begin_op(&shared, Side::Reader);
                let filled = reader.fill(&mut sock);
                let met = match &filled {
                    Err(ReadError::Io(kind)) => Some(*kind),
                    _ => None,
                };
                end_op(&shared, Side::Reader, met);
                match filled {
                    Ok(_) => continue,
                    Err(error) => Err(error),
                }
            }
            taken => taken,
        };
        match read {
            Ok(Some(frame)) => {
                let received_at_ms = now_ms();
                #[cfg(test)]
                if gate.is_some() {
                    let hook = lock(&shared.receipt_gate).take();
                    if let Some(hook) = hook {
                        let _ = hook.recv();
                    }
                }
                if let Some(json) = frame.json {
                    if lost_notification(&json) {
                        drop(gate.take());
                        note_loss(&shared, LinkLoss::UnitLost);
                        record(RequestCause::ConnectionLost);
                    }
                    let mut received = Received {
                        message: json,
                        len: frame.len,
                        received_at_ms,
                        cutoff: 0,
                    };
                    // Recipients and budget are decided here, at receipt.
                    match route(&shared, &received, queueing, at_receipt, gate.take()) {
                        Routed::NotNotification => {}
                        Routed::Queued | Routed::Dropped => continue,
                        // Only while queueing: once not, `route` drops every notification.
                        stopped @ (Routed::Overflow | Routed::ObserverFailed) => {
                            queueing = false;
                            let cause = match stopped {
                                Routed::Overflow => RequestCause::NotificationOverflow,
                                _ => RequestCause::InternalError,
                            };
                            record(cause);
                            let _ = events.send(Event::QueueingStopped(cause));
                            continue;
                        }
                    }
                    received.cutoff = shared
                        .notifications
                        .as_ref()
                        .map_or(0, |queue| lock(queue).accepted());
                    if events.send(Event::Frame(received)).is_err() {
                        return;
                    }
                }
            }
            Ok(None) => {}
            Err(error) => {
                drop(gate.take());
                if !stop.load(Ordering::SeqCst) {
                    let cause = match error {
                        ReadError::Oversized { .. } => RequestCause::InvalidResponse,
                        ReadError::Closed => {
                            note_socket_loss(&shared, Side::Reader, LinkLoss::PeerClosed);
                            RequestCause::ConnectionLost
                        }
                        ReadError::Io(kind) => {
                            note_socket_loss(&shared, Side::Reader, LinkLoss::SocketError(kind));
                            RequestCause::ConnectionLost
                        }
                    };
                    record(cause);
                    let _ = events.send(Event::ReadFailed(cause));
                }
                return;
            }
        }
    }
}

/// Records how the link was lost, unless that is already recorded; called
/// before the `connection_lost` end it explains is recorded (R1-L-A).
fn note_loss(shared: &Shared, loss: LinkLoss) {
    lock(&shared.loss).get_or_insert(loss);
}

/// The two threads that operate on a connection's socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Reader,
    Writer,
}

/// The reader's and the writer's socket operations (`Shared::ops`).
#[derive(Debug, Default)]
struct SocketOps {
    /// The reader runs; it reads the whole connection long.
    reading: bool,
    reader_busy: bool,
    /// Reader operations finished.
    reads: u64,
    writer_busy: bool,
    /// Either met a reset.
    reset: bool,
}

/// Marks the start of a socket operation by `side`.
fn begin_op(shared: &Shared, side: Side) {
    let mut ops = lock(&shared.ops);
    match side {
        Side::Reader => ops.reader_busy = true,
        Side::Writer => ops.writer_busy = true,
    }
}

/// Marks the end of `side`'s socket operation with the error it met, if
/// any, in one step: an operation that met a reset is never seen finished
/// without it.
fn end_op(shared: &Shared, side: Side, met: Option<ErrorKind>) {
    let mut ops = lock(&shared.ops);
    match side {
        Side::Reader => {
            ops.reader_busy = false;
            ops.reads += 1;
        }
        Side::Writer => ops.writer_busy = false,
    }
    ops.reset |= met == Some(ErrorKind::ConnectionReset);
    drop(ops);
    shared.ops_changed.notify_all();
}

/// How the connection was lost, `own` being what `side` met, once the
/// other side's account is in: a reset either met, else `own`. The reader
/// waits for a write in progress to end; the writer waits for the reader's
/// next read to end, which meets a reset the writer only saw a symptom of,
/// or for the reader to stop. Each side has ended its own operation first,
/// so neither waits for the other's wait. The waits are bounded by the
/// socket operations themselves: a write by its send deadline, a read by
/// the reader's poll.
fn settle_loss(shared: &Shared, side: Side, own: LinkLoss) -> LinkLoss {
    let mut ops = lock(&shared.ops);
    let target = ops.reads + 1;
    loop {
        let waiting = match side {
            Side::Reader => ops.writer_busy,
            Side::Writer => ops.reading && ops.reads < target,
        };
        if ops.reset || !waiting {
            break;
        }
        ops = shared
            .ops_changed
            .wait(ops)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
    if ops.reset {
        LinkLoss::SocketError(ErrorKind::ConnectionReset)
    } else {
        own
    }
}

/// Records how a socket failure `side` met lost the connection
/// (`settle_loss`).
fn note_socket_loss(shared: &Shared, side: Side, own: LinkLoss) {
    let loss = settle_loss(shared, side, own);
    note_loss(shared, loss);
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
            finish(&mut sock, mark_ended(&shared, cause));
            return;
        }
        let job = {
            let mut state = shared.lock();
            let job = state.jobs.pop_front();
            state.active |= job.is_some();
            state.job = job.is_some();
            job
        };
        if let Some(job) = job {
            let (deliveries, fatal) = run_job(&mut sock, &inbox, &shared, &options, job);
            let ended = fatal.map(|cause| mark_ended(&shared, cause));
            {
                let mut state = shared.lock();
                state.active = false;
                state.job = false;
                drop(state);
                shared.settled.notify_all();
            }
            for (done, outcome) in deliveries {
                deliver_lifecycle(done, outcome);
            }
            if let Some(ended) = ended {
                finish(&mut sock, ended);
                return;
            }
            continue;
        }
        let next = {
            let mut state = shared.lock();
            if state.closing && state.waiting.is_empty() {
                drop(state);
                tear_down(&mut sock, &inbox, &shared, &options);
                return;
            }
            state.waiting.pop_front().map(|item| {
                state.waiting_bytes -= item.frame.len();
                state.active = true;
                state.next_result += 1;
                let id = state.next_result;
                state.result = Some(HeldResult { id, adopted: false });
                (item, id)
            })
        };
        let fatal = match next {
            Some((item, id)) => {
                let (outcome, fatal) = execute(&mut sock, &inbox, &shared, &options, &item);
                // Only a request that may have reached the unit holds the
                // slot for its adoption; an end releases it.
                let holds = fatal.is_none() && !is_unsent(&outcome);
                {
                    let mut state = shared.lock();
                    state.active = false;
                    if !holds {
                        state.result = None;
                    }
                }
                shared.settled.notify_all();
                // The end is recorded, and the waiting requests taken with it,
                // before the outcome is delivered: whoever receives it sees
                // the ended state, and nothing it does can change how the
                // waiting requests end.
                let waiting = fatal.map(|cause| mark_ended(&shared, cause));
                let adoption = if holds {
                    ResultAdoption {
                        shared: Arc::downgrade(&shared),
                        id,
                    }
                } else {
                    ResultAdoption::none()
                };
                if !deliver(item.done, outcome, adoption) && holds {
                    // A callback that failed took its adoption with it; the
                    // result is consumed, as the other completions are not
                    // held up by a failed callback.
                    if let Some(held) = shared.lock().result.as_mut() {
                        held.adopted = true;
                    }
                }
                if let Some(ended) = waiting {
                    finish(&mut sock, ended);
                    return;
                }
                if holds {
                    // Nothing starts on the wire until the result is
                    // adopted; an end or a close does not wait for it.
                    hold(
                        &shared,
                        options.send_deadline,
                        |state| state.result.as_ref().is_none_or(|held| held.adopted),
                        |_| false,
                    );
                    shared.lock().result = None;
                }
                None
            }
            None => match inbox.recv() {
                Ok(Event::Wake) => None,
                Ok(Event::Frame(received)) => lost_notification(&received.message).then(|| {
                    note_loss(&shared, LinkLoss::UnitLost);
                    RequestCause::ConnectionLost
                }),
                Ok(Event::ReadFailed(cause) | Event::QueueingStopped(cause)) => Some(cause),
                Err(_) => return,
            },
        };
        if let Some(cause) = fatal {
            finish(&mut sock, mark_ended(&shared, cause));
            return;
        }
    }
}

/// Records `cause` as the end of the connection unless one is recorded, and
/// returns the recorded end.
fn record_end(shared: &Shared, cause: RequestCause) -> RequestCause {
    let mut link_end = shared.link_end();
    let cause = *link_end.get_or_insert(cause);
    note_end(shared, &mut shared.lock(), cause);
    drop(link_end);
    shared.advance.notify_all();
    cause
}

/// Mirrors the recorded end into the state, once, with the notification
/// records acknowledged at that moment.
fn note_end(shared: &Shared, state: &mut State, cause: RequestCause) {
    if state.ended.is_none() {
        state.ended = Some(cause);
        // The queue lock is taken under the state lock, never the reverse.
        state.ended_adopted = shared
            .notifications
            .as_ref()
            .map_or(0, |queue| lock(queue).adopted());
    }
}

/// Records `cause` as the end of the connection and takes the waiting
/// requests in the same step, so that no later cancellation or close changes
/// how they end.
fn mark_ended(shared: &Shared, cause: RequestCause) -> Ended {
    // The first recorded end is the connection's cause: a later failure the
    // worker meets (or reports) does not replace it.
    let mut link_end = shared.link_end();
    let cause = *link_end.get_or_insert(cause);
    let mut state = shared.lock();
    note_end(shared, &mut state, cause);
    state.terminal.get_or_insert(cause);
    let taken = take_pending(&mut state);
    drop(state);
    drop(link_end);
    shared.advance.notify_all();
    // A close waiting for the teardown stops waiting: there is none.
    shared.settled.notify_all();
    // No hold follows the end: the expiry threads end once nothing is
    // queued, without waiting for the completions the end still runs.
    shared.expiry.stop();
    Ended { taken, cause }
}

/// What an end took, and the connection's cause it completes them with.
struct Ended {
    taken: Taken,
    cause: RequestCause,
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
    /// Completes everything taken without sending anything, here.
    fn complete(self, cause: RequestCause) {
        for completion in self.completions(cause) {
            completion();
        }
    }

    /// One completion per callback taken: requests unsent with `cause`,
    /// lifecycle calls as not connected.
    fn completions(self, cause: RequestCause) -> Vec<Completion> {
        let mut completions: Vec<Completion> = Vec::new();
        for item in self.waiting {
            // Its gate goes with it and is let go here, outside the locks it was taken under.
            let Item { gate, done, .. } = item;
            completions.push(Box::new(move || {
                drop(gate);
                deliver(
                    done,
                    Outcome::failed(cause, RequestPhase::Admission, Evidence::NotSent),
                    ResultAdoption::none(),
                );
            }));
        }
        for job in self.jobs {
            if let Job::Activate { done, .. } = job {
                completions.push(Box::new(move || {
                    deliver_lifecycle(done, Err(not_connected(Phase::Subscription)));
                }));
            }
        }
        for release in self.releases {
            for done in release.waiting {
                completions.push(Box::new(move || {
                    deliver_lifecycle(done, Err(not_connected(Phase::Subscription)));
                }));
            }
        }
        completions
    }
}

/// Closes the socket and completes what the end took with its cause.
fn finish(sock: &mut TcpStream, ended: Ended) {
    let _ = sock.shutdown(Shutdown::Both);
    ended.taken.complete(ended.cause);
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
        teardown: None,
    };
    match job {
        Job::Activate {
            token,
            cancelled,
            done,
        } => {
            let activation = io.activate(token, &cancelled);
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
    /// The close's teardown end, for the unregistrations it runs: they are
    /// sent although the close is marked, and neither their send nor their
    /// response wait outlasts it (N2).
    teardown: Option<Instant>,
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
        /// Where the request stopped (K34).
        phase: RequestPhase,
        /// The end of the connection it comes with, if any: its own cause,
        /// or an end recorded meanwhile that leaves its verdict as it is.
        ends: Option<RequestCause>,
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
        self.post_with(request, stop, false)
    }

    /// An unregistration of owned cleanup: once started, the cleanup goes on
    /// although a close is marked; the close waits for its job (K10, K37).
    fn post_cleanup(&mut self, request: wire::Request) -> Posted {
        self.post_with(request, &|_| false, true)
    }

    fn post_with(
        &mut self,
        request: wire::Request,
        stop: &dyn Fn(&State) -> bool,
        cleanup: bool,
    ) -> Posted {
        let refused = |verdict, cause, phase, ends| Posted::Refused {
            verdict,
            cause,
            phase,
            ends,
        };
        let Ok(frame) = frame::encode(&request.message()) else {
            return refused(
                Verdict::Rejected,
                RequestCause::InternalError,
                RequestPhase::Admission,
                None,
            );
        };
        let key = request.reply_key();
        let cap = self.teardown;
        let send_end = Instant::now() + self.options.send_deadline;
        let send_end = cap.map_or(send_end, |cap| send_end.min(cap));
        let unstarted = |state: &State| {
            if state.closing && cap.is_none() && !cleanup {
                Some(Stop::Closing)
            } else if stop(state) {
                Some(Stop::Cancelled)
            } else {
                None
            }
        };
        let sent = match request {
            wire::Request::RegisterParameter(_) | wire::Request::RegisterMeter(_) => {
                Some(&self.shared.sent_registrations)
            }
            wire::Request::UnregisterParameter(_) | wire::Request::UnregisterMeter(_) => {
                Some(&self.shared.sent_unregistrations)
            }
            _ => None,
        };
        let outbound = Outbound {
            frame: &frame,
            key: &key,
            send_end,
            cap,
            unstarted: &unstarted,
            sent,
        };
        match exchange(self.sock, self.inbox, self.shared, self.options, outbound) {
            Ok(held) => {
                let ending = match await_cutoff(self.shared, self.options, &held) {
                    Held::Ready | Held::Closing => None,
                    Held::Ended(cause) => Some(cause),
                };
                let reply = held
                    .inbound
                    .reply(&key)
                    .expect("exchange returns the matching reply");
                let posted = match reply.post_verdict() {
                    PostVerdict::Accepted => Posted::Accepted,
                    PostVerdict::Rejected(_) => refused(
                        Verdict::Rejected,
                        RequestCause::DeviceRejected,
                        RequestPhase::Response,
                        None,
                    ),
                    PostVerdict::Malformed => refused(
                        Verdict::Unknown,
                        RequestCause::InvalidResponse,
                        RequestPhase::Response,
                        None,
                    ),
                };
                // An end before the verdict is consumed ends the connection;
                // an acceptance then fails with it at delivery, and a refusal
                // keeps its own cause (K34).
                match (posted, ending) {
                    (posted, None) => posted,
                    (Posted::Accepted, Some(end)) => {
                        refused(Verdict::Accepted, end, RequestPhase::Delivery, Some(end))
                    }
                    (
                        Posted::Refused {
                            verdict,
                            cause,
                            phase,
                            ..
                        },
                        Some(end),
                    ) => refused(verdict, cause, phase, Some(end)),
                    (Posted::Stopped, Some(_)) => Posted::Stopped,
                }
            }
            Err(failed) => match failed.failure {
                RequestFailure::Cancelled { .. } => Posted::Stopped,
                RequestFailure::Cause { code, phase } => {
                    // A send budget cut short by the teardown's end expires
                    // as the teardown (N2, K34).
                    let code = match (code, cap) {
                        (RequestCause::SendTimeout, Some(cap)) if Instant::now() >= cap => {
                            RequestCause::TeardownTimeout
                        }
                        (code, _) => code,
                    };
                    let verdict = if failed.evidence == Evidence::NotSent {
                        Verdict::Rejected
                    } else {
                        Verdict::Unknown
                    };
                    refused(verdict, code, phase, failed.ends)
                }
            },
        }
    }

    fn activate(&mut self, token: TokenId, cancelled: &AtomicBool) -> Activation {
        let stopped = |state: &State| {
            cancelled.load(Ordering::SeqCst) || state.releases.iter().any(|r| r.token == token)
        };
        let done = |outcome, ends, released| Activation {
            outcome,
            ends,
            released,
        };
        let started = {
            let state = self.shared.lock();
            let active = state.ledger.is_active(token);
            (active, stopped(&state))
        };
        if let (true, stop) = started {
            // Already active: this call acquires nothing, so a cancellation
            // of it leaves the established subscription as it is.
            let outcome = if stop {
                Err(LifecycleFailure {
                    failure: Failure::Cancelled {
                        phase: Phase::Subscription,
                    },
                    cleanup: Cleanup::COMPLETE,
                })
            } else {
                Ok(())
            };
            return done(outcome, None, false);
        }
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
                    phase,
                    ends,
                } => {
                    self.shared.lock().ledger.registered(address, verdict);
                    let failed =
                        Failure::of_request(lifecycle_cause(cause), Phase::Subscription, phase);
                    failure = Some((failed, ends));
                    break;
                }
            }
        }
        let (failure, ends) = match failure {
            Some(failure) => failure,
            None => {
                // The stop check and the activation happen under one lock: a
                // cancellation or release accepted first is cleaned up.
                let mut state = self.shared.lock();
                if stopped(&state) {
                    let cancelled = Failure::Cancelled {
                        phase: Phase::Subscription,
                    };
                    (cancelled, None)
                } else {
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
                }
            }
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

    /// Unregisters every address the connection may still have registered,
    /// once each, within the teardown budget (K8, N2). The first failure
    /// stops the rest.
    fn unregister_remaining(&mut self) -> Option<Failure> {
        let addresses = self.shared.lock().ledger.remaining_registrations();
        for address in addresses {
            let posted = self.post_cleanup(unregister(address));
            let (verdict, cause) = match posted {
                Posted::Accepted => (Verdict::Accepted, None),
                Posted::Refused {
                    verdict,
                    cause,
                    ends,
                    ..
                } => {
                    // A failure that ends the link is the connection's end,
                    // recorded before the close reports it, as a request's is
                    // before its outcome.
                    if let Some(end) = ends {
                        record_end(self.shared, end);
                    }
                    (verdict, Some(cause))
                }
                Posted::Stopped => (Verdict::Rejected, Some(RequestCause::NotConnected)),
            };
            self.shared.lock().ledger.unregistered(address, verdict);
            if let Some(cause) = cause {
                return Some(Failure::cause(lifecycle_cause(cause), Phase::Teardown));
            }
        }
        None
    }

    /// Ends `token`'s ownership and unregisters what it was the last holder
    /// of, once each. A failure stops the rest and ends the connection (K10).
    fn unregister_owned(&mut self, token: TokenId) -> (Cleanup, Option<RequestCause>) {
        let addresses = self.shared.lock().ledger.begin_release(token);
        for address in addresses {
            let posted = self.post_cleanup(unregister(address));
            let (verdict, cause, ends) = match posted {
                Posted::Accepted => (Verdict::Accepted, None, None),
                Posted::Refused {
                    verdict,
                    cause,
                    phase,
                    ends,
                } => (verdict, Some((cause, phase)), ends),
                Posted::Stopped => (
                    Verdict::Rejected,
                    Some((RequestCause::NotConnected, RequestPhase::Admission)),
                    None,
                ),
            };
            self.shared.lock().ledger.unregistered(address, verdict);
            if let Some((cause, phase)) = cause {
                let mut state = self.shared.lock();
                state.ledger.finish(token);
                if state.closing {
                    let teardown = Failure::cause(lifecycle_cause(cause), Phase::Teardown);
                    state.close_cleanup_failure.get_or_insert(teardown);
                }
                drop(state);
                let failure =
                    Failure::of_request(lifecycle_cause(cause), Phase::Subscription, phase);
                let cleanup = Cleanup {
                    state: CleanupState::ConnectionClosed,
                    failure: Some(failure),
                };
                return (cleanup, Some(ends.unwrap_or(cause)));
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
        cancelled,
        request,
        frame,
        key,
        submitted,
        gate,
        ..
    } = item;
    // Read under the state lock, as `cancel` sets it.
    let stopped = {
        let _state = shared.lock();
        cancelled.load(Ordering::SeqCst)
    };
    if stopped {
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
        } else if cancelled.load(Ordering::SeqCst) {
            Some(Stop::Cancelled)
        } else if gate
            .as_ref()
            .is_some_and(|gate| !panic::catch_unwind(AssertUnwindSafe(gate)).unwrap_or(false))
        {
            Some(Stop::Held)
        } else {
            None
        }
    };
    let sent = match request {
        Request::GetNumeric(_) | Request::GetText(_) | Request::GetName(_) => &shared.sent_gets,
        Request::SetNumeric(..) | Request::SetText(..) => &shared.sent_sets,
    };
    let outbound = Outbound {
        frame,
        key,
        send_end,
        cap: None,
        unstarted: &unstarted,
        sent: Some(sent),
    };
    match exchange(sock, inbox, shared, options, outbound) {
        Ok(reply) => {
            let outcome = decode(
                request,
                reply
                    .inbound
                    .reply(key)
                    .expect("exchange returns the matching reply"),
            );
            match await_cutoff(shared, options, &reply) {
                Held::Ready | Held::Closing => (outcome, None),
                Held::Ended(cause) => (at_delivery(outcome, cause), Some(cause)),
            }
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

/// The matching reply of one exchange.
struct Answer {
    inbound: Inbound,
    /// Notification records queued before it was received (K12).
    cutoff: u64,
    /// An end that came while it was awaited.
    ending: Option<RequestCause>,
}

/// What a held result stopped waiting for.
enum Held {
    Ready,
    Ended(RequestCause),
    Closing,
}

/// Waits until `ready`, or until the connection ends or closes: fatal
/// stopping and a close never wait for the application (K6, K12).
fn hold(
    shared: &Shared,
    send_deadline: Duration,
    ready: impl Fn(&State) -> bool,
    ready_before_end: impl Fn(&State) -> bool,
) -> Held {
    let mut state = shared.lock();
    loop {
        // Once an end is recorded, only what was ready before it counts:
        // what the application adopts afterwards does not turn the result
        // into a normal one.
        if let Some(cause) = state.ended {
            return if ready_before_end(&state) {
                Held::Ready
            } else {
                Held::Ended(cause)
            };
        }
        if ready(&state) {
            return Held::Ready;
        }
        if state.closing {
            return Held::Closing;
        }
        // Waiting requests whose send budget runs out meanwhile complete
        // unsent, releasing their queue capacity (K5, K6).
        let now = Instant::now();
        let (expired, waiting): (VecDeque<Item>, VecDeque<Item>) =
            std::mem::take(&mut state.waiting)
                .into_iter()
                .partition(|item| item.submitted + send_deadline <= now);
        state.waiting = waiting;
        if !expired.is_empty() {
            state.waiting_bytes = state.waiting.iter().map(|item| item.frame.len()).sum();
            // Queued under the state lock, so a close marked after this
            // finds them queued before it stops the threads. Each has its
            // thread held since its admission.
            shared.expiry.queue(expired);
            continue;
        }
        let next = state
            .waiting
            .iter()
            .map(|item| item.submitted + send_deadline)
            .min();
        state = match next {
            Some(at) => {
                shared
                    .advance
                    .wait_timeout(state, at.saturating_duration_since(now))
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0
            }
            None => shared
                .advance
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        };
    }
}

/// Holds a reply until every notification record received before it is
/// adopted (K12), or the connection ends or closes.
fn await_cutoff(shared: &Shared, options: &ConnectionOptions, reply: &Answer) -> Held {
    if let Some(cause) = reply.ending {
        return Held::Ended(cause);
    }
    // Its exchange is settled: a close need not wait for this hold (it
    // stops it), and a callback run meanwhile may close. A write after it
    // cannot start once the close is marked, so the request is active again
    // only for what follows.
    shared.lock().active = false;
    shared.settled.notify_all();
    // The queue lock is taken under the state lock, never the reverse.
    let held = hold(
        shared,
        options.send_deadline,
        |_| {
            shared
                .notifications
                .as_ref()
                .is_none_or(|queue| lock(queue).has_adopted(reply.cutoff))
        },
        |state| state.ended_adopted >= reply.cutoff,
    );
    shared.lock().active = true;
    held
}

/// An established result whose normal delivery cannot complete because the
/// connection ended: a failure at delivery keeping its evidence (K34). A
/// rejection or a failure stays as it is.
fn at_delivery(outcome: Outcome, cause: RequestCause) -> Outcome {
    match outcome {
        Outcome::Success { evidence, .. } => {
            Outcome::failed(cause, RequestPhase::Delivery, evidence)
        }
        failure => failure,
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
    /// A teardown budget's end, which also bounds the response wait.
    cap: Option<Instant>,
    /// Whether a frame not yet started must not start.
    unstarted: &'a dyn Fn(&State) -> Option<Stop>,
    /// The count a frame written whole adds one to, if any.
    sent: Option<&'a AtomicU64>,
}

fn exchange(
    sock: &mut TcpStream,
    inbox: &Receiver<Event>,
    shared: &Shared,
    options: &ConnectionOptions,
    outbound: Outbound<'_>,
) -> Result<Answer, Failed> {
    let Outbound {
        frame,
        key,
        send_end,
        cap,
        unstarted,
        sent,
    } = outbound;
    if Instant::now() >= send_end {
        return Err(Failed::new(
            RequestCause::SendTimeout,
            RequestPhase::Admission,
            Evidence::NotSent,
            false,
        ));
    }
    match write_frame(sock, shared, frame, send_end, unstarted, sent) {
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
        Err(WriteError::Stopped(Stop::Held)) => {
            return Err(Failed::new(
                RequestCause::PreconditionFailed,
                RequestPhase::Admission,
                Evidence::NotSent,
                false,
            ))
        }
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
    #[cfg(test)]
    if let Some(gate) = lock(&shared.response_gate).take() {
        let _ = gate.recv();
    }
    let response_end = Instant::now() + options.response_deadline;
    let (response_end, timeout) = match cap {
        Some(cap) if cap < response_end => (cap, RequestCause::TeardownTimeout),
        _ => (response_end, RequestCause::ResponseTimeout),
    };
    // A response-phase failure ends the connection: the cause is recorded
    // as its end when chosen, unless an earlier end was recorded, which is
    // reported instead.
    let unconfirmed = |cause: RequestCause| {
        Err(Failed::new(
            record_end(shared, cause),
            RequestPhase::Response,
            Evidence::Unconfirmed,
            true,
        ))
    };
    // A stop of the queueing (an overflow, or a failed receipt observer) ends
    // the connection but not this request: its reply is still awaited within
    // its deadline and kept as evidence.
    let mut ending = None;
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
                    note_loss(shared, LinkLoss::UnitLost);
                    return unconfirmed(RequestCause::ConnectionLost);
                }
                let inbound = Inbound::new(received.message);
                if inbound.reply(key).is_some() {
                    return Ok(Answer {
                        inbound,
                        cutoff: received.cutoff,
                        ending,
                    });
                }
            }
            Ok(Event::Wake) => {}
            Ok(Event::QueueingStopped(cause)) => {
                ending.get_or_insert(cause);
            }
            Ok(Event::ReadFailed(cause)) => return unconfirmed(cause),
            Err(RecvTimeoutError::Timeout) => return unconfirmed(ending.unwrap_or(timeout)),
            Err(RecvTimeoutError::Disconnected) => return unconfirmed(RequestCause::InternalError),
        }
    }
}

/// The two socket calls a write makes, so tests can stand in for the socket.
trait Outgoing {
    fn set_write_timeout(&self, timeout: Option<Duration>) -> std::io::Result<()>;
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize>;
    /// The error the socket holds pending, taken.
    fn pending_error(&self) -> Option<ErrorKind>;
}

impl Outgoing for TcpStream {
    fn set_write_timeout(&self, timeout: Option<Duration>) -> std::io::Result<()> {
        TcpStream::set_write_timeout(self, timeout)
    }

    fn pending_error(&self) -> Option<ErrorKind> {
        self.take_error().ok().flatten().map(|error| error.kind())
    }

    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        Write::write(self, bytes)
    }
}

/// Writes `frame` by `end`, starting no write once the reader has recorded
/// the link's end. On failure, the cause and how many bytes went out. A
/// frame written whole adds one to `sent`, if given, under the end gate its
/// last write held; one cut short or never started adds nothing.
fn write_frame<O: Outgoing>(
    sock: &mut O,
    shared: &Shared,
    frame: &[u8],
    end: Instant,
    unstarted: &dyn Fn(&State) -> Option<Stop>,
    sent: Option<&AtomicU64>,
) -> Result<(), WriteError> {
    debug_assert!(frame.len() <= MAX_FRAME_BYTES + 1);
    let mut written = 0;
    while written < frame.len() {
        let failed = |cause| Err(WriteError::Failed { cause, written });
        let remaining = end.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return failed(RequestCause::SendTimeout);
        }
        begin_op(shared, Side::Writer);
        // A refused timeout's symptom gives way to the reset the socket
        // holds, reported with the operation's end, so the reader settles
        // with it.
        let set = sock
            .set_write_timeout(Some(remaining.min(WRITE_POLL)))
            .map_err(|error| sock.pending_error().unwrap_or(error.kind()));
        end_op(shared, Side::Writer, set.err());
        if let Err(kind) = set {
            note_socket_loss(shared, Side::Writer, LinkLoss::SocketError(kind));
            return failed(RequestCause::ConnectionLost);
        }
        // Held across the write: the reader cannot record an end, and a
        // close, a cancellation or a release cannot be accepted, between
        // this check and the start of the write.
        let link_end = shared.link_end();
        if let Some(cause) = *link_end {
            return failed(cause);
        }
        // Checked again under the gate: waiting for it may have used up the
        // budget.
        if Instant::now() >= end {
            return failed(RequestCause::SendTimeout);
        }
        if written == 0 {
            let state = shared.lock();
            if let Some(stop) = unstarted(&state) {
                return Err(WriteError::Stopped(stop));
            }
            drop(state);
            #[cfg(test)]
            {
                // Taken first, so the wait does not hold the slot's lock.
                let gate = lock(&shared.first_byte_gate).take();
                if let Some(gate) = gate {
                    let _ = gate.recv();
                }
            }
            // And after the state lock, the last wait before the write.
            if Instant::now() >= end {
                return failed(RequestCause::SendTimeout);
            }
        }
        begin_op(shared, Side::Writer);
        let outcome = sock.write(&frame[written..]);
        // A failed write's symptom gives way to the reset the socket holds,
        // likewise; a write that only timed out met nothing.
        let met = match &outcome {
            Ok(0) => sock.pending_error(),
            Err(e) if !transient(e.kind()) => Some(sock.pending_error().unwrap_or(e.kind())),
            _ => None,
        };
        end_op(shared, Side::Writer, met);
        // Counted before the gate is let go: `sent_frames` reads under it, so
        // a frame the peer has whole is never missing from a count read after.
        if let (Some(sent), Ok(n)) = (sent, &outcome) {
            if *n > 0 && written + n == frame.len() {
                sent.fetch_add(1, Ordering::SeqCst);
            }
        }
        drop(link_end);
        match outcome {
            Ok(0) => {
                let own = met.map_or(LinkLoss::PeerClosed, LinkLoss::SocketError);
                note_socket_loss(shared, Side::Writer, own);
                return failed(RequestCause::ConnectionLost);
            }
            Ok(n) => written += n,
            Err(e) if transient(e.kind()) => {}
            Err(e) => {
                let kind = met.unwrap_or(e.kind());
                note_socket_loss(shared, Side::Writer, LinkLoss::SocketError(kind));
                return failed(RequestCause::ConnectionLost);
            }
        }
    }
    Ok(())
}

/// Whether a write's error leaves the socket as it was: it only ran out of
/// its poll or was interrupted.
fn transient(kind: ErrorKind) -> bool {
    matches!(
        kind,
        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
    )
}

/// Why a frame whose first byte had not gone out was not started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    /// The connection began closing.
    Closing,
    /// Its operation was cancelled, or its token's release was asked for.
    Cancelled,
    /// Its send gate refused it (`Connection::submit_gated`).
    Held,
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
