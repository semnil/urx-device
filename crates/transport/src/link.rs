//! A blocking request/response exchange over one loopback TCP connection,
//! bounded by an enclosing budget and per-request deadlines and stopped by a
//! [`Control`].
//!
//! Every blocking step returns to the caller at least every [`POLL`], and the
//! stop conditions (cancellation, then the earliest expired bound) are checked
//! before each step and again before its outcome is used, so a condition that
//! holds first is reported even when a reply, a close or an oversized frame
//! arrives after it.

use crate::frame::{self, FrameReader, ReadError};
use crate::lifecycle::{Cause, Control, Failure, Phase};
use serde_json::Value;
use std::io::{ErrorKind, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

/// Longest a blocking socket call runs before the stop conditions are checked
/// again.
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
    fn bound(&self, deadline: Duration, own: Cause) -> Bound {
        let individual = Instant::now() + deadline;
        if self.end <= individual {
            Bound {
                end: self.end,
                expired: self.expired,
            }
        } else {
            Bound {
                end: individual,
                expired: own,
            }
        }
    }

    fn whole(&self) -> Bound {
        Bound {
            end: self.end,
            expired: self.expired,
        }
    }
}

/// The end one step must finish by, and the cause reported when it does not.
#[derive(Debug, Clone, Copy)]
struct Bound {
    end: Instant,
    expired: Cause,
}

/// Whichever of cancellation and expiry of `bound` happened first; otherwise
/// the time left in `bound`.
fn stop(control: &Control, bound: &Bound, phase: Phase) -> Result<Duration, Failure> {
    let now = Instant::now();
    if let Some(cancelled) = control.cancelled_at() {
        if cancelled < bound.end || now < bound.end {
            return Err(Failure::Cancelled { phase });
        }
    }
    let remaining = bound.end.saturating_duration_since(now);
    if remaining.is_zero() {
        return Err(Failure::cause(bound.expired, phase));
    }
    Ok(remaining)
}

pub(crate) struct Link<'a> {
    sock: TcpStream,
    reader: FrameReader,
    phase: Phase,
    control: &'a Control,
}

impl<'a> Link<'a> {
    /// Connects to `port` on the loopback interface within `budget`. The one
    /// connection attempt runs on its own thread so that cancellation and
    /// expiry are seen while it is pending; an attempt still pending when the
    /// call stops ends within the budget, and its socket is closed unused.
    pub fn connect(
        port: u16,
        budget: &Budget,
        phase: Phase,
        control: &'a Control,
    ) -> Result<Self, Failure> {
        let bound = budget.whole();
        let remaining = stop(control, &bound, phase)?;
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(TcpStream::connect_timeout(&addr, remaining));
        });
        let sock = loop {
            let remaining = stop(control, &bound, phase)?;
            match rx.recv_timeout(remaining.min(POLL)) {
                Ok(result) => {
                    stop(control, &bound, phase)?;
                    break result.map_err(|_| Failure::cause(Cause::ConnectionFailed, phase))?;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(Failure::cause(Cause::InternalError, phase))
                }
            }
        };
        sock.set_nodelay(true)
            .map_err(|_| Failure::cause(Cause::ConnectionFailed, phase))?;
        Ok(Link {
            sock,
            reader: FrameReader::new(),
            phase,
            control,
        })
    }

    /// Writes `message` as one frame within `deadline` and the budget.
    pub fn send(
        &mut self,
        message: &Value,
        deadline: Duration,
        budget: &Budget,
    ) -> Result<(), Failure> {
        let bound = budget.bound(deadline, Cause::SendTimeout);
        stop(self.control, &bound, self.phase)?;
        let bytes =
            frame::encode(message).map_err(|_| Failure::cause(Cause::InternalError, self.phase))?;
        let mut written = 0;
        while written < bytes.len() {
            let remaining = stop(self.control, &bound, self.phase)?;
            self.sock
                .set_write_timeout(Some(remaining.min(POLL)))
                .map_err(|_| Failure::cause(Cause::ConnectionLost, self.phase))?;
            let outcome = self.sock.write(&bytes[written..]);
            stop(self.control, &bound, self.phase)?;
            match outcome {
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

    /// Reads frames until `answer` decides one, within `deadline` from now and
    /// the budget. `answer` returns `None` to skip a frame, `Some(Ok)` to
    /// accept it and `Some(Err)` to fail; lines that are not JSON are skipped.
    pub fn await_frame<T>(
        &mut self,
        deadline: Duration,
        budget: &Budget,
        mut answer: impl FnMut(&Value) -> Option<Result<T, Failure>>,
    ) -> Result<T, Failure> {
        let bound = budget.bound(deadline, Cause::ResponseTimeout);
        loop {
            let remaining = stop(self.control, &bound, self.phase)?;
            self.sock
                .set_read_timeout(Some(remaining.min(POLL)))
                .map_err(|_| Failure::cause(Cause::ConnectionLost, self.phase))?;
            let outcome = self.reader.read_once(&mut self.sock);
            stop(self.control, &bound, self.phase)?;
            match outcome {
                Ok(Some(frame)) => {
                    if let Some(decided) = frame.json.as_ref().and_then(&mut answer) {
                        return decided;
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

#[cfg(test)]
mod tests {
    use super::{stop, Bound};
    use crate::lifecycle::{Cause, Control, Failure, Phase};
    use std::thread;
    use std::time::{Duration, Instant};

    fn bound(end: Instant) -> Bound {
        Bound {
            end,
            expired: Cause::ResponseTimeout,
        }
    }

    #[test]
    fn the_first_of_cancellation_and_expiry_is_the_cause() {
        let control = Control::new();
        control.cancel();
        let cancelled = control.cancelled_at().unwrap();
        thread::sleep(Duration::from_millis(20));

        assert_eq!(
            stop(
                &control,
                &bound(cancelled + Duration::from_millis(5)),
                Phase::Discovery
            ),
            Err(Failure::Cancelled {
                phase: Phase::Discovery
            }),
            "cancelled before the end that has since passed"
        );
        assert_eq!(
            stop(
                &control,
                &bound(cancelled - Duration::from_millis(5)),
                Phase::Discovery
            ),
            Err(Failure::Cause {
                code: Cause::ResponseTimeout,
                phase: Phase::Discovery
            }),
            "expired before the cancellation"
        );
        assert_eq!(
            stop(
                &control,
                &bound(Instant::now() + Duration::from_secs(5)),
                Phase::Discovery
            ),
            Err(Failure::Cancelled {
                phase: Phase::Discovery
            }),
            "cancelled with time left"
        );
    }

    #[test]
    fn a_later_cancellation_does_not_replace_the_first() {
        let control = Control::new();
        control.cancel();
        let first = control.cancelled_at().unwrap();
        thread::sleep(Duration::from_millis(10));
        control.cancel();
        assert_eq!(control.cancelled_at(), Some(first));
        assert_eq!(
            stop(
                &control,
                &bound(first - Duration::from_millis(1)),
                Phase::Connect
            ),
            Err(Failure::Cause {
                code: Cause::ResponseTimeout,
                phase: Phase::Connect
            })
        );
    }

    #[test]
    fn without_cancellation_or_expiry_the_time_left_is_returned() {
        let left = stop(
            &Control::new(),
            &bound(Instant::now() + Duration::from_secs(5)),
            Phase::Discovery,
        )
        .unwrap();
        assert!(left > Duration::from_secs(4));
    }
}
