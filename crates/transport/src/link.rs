//! A blocking request/response exchange over one loopback TCP connection,
//! bounded by an enclosing budget and per-request deadlines and stopped by a
//! [`Control`].
//!
//! Every blocking step returns to the caller at least every [`POLL`], and the
//! stop conditions (cancellation, then the earliest expired bound) are checked
//! before each step and again before its outcome is used, so a condition that
//! holds first is reported even when a reply, a close or an oversized frame
//! arrives after it.

use crate::connection::{LinkFailure, LinkLoss};
use crate::frame::{self, FrameReader, ReadError};
use crate::lifecycle::{Cause, Control, Failure, Phase};
use serde_json::Value;
use std::io::{ErrorKind, Read, Write};
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
    /// How the link was lost, once a failure ended it as `connection_lost`
    /// (R1-O-A). The first one recorded stands.
    lost: Option<LinkLoss>,
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
            lost: None,
        })
    }

    /// The phase later failures on this link report.
    pub fn set_phase(&mut self, phase: Phase) {
        self.phase = phase;
    }

    /// `failure`, with how the link was lost when the failure ended it as
    /// `connection_lost` and that is known.
    pub fn failed(&self, failure: Failure) -> LinkFailure {
        let lost_link = match failure {
            Failure::Cause {
                code: Cause::ConnectionLost,
                ..
            } => self.lost,
            _ => None,
        };
        LinkFailure { failure, lost_link }
    }

    /// Records how the link was lost, unless that is already recorded.
    pub fn note_loss(&mut self, loss: LinkLoss) {
        self.lost.get_or_insert(loss);
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
        write_within(
            &mut self.sock,
            &bytes,
            self.control,
            self.phase,
            &bound,
            &mut self.lost,
        )
    }

    /// Reads frames until `answer` decides one, within `deadline` from now and
    /// the budget. `answer` returns `None` to skip a frame, `Some(Ok)` to
    /// accept it and `Some(Err)` to fail; lines that are not JSON are skipped.
    pub fn await_frame<T>(
        &mut self,
        deadline: Duration,
        budget: &Budget,
        answer: impl FnMut(&Value) -> Option<Result<T, Failure>>,
    ) -> Result<T, Failure> {
        let bound = budget.bound(deadline, Cause::ResponseTimeout);
        read_until(
            &mut self.sock,
            &mut self.reader,
            self.control,
            self.phase,
            &bound,
            &mut self.lost,
            answer,
        )
    }
}

/// What [`read_until`] reads from: the connection's socket, or a test's
/// scripted source.
trait Source: Read {
    fn set_poll(&mut self, timeout: Duration) -> std::io::Result<()>;
}

impl Source for TcpStream {
    fn set_poll(&mut self, timeout: Duration) -> std::io::Result<()> {
        self.set_read_timeout(Some(timeout))
    }
}

/// What [`write_within`] writes to: the connection's socket, or a test's
/// scripted sink.
trait Sink: Write {
    fn set_write_poll(&mut self, timeout: Duration) -> std::io::Result<()>;
}

impl Sink for TcpStream {
    fn set_write_poll(&mut self, timeout: Duration) -> std::io::Result<()> {
        self.set_write_timeout(Some(timeout))
    }
}

/// [`Link::send`]'s loop: one write at a time, each bounded by [`POLL`], with
/// the stop conditions checked before and after every write. A failure that
/// ends the link as `connection_lost` records how in `lost`.
fn write_within<S: Sink>(
    sock: &mut S,
    bytes: &[u8],
    control: &Control,
    phase: Phase,
    bound: &Bound,
    lost: &mut Option<LinkLoss>,
) -> Result<(), Failure> {
    let mut lose = |loss: LinkLoss| {
        lost.get_or_insert(loss);
        Failure::cause(Cause::ConnectionLost, phase)
    };
    let mut written = 0;
    while written < bytes.len() {
        let remaining = stop(control, bound, phase)?;
        if let Err(error) = sock.set_write_poll(remaining.min(POLL)) {
            return Err(lose(LinkLoss::SocketError(error.kind())));
        }
        let outcome = sock.write(&bytes[written..]);
        stop(control, bound, phase)?;
        match outcome {
            Ok(0) => return Err(lose(LinkLoss::PeerClosed)),
            Ok(n) => written += n,
            Err(e)
                if matches!(
                    e.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) => {}
            Err(e) => return Err(lose(LinkLoss::SocketError(e.kind()))),
        }
    }
    Ok(())
}

