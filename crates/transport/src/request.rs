//! Single-request records (K34): the reads and writes an application submits
//! on a connection, and the outcome each one completes with.

use crate::wire::{NameValue, ParameterAddress};

/// One application-issued read or setting write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    GetNumeric(ParameterAddress),
    GetText(ParameterAddress),
    GetName(ParameterAddress),
    SetNumeric(ParameterAddress, i64),
    SetText(ParameterAddress, String),
}

impl Request {
    pub fn is_write(&self) -> bool {
        matches!(self, Request::SetNumeric(..) | Request::SetText(..))
    }
}

/// The E2 causes a single request can report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestCause {
    InvalidInput,
    PreconditionFailed,
    NotConnected,
    SendTimeout,
    ResponseTimeout,
    TeardownTimeout,
    DeviceRejected,
    InvalidResponse,
    ConnectionLost,
    NotificationOverflow,
    InternalError,
}

/// Where a request failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestPhase {
    Validation,
    Admission,
    Send,
    Response,
    Delivery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestFailure {
    Cause {
        code: RequestCause,
        phase: RequestPhase,
    },
    Cancelled {
        phase: RequestPhase,
    },
}

/// What is established about a request's transmission and answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Evidence {
    /// No byte of the request was sent.
    NotSent,
    /// Neither a valid read nor a definite POST verdict, and transmission is not
    /// ruled out.
    Unconfirmed,
    /// A matching reply with this integer response code other than 200.
    Rejected(i64),
    /// A matching read reply decoded in the request's raw type.
    Read,
    /// A matching POST reply with integer response code 200.
    Accepted,
}

/// A read's value in the request's raw type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadValue {
    Numeric(i64),
    Text(String),
    Name(NameValue),
}

/// How a request completed. A write's success has no value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Success {
        value: Option<ReadValue>,
        evidence: Evidence,
    },
    Failure {
        failure: RequestFailure,
        evidence: Evidence,
    },
}

impl Outcome {
    pub(crate) fn failed(code: RequestCause, phase: RequestPhase, evidence: Evidence) -> Self {
        Outcome::Failure {
            failure: RequestFailure::Cause { code, phase },
            evidence,
        }
    }
}
