//! A scripted loopback endpoint standing in for Device Center in tests.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

type Respond = Arc<dyn Fn(&Value) -> Vec<Vec<u8>> + Send + Sync>;

/// A loopback endpoint that answers each request line with the lines
/// `respond` returns, and records the `uri` of every request.
pub(crate) struct Peer {
    pub port: u16,
    uris: Arc<Mutex<Vec<String>>>,
}

impl Peer {
    pub fn serve(respond: impl Fn(&Value) -> Vec<Vec<u8>> + Send + Sync + 'static) -> Peer {
        Peer::serve_paced(Duration::ZERO, respond)
    }

    /// Like [`Peer::serve`], waiting `pace` after writing each piece.
    pub fn serve_paced(
        pace: Duration,
        respond: impl Fn(&Value) -> Vec<Vec<u8>> + Send + Sync + 'static,
    ) -> Peer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let uris = Arc::new(Mutex::new(Vec::new()));
        let respond: Respond = Arc::new(respond);
        let seen = Arc::clone(&uris);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                let respond = Arc::clone(&respond);
                let seen = Arc::clone(&seen);
                thread::spawn(move || answer(stream, pace, respond, seen));
            }
        });
        Peer { port, uris }
    }

    pub fn uris(&self) -> Vec<String> {
        self.uris.lock().unwrap().clone()
    }
}

fn answer(stream: TcpStream, pace: Duration, respond: Respond, seen: Arc<Mutex<Vec<String>>>) {
    let mut writer = stream.try_clone().unwrap();
    for line in BufReader::new(stream).lines() {
        let Ok(line) = line else { return };
        let request: Value = serde_json::from_str(&line).unwrap();
        let envelope = request.get("vdp").or_else(|| request.get("vddp")).unwrap();
        seen.lock()
            .unwrap()
            .push(envelope["uri"].as_str().unwrap().to_string());
        for out in respond(&request) {
            if writer.write_all(&out).is_err() {
                return;
            }
            thread::sleep(pace);
        }
    }
}

/// A port whose peer answers its first requests with `answers`, one each in
/// order, then waits for the next request without reading it and closes: with
/// a request unread, the system resets the connection instead of ending the
/// stream, so the other side's read fails.
pub(crate) fn resetting(answers: Vec<Vec<u8>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        for answer in answers {
            // One request, a byte at a time, so nothing after it is read.
            let mut byte = [0u8; 1];
            loop {
                match stream.read(&mut byte) {
                    Ok(1) if byte[0] == b'\n' => break,
                    Ok(1) => {}
                    _ => return,
                }
            }
            if stream.write_all(&answer).is_err() {
                return;
            }
        }
        let _ = stream.peek(&mut [0u8; 1]);
    });
    port
}

/// Whether `loss` is the socket error a reset connection reads as.
pub(crate) fn is_reset(loss: Option<crate::connection::LinkLoss>) -> bool {
    matches!(
        loss,
        Some(crate::connection::LinkLoss::SocketError(
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
        ))
    )
}

pub(crate) fn line(message: Value) -> Vec<u8> {
    let mut bytes = message.to_string().into_bytes();
    bytes.push(b'\n');
    bytes
}

pub(crate) fn uri_of(request: &Value) -> &str {
    request["vdp"]["uri"].as_str().unwrap_or("")
}

pub(crate) fn get_reply(uri: &str, data: Value) -> Vec<u8> {
    line(json!({ "vdp": { "method": "get", "uri": uri, "data": data } }))
}
