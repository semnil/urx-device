//! Discovery against fake Device Center endpoints on loopback ports: one list
//! endpoint and one `vdp` endpoint per listed unit, each answering with
//! scripted lines and recording the requests it received.

use super::{discover, DeviceEntry, DiscoveryOptions, SystemFirmware};
use crate::lifecycle::{Cause, Control, Failure, Phase};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

type Respond = Arc<dyn Fn(&Value) -> Vec<Vec<u8>> + Send + Sync>;

/// A loopback endpoint that answers each request line with the lines
/// `respond` returns, and records the `uri` of every request.
struct Peer {
    port: u16,
    uris: Arc<Mutex<Vec<String>>>,
}

impl Peer {
    fn serve(respond: impl Fn(&Value) -> Vec<Vec<u8>> + Send + Sync + 'static) -> Peer {
        Peer::serve_paced(Duration::ZERO, respond)
    }

    /// Like [`Peer::serve`], waiting `pace` after writing each piece.
    fn serve_paced(
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

    fn uris(&self) -> Vec<String> {
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

fn line(message: Value) -> Vec<u8> {
    let mut bytes = message.to_string().into_bytes();
    bytes.push(b'\n');
    bytes
}

fn uri_of(request: &Value) -> &str {
    request["vdp"]["uri"].as_str().unwrap_or("")
}

fn get_reply(uri: &str, data: Value) -> Vec<u8> {
    line(json!({ "vdp": { "method": "get", "uri": uri, "data": data } }))
}

fn online(id: &str) -> Value {
    json!({ "compatibled": true, "response_code": 200, "sync_status": "online", "usb_id": id })
}

fn lost() -> Value {
    json!({ "compatibled": true, "response_code": 200, "sync_status": "lost" })
}

fn firm_list(entries: Value) -> Value {
    json!({ "firm_list": entries, "model_name": "URX44V", "response_code": 200 })
}

/// A unit endpoint answering `/vd/synchronize` and `/vd/device` with `sync`
/// and `device`.
fn unit(sync: Value, device: Value) -> Peer {
    Peer::serve(move |request| match uri_of(request) {
        "/vd/synchronize" => vec![get_reply("/vd/synchronize", sync.clone())],
        "/vd/device" => vec![get_reply("/vd/device", device.clone())],
        _ => vec![],
    })
}

/// A unit endpoint that reads requests and never answers.
fn silent() -> Peer {
    Peer::serve(|_| vec![])
}

/// The list endpoint, answering with `data` as the device list.
fn center_data(data: Value) -> Peer {
    Peer::serve(move |_| vec![list_reply(data.clone())])
}

fn list_reply(data: Value) -> Vec<u8> {
    line(json!({ "vddp": { "method": "get", "uri": "/vddp_srv/devices", "data": data } }))
}

/// `bytes` cut into pieces of `size` bytes.
fn pieces(bytes: Vec<u8>, size: usize) -> Vec<Vec<u8>> {
    bytes.chunks(size).map(<[u8]>::to_vec).collect()
}

fn metadata(options: DiscoveryOptions) -> DiscoveryOptions {
    DiscoveryOptions {
        metadata: true,
        ..options
    }
}

/// The list endpoint, listing `units` as `(vdp port, model)`.
fn center(units: &[(u16, &str)]) -> Peer {
    let list: Vec<Value> = units
        .iter()
        .map(|(port, model)| json!({ "model": model, "vd_type": "vd", "vdpport": port }))
        .collect();
    center_data(json!({ "list": list }))
}

fn options(list_port: u16) -> DiscoveryOptions {
    DiscoveryOptions {
        list_port,
        deadline: Duration::from_secs(5),
        request_deadline: Duration::from_secs(3),
        metadata: false,
    }
}

fn run(options: &DiscoveryOptions) -> Result<Vec<DeviceEntry>, Failure> {
    discover(options, &Control::new())
}

fn fails_with(code: Cause) -> Result<Vec<DeviceEntry>, Failure> {
    Err(Failure::Cause {
        code,
        phase: Phase::Discovery,
    })
}

/// A loopback port nothing listens on.
fn closed_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

#[test]
fn an_empty_list_is_a_completed_discovery() {
    let center = center(&[]);
    assert_eq!(run(&options(center.port)), Ok(vec![]));
    assert_eq!(center.uris(), ["/vddp_srv/devices"]);
}

#[test]
fn an_online_unit_is_listed_with_its_usb_id_and_without_a_firmware_read() {
    let a = unit(online("<device-id-a>"), firm_list(json!([])));
    let center = center(&[(a.port, "URX44V")]);
    assert_eq!(
        run(&options(center.port)),
        Ok(vec![DeviceEntry {
            id: "<device-id-a>".into(),
            model: "URX44V".into(),
            port: a.port,
            firmware: None,
        }])
    );
    assert_eq!(
        a.uris(),
        ["/vd/synchronize"],
        "no metadata read without metadata"
    );
}

#[test]
fn units_that_are_not_online_are_left_out_and_list_order_is_kept() {
    let b = unit(online("<device-id-b>"), Value::Null);
    let gone = unit(lost(), Value::Null);
    let a = unit(online("<device-id-a>"), Value::Null);
    let center = center(&[(b.port, "URX22"), (gone.port, "URX44"), (a.port, "URX44V")]);
    let ids: Vec<String> = run(&options(center.port))
        .unwrap()
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    assert_eq!(ids, ["<device-id-b>", "<device-id-a>"]);
}

#[test]
fn metadata_reads_the_system_firmware_version() {
    let cases = [
        (
            json!([{ "firm_name": "DSP", "firm_version": "1.0" }, { "firm_name": "System", "firm_version": "9.9.9" }]),
            SystemFirmware::Version("9.9.9".into()),
        ),
        (
            json!([{ "firm_name": "SYSTEM", "firm_version": "9.9.9" }]),
            SystemFirmware::Version("9.9.9".into()),
        ),
        (
            json!([{ "firm_name": "DSP", "firm_version": "1.0" }]),
            SystemFirmware::Absent,
        ),
        (json!([]), SystemFirmware::Absent),
        (
            json!([{ "firm_name": "system", "firm_version": "" }]),
            SystemFirmware::Absent,
        ),
    ];
    for (entries, expected) in cases {
        let a = unit(online("<device-id-a>"), firm_list(entries.clone()));
        let center = center(&[(a.port, "URX44V")]);
        let found = run(&DiscoveryOptions {
            metadata: true,
            ..options(center.port)
        })
        .unwrap();
        assert_eq!(found[0].firmware, Some(expected), "{entries}");
        assert_eq!(a.uris(), ["/vd/synchronize", "/vd/device"]);
    }
}

#[test]
fn malformed_firmware_metadata_fails_the_discovery() {
    for device in [
        json!({ "model_name": "URX44V" }),
        firm_list(json!({})),
        firm_list(json!([{ "firm_name": "System" }])),
        firm_list(json!([{ "firm_name": "System", "firm_version": 1 }])),
    ] {
        let a = unit(online("<device-id-a>"), device.clone());
        let center = center(&[(a.port, "URX44V")]);
        let result = run(&DiscoveryOptions {
            metadata: true,
            ..options(center.port)
        });
        assert_eq!(result, fails_with(Cause::InvalidResponse), "{device}");
    }
}

#[test]
fn a_missing_empty_or_duplicate_online_identity_is_an_identity_error() {
    let missing = unit(json!({ "sync_status": "online" }), Value::Null);
    let empty = unit(online(""), Value::Null);
    let non_string = unit(json!({ "sync_status": "online", "usb_id": 7 }), Value::Null);
    for peer in [&missing, &empty, &non_string] {
        let center = center(&[(peer.port, "URX44V")]);
        assert_eq!(run(&options(center.port)), fails_with(Cause::IdentityError));
    }
    let a = unit(online("<device-id-a>"), Value::Null);
    let twin = unit(online("<device-id-a>"), Value::Null);
    let center = center(&[(a.port, "URX44V"), (twin.port, "URX44V")]);
    assert_eq!(run(&options(center.port)), fails_with(Cause::IdentityError));
}

#[test]
fn a_malformed_device_list_fails_the_discovery() {
    let a = unit(online("<device-id-a>"), Value::Null);
    for data in [
        json!({}),
        json!({ "list": {} }),
        json!({ "list": [{ "model": "URX44V" }] }),
        json!({ "list": [{ "model": "URX44V", "vdpport": 0 }] }),
        json!({ "list": [{ "model": "URX44V", "vdpport": 65536 }] }),
        json!({ "list": [{ "model": "URX44V", "vdpport": "1" }] }),
        json!({ "list": [{ "vdpport": a.port }] }),
        json!({ "list": [{ "model": "", "vdpport": a.port }] }),
        json!({ "list": [{ "model": "URX44V", "vdpport": a.port }, { "model": "URX22" }] }),
    ] {
        let center = center_data(data.clone());
        assert_eq!(
            run(&options(center.port)),
            fails_with(Cause::InvalidResponse),
            "{data}"
        );
    }
}

#[test]
fn a_synchronize_reply_without_a_status_or_data_is_invalid() {
    let no_status = unit(json!({ "usb_id": "<device-id-a>" }), Value::Null);
    let no_data = Peer::serve(|_| {
        vec![line(
            json!({ "vdp": { "method": "get", "uri": "/vd/synchronize" } }),
        )]
    });
    for peer in [&no_status, &no_data] {
        let center = center(&[(peer.port, "URX44V")]);
        assert_eq!(
            run(&options(center.port)),
            fails_with(Cause::InvalidResponse)
        );
    }
}

#[test]
fn notifications_other_replies_and_non_json_lines_do_not_answer_the_check() {
    let a = Peer::serve(|request| {
        if uri_of(request) != "/vd/synchronize" {
            return vec![];
        }
        vec![
            b"not json\n".to_vec(),
            line(
                json!({ "vdp": { "method": "notify", "uri": "/vd/synchronize", "data": { "sync_status": "lost" } } }),
            ),
            line(
                json!({ "vdp": { "method": "post", "uri": "/vd/synchronize", "data": { "sync_status": "lost" } } }),
            ),
            line(
                json!({ "vdp": { "method": "get", "uri": "/vd/device", "data": { "sync_status": "lost" } } }),
            ),
            get_reply("/vd/synchronize", online("<device-id-a>")),
        ]
    });
    let center = center(&[(a.port, "URX44V")]);
    let found = run(&options(center.port)).unwrap();
    assert_eq!(found.len(), 1);
}

#[test]
fn an_unreachable_endpoint_is_a_connection_failure() {
    assert_eq!(
        run(&options(closed_port())),
        fails_with(Cause::ConnectionFailed)
    );
    let a = unit(online("<device-id-a>"), Value::Null);
    let center = center(&[(a.port, "URX44V"), (closed_port(), "URX22")]);
    assert_eq!(
        run(&options(center.port)),
        fails_with(Cause::ConnectionFailed)
    );
}

#[test]
fn a_peer_that_closes_before_answering_is_a_lost_connection() {
    let closing = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = closing.local_addr().unwrap().port();
    thread::spawn(move || {
        let (stream, _) = closing.accept().unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
    });
    let list = center_data(json!({ "list": [{ "model": "URX44V", "vdpport": port }] }));
    assert_eq!(run(&options(list.port)), fails_with(Cause::ConnectionLost));
}

#[test]
fn an_oversized_frame_is_an_invalid_response() {
    let big = Peer::serve(|_| {
        let mut bytes = vec![b'x'; crate::frame::MAX_FRAME_BYTES + 1];
        bytes.push(b'\n');
        vec![bytes]
    });
    let center = center(&[(big.port, "URX44V")]);
    assert_eq!(
        run(&options(center.port)),
        fails_with(Cause::InvalidResponse)
    );
}

#[test]
fn an_unanswered_check_stops_at_the_earlier_of_its_own_deadline_and_the_budget() {
    let quiet = silent();
    let center = center(&[(quiet.port, "URX44V")]);

    let started = Instant::now();
    let own_first = DiscoveryOptions {
        deadline: Duration::from_secs(5),
        request_deadline: Duration::from_millis(200),
        ..options(center.port)
    };
    assert_eq!(run(&own_first), fails_with(Cause::ResponseTimeout));
    assert!(started.elapsed() < Duration::from_secs(2));

    let started = Instant::now();
    let budget_first = DiscoveryOptions {
        deadline: Duration::from_millis(300),
        request_deadline: Duration::from_secs(3),
        ..options(center.port)
    };
    assert_eq!(run(&budget_first), fails_with(Cause::DiscoveryTimeout));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn the_budget_is_not_reset_between_candidates() {
    // Each candidate answers after 250 ms: within its own deadline, but three
    // of them do not fit a 600 ms budget.
    let slow = || {
        Peer::serve(|request| {
            thread::sleep(Duration::from_millis(250));
            if uri_of(request) == "/vd/synchronize" {
                vec![get_reply("/vd/synchronize", lost())]
            } else {
                vec![]
            }
        })
    };
    let (a, b, c) = (slow(), slow(), slow());
    let center = center(&[(a.port, "URX44V"), (b.port, "URX44V"), (c.port, "URX44V")]);
    let result = run(&DiscoveryOptions {
        deadline: Duration::from_millis(600),
        request_deadline: Duration::from_secs(3),
        ..options(center.port)
    });
    assert_eq!(result, fails_with(Cause::DiscoveryTimeout));
}

#[test]
fn cancellation_stops_before_starting_and_while_waiting() {
    let empty = center(&[]);
    let control = Control::new();
    control.cancel();
    assert_eq!(
        discover(&options(empty.port), &control),
        Err(Failure::Cancelled {
            phase: Phase::Discovery
        })
    );
    assert!(empty.uris().is_empty(), "nothing sent once cancelled");

    let quiet = silent();
    let center = center(&[(quiet.port, "URX44V")]);
    let control = Control::new();
    let canceller = control.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(150));
        canceller.cancel();
    });
    let started = Instant::now();
    assert_eq!(
        discover(&options(center.port), &control),
        Err(Failure::Cancelled {
            phase: Phase::Discovery
        })
    );
    assert!(started.elapsed() < Duration::from_secs(1));
}

/// A unit whose `/vd/synchronize` and `/vd/device` replies arrive in 8-byte
/// pieces every 20 ms, so each takes several hundred milliseconds.
fn dribbling_unit() -> Peer {
    Peer::serve_paced(Duration::from_millis(20), |request| match uri_of(request) {
        "/vd/synchronize" => pieces(get_reply("/vd/synchronize", online("<device-id-a>")), 8),
        "/vd/device" => pieces(
            get_reply(
                "/vd/device",
                firm_list(json!([{ "firm_name": "System", "firm_version": "9.9.9" }])),
            ),
            8,
        ),
        _ => vec![],
    })
}

#[test]
fn a_reply_that_keeps_arriving_in_pieces_still_stops_at_its_deadline() {
    let a = dribbling_unit();
    let center = center(&[(a.port, "URX44V")]);

    let started = Instant::now();
    let result = run(&DiscoveryOptions {
        request_deadline: Duration::from_millis(100),
        ..options(center.port)
    });
    assert_eq!(result, fails_with(Cause::ResponseTimeout));
    assert!(
        started.elapsed() < Duration::from_millis(250),
        "{:?}",
        started.elapsed()
    );

    let started = Instant::now();
    let result = run(&DiscoveryOptions {
        deadline: Duration::from_millis(100),
        ..options(center.port)
    });
    assert_eq!(result, fails_with(Cause::DiscoveryTimeout));
    assert!(
        started.elapsed() < Duration::from_millis(250),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn a_reply_that_keeps_arriving_in_pieces_is_cancellable() {
    let a = dribbling_unit();
    let center = center(&[(a.port, "URX44V")]);
    let control = Control::new();
    let canceller = control.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(80));
        canceller.cancel();
    });
    let started = Instant::now();
    assert_eq!(
        discover(&options(center.port), &control),
        Err(Failure::Cancelled {
            phase: Phase::Discovery
        })
    );
    assert!(
        started.elapsed() < Duration::from_millis(250),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn a_reply_in_pieces_that_completes_in_time_is_used() {
    let a = dribbling_unit();
    let center = center(&[(a.port, "URX44V")]);
    let found = run(&metadata(options(center.port))).unwrap();
    assert_eq!(
        found[0].firmware,
        Some(SystemFirmware::Version("9.9.9".into()))
    );
}

#[test]
fn an_expired_deadline_is_reported_over_a_later_close_or_oversized_frame() {
    let closes_late = Peer::serve(|_| {
        thread::sleep(Duration::from_millis(300));
        vec![]
    });
    let oversized_late = Peer::serve_paced(Duration::from_millis(300), |_| {
        let mut big = vec![b'x'; crate::frame::MAX_FRAME_BYTES + 1];
        big.push(b'\n');
        vec![b"{".to_vec(), big]
    });
    for peer in [&closes_late, &oversized_late] {
        let center = center(&[(peer.port, "URX44V")]);
        let result = run(&DiscoveryOptions {
            request_deadline: Duration::from_millis(100),
            ..options(center.port)
        });
        assert_eq!(result, fails_with(Cause::ResponseTimeout));
    }
}

#[test]
fn a_list_reply_without_usable_data_is_invalid_at_once() {
    let no_data = Peer::serve(|_| {
        vec![line(
            json!({ "vddp": { "method": "get", "uri": "/vddp_srv/devices" } }),
        )]
    });
    let null_data = center_data(Value::Null);
    let empty_data = center_data(json!({}));
    for peer in [&no_data, &null_data, &empty_data] {
        let started = Instant::now();
        assert_eq!(run(&options(peer.port)), fails_with(Cause::InvalidResponse));
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}

#[test]
fn only_the_list_reply_decides_the_list() {
    let a = unit(online("<device-id-a>"), Value::Null);
    let list = json!({ "list": [{ "model": "URX44V", "vdpport": a.port }] });
    let center = Peer::serve(move |_| {
        vec![
            line(
                json!({ "vddp": { "method": "get", "uri": "/vddp_srv", "data": { "protocol_version": 1 } } }),
            ),
            line(
                json!({ "vddp": { "method": "notify", "uri": "/vddp_srv/devices", "data": { "list": [] } } }),
            ),
            line(json!({ "vddp": { "method": "post", "uri": "/vddp_srv/devices", "data": {} } })),
            list_reply(list.clone()),
        ]
    });
    assert_eq!(run(&options(center.port)).unwrap().len(), 1);
}

/// A unit that answers `/vd/synchronize` online and `/vd/device` from cache,
/// with `pushes` written after the synchronize reply, before the device reply.
fn unplugged_while_checked(id: &'static str, pushes: Vec<Value>) -> Peer {
    Peer::serve(move |request| match uri_of(request) {
        "/vd/synchronize" => {
            let mut out = vec![get_reply("/vd/synchronize", online(id))];
            out.extend(pushes.iter().cloned().map(line));
            out
        }
        "/vd/device" => vec![get_reply(
            "/vd/device",
            firm_list(json!([{ "firm_name": "System", "firm_version": "9.9.9" }])),
        )],
        _ => vec![],
    })
}

fn sync_push(status: &str) -> Value {
    json!({ "vdp": { "method": "notify", "uri": "/vd/synchronize", "data": { "sync_status": status } } })
}

#[test]
fn a_unit_lost_after_reporting_online_fails_a_metadata_discovery() {
    for pushes in [
        vec![sync_push("offline")],
        vec![sync_push("lost")],
        vec![sync_push("offline"), sync_push("lost")],
        vec![sync_push("lost"), sync_push("online")],
    ] {
        let a = unplugged_while_checked("<device-id-a>", pushes.clone());
        let center = center(&[(a.port, "URX44V")]);
        assert_eq!(
            run(&metadata(options(center.port))),
            fails_with(Cause::ConnectionLost),
            "{pushes:?}"
        );
    }
    let a = unit(online("<device-id-a>"), firm_list(json!([])));
    let b = unplugged_while_checked("<device-id-b>", vec![sync_push("lost")]);
    let center = center(&[(a.port, "URX44V"), (b.port, "URX22")]);
    assert_eq!(
        run(&metadata(options(center.port))),
        fails_with(Cause::ConnectionLost),
        "no partial list"
    );
}

#[test]
fn an_online_push_or_a_push_before_the_status_reply_does_not_fail_the_check() {
    let online_push = unplugged_while_checked("<device-id-a>", vec![sync_push("online")]);
    let before = Peer::serve(|request| match uri_of(request) {
        "/vd/synchronize" => vec![
            line(sync_push("lost")),
            get_reply("/vd/synchronize", online("<device-id-a>")),
        ],
        "/vd/device" => vec![get_reply("/vd/device", firm_list(json!([])))],
        _ => vec![],
    });
    for peer in [&online_push, &before] {
        let center = center(&[(peer.port, "URX44V")]);
        assert_eq!(run(&metadata(options(center.port))).unwrap().len(), 1);
    }
}
