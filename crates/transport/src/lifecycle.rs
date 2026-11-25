//! Failure records and cancellation for discovery and connection lifecycle
//! calls (K37).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The E2 causes a lifecycle call can report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cause {
    /// A connection to Device Center or a device endpoint could not be opened.
    ConnectionFailed,
    /// An open connection closed or failed.
    ConnectionLost,
    /// The whole-discovery budget expired.
    DiscoveryTimeout,
    /// One request could not be written within its send deadline.
    SendTimeout,
    /// One response did not arrive within its response deadline.
    ResponseTimeout,
    /// A response was malformed, undecodable or larger than a frame may be.
    InvalidResponse,
    /// Identity was missing or ambiguous after otherwise successful queries.
    IdentityError,
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
    Cause { code: Cause, phase: Phase },
    Cancelled { phase: Phase },
}

impl Failure {
    pub(crate) fn cause(code: Cause, phase: Phase) -> Self {
        Failure::Cause { code, phase }
    }
}

/// A caller-owned cancellation signal, created before the call it controls and
/// shared with it. Cancelling is idempotent.
#[derive(Debug, Clone, Default)]
pub struct Control {
    cancelled: Arc<AtomicBool>,
}

impl Control {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}