/// [`Link::await_frame`]'s loop: one read at a time, each bounded by
/// [`POLL`], with the stop conditions checked before and after every read. A
/// failure that ends the link as `connection_lost` records how in `lost`.
fn read_until<S: Source, T>(
    sock: &mut S,
    reader: &mut FrameReader,
    control: &Control,
    phase: Phase,
    bound: &Bound,
    lost: &mut Option<LinkLoss>,
    mut answer: impl FnMut(&Value) -> Option<Result<T, Failure>>,
) -> Result<T, Failure> {
    let mut lose = |loss: LinkLoss| {
        lost.get_or_insert(loss);
        Failure::cause(Cause::ConnectionLost, phase)
    };
    loop {
        let remaining = stop(control, bound, phase)?;
        if let Err(error) = sock.set_poll(remaining.min(POLL)) {
            return Err(lose(LinkLoss::SocketError(error.kind())));
        }
        let outcome = reader.read_once(sock);
        stop(control, bound, phase)?;
        match outcome {
            Ok(Some(frame)) => {
                if let Some(decided) = frame.json.as_ref().and_then(&mut answer) {
                    return decided;
                }
            }
            Ok(None) => {}
            Err(ReadError::Oversized { .. }) => {
                return Err(Failure::cause(Cause::InvalidResponse, phase))
            }
            Err(ReadError::Closed) => return Err(lose(LinkLoss::PeerClosed)),
            Err(ReadError::Io(kind)) => return Err(lose(LinkLoss::SocketError(kind))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{attempt, decide, read_until, stop, write_within, Bound, Sink, Source};
    use crate::connection::LinkLoss;
    use crate::frame::FrameReader;
    use crate::lifecycle::{Cause, Control, Failure, Phase};
    use serde_json::Value;
    use std::collections::VecDeque;
    use std::io::{ErrorKind, Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::thread;
    use std::time::{Duration, Instant};

    /// A source that returns one scripted piece per read, cancels `control`
    /// during the given read (counted from 1), and counts its reads.
    struct Pieces<'a> {
        pieces: VecDeque<&'static [u8]>,
        cancel_in_read: Option<(usize, &'a Control)>,
        reads: usize,
    }

    impl Read for Pieces<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.reads += 1;
            if let Some((read, control)) = self.cancel_in_read {
                if read == self.reads {
                    control.cancel();
                }
            }
            match self.pieces.pop_front() {
                Some(piece) => {
                    buf[..piece.len()].copy_from_slice(piece);
                    Ok(piece.len())
                }
                None => Err(ErrorKind::WouldBlock.into()),
            }
        }
    }

    impl Source for Pieces<'_> {
        fn set_poll(&mut self, _: Duration) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// One frame in four pieces, each readable at once, cancelled during read
    /// `cancel_in` when given; the frame is accepted.
    fn read_pieces(control: &Control, cancel_in: Option<usize>) -> (Result<Value, Failure>, usize) {
        let mut source = Pieces {
            pieces: VecDeque::from([&b"{\"uri\":"[..], b"\"/vd/", b"synchronize\"", b"}\n"]),
            cancel_in_read: cancel_in.map(|read| (read, control)),
            reads: 0,
        };
        let bound = bound(Instant::now() + Duration::from_secs(5));
        let result = read_until(
            &mut source,
            &mut FrameReader::new(),
            control,
            Phase::Discovery,
            &bound,
            &mut None,
            |frame| Some(Ok(frame.clone())),
        );
        (result, source.reads)
    }

    #[test]
    fn the_read_loop_stops_at_a_cancel_before_reading_on_or_using_the_frame() {
        // The cancel lands while the first piece is being read; the rest of
        // the frame is readable at once. The loop returns Cancelled without
        // reading again: reading on to the end of the line, or past the
        // cancel, takes more reads.
        let (result, reads) = read_pieces(&Control::new(), Some(1));
        assert_eq!(
            result,
            Err(Failure::Cancelled {
                phase: Phase::Discovery
            })
        );
        assert_eq!(reads, 1);

        // Cancelled before the loop starts: no read at all.
        let cancelled = Control::new();
        cancelled.cancel();
        let (result, reads) = read_pieces(&cancelled, None);
        assert_eq!(
            result,
            Err(Failure::Cancelled {
                phase: Phase::Discovery
            })
        );
        assert_eq!(reads, 0);

        // A cancel during the read that completes the frame: the frame is not used.
        let (result, reads) = read_pieces(&Control::new(), Some(4));
        assert_eq!(
            result,
            Err(Failure::Cancelled {
                phase: Phase::Discovery
            })
        );
        assert_eq!(reads, 4);

        // The same pieces without the cancel: the frame completes and is used.
        let (result, reads) = read_pieces(&Control::new(), None);
        assert_eq!(result, Ok(serde_json::json!({ "uri": "/vd/synchronize" })));
        assert_eq!(reads, 4);
    }

    fn bound(end: Instant) -> Bound {
        Bound {
            end,
            expired: Cause::ResponseTimeout,
        }
    }

    /// A socket whose timeout setting fails with `poll`, and whose reads and
    /// writes fail with `io`, or report the stream closed without one.
    struct Failing {
        poll: Option<ErrorKind>,
        io: Option<ErrorKind>,
    }

    impl Failing {
        fn outcome(&self) -> std::io::Result<usize> {
            self.io.map_or(Ok(0), |kind| Err(kind.into()))
        }

        fn set(&self) -> std::io::Result<()> {
            self.poll.map_or(Ok(()), |kind| Err(kind.into()))
        }
    }

    impl Read for Failing {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            self.outcome()
        }
    }

    impl Write for Failing {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            self.outcome()
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Source for Failing {
        fn set_poll(&mut self, _: Duration) -> std::io::Result<()> {
            self.set()
        }
    }

    impl Sink for Failing {
        fn set_write_poll(&mut self, _: Duration) -> std::io::Result<()> {
            self.set()
        }
    }

    #[test]
    fn a_read_or_write_that_ends_the_link_records_how_with_the_error_it_failed_with() {
        let lost = Failure::cause(Cause::ConnectionLost, Phase::Identity);
        for (poll, io, expected) in [
            (
                Some(ErrorKind::InvalidInput),
                None,
                LinkLoss::SocketError(ErrorKind::InvalidInput),
            ),
            (
                None,
                Some(ErrorKind::ConnectionReset),
                LinkLoss::SocketError(ErrorKind::ConnectionReset),
            ),
            (
                None,
                Some(ErrorKind::BrokenPipe),
                LinkLoss::SocketError(ErrorKind::BrokenPipe),
            ),
            (None, None, LinkLoss::PeerClosed),
        ] {
            let bound = bound(Instant::now() + Duration::from_secs(5));
            let mut recorded = None;
            let read = read_until(
                &mut Failing { poll, io },
                &mut FrameReader::new(),
                &Control::new(),
                Phase::Identity,
                &bound,
                &mut recorded,
                |frame| Some(Ok(frame.clone())),
            );
            assert_eq!(read, Err(lost), "read: {expected:?}");
            assert_eq!(recorded, Some(expected), "read");
            let mut recorded = None;
            let written = write_within(
                &mut Failing { poll, io },
                b"{}\n",
                &Control::new(),
                Phase::Identity,
                &bound,
                &mut recorded,
            );
            assert_eq!(written, Err(lost), "write: {expected:?}");
            assert_eq!(recorded, Some(expected), "write");
        }
        // The first loss recorded stands.
        let bound = bound(Instant::now() + Duration::from_secs(5));
        let mut recorded = Some(LinkLoss::UnitLost);
        let _ = write_within(
            &mut Failing {
                poll: None,
                io: Some(ErrorKind::BrokenPipe),
            },
            b"{}\n",
            &Control::new(),
            Phase::Identity,
            &bound,
            &mut recorded,
        );
        assert_eq!(recorded, Some(LinkLoss::UnitLost));
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
