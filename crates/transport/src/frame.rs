//! Newline-delimited JSON framing for the Device Center link (K6).
//!
//! One frame is one line of UTF-8 JSON. Its size is the number of bytes before
//! the terminating LF, a CR before the LF included, and no frame in either
//! direction may exceed [`MAX_FRAME_BYTES`].

use serde_json::Value;
use std::fmt;
use std::io::{ErrorKind, Read};

/// Largest frame, in bytes before the terminating LF, sent or accepted.
pub const MAX_FRAME_BYTES: usize = 1 << 20;

/// Size of each socket read.
const CHUNK_BYTES: usize = 8192;

/// One inbound line.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    /// Bytes before the terminating LF.
    pub len: usize,
    /// The line parsed as JSON, or `None` when it is not JSON. Such a line has
    /// been consumed; the next read starts after it.
    pub json: Option<Value>,
}

/// Why reading stopped. Each ends the connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    /// The peer closed the stream. Bytes of an unterminated last line are discarded.
    Closed,
    /// A frame exceeds [`MAX_FRAME_BYTES`]; `bytes` is how many were seen before
    /// reading stopped, which is the whole frame when its LF had arrived.
    Oversized { bytes: usize },
    /// The stream failed with an error other than a read timeout.
    Io(ErrorKind),
}

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReadError::Closed => f.write_str("the peer closed the connection"),
            ReadError::Oversized { bytes } => write!(
                f,
                "incoming frame of at least {bytes} bytes exceeds {MAX_FRAME_BYTES}"
            ),
            ReadError::Io(kind) => write!(f, "read failed: {kind}"),
        }
    }
}

impl std::error::Error for ReadError {}

/// Reads frames off a byte stream, keeping the partial tail of a line between
/// reads because a read boundary is not a frame boundary.
#[derive(Debug)]
pub struct FrameReader {
    pending: Vec<u8>,
    chunk: Vec<u8>,
}

impl Default for FrameReader {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameReader {
    pub fn new() -> Self {
        FrameReader {
            pending: Vec::new(),
            chunk: vec![0u8; CHUNK_BYTES],
        }
    }

    /// The next frame, or `None` when the stream reports a read timeout before
    /// one is complete. A frame already buffered is returned without reading.
    /// Retained bytes never exceed [`MAX_FRAME_BYTES`] plus one read.
    pub fn read_frame<R: Read>(&mut self, src: &mut R) -> Result<Option<Frame>, ReadError> {
        loop {
            if let Some(frame) = self.take_buffered()? {
                return Ok(Some(frame));
            }
            if !self.read_chunk(src)? {
                return Ok(None);
            }
        }
    }

    /// A frame already buffered, or else the frame completed by at most one
    /// read of `src`; `None` when that read timed out or left the frame
    /// incomplete. A caller that keeps receiving data regains control after
    /// every read.
    pub fn read_once<R: Read>(&mut self, src: &mut R) -> Result<Option<Frame>, ReadError> {
        if let Some(frame) = self.take_buffered()? {
            return Ok(Some(frame));
        }
        self.read_chunk(src)?;
        self.take_buffered()
    }

    /// A frame already complete in the buffer, taken out of it, with no read
    /// of the stream.
    pub fn take_frame(&mut self) -> Result<Option<Frame>, ReadError> {
        self.take_buffered()
    }

    /// One read of `src` into the buffer: `false` when the stream reported a
    /// read timeout; an interrupted read counts as a read with no data.
    pub fn fill<R: Read>(&mut self, src: &mut R) -> Result<bool, ReadError> {
        self.read_chunk(src)
    }

    fn take_buffered(&mut self) -> Result<Option<Frame>, ReadError> {
        if let Some(nl) = self.pending.iter().position(|&b| b == b'\n') {
            if nl > MAX_FRAME_BYTES {
                return Err(ReadError::Oversized { bytes: nl });
            }
            let json = serde_json::from_slice::<Value>(&self.pending[..nl]).ok();
            self.pending.drain(..=nl);
            return Ok(Some(Frame { len: nl, json }));
        }
        if self.pending.len() > MAX_FRAME_BYTES {
            return Err(ReadError::Oversized {
                bytes: self.pending.len(),
            });
        }
        Ok(None)
    }

