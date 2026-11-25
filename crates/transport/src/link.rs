//! A blocking request/response exchange over one loopback TCP connection,
//! bounded by an enclosing budget and per-request deadlines and stopped by a
//! [`Control`].

use crate::frame::{self, FrameReader, ReadError};
use crate::lifecycle::{Cause, Control, Failure, Phase};
use serde_json::Value;
use std::io::{ErrorKind, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

/// Longest a blocking socket call runs before cancellation is checked again.
const POLL: Duration = Duration::from_millis(50);

/// The end of an enclosing budget, and the cause reported when it is reached.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Budget {
    pub end: Instant,
    pub expired: Cause,
}

impl Budget {
    pub fn starting_now(length: Duration, expired: Cause) -> Self {
        Budget {
            end: Instant::now() + length,
            expired,
        }
    }

    /// The earlier of this budget's end and `deadline` from now, with the
    /// cause to report when that end is reached.
    fn bound(&self, deadline: Duration, own: Cause) -> (Instant, Cause) {
        let individual = Instant::now() + deadline;
        if self.end <= individual {
            (self.end, self.expired)
        } else {
            (individual, own)
        }
    }
}

pub(crate) struct Link<'a> {
    sock: TcpStream,
    reader: FrameReader,
    phase: Phase,
    control: &'a Control,
}

impl<'a> Link<'a> {
    /// Connects to `port` on the loopback interface within `budget`.
    pub fn connect(
        port: u16,
        budget: &Budget,
        phase: Phase,
        control: &'a Control,
    ) -> Result<Self, Failure> {
        if control.is_cancelled() {
            return Err(Failure::Cancelled { phase });
        }
        let remaining = budget.end.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(Failure::cause(budget.expired, phase));
        }
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let sock = TcpStream::connect_timeout(&addr, remaining).map_err(|e| {
            let code = if e.kind() == ErrorKind::TimedOut && Instant::now() >= budget.end {
                budget.expired
            } else {
                Cause::ConnectionFailed
            };
            Failure::cause(code, phase)
        })?;
        sock.set_nodelay(true)
            .map_err(|_| Failure::cause(Cause::ConnectionFailed, phase))?;
        Ok(Link {
            sock,
            reader: FrameReader::new(),
            phase,
            control,
        })
    }

    fn cancelled(&self) -> Result<(), Failure> {
        if self.control.is_cancelled() {
            Err(Failure::Cancelled { phase: self.phase })
        } else {
            Ok(())
        }
    }

    /// Writes `message` as one frame within `deadline` and the budget.
    pub fn send(
        &mut self,
        message: &Value,
        deadline: Duration,
        budget: &Budget,
    ) -> Result<(), Failure> {
        self.cancelled()?;
        let bytes =
            frame::encode(message).map_err(|_| Failure::cause(Cause::InternalError, self.phase))?;
        let (end, expired) = budget.bound(deadline, Cause::SendTimeout);
        let mut written = 0;
        while written < bytes.len() {
            self.cancelled()?;
            let remaining = end.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Failure::cause(expired, self.phase));
            }
            self.sock
                .set_write_timeout(Some(remaining.min(POLL)))
                .map_err(|_| Failure::cause(Cause::ConnectionLost, self.phase))?;
            match self.sock.write(&bytes[written..]) {
                Ok(0) => return Err(Failure::cause(Cause::ConnectionLost, self.phase)),
                Ok(n) => written += n,
                Err(e)
                    if matches!(
                        e.kind(),
                        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                    ) => {}
                Err(_) => return Err(Failure::cause(Cause::ConnectionLost, self.phase)),
            }
        }
        Ok(())
    }

    /// Reads frames until `answer` accepts one, within `deadline` from now and
    /// the budget. Frames `answer` declines, and lines that are not JSON, are
    /// skipped.
    pub fn await_frame<T>(
        &mut self,
        deadline: Duration,
        budget: &Budget,
        mut answer: impl FnMut(&Value) -> Option<T>,
    ) -> Result<T, Failure> {
        let (end, expired) = budget.bound(deadline, Cause::ResponseTimeout);
        loop {
            self.cancelled()?;
            let remaining = end.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Failure::cause(expired, self.phase));
            }
            self.sock
                .set_read_timeout(Some(remaining.min(POLL)))
                .map_err(|_| Failure::cause(Cause::ConnectionLost, self.phase))?;
            match self.reader.read_frame(&mut self.sock) {
                Ok(Some(frame)) => {
                    if let Some(found) = frame.json.as_ref().and_then(&mut answer) {
                        return Ok(found);
                    }
                }
                Ok(None) => {}
                Err(ReadError::Oversized { .. }) => {
                    return Err(Failure::cause(Cause::InvalidResponse, self.phase))
                }
                Err(ReadError::Closed | ReadError::Io(_)) => {
                    return Err(Failure::cause(Cause::ConnectionLost, self.phase))
                }
            }
        }
    }
}
