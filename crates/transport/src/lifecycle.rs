//! Failure records and cancellation for discovery and connection lifecycle
//! calls (K37).

use std::sync::{Arc, OnceLock};
use std::time::Instant;

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
