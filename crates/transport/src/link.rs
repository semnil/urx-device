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
///
/// The clock is read before the cancellation time. A cancellation found then
/// is compared with the bound's end alone. A cancellation not yet made when
/// it is read happens after the clock reading, so when that reading is past
/// the end, any cancellation comes after the expiry.
fn stop(control: &Control, bound: &Bound, phase: Phase) -> Result<Duration, Failure> {
    let now = Instant::now();
    decide(control.cancelled_at(), now, bound, phase)
}

/// [`stop`]'s decision from the first cancellation time and a clock reading
/// taken before it was read. A tie between cancellation and the end is expiry.
fn decide(
    cancelled: Option<Instant>,
    now: Instant,
    bound: &Bound,
    phase: Phase,
) -> Result<Duration, Failure> {
    if let Some(cancelled) = cancelled {
        return Err(if cancelled < bound.end {
            Failure::Cancelled { phase }
        } else {
            Failure::cause(bound.expired, phase)
        });
    }
    let remaining = bound.end.saturating_duration_since(now);
    if remaining.is_zero() {
        return Err(Failure::cause(bound.expired, phase));
    }
    Ok(remaining)
}

/// One connection attempt that starts only if `control` is not cancelled and
/// `end` has not passed when it starts, bounded by the time then left.
fn attempt(
    addr: SocketAddr,
    end: Instant,
    control: &Control,
) -> Option<std::io::Result<TcpStream>> {
    if control.is_cancelled() {
        return None;
    }
    let remaining = end.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return None;
    }
    Some(TcpStream::connect_timeout(&addr, remaining))
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
    /// expiry are seen while it is pending. The thread starts the attempt only
    /// if the call has not stopped by then, with the budget left at that time;
    /// an attempt that completes after the call stopped is closed unused.
    pub fn connect(
        port: u16,
        budget: &Budget,
        phase: Phase,
        control: &'a Control,
    ) -> Result<Self, Failure> {
        let bound = budget.whole();
        stop(control, &bound, phase)?;
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let (tx, rx) = mpsc::channel();
        let attempt_control = control.clone();
        let end = bound.end;
        thread::spawn(move || {
            if let Some(result) = attempt(addr, end, &attempt_control) {
                let _ = tx.send(result);
            }
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
                    // The thread found the call stopped before starting.
                    stop(control, &bound, phase)?;
                    return Err(Failure::cause(Cause::InternalError, phase));
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

    /// The phase later failures on this link report.
    pub fn set_phase(&mut self, phase: Phase) {
        self.phase = phase;
    }

    /// The connected socket and the reader holding any bytes already received.
    pub fn into_parts(self) -> (TcpStream, FrameReader) {
        (self.sock, self.reader)
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
    use super::{attempt, decide, stop, Bound};
    use crate::lifecycle::{Cause, Control, Failure, Phase};
    use std::net::{SocketAddr, TcpListener};
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
    fn every_order_of_cancellation_expiry_and_clock_reading_reports_the_first() {
        let end = Instant::now();
        let ms = Duration::from_millis;
        let phase = Phase::Discovery;
        let cancelled = Err(Failure::Cancelled { phase });
        let expired = Err(Failure::Cause {
            code: Cause::ResponseTimeout,
            phase,
        });
        // (cancellation time read, clock read before it)
        let cases = [
            // cancelled, then the clock read, then the end passes
            (Some(end - ms(20)), end - ms(10), cancelled),
            // cancelled, the end passes, then the clock read
            (Some(end - ms(10)), end + ms(10), cancelled),
            // the end passes, cancelled, then the clock read
            (Some(end + ms(10)), end + ms(20), expired),
            // the clock read before the end, the end passes, then cancelled
            (Some(end + ms(10)), end - ms(10), expired),
            // the clock read past the end, nothing cancelled yet
            (None, end + ms(10), expired),
            // cancelled exactly at the end
            (Some(end), end + ms(10), expired),
        ];
        for (cancel, now, expected) in cases {
            assert_eq!(
                decide(cancel, now, &bound(end), phase).map(|_| ()),
                expected,
                "{cancel:?} {now:?}"
            );
        }
        assert_eq!(decide(None, end - ms(10), &bound(end), phase), Ok(ms(10)));
    }

    #[test]
    fn a_cancellation_at_the_end_is_expiry() {
        let control = Control::new();
        control.cancel();
        let at = control.cancelled_at().unwrap();
        assert_eq!(
            stop(&control, &bound(at), Phase::Discovery),
            Err(Failure::Cause {
                code: Cause::ResponseTimeout,
                phase: Phase::Discovery
            })
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

    #[test]
    fn a_connection_attempt_does_not_start_once_the_call_has_stopped() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();

        let cancelled = Control::new();
        cancelled.cancel();
        assert!(attempt(addr, Instant::now() + Duration::from_secs(5), &cancelled).is_none());
        assert!(attempt(
            addr,
            Instant::now() - Duration::from_millis(1),
            &Control::new()
        )
        .is_none());
        assert!(listener.accept().is_err(), "no connection was made");

        assert!(attempt(
            addr,
            Instant::now() + Duration::from_secs(5),
            &Control::new()
        )
        .unwrap()
        .is_ok());
    }
}
