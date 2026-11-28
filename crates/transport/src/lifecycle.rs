//! Failure records and cancellation for discovery and connection lifecycle
//! calls (K37).

use std::sync::{Arc, OnceLock};
use std::time::Instant;

use crate::request::RequestPhase;

/// The E2 causes a lifecycle call can report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cause {
    /// A connection to Device Center or a device endpoint could not be opened.
    ConnectionFailed,
    /// An open connection closed or failed.
    ConnectionLost,
    /// The whole-discovery budget expired.
    DiscoveryTimeout,
    /// The operational-connection budget expired.
    ConnectTimeout,
    /// The requested unit is not online, or another unit answers in its place.
    DeviceNotFound,
    /// One request could not be written within its send deadline.
    SendTimeout,
    /// One response did not arrive within its response deadline.
    ResponseTimeout,
    /// A response was malformed, undecodable or larger than a frame may be.
    InvalidResponse,
    /// Closing did not finish within its teardown budget.
    TeardownTimeout,
    /// Identity was missing or ambiguous after otherwise successful queries.
    IdentityError,
    /// Device Center explicitly refused a registration or unregistration.
    DeviceRejected,
    /// The connection is closing or has ended.
    NotConnected,
    /// A local limit refused the call before anything was sent.
    PreconditionFailed,
    /// A notification did not fit the delivery budget (K6).
    NotificationOverflow,
    /// An unexpected internal failure.
    InternalError,
}

/// Where a lifecycle call stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Discovery,
    Connect,
    Identity,
    Admission,
    Subscription,
    Teardown,
}

/// A lifecycle call's failure: its first cause, or cancellation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Cause {
        code: Cause,
        phase: Phase,
        /// The phase of the request whose failure this is, where the
        /// transport records one: a subscription call's registration, or an
        /// unregistration of its cleanup or of a release (K34). None for any
        /// other cause, a close's among them.
        request: Option<RequestPhase>,
    },
    Cancelled {
        phase: Phase,
    },
}

impl Failure {
    pub(crate) fn cause(code: Cause, phase: Phase) -> Self {
        Failure::Cause {
            code,
            phase,
            request: None,
        }
    }

    /// The failure of a request this call sent, at `request`.
    pub(crate) fn of_request(code: Cause, phase: Phase, request: RequestPhase) -> Self {
        Failure::Cause {
            code,
            phase,
            request: Some(request),
        }
    }
}

/// A caller-owned cancellation signal, created before the call it controls and
/// shared with it. It keeps the time of the first cancellation, so a deadline
/// that expired before it is still reported as the cause; later cancellations
/// change nothing.
#[derive(Debug, Clone, Default)]
pub struct Control {
    cancelled_at: Arc<OnceLock<Instant>>,
}

impl Control {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        let _ = self.cancelled_at.set(Instant::now());
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled_at.get().is_some()
    }

    /// When the first cancellation happened.
    pub fn cancelled_at(&self) -> Option<Instant> {
        self.cancelled_at.get().copied()
    }
}

/// How far cleanup got after a lifecycle call failed (K37).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupState {
    /// Everything the call owned was released, or it owned nothing.
    Complete,
    /// The connection was ended, which releases everything it owned.
    ConnectionClosed,
    /// Neither is established.
    Incomplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cleanup {
    pub state: CleanupState,
    /// The first cleanup failure, if cleanup failed.
    pub failure: Option<Failure>,
}

impl Cleanup {
    pub const COMPLETE: Cleanup = Cleanup {
        state: CleanupState::Complete,
        failure: None,
    };
}

/// A failed lifecycle call: its first cause and how far cleanup got.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LifecycleFailure {
    pub failure: Failure,
    pub cleanup: Cleanup,
}

pub type LifecycleOutcome = Result<(), LifecycleFailure>;