    /// One read into the buffer. `false` when the stream reported a read
    /// timeout; an interrupted read counts as a read with no data.
    fn read_chunk<R: Read>(&mut self, src: &mut R) -> Result<bool, ReadError> {
        match src.read(&mut self.chunk) {
            Ok(0) => Err(ReadError::Closed),
            Ok(n) => {
                self.pending.extend_from_slice(&self.chunk[..n]);
                Ok(true)
            }
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => Ok(false),
            Err(e) if e.kind() == ErrorKind::Interrupted => Ok(true),
            Err(e) => Err(ReadError::Io(e.kind())),
        }
    }
}

/// An outgoing frame larger than [`MAX_FRAME_BYTES`]; nothing was sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OversizedFrame {
    pub bytes: usize,
}

impl fmt::Display for OversizedFrame {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "outgoing frame of {} bytes exceeds {MAX_FRAME_BYTES}",
            self.bytes
        )
    }
}

impl std::error::Error for OversizedFrame {}

/// The bytes to send for `message`: its compact JSON and a terminating LF.
pub fn encode(message: &Value) -> Result<Vec<u8>, OversizedFrame> {
    let mut bytes = message.to_string().into_bytes();
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(OversizedFrame { bytes: bytes.len() });
    }
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{
        encode, Frame, FrameReader, OversizedFrame, ReadError, CHUNK_BYTES, MAX_FRAME_BYTES,
    };
    use serde_json::{json, Value};
    use std::collections::VecDeque;
    use std::io::{Error, ErrorKind, Read};

    /// A byte source that returns at most one scripted piece per read, split when
    /// it does not fit the caller's buffer, and then reports a read timeout.
    /// `WouldBlock` rather than end of stream: an exhausted `Cursor` returns
    /// `Ok(0)`, which the reader must treat as the peer closing.
    struct Chunks(VecDeque<Vec<u8>>);

    impl Chunks {
        fn of(parts: &[&[u8]]) -> Self {
            Chunks(parts.iter().map(|p| p.to_vec()).collect())
        }
    }

    impl Read for Chunks {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let Some(mut next) = self.0.pop_front() else {
                return Err(Error::new(ErrorKind::WouldBlock, "quiet link"));
            };
            let n = next.len().min(buf.len());
            buf[..n].copy_from_slice(&next[..n]);
            if n < next.len() {
                self.0.push_front(next.split_off(n));
            }
            Ok(n)
        }
    }

    fn json_of(frame: Option<Frame>) -> Option<Value> {
        frame.expect("a frame").json
    }

    /// A JSON line of exactly `len` bytes before the LF: a string value padded out.
    fn line_of_len(len: usize) -> Vec<u8> {
        let overhead = r#"{"p":""}"#.len();
        let mut line = format!(r#"{{"p":"{}"}}"#, "y".repeat(len - overhead)).into_bytes();
        assert_eq!(line.len(), len);
        line.push(b'\n');
        line
    }

    #[test]
    fn a_line_split_across_two_reads_is_rejoined() {
        let mut reader = FrameReader::new();
        let mut src = Chunks::of(&[b"{\"vddp\":{\"seq\"", b":7}}\n"]);
        assert_eq!(
            json_of(reader.read_frame(&mut src).unwrap()),
            Some(json!({ "vddp": { "seq": 7 } }))
        );
    }

    #[test]
    fn two_frames_in_one_read_come_back_one_per_call() {
        let mut reader = FrameReader::new();
        let mut src = Chunks::of(&[b"{\"a\":1}\n{\"b\":2}\n"]);
        assert_eq!(
            json_of(reader.read_frame(&mut src).unwrap()),
            Some(json!({"a": 1}))
        );
        assert_eq!(
            json_of(reader.read_frame(&mut src).unwrap()),
            Some(json!({"b": 2}))
        );
        assert_eq!(reader.read_frame(&mut src).unwrap(), None, "then quiet");
    }

    #[test]
    fn read_once_returns_after_each_read_of_a_line_still_arriving() {
        let mut reader = FrameReader::new();
        let mut src = Chunks::of(&[b"{\"a\"", b":1", b"}\n{\"b\":2}\n"]);
        assert_eq!(reader.read_once(&mut src).unwrap(), None);
        assert_eq!(reader.read_once(&mut src).unwrap(), None);
        assert_eq!(
            json_of(reader.read_once(&mut src).unwrap()),
            Some(json!({"a": 1}))
        );
        assert_eq!(
            json_of(reader.read_once(&mut src).unwrap()),
            Some(json!({"b": 2})),
            "buffered, no read"
        );
        assert_eq!(reader.read_once(&mut src).unwrap(), None, "then quiet");
    }

    #[test]
    fn a_line_that_is_not_json_is_consumed_and_reported_as_such() {
        let mut reader = FrameReader::new();
        let mut src = Chunks::of(&[b"not json\n{\"a\":1}\n"]);
        assert_eq!(
            reader.read_frame(&mut src).unwrap(),
            Some(Frame { len: 8, json: None })
        );
        assert_eq!(
            json_of(reader.read_frame(&mut src).unwrap()),
            Some(json!({"a": 1}))
        );
    }

    #[test]
    fn the_length_counts_encoded_bytes_and_a_carriage_return() {
        let mut reader = FrameReader::new();
        let text = "{\"n\":\"\u{3042}\\\"\"}\r\n";
        let mut src = Chunks::of(&[text.as_bytes()]);
        let frame = reader.read_frame(&mut src).unwrap().expect("a frame");
        assert_eq!(frame.len, text.len() - 1);
        assert_eq!(frame.json, Some(json!({ "n": "\u{3042}\"" })));
    }

    #[test]
    fn a_frame_of_exactly_the_limit_is_accepted() {
        let mut reader = FrameReader::new();
        let line = line_of_len(MAX_FRAME_BYTES);
        let mut src = Chunks::of(&[&line]);
        let frame = reader.read_frame(&mut src).unwrap().expect("a frame");
        assert_eq!(frame.len, MAX_FRAME_BYTES);
        assert!(frame.json.is_some());
    }

    #[test]
    fn a_terminated_frame_one_byte_over_the_limit_is_refused() {
        let mut reader = FrameReader::new();
        let mut line = vec![b'x'; MAX_FRAME_BYTES + 1];
        line.push(b'\n');
        let mut src = Chunks::of(&[&line]);
        assert_eq!(
            reader.read_frame(&mut src),
            Err(ReadError::Oversized {
                bytes: MAX_FRAME_BYTES + 1
            })
        );
    }

    #[test]
    fn the_limit_applies_to_each_frame_not_to_the_bytes_buffered_after_it() {
        for first in [MAX_FRAME_BYTES - 1, MAX_FRAME_BYTES] {
            // The next frame arrives in the same read, so the buffer holds more
            // than the limit while the first frame is within it.
            let mut bytes = line_of_len(first);
            bytes.extend_from_slice(b"{\"b\":2}\n");
            assert!(bytes.len() - 1 > MAX_FRAME_BYTES);
            // The last read is the final CHUNK_BYTES bytes, so it holds both LFs.
            let (head, tail) = bytes.split_at(bytes.len() - CHUNK_BYTES);
            assert_eq!(tail.iter().filter(|&&b| b == b'\n').count(), 2);
            let mut reader = FrameReader::new();
            let mut src = Chunks::of(&[head, tail]);
            assert_eq!(
                reader.read_frame(&mut src).unwrap().map(|f| f.len),
                Some(first)
            );
            assert_eq!(
                json_of(reader.read_frame(&mut src).unwrap()),
                Some(json!({"b": 2}))
            );
        }

        // The next frame is split across reads with a read timeout between.
        let mut bytes = line_of_len(MAX_FRAME_BYTES);
        bytes.extend_from_slice(b"{\"b\"");
        let mut reader = FrameReader::new();
        let mut src = Chunks::of(&[&bytes]);
        assert_eq!(
            reader.read_frame(&mut src).unwrap().map(|f| f.len),
            Some(MAX_FRAME_BYTES)
        );
        assert_eq!(reader.read_frame(&mut src).unwrap(), None);
        let mut rest = Chunks::of(&[b":2}\n"]);
        assert_eq!(
            json_of(reader.read_frame(&mut rest).unwrap()),
            Some(json!({"b": 2}))
        );
    }

    #[test]
    fn a_peer_that_never_terminates_a_line_is_refused_with_bounded_memory() {
        /// Endless non-newline bytes, up to four times the limit, so a reader that
        /// does not stop fails this case instead of exhausting memory.
        struct Noise(usize);
        impl Read for Noise {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.0 += buf.len();
                assert!(self.0 < MAX_FRAME_BYTES * 4, "unbounded");
                buf.fill(b'x');
                Ok(buf.len())
            }
        }
        let mut reader = FrameReader::new();
        match reader.read_frame(&mut Noise(0)) {
            Err(ReadError::Oversized { bytes }) => {
                assert!(bytes > MAX_FRAME_BYTES && bytes <= MAX_FRAME_BYTES + 8192)
            }
            other => panic!("expected an oversized frame, got {other:?}"),
        }
    }

    #[test]
    fn end_of_stream_is_closed_even_with_a_partial_line() {
        let mut reader = FrameReader::new();
        let mut src: &[u8] = b"{\"a\":";
        assert_eq!(reader.read_frame(&mut src), Err(ReadError::Closed));
    }

    #[test]
    fn an_interrupted_read_is_retried_and_other_errors_end_reading() {
        struct Script(VecDeque<std::io::Result<Vec<u8>>>);
        impl Read for Script {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let bytes = self.0.pop_front().expect("scripted")?;
                buf[..bytes.len()].copy_from_slice(&bytes);
                Ok(bytes.len())
            }
        }
        let mut reader = FrameReader::new();
        let mut src = Script(VecDeque::from([
            Err(Error::from(ErrorKind::Interrupted)),
            Ok(b"{\"a\":1}\n".to_vec()),
            Err(Error::from(ErrorKind::TimedOut)),
            Err(Error::from(ErrorKind::ConnectionReset)),
        ]));
        assert_eq!(
            json_of(reader.read_frame(&mut src).unwrap()),
            Some(json!({"a": 1}))
        );
        assert_eq!(reader.read_frame(&mut src), Ok(None));
        assert_eq!(
            reader.read_frame(&mut src),
            Err(ReadError::Io(ErrorKind::ConnectionReset))
        );
    }

    #[test]
    fn encode_appends_one_line_feed_to_compact_json() {
        assert_eq!(
            encode(&json!({ "vdp": { "method": "get" } })).unwrap(),
            b"{\"vdp\":{\"method\":\"get\"}}\n"
        );
    }

    #[test]
    fn encode_limits_the_escaped_utf8_size_before_the_line_feed() {
        let overhead = r#"{"p":""}"#.len();
        let at_limit = json!({ "p": "y".repeat(MAX_FRAME_BYTES - overhead) });
        assert_eq!(encode(&at_limit).unwrap().len(), MAX_FRAME_BYTES + 1);

        let over = json!({ "p": "y".repeat(MAX_FRAME_BYTES - overhead + 1) });
        assert_eq!(
            encode(&over),
            Err(OversizedFrame {
                bytes: MAX_FRAME_BYTES + 1
            })
        );

        // A quote escapes to two bytes and U+3042 encodes as three.
        let escaped = json!({ "p": "\"".repeat((MAX_FRAME_BYTES - overhead) / 2 + 1) });
        assert!(encode(&escaped).is_err());
        let multibyte = json!({ "p": "\u{3042}".repeat((MAX_FRAME_BYTES - overhead) / 3 + 1) });
        assert!(encode(&multibyte).is_err());
    }
}
