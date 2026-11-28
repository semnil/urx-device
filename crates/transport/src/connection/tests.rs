//! The operational connection against a fake unit endpoint.

use super::{
    open, CloseOutcome, Connection, ConnectionOptions, LinkFailure, LinkLoss, SentFrames,
    MAX_WAITING_BYTES, MAX_WAITING_REQUESTS,
};
use crate::discovery::SystemFirmware;
use crate::frame;
use crate::lifecycle::{Cause, Control, Failure, Phase};
use crate::request::{
    Evidence, Outcome, ReadValue, Request, RequestCause, RequestFailure, RequestPhase,
};
use crate::test_peer::{get_reply, is_reset, line, resetting, uri_of, Peer};
use crate::wire::{NameValue, ParameterAddress};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const ID: &str = "<device-id-a>";
const TEARDOWN: Duration = Duration::from_secs(2);

fn address(param_id: u32) -> ParameterAddress {
    ParameterAddress {
        param_id,
        x: 0,
        y: 0,
    }
}

fn options() -> ConnectionOptions {
    ConnectionOptions {
        connect_deadline: Duration::from_secs(5),
        handshake_request_deadline: Duration::from_secs(3),
        send_deadline: Duration::from_secs(3),
        response_deadline: Duration::from_secs(3),
    }
}

fn online(id: &str) -> Value {
    json!({ "response_code": 200, "sync_status": "online", "usb_id": id })
}

fn firmware() -> Value {
    json!({ "firm_list": [{ "firm_name": "System", "firm_version": "9.9.9" }], "response_code": 200 })
}

/// How a unit answers parameter requests.
type Answer = Arc<dyn Fn(&Value) -> Vec<Vec<u8>> + Send + Sync>;

/// A unit that passes the handshake and answers parameter requests with
/// `answer`.
fn unit(answer: impl Fn(&Value) -> Vec<Vec<u8>> + Send + Sync + 'static) -> Peer {
    let answer: Answer = Arc::new(answer);
    Peer::serve(move |request| match uri_of(request) {
        "/vd/synchronize" => vec![get_reply("/vd/synchronize", online(ID))],
        "/vd/device" => vec![get_reply("/vd/device", firmware())],
        _ => answer(request),
    })
}

/// Answers a GET with `current_value: 7` and a POST with `response_code: 200`.
fn plain(request: &Value) -> Vec<Vec<u8>> {
    let vdp = &request["vdp"];
    let uri = vdp["uri"].as_str().unwrap();
    match vdp["method"].as_str().unwrap() {
        "get" => vec![get_reply(
            uri,
            json!({ "current_value": 7, "response_code": 200 }),
        )],
        _ => vec![line(
            json!({ "vdp": { "method": "post", "uri": uri, "data": { "response_code": 200 } } }),
        )],
    }
}

fn post_reply(uri: &str, data: Value) -> Vec<u8> {
    line(json!({ "vdp": { "method": "post", "uri": uri, "data": data } }))
}

fn connect(peer: &Peer) -> Connection {
    open(peer.port, ID, &options(), &Control::new()).expect("open")
}

/// Submits `request` and returns where its outcome will arrive.
fn submit(
    connection: &Connection,
    operation: &super::Operation,
    request: Request,
) -> Receiver<Outcome> {
    let (tx, rx) = mpsc::channel();
    connection.submit_adopted(operation, request, move |outcome| {
        let _ = tx.send(outcome);
    });
    rx
}

fn outcome(rx: &Receiver<Outcome>) -> Outcome {
    rx.recv_timeout(Duration::from_secs(10))
        .expect("an outcome")
}

fn failed(code: RequestCause, phase: RequestPhase, evidence: Evidence) -> Outcome {
    Outcome::Failure {
        failure: RequestFailure::Cause { code, phase },
        evidence,
    }
}

fn cancelled() -> Outcome {
    Outcome::Failure {
        failure: RequestFailure::Cancelled {
            phase: RequestPhase::Admission,
        },
        evidence: Evidence::NotSent,
    }
}

/// Parameter requests the peer has received so far.
fn parameter_uris(peer: &Peer) -> Vec<String> {
    peer.uris()
        .into_iter()
        .filter(|uri| uri.starts_with("/vd/parameters"))
        .collect()
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let started = Instant::now();
    while !condition() {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "timed out waiting"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn open_checks_identity_reads_firmware_and_numbers_each_connection() {
    let peer = unit(plain);
    let first = connect(&peer);
    let second = connect(&peer);
    assert_eq!(first.firmware(), &SystemFirmware::Version("9.9.9".into()));
    assert!(second.generation() > first.generation());
    assert_eq!(
        peer.uris(),
        [
            "/vd/synchronize",
            "/vd/device",
            "/vd/synchronize",
            "/vd/device"
        ]
    );
}

#[test]
fn open_refuses_a_unit_that_is_absent_or_not_the_one_requested() {
    let identity = |code| {
        Err(Failure::Cause {
            code,
            phase: Phase::Identity,
        })
    };
    let cases = [
        (
            json!({ "sync_status": "lost" }),
            identity(Cause::DeviceNotFound),
        ),
        (online("<device-id-b>"), identity(Cause::DeviceNotFound)),
        (
            json!({ "sync_status": "online" }),
            identity(Cause::IdentityError),
        ),
        // An empty status is a status other than `online` (R1-S-A).
        (
            json!({ "sync_status": "" }),
            identity(Cause::DeviceNotFound),
        ),
        (
            json!({ "sync_status": 1 }),
            identity(Cause::InvalidResponse),
        ),
    ];
    for (sync, expected) in cases {
        let peer = Peer::serve(move |request| match uri_of(request) {
            "/vd/synchronize" => vec![get_reply("/vd/synchronize", sync.clone())],
            _ => vec![get_reply("/vd/device", firmware())],
        });
        let result = open(peer.port, ID, &options(), &Control::new())
            .map(|_| ())
            .map_err(|failed| failed.failure);
        assert_eq!(result, expected);
        assert_eq!(
            peer.uris(),
            ["/vd/synchronize"],
            "no firmware read for a refused unit"
        );
    }
}

/// The opening's `connection_lost` failure, and how the link was lost.
fn lost_while_opening(lost_link: Option<LinkLoss>) -> Result<(), LinkFailure> {
    Err(LinkFailure {
        failure: Failure::Cause {
            code: Cause::ConnectionLost,
            phase: Phase::Identity,
        },
        lost_link,
    })
}

#[test]
fn an_opening_that_loses_its_link_says_how() {
    // The unit reported lost while its firmware is read: Device Center goes on answering
    // that read from its cache.
    let lost = Peer::serve(|request| match uri_of(request) {
        "/vd/synchronize" => vec![
            get_reply("/vd/synchronize", online(ID)),
            line(
                json!({ "vdp": { "method": "notify", "uri": "/vd/synchronize", "data": { "sync_status": "lost" } } }),
            ),
        ],
        _ => vec![get_reply("/vd/device", firmware())],
    });
    let result = |peer: &Peer| open(peer.port, ID, &options(), &Control::new()).map(|_| ());
    assert_eq!(result(&lost), lost_while_opening(Some(LinkLoss::UnitLost)));
    // The peer closing the stream instead of answering the firmware read.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut requests = BufReader::new(stream);
        let mut request = String::new();
        requests.read_line(&mut request).unwrap();
        writer
            .write_all(&get_reply("/vd/synchronize", online(ID)))
            .unwrap();
        request.clear();
        requests.read_line(&mut request).unwrap();
        writer.shutdown(std::net::Shutdown::Both).unwrap();
    });
    assert_eq!(
        open(port, ID, &options(), &Control::new()).map(|_| ()),
        lost_while_opening(Some(LinkLoss::PeerClosed))
    );
    // The peer resetting the connection at each of the opening's reads.
    for answered in [vec![], vec![get_reply("/vd/synchronize", online(ID))]] {
        let read = answered.len();
        let failed = open(resetting(answered), ID, &options(), &Control::new())
            .map(|_| ())
            .unwrap_err();
        assert_eq!(
            failed.failure,
            Failure::Cause {
                code: Cause::ConnectionLost,
                phase: Phase::Identity,
            },
            "read {read}"
        );
        assert!(is_reset(failed.lost_link), "read {read}: {failed:?}");
    }
}

#[test]
fn unreadable_firmware_rows_open_the_unit_and_are_reported_as_such() {
    let system = |version: &str| json!({ "firm_name": "System", "firm_version": version });
    for rows in [
        json!({}),
        json!([{ "firm_name": "", "firm_version": "1.0" }]),
        json!([system("")]),
        json!([system("9.9.9"), system("9.9.8")]),
    ] {
        let device = json!({ "firm_list": rows.clone() });
        let peer = Peer::serve(move |request| match uri_of(request) {
            "/vd/synchronize" => vec![get_reply("/vd/synchronize", online(ID))],
            _ => vec![get_reply("/vd/device", device.clone())],
        });
        let connection = open(peer.port, ID, &options(), &Control::new()).unwrap();
        assert_eq!(connection.firmware(), &SystemFirmware::Unreadable, "{rows}");
    }
}

#[test]
fn open_fails_on_an_unreachable_or_silent_unit() {
    let result = |port| {
        open(port, ID, &options(), &Control::new())
            .map(|_| ())
            .map_err(|failed| failed.failure)
    };

    let closed = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    assert_eq!(
        result(closed),
        Err(Failure::Cause {
            code: Cause::ConnectionFailed,
            phase: Phase::Connect
        })
    );

    let silent = Peer::serve(|_| vec![]);
    let started = Instant::now();
    let short = ConnectionOptions {
        connect_deadline: Duration::from_millis(200),
        ..options()
    };
    assert_eq!(
        open(silent.port, ID, &short, &Control::new())
            .map(|_| ())
            .map_err(|failed| failed.failure),
        Err(Failure::Cause {
            code: Cause::ConnectTimeout,
            phase: Phase::Identity
        })
    );
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn reads_and_writes_complete_with_their_value_and_evidence() {
    let peer = unit(|request| {
        let uri = request["vdp"]["uri"].as_str().unwrap().to_string();
        let value = match uri.as_str() {
            "/vd/parameters/1:0:0" => json!(-32768),
            "/vd/parameters/2:0:0" => json!("01"),
            "/vd/parameters/3:0:0" => json!(4),
            _ => Value::Null,
        };
        match request["vdp"]["method"].as_str().unwrap() {
            "get" => vec![get_reply(
                &uri,
                json!({ "current_value": value, "response_code": 200 }),
            )],
            _ => vec![post_reply(&uri, json!({ "response_code": 200 }))],
        }
    });
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let cases = [
        (
            Request::GetNumeric(address(1)),
            Some(ReadValue::Numeric(-32768)),
            Evidence::Read,
        ),
        (
            Request::GetText(address(2)),
            Some(ReadValue::Text("01".into())),
            Evidence::Read,
        ),
        (
            Request::GetName(address(3)),
            Some(ReadValue::Name(NameValue::Integer(4))),
            Evidence::Read,
        ),
        (
            Request::GetName(address(2)),
            Some(ReadValue::Name(NameValue::Text("01".into()))),
            Evidence::Read,
        ),
        (Request::SetNumeric(address(1), 5), None, Evidence::Accepted),
        (
            Request::SetText(address(2), "Vox".into()),
            None,
            Evidence::Accepted,
        ),
    ];
    for (request, value, evidence) in cases {
        let rx = submit(&connection, &operation, request.clone());
        assert_eq!(
            outcome(&rx),
            Outcome::Success { value, evidence },
            "{request:?}"
        );
    }
    let sent = parameter_uris(&peer);
    assert_eq!(
        sent.len(),
        6,
        "one wire request per submitted request: {sent:?}"
    );
}

#[test]
fn a_wrong_type_or_verdict_is_an_invalid_response_and_a_refusal_keeps_its_code() {
    let peer = unit(|request| {
        let uri = request["vdp"]["uri"].as_str().unwrap().to_string();
        match (request["vdp"]["method"].as_str().unwrap(), uri.as_str()) {
            ("get", "/vd/parameters/1:0:0") => {
                vec![get_reply(&uri, json!({ "current_value": "7" }))]
            }
            ("get", "/vd/parameters/2:0:0") => vec![get_reply(&uri, json!({ "current_value": 7 }))],
            ("get", _) => vec![get_reply(&uri, json!({ "response_code": 404 }))],
            (_, "/vd/parameters/1:0:0?operation=value") => {
                vec![post_reply(&uri, json!({ "response_code": 400 }))]
            }
            _ => vec![post_reply(&uri, json!({ "response_code": "200" }))],
        }
    });
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let invalid = failed(
        RequestCause::InvalidResponse,
        RequestPhase::Response,
        Evidence::Unconfirmed,
    );
    let rejected = |code| {
        failed(
            RequestCause::DeviceRejected,
            RequestPhase::Response,
            Evidence::Rejected(code),
        )
    };
    let cases = [
        (Request::GetNumeric(address(1)), invalid.clone()),
        (Request::GetText(address(2)), invalid.clone()),
        (Request::GetNumeric(address(3)), rejected(404)),
        (Request::SetNumeric(address(1), 5), rejected(400)),
        (Request::SetNumeric(address(2), 5), invalid),
    ];
    for (request, expected) in cases {
        let rx = submit(&connection, &operation, request.clone());
        assert_eq!(outcome(&rx), expected, "{request:?}");
    }
    assert_eq!(
        connection.terminal(),
        None,
        "a bad reply does not end the connection"
    );
}

#[test]
fn notifications_and_other_replies_do_not_answer_a_request() {
    let peer = unit(|request| {
        let uri = request["vdp"]["uri"].as_str().unwrap();
        vec![
            line(
                json!({ "vdp": { "method": "notify", "uri": uri, "data": { "current_value": 1 } } }),
            ),
            post_reply(
                &format!("{uri}?operation=value"),
                json!({ "response_code": 200 }),
            ),
            get_reply("/vd/parameters/9:0:0", json!({ "current_value": 2 })),
            get_reply(uri, json!({ "current_value": 3, "response_code": 200 })),
        ]
    });
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let rx = submit(&connection, &operation, Request::GetNumeric(address(1)));
    assert_eq!(
        outcome(&rx),
        Outcome::Success {
            value: Some(ReadValue::Numeric(3)),
            evidence: Evidence::Read
        }
    );
}

/// A unit that answers each parameter request `delay` after receiving it.
/// Submits a request whose completion callback holds the worker until the
/// returned sender is used (or dropped): the worker takes nothing from the
/// queue meanwhile, and no response deadline runs out, since the reply was
/// already received.
fn hold_worker(connection: &Connection, operation: &super::Operation) -> mpsc::Sender<()> {
    let (open, gate) = mpsc::channel::<()>();
    let (entered_tx, entered) = mpsc::channel();
    connection.submit_adopted(operation, Request::GetNumeric(address(1)), move |outcome| {
        // Only a success holds: a refusal may run on the submitting thread.
        let success = matches!(outcome, Outcome::Success { .. });
        let _ = entered_tx.send(outcome);
        if success {
            let _ = gate.recv();
        }
    });
    let outcome = entered.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(outcome, Outcome::Success { .. }), "{outcome:?}");
    open
}

fn slow(delay: Duration) -> Peer {
    unit(move |request| {
        thread::sleep(delay);
        plain(request)
    })
}

#[test]
fn requests_run_one_at_a_time_in_admission_order() {
    let peer = slow(Duration::from_millis(30));
    let connection = connect(&peer);
    let a = connection.create_operation().unwrap();
    let b = connection.create_operation().unwrap();
    let receivers: Vec<_> = [(&a, 1), (&b, 2), (&a, 3), (&b, 4)]
        .into_iter()
        .map(|(operation, id)| submit(&connection, operation, Request::SetNumeric(address(id), 1)))
        .collect();
    for rx in &receivers {
        assert!(matches!(outcome(rx), Outcome::Success { .. }));
    }
    let order: Vec<String> = parameter_uris(&peer);
    assert_eq!(
        order,
        [1, 2, 3, 4].map(|id| format!("/vd/parameters/{id}:0:0?operation=value"))
    );
}

#[test]
fn the_waiting_queue_admits_exactly_its_count_limit() {
    let peer = unit(plain);
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    // The worker holds the active request's completion while the limit is
    // checked, so it frees no queue room.
    let open = hold_worker(&connection, &operation);
    let admitted: Vec<_> = (0..MAX_WAITING_REQUESTS)
        .map(|i| {
            submit(
                &connection,
                &operation,
                Request::GetNumeric(address(i as u32 + 2)),
            )
        })
        .collect();
    let refused = submit(&connection, &operation, Request::GetNumeric(address(999)));
    assert_eq!(
        outcome(&refused),
        failed(
            RequestCause::PreconditionFailed,
            RequestPhase::Admission,
            Evidence::NotSent
        )
    );
    drop(open);
    drop(admitted);
    assert_eq!(
        connection.terminal(),
        None,
        "a full queue does not end the connection"
    );
    assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
}

#[test]
fn the_waiting_queue_admits_exactly_its_byte_limit() {
    let peer = unit(plain);
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    // The worker holds the active request's completion while the limit is
    // checked, so it frees no queue room.
    let open = hold_worker(&connection, &operation);

    // A text write's frame grows by one byte per ASCII character.
    let write = |len: usize| Request::SetText(address(2), "y".repeat(len));
    let size = |len: usize| {
        frame::encode(&super::message_of(&write(len)))
            .unwrap()
            .len()
    };
    let base = size(0);
    let large = 100_000;
    let fit = MAX_WAITING_BYTES / size(large);
    assert!(
        fit < MAX_WAITING_REQUESTS,
        "the byte limit is reached first"
    );
    let mut admitted: Vec<_> = (0..fit)
        .map(|_| submit(&connection, &operation, write(large)))
        .collect();
    let left = MAX_WAITING_BYTES - fit * size(large);
    assert!(left >= base);

    let one_over = submit(&connection, &operation, write(left - base + 1));
    assert_eq!(
        outcome(&one_over),
        failed(
            RequestCause::PreconditionFailed,
            RequestPhase::Admission,
            Evidence::NotSent
        )
    );
    let exact = submit(&connection, &operation, write(left - base));
    assert!(
        exact.try_recv().is_err(),
        "a frame that exactly fills the limit is admitted"
    );
    admitted.push(exact);
    let empty = submit(&connection, &operation, write(0));
    assert_eq!(
        outcome(&empty),
        failed(
            RequestCause::PreconditionFailed,
            RequestPhase::Admission,
            Evidence::NotSent
        ),
        "nothing fits once the limit is full"
    );
    drop(open);
    drop(admitted);
    assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
}

#[test]
fn a_request_too_large_for_one_frame_is_invalid_input_and_never_sent() {
    let peer = unit(plain);
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let rx = submit(
        &connection,
        &operation,
        Request::SetText(address(1), "y".repeat(frame::MAX_FRAME_BYTES)),
    );
    assert_eq!(
        outcome(&rx),
        failed(
            RequestCause::InvalidInput,
            RequestPhase::Validation,
            Evidence::NotSent
        )
    );
    assert!(parameter_uris(&peer).is_empty());
}

#[test]
fn cancelling_an_operation_drops_only_its_waiting_requests() {
    let peer = slow(Duration::from_millis(150));
    let connection = connect(&peer);
    let a = connection.create_operation().unwrap();
    let b = connection.create_operation().unwrap();
    let a_active = submit(&connection, &a, Request::SetNumeric(address(1), 1));
    wait_until(|| parameter_uris(&peer).len() == 1);
    let a_waiting = submit(&connection, &a, Request::SetNumeric(address(2), 1));
    let b_waiting = submit(&connection, &b, Request::SetNumeric(address(3), 1));
    a.cancel();
    a.cancel();
    // Cancellation does not wait behind the active request.
    assert_eq!(
        a_waiting.recv_timeout(Duration::from_millis(50)),
        Ok(cancelled())
    );
    assert!(
        a_active.try_recv().is_err(),
        "the active request is still pending"
    );
    assert_eq!(
        outcome(&a_active),
        Outcome::Success {
            value: None,
            evidence: Evidence::Accepted
        },
        "a sent request settles normally"
    );
    assert!(matches!(outcome(&b_waiting), Outcome::Success { .. }));
    let late = submit(&connection, &a, Request::SetNumeric(address(4), 1));
    assert_eq!(outcome(&late), cancelled());
    assert_eq!(
        parameter_uris(&peer),
        [
            "/vd/parameters/1:0:0?operation=value",
            "/vd/parameters/3:0:0?operation=value"
        ]
    );
}

#[test]
fn a_request_whose_send_deadline_passes_while_waiting_is_never_sent() {
    let peer = slow(Duration::from_millis(300));
    let connection = open(
        peer.port,
        ID,
        &ConnectionOptions {
            send_deadline: Duration::from_millis(100),
            ..options()
        },
        &Control::new(),
    )
    .unwrap();
    let operation = connection.create_operation().unwrap();
    let first = submit(&connection, &operation, Request::GetNumeric(address(1)));
    let second = submit(&connection, &operation, Request::GetNumeric(address(2)));
    assert!(matches!(outcome(&first), Outcome::Success { .. }));
    assert_eq!(
        outcome(&second),
        failed(
            RequestCause::SendTimeout,
            RequestPhase::Admission,
            Evidence::NotSent
        )
    );
    assert_eq!(parameter_uris(&peer), ["/vd/parameters/1:0:0"]);
    assert_eq!(connection.terminal(), None);
}

#[test]
fn a_response_deadline_ends_the_connection_without_sending_more() {
    let peer = unit(|_| vec![]);
    let connection = open(
        peer.port,
        ID,
        &ConnectionOptions {
            response_deadline: Duration::from_millis(150),
            ..options()
        },
        &Control::new(),
    )
    .unwrap();
    let operation = connection.create_operation().unwrap();
    let write = submit(&connection, &operation, Request::SetNumeric(address(1), 1));
    let waiting = submit(&connection, &operation, Request::GetNumeric(address(2)));
    assert_eq!(
        outcome(&write),
        failed(
            RequestCause::ResponseTimeout,
            RequestPhase::Response,
            Evidence::Unconfirmed
        )
    );
    assert_eq!(
        outcome(&waiting),
        failed(
            RequestCause::ResponseTimeout,
            RequestPhase::Admission,
            Evidence::NotSent
        )
    );
    assert_eq!(connection.terminal(), Some(RequestCause::ResponseTimeout));
    let later = submit(&connection, &operation, Request::GetNumeric(address(3)));
    assert_eq!(
        outcome(&later),
        failed(
            RequestCause::NotConnected,
            RequestPhase::Admission,
            Evidence::NotSent
        )
    );
    assert!(connection.create_operation().is_err());
    assert_eq!(
        parameter_uris(&peer),
        ["/vd/parameters/1:0:0?operation=value"]
    );
}

#[test]
fn a_lost_push_or_a_closed_link_ends_the_connection() {
    let lost_mid_request = unit(|_| {
        vec![line(
            json!({ "vdp": { "method": "notify", "uri": "/vd/synchronize", "data": { "sync_status": "lost" } } }),
        )]
    });
    let connection = connect(&lost_mid_request);
    let operation = connection.create_operation().unwrap();
    let rx = submit(&connection, &operation, Request::SetNumeric(address(1), 1));
    assert_eq!(
        outcome(&rx),
        failed(
            RequestCause::ConnectionLost,
            RequestPhase::Response,
            Evidence::Unconfirmed
        )
    );
    assert_eq!(connection.terminal(), Some(RequestCause::ConnectionLost));
    assert_eq!(connection.lost_link(), Some(LinkLoss::UnitLost));

    // The unit pushes device-lost after the handshake, while nothing is active.
    let lost_idle = Peer::serve(|request| match uri_of(request) {
        "/vd/synchronize" => vec![get_reply("/vd/synchronize", online(ID))],
        _ => vec![
            get_reply("/vd/device", firmware()),
            line(
                json!({ "vdp": { "method": "notify", "uri": "/vd/synchronize", "data": { "sync_status": "offline" } } }),
            ),
        ],
    });
    let connection = connect(&lost_idle);
    wait_until(|| connection.terminal().is_some());
    assert_eq!(connection.terminal(), Some(RequestCause::ConnectionLost));
    assert_eq!(connection.lost_link(), Some(LinkLoss::UnitLost));

    // The unit closes the link when the first parameter request arrives.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut writer = stream.try_clone().unwrap();
        for request in BufReader::new(stream).lines() {
            let request: Value = serde_json::from_str(&request.unwrap()).unwrap();
            let reply = match uri_of(&request) {
                "/vd/synchronize" => get_reply("/vd/synchronize", online(ID)),
                "/vd/device" => get_reply("/vd/device", firmware()),
                _ => return,
            };
            writer.write_all(&reply).unwrap();
        }
    });
    let connection = open(port, ID, &options(), &Control::new()).unwrap();
    let operation = connection.create_operation().unwrap();
    let rx = submit(&connection, &operation, Request::GetNumeric(address(1)));
    assert_eq!(
        outcome(&rx),
        failed(
            RequestCause::ConnectionLost,
            RequestPhase::Response,
            Evidence::Unconfirmed
        )
    );
    assert_eq!(connection.terminal(), Some(RequestCause::ConnectionLost));
    assert_eq!(connection.lost_link(), Some(LinkLoss::PeerClosed));
}

#[test]
fn how_the_link_was_lost_is_known_to_requests_completed_before_the_worker_ends_it() {
    // The unit's reply to the first request is followed by a device-lost
    // push, which the reader records while that request's callback holds
    // the worker: the worker has not yet ended the connection itself.
    let held_then_lost = || {
        unit(|request| {
            let mut out = plain(request);
            if uri_of(request).starts_with("/vd/parameters/1:") {
                out.push(line(
                    json!({ "vdp": { "method": "notify", "uri": "/vd/synchronize", "data": { "sync_status": "offline" } } }),
                ));
            }
            out
        })
    };
    let lost_unsent = failed(
        RequestCause::ConnectionLost,
        RequestPhase::Admission,
        Evidence::NotSent,
    );

    // A cancellation completes the waiting request.
    let peer = held_then_lost();
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let release = hold_worker(&connection, &operation);
    wait_until(|| connection.shared.link_end().is_some());
    let waiting = submit(&connection, &operation, Request::GetNumeric(address(2)));
    operation.cancel();
    assert_eq!(outcome(&waiting), lost_unsent);
    assert_eq!(connection.terminal(), None, "the worker is still held");
    assert_eq!(connection.lost_link(), Some(LinkLoss::UnitLost));
    drop(release);
    wait_until(|| connection.terminal().is_some());
    assert_eq!(connection.lost_link(), Some(LinkLoss::UnitLost));

    // A close completes the waiting request.
    let peer = held_then_lost();
    let connection = Arc::new(connect(&peer));
    let operation = connection.create_operation().unwrap();
    let release = hold_worker(&connection, &operation);
    wait_until(|| connection.shared.link_end().is_some());
    let waiting = submit(&connection, &operation, Request::GetNumeric(address(2)));
    let closing = {
        let connection = Arc::clone(&connection);
        thread::spawn(move || connection.close(TEARDOWN))
    };
    assert_eq!(outcome(&waiting), lost_unsent);
    assert_eq!(connection.terminal(), None, "the worker is still held");
    assert_eq!(connection.lost_link(), Some(LinkLoss::UnitLost));
    drop(release);
    closing.join().unwrap();
    assert_eq!(connection.lost_link(), Some(LinkLoss::UnitLost));
}

#[test]
fn close_completes_waiting_requests_unsent_after_the_active_one_settles() {
    let peer = slow(Duration::from_millis(150));
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let active = submit(&connection, &operation, Request::SetNumeric(address(1), 1));
    wait_until(|| parameter_uris(&peer).len() == 1);
    let waiting = submit(&connection, &operation, Request::SetNumeric(address(2), 1));
    assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    assert_eq!(
        outcome(&waiting),
        failed(
            RequestCause::NotConnected,
            RequestPhase::Admission,
            Evidence::NotSent
        )
    );
    assert_eq!(
        outcome(&active),
        Outcome::Success {
            value: None,
            evidence: Evidence::Accepted
        }
    );
    assert_eq!(parameter_uris(&peer).len(), 1);
}

#[test]
fn an_operation_of_another_connection_is_not_connected() {
    let peer = unit(plain);
    let first = connect(&peer);
    let second = connect(&peer);
    let foreign = first.create_operation().unwrap();
    let rx = submit(&second, &foreign, Request::GetNumeric(address(1)));
    assert_eq!(
        outcome(&rx),
        failed(
            RequestCause::NotConnected,
            RequestPhase::Admission,
            Evidence::NotSent
        )
    );
    assert_eq!(first.close(TEARDOWN), CloseOutcome::Closed);
    let rx = submit(
        &second,
        &second.create_operation().unwrap(),
        Request::GetNumeric(address(1)),
    );
    assert!(matches!(outcome(&rx), Outcome::Success { .. }));
}

#[test]
fn an_outcome_that_ends_the_connection_is_delivered_after_the_end_is_recorded() {
    let peer = unit(|_| vec![]);
    let connection = Arc::new(
        open(
            peer.port,
            ID,
            &ConnectionOptions {
                response_deadline: Duration::from_millis(100),
                ..options()
            },
            &Control::new(),
        )
        .unwrap(),
    );
    let operation = connection.create_operation().unwrap();
    let (tx, rx) = mpsc::channel();
    let observer = Arc::clone(&connection);
    connection.submit_adopted(
        &operation,
        Request::GetNumeric(address(1)),
        move |outcome| {
            let _ = tx.send((outcome, observer.terminal()));
        },
    );
    let (outcome, terminal) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        outcome,
        failed(
            RequestCause::ResponseTimeout,
            RequestPhase::Response,
            Evidence::Unconfirmed
        )
    );
    assert_eq!(terminal, Some(RequestCause::ResponseTimeout));
}

#[test]
fn a_panicking_callback_does_not_stop_other_completions() {
    let peer = unit(plain);
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    connection.submit_adopted(&operation, Request::GetNumeric(address(1)), |_| {
        panic!("callback failure")
    });
    let next = submit(&connection, &operation, Request::GetNumeric(address(2)));
    assert!(matches!(outcome(&next), Outcome::Success { .. }));
    assert_eq!(connection.terminal(), None);

    let silent = unit(|_| vec![]);
    let connection = open(
        silent.port,
        ID,
        &ConnectionOptions {
            response_deadline: Duration::from_millis(100),
            ..options()
        },
        &Control::new(),
    )
    .unwrap();
    let operation = connection.create_operation().unwrap();
    connection.submit_adopted(&operation, Request::GetNumeric(address(1)), |_| {
        panic!("callback failure")
    });
    connection.submit_adopted(&operation, Request::GetNumeric(address(2)), |_| {
        panic!("callback failure")
    });
    let last = submit(&connection, &operation, Request::GetNumeric(address(3)));
    assert_eq!(
        outcome(&last),
        failed(
            RequestCause::ResponseTimeout,
            RequestPhase::Admission,
            Evidence::NotSent
        )
    );
    assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
}

#[test]
fn releasing_the_connection_from_a_completion_callback_does_not_deadlock() {
    for lose in [false, true] {
        let peer = if lose {
            unit(|_| {
                vec![line(
                    json!({ "vdp": { "method": "notify", "uri": "/vd/synchronize", "data": { "sync_status": "lost" } } }),
                )]
            })
        } else {
            unit(plain)
        };
        let connection = Arc::new(connect(&peer));
        let operation = connection.create_operation().unwrap();
        let (tx, rx) = mpsc::channel();
        let last = Arc::clone(&connection);
        let waiting = submit(&connection, &operation, Request::GetNumeric(address(9)));
        connection.submit_adopted(
            &operation,
            Request::GetNumeric(address(1)),
            move |outcome| {
                drop(last);
                let _ = tx.send(outcome);
            },
        );
        drop(operation);
        drop(connection);
        let result = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the callback finished");
        assert!(matches!(
            result,
            Outcome::Success { .. } | Outcome::Failure { .. }
        ));
        assert!(
            waiting.recv_timeout(Duration::from_secs(5)).is_ok(),
            "the earlier request completed"
        );
    }
}

#[test]
fn cancelling_or_closing_after_the_end_does_not_change_how_waiting_requests_end() {
    let peer = unit(|_| vec![]);
    let connection = open(
        peer.port,
        ID,
        &ConnectionOptions {
            response_deadline: Duration::from_millis(100),
            ..options()
        },
        &Control::new(),
    )
    .unwrap();
    let operation = Arc::new(connection.create_operation().unwrap());
    let other = connection.create_operation().unwrap();
    let canceller = Arc::clone(&operation);
    let (tx, active) = mpsc::channel();
    connection.submit_adopted(
        &operation,
        Request::GetNumeric(address(1)),
        move |outcome| {
            canceller.cancel();
            let _ = tx.send(outcome);
        },
    );
    let mine = submit(&connection, &operation, Request::GetNumeric(address(2)));
    let theirs = submit(&connection, &other, Request::GetNumeric(address(3)));
    assert_eq!(
        outcome(&active),
        failed(
            RequestCause::ResponseTimeout,
            RequestPhase::Response,
            Evidence::Unconfirmed
        )
    );
    let ended = failed(
        RequestCause::ResponseTimeout,
        RequestPhase::Admission,
        Evidence::NotSent,
    );
    assert_eq!(outcome(&mine), ended.clone(), "not cancelled after the end");
    assert_eq!(outcome(&theirs), ended);
    assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
}

#[test]
fn no_write_starts_after_the_link_is_reported_lost() {
    // The reply to the first write is followed by a device-lost push; the
    // first write's callback holds the worker long enough for the reader to
    // queue that push before the next write would start.
    let peer = unit(|request| {
        let uri = request["vdp"]["uri"].as_str().unwrap();
        vec![
            post_reply(uri, json!({ "response_code": 200 })),
            line(
                json!({ "vdp": { "method": "notify", "uri": "/vd/synchronize", "data": { "sync_status": "lost" } } }),
            ),
        ]
    });
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let (tx, first) = mpsc::channel();
    connection.submit_adopted(
        &operation,
        Request::SetNumeric(address(1), 1),
        move |outcome| {
            thread::sleep(Duration::from_millis(100));
            let _ = tx.send(outcome);
        },
    );
    let second = submit(&connection, &operation, Request::SetNumeric(address(2), 1));
    assert!(matches!(outcome(&first), Outcome::Success { .. }));
    assert_eq!(
        outcome(&second),
        failed(
            RequestCause::ConnectionLost,
            RequestPhase::Admission,
            Evidence::NotSent
        )
    );
    assert_eq!(
        parameter_uris(&peer),
        ["/vd/parameters/1:0:0?operation=value"]
    );
}

/// A socket stand-in that takes at most 8 bytes per write and lets a test act
/// as the reader at chosen points.
struct Scripted {
    shared: Arc<super::Shared>,
    written: Vec<u8>,
    /// Record the link's end when the n-th write is being prepared.
    end_before_write: Option<usize>,
    writes: usize,
    /// Whether the reader could record an end while a write was running.
    recordable_during_write: bool,
    /// The error the socket holds pending.
    pending: Option<std::io::ErrorKind>,
    /// Refuse the write timeout, as a reset socket does.
    refuse_timeout: bool,
    /// Fail each write: with this error, or as a closed stream (`Some(None)`).
    fail_write: Option<Option<std::io::ErrorKind>>,
    /// Interrupt the n-th write, once.
    interrupt_at: Option<usize>,
}

impl super::Outgoing for Scripted {
    fn pending_error(&self) -> Option<std::io::ErrorKind> {
        self.pending
    }

    fn set_write_timeout(&self, _: Option<Duration>) -> std::io::Result<()> {
        if self.refuse_timeout {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        if self.end_before_write == Some(self.writes) {
            self.shared
                .link_end()
                .get_or_insert(RequestCause::ConnectionLost);
        }
        Ok(())
    }

    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.interrupt_at == Some(self.writes) {
            self.interrupt_at = None;
            self.writes += 1;
            return Err(std::io::ErrorKind::Interrupted.into());
        }
        match self.fail_write {
            Some(Some(kind)) => return Err(kind.into()),
            Some(None) => return Ok(0),
            None => {}
        }
        if self.shared.link_end.try_lock().is_ok() {
            self.recordable_during_write = true;
        }
        self.writes += 1;
        let n = bytes.len().min(8);
        self.written.extend_from_slice(&bytes[..n]);
        Ok(n)
    }
}

/// The stop rule ordinary requests use, without an operation to cancel.
fn closing_only(state: &super::State) -> Option<super::Stop> {
    state.closing.then_some(super::Stop::Closing)
}

fn scripted(end_before_write: Option<usize>) -> Scripted {
    Scripted {
        shared: Arc::new(super::Shared {
            state: std::sync::Mutex::new(super::State::default()),
            link_end: std::sync::Mutex::new(None),
            loss: std::sync::Mutex::new(None),
            // No reader runs beside a scripted write.
            ops: std::sync::Mutex::new(super::SocketOps::default()),
            ops_changed: std::sync::Condvar::new(),
            settled: std::sync::Condvar::new(),
            advance: std::sync::Condvar::new(),
            expiry: Default::default(),
            notifications: None,
            deliverable: std::sync::Condvar::new(),
            delivery_stop: std::sync::atomic::AtomicBool::new(false),
            sent_registrations: std::sync::atomic::AtomicU64::new(0),
            sent_unregistrations: std::sync::atomic::AtomicU64::new(0),
            sent_gets: std::sync::atomic::AtomicU64::new(0),
            sent_sets: std::sync::atomic::AtomicU64::new(0),
            response_gate: std::sync::Mutex::new(None),
            first_byte_gate: std::sync::Mutex::new(None),
            receipt_gate: std::sync::Mutex::new(None),
        }),
        written: Vec::new(),
        end_before_write,
        writes: 0,
        recordable_during_write: false,
        pending: None,
        refuse_timeout: false,
        fail_write: None,
        interrupt_at: None,
    }
}

// How a lost connection was lost is decided with both sides' accounts in: a
// side that met only a symptom waits for the other's operation in progress —
// the writer for the reader's next read, the reader for a write — and a reset
// either met is the loss, whichever side met it and in whatever order.
#[test]
fn a_loss_is_settled_with_both_sides_accounts() {
    use super::{begin_op, end_op, settle_loss, Side, SocketOps};
    use std::io::ErrorKind::{BrokenPipe, ConnectionReset, InvalidInput};
    let reset = LinkLoss::SocketError(ConnectionReset);
    let fresh = |reading: bool| {
        let shared = Arc::clone(&scripted(None).shared);
        *super::lock(&shared.ops) = SocketOps {
            reading,
            ..SocketOps::default()
        };
        shared
    };
    let later = |shared: &Arc<super::Shared>, side: Side, met: Option<std::io::ErrorKind>| {
        let shared = Arc::clone(shared);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            end_op(&shared, side, met);
        })
    };

    // The writer met a refused timeout while the reader's read was meeting the reset.
    let shared = fresh(true);
    begin_op(&shared, Side::Reader);
    let reader = later(&shared, Side::Reader, Some(ConnectionReset));
    assert_eq!(
        settle_loss(&shared, Side::Writer, LinkLoss::SocketError(InvalidInput)),
        reset
    );
    reader.join().unwrap();

    // The reader reads on and meets nothing: the writer's own stands. The
    // reader reads the way the real one does, one read after another, so
    // the writer's wait for its next read ends whichever thread runs first.
    let shared = fresh(true);
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader = {
        let (shared, done) = (Arc::clone(&shared), Arc::clone(&done));
        thread::spawn(move || {
            while !done.load(std::sync::atomic::Ordering::SeqCst) {
                begin_op(&shared, Side::Reader);
                thread::sleep(Duration::from_millis(5));
                end_op(&shared, Side::Reader, None);
            }
        })
    };
    let pipe = LinkLoss::SocketError(BrokenPipe);
    assert_eq!(settle_loss(&shared, Side::Writer, pipe), pipe);
    done.store(true, std::sync::atomic::Ordering::SeqCst);
    reader.join().unwrap();

    // No reader reads: the writer's own, at once.
    assert_eq!(settle_loss(&fresh(false), Side::Writer, pipe), pipe);

    // The reader met the stream's end while a write was meeting the reset.
    let shared = fresh(true);
    begin_op(&shared, Side::Writer);
    let writer = later(&shared, Side::Writer, Some(ConnectionReset));
    assert_eq!(
        settle_loss(&shared, Side::Reader, LinkLoss::PeerClosed),
        reset
    );
    writer.join().unwrap();

    // No write in progress: the reader's own, at once.
    assert_eq!(
        settle_loss(&fresh(true), Side::Reader, LinkLoss::PeerClosed),
        LinkLoss::PeerClosed
    );

    // A reset already met by either side is the loss.
    let shared = fresh(true);
    begin_op(&shared, Side::Writer);
    end_op(&shared, Side::Writer, Some(ConnectionReset));
    assert_eq!(
        settle_loss(&shared, Side::Reader, LinkLoss::PeerClosed),
        reset
    );
}

// A write whose timeout the socket refuses reports the reset the socket holds,
// if it holds one, so the loss is the reset whatever the reader did meanwhile;
// with nothing pending the refusal itself is the loss.
#[test]
fn a_refused_write_timeout_gives_way_to_the_reset_the_socket_holds() {
    let frame = vec![b'x'; 30];
    let deadline = Instant::now() + Duration::from_secs(5);
    for (pending, expected) in [
        (
            Some(std::io::ErrorKind::ConnectionReset),
            std::io::ErrorKind::ConnectionReset,
        ),
        (None, std::io::ErrorKind::InvalidInput),
    ] {
        let mut sock = scripted(None);
        sock.pending = pending;
        sock.refuse_timeout = true;
        let shared = Arc::clone(&sock.shared);
        assert!(
            super::write_frame(&mut sock, &shared, &frame, deadline, &closing_only, None).is_err()
        );
        assert_eq!(
            *super::lock(&shared.loss),
            Some(LinkLoss::SocketError(expected)),
            "{pending:?}"
        );
        assert!(sock.written.is_empty());
    }
    // Likewise a write that fails, and one that writes nothing.
    let reset = LinkLoss::SocketError(std::io::ErrorKind::ConnectionReset);
    for (fail, pending, expected) in [
        (
            Some(std::io::ErrorKind::BrokenPipe),
            Some(std::io::ErrorKind::ConnectionReset),
            reset,
        ),
        (
            Some(std::io::ErrorKind::BrokenPipe),
            None,
            LinkLoss::SocketError(std::io::ErrorKind::BrokenPipe),
        ),
        (None, Some(std::io::ErrorKind::ConnectionReset), reset),
        (None, None, LinkLoss::PeerClosed),
    ] {
        let mut sock = scripted(None);
        sock.pending = pending;
        sock.fail_write = Some(fail);
        let shared = Arc::clone(&sock.shared);
        assert!(
            super::write_frame(&mut sock, &shared, &frame, deadline, &closing_only, None).is_err()
        );
        assert_eq!(
            *super::lock(&shared.loss),
            Some(expected),
            "{fail:?} {pending:?}"
        );
    }
}

// A peer that resets the operational connection: the requests in flight and
// after it fail as `connection_lost`, and the loss reads as the reset from the
// first failure through the close, however the reader and the worker meet it.
#[test]
fn a_reset_after_the_opening_is_known_as_the_reset() {
    for round in 0..20 {
        let peer = resetting(vec![
            get_reply("/vd/synchronize", online(ID)),
            get_reply("/vd/device", firmware()),
        ]);
        let connection = open(peer, ID, &options(), &Control::new()).expect("open");
        let operation = connection.create_operation().unwrap();
        let first = submit(&connection, &operation, Request::GetNumeric(address(1)));
        let second = submit(&connection, &operation, Request::GetNumeric(address(2)));
        for rx in [first, second] {
            assert!(
                matches!(outcome(&rx), Outcome::Failure { .. }),
                "round {round}: a request on a reset link fails"
            );
            assert!(
                is_reset(connection.lost_link()),
                "round {round}: {:?}",
                connection.lost_link()
            );
        }
        connection.close(TEARDOWN);
        assert!(
            is_reset(connection.lost_link()),
            "round {round} after the close: {:?}",
            connection.lost_link()
        );
    }
}

#[test]
fn a_write_does_not_start_once_waiting_for_the_state_used_up_its_budget() {
    let frame = vec![b'x'; 30];
    let mut sock = scripted(None);
    let shared = Arc::clone(&sock.shared);
    let (held_tx, held) = mpsc::channel();
    let holder = {
        let shared = Arc::clone(&shared);
        thread::spawn(move || {
            let _state = shared.lock();
            held_tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(200));
        })
    };
    held.recv().unwrap();
    let deadline = Instant::now() + Duration::from_millis(100);
    assert_eq!(
        super::write_frame(&mut sock, &shared, &frame, deadline, &closing_only, None),
        Err(super::WriteError::Failed {
            cause: RequestCause::SendTimeout,
            written: 0
        })
    );
    assert!(sock.written.is_empty());
    holder.join().unwrap();
}

#[test]
fn a_write_never_starts_after_the_reader_records_the_end() {
    let frame = vec![b'x'; 30];
    let deadline = Instant::now() + Duration::from_secs(5);
    // A frame counts as sent once written whole (R1-C-A).
    let sent = std::sync::atomic::AtomicU64::new(0);
    let count = || sent.load(std::sync::atomic::Ordering::SeqCst);

    // Recorded while the first write is being prepared: nothing goes out.
    let mut sock = scripted(Some(0));
    let shared = Arc::clone(&sock.shared);
    assert_eq!(
        super::write_frame(
            &mut sock,
            &shared,
            &frame,
            deadline,
            &closing_only,
            Some(&sent)
        ),
        Err(super::WriteError::Failed {
            cause: RequestCause::ConnectionLost,
            written: 0
        })
    );
    assert!(sock.written.is_empty());
    assert_eq!(count(), 0, "a frame never started is not sent");

    // Recorded after the first 8 bytes, while the next part is being
    // prepared: no more bytes go out, and the count says how many did.
    let mut sock = scripted(Some(1));
    let shared = Arc::clone(&sock.shared);
    assert_eq!(
        super::write_frame(
            &mut sock,
            &shared,
            &frame,
            deadline,
            &closing_only,
            Some(&sent)
        ),
        Err(super::WriteError::Failed {
            cause: RequestCause::ConnectionLost,
            written: 8
        })
    );
    assert_eq!(sock.written.len(), 8);
    assert_eq!(count(), 0, "a frame cut short is not sent");

    // Without an end the whole frame goes out, and no write ran while the
    // reader could have recorded one.
    let mut sock = scripted(None);
    let shared = Arc::clone(&sock.shared);
    assert_eq!(
        super::write_frame(
            &mut sock,
            &shared,
            &frame,
            deadline,
            &closing_only,
            Some(&sent)
        ),
        Ok(())
    );
    assert_eq!(sock.written, frame);
    assert_eq!(count(), 1);
    assert!(
        !sock.recordable_during_write,
        "the end lock is held across each write"
    );
}

#[test]
fn repeated_and_concurrent_closes_share_one_close() {
    let peer = slow(Duration::from_millis(150));
    let connection = Arc::new(connect(&peer));
    let operation = connection.create_operation().unwrap();
    let active = submit(&connection, &operation, Request::SetNumeric(address(1), 1));
    wait_until(|| parameter_uris(&peer).len() == 1);
    let closers: Vec<_> = (0..3)
        .map(|_| {
            let connection = Arc::clone(&connection);
            thread::spawn(move || connection.close(TEARDOWN))
        })
        .collect();
    for closer in closers {
        assert_eq!(closer.join().unwrap(), CloseOutcome::Closed);
    }
    assert!(
        matches!(outcome(&active), Outcome::Success { .. }),
        "the sent request settled first"
    );
    assert_eq!(
        connection.close(TEARDOWN),
        CloseOutcome::Closed,
        "a later close returns the same outcome"
    );
    assert!(connection.create_operation().is_err());
    let late = submit(&connection, &operation, Request::GetNumeric(address(2)));
    assert_eq!(
        outcome(&late),
        failed(
            RequestCause::NotConnected,
            RequestPhase::Admission,
            Evidence::NotSent
        )
    );
    assert_eq!(parameter_uris(&peer).len(), 1, "closing sent nothing");
}

#[test]
fn a_reader_that_does_not_finish_in_the_teardown_budget_is_incomplete() {
    let peer = unit(plain);
    let connection = connect(&peer);
    // Stand in for a reader that does not end: the real one is detached and
    // ends when the socket is shut down.
    let stuck = thread::spawn(|| thread::sleep(Duration::from_secs(1)));
    drop(connection.reader.lock().unwrap().replace(stuck));
    let started = Instant::now();
    let outcome = connection.close(Duration::from_millis(100));
    assert_eq!(
        outcome,
        CloseOutcome::Incomplete(Failure::Cause {
            code: Cause::TeardownTimeout,
            phase: Phase::Teardown
        })
    );
    assert!(
        started.elapsed() < Duration::from_millis(600),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(
        connection.close(TEARDOWN),
        outcome,
        "later calls get the same outcome"
    );
    assert!(connection.create_operation().is_err());
}

#[test]
fn a_close_started_from_a_callback_finishes_for_other_callers() {
    let peer = unit(plain);
    let connection = Arc::new(connect(&peer));
    let operation = connection.create_operation().unwrap();
    let (tx, started) = mpsc::channel();
    let closer = Arc::clone(&connection);
    connection.submit_adopted(&operation, Request::GetNumeric(address(1)), move |_| {
        let _ = tx.send(closer.close(TEARDOWN));
    });
    assert_eq!(
        started.recv_timeout(Duration::from_secs(5)).unwrap(),
        CloseOutcome::Started
    );
    assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
}

#[test]
fn a_second_close_from_the_same_callback_does_not_wait_for_its_own_worker() {
    let peer = unit(plain);
    let connection = Arc::new(connect(&peer));
    let operation = connection.create_operation().unwrap();
    let (tx, outcomes) = mpsc::channel();
    let closer = Arc::clone(&connection);
    connection.submit_adopted(&operation, Request::GetNumeric(address(1)), move |_| {
        let first = closer.close(TEARDOWN);
        let second = closer.close(TEARDOWN);
        let _ = tx.send((first, second));
    });
    assert_eq!(
        outcomes.recv_timeout(Duration::from_secs(5)).unwrap(),
        (CloseOutcome::Started, CloseOutcome::Started)
    );
    assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
}

#[test]
fn a_write_not_yet_started_when_closing_begins_is_never_sent() {
    let frame = vec![b'x'; 30];
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut sock = scripted(None);
    let shared = Arc::clone(&sock.shared);
    shared.lock().closing = true;
    assert_eq!(
        super::write_frame(&mut sock, &shared, &frame, deadline, &closing_only, None),
        Err(super::WriteError::Stopped(super::Stop::Closing))
    );
    assert!(sock.written.is_empty());

    // A write already under way finishes: its bytes are on the wire.
    let mut sock = scripted(None);
    let shared = Arc::clone(&sock.shared);
    struct CloseAfterFirst(Scripted);
    impl super::Outgoing for CloseAfterFirst {
        fn pending_error(&self) -> Option<std::io::ErrorKind> {
            None
        }

        fn set_write_timeout(&self, timeout: Option<Duration>) -> std::io::Result<()> {
            self.0.set_write_timeout(timeout)
        }
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let n = self.0.write(bytes)?;
            self.0.shared.lock().closing = true;
            Ok(n)
        }
    }
    let mut sock = CloseAfterFirst(std::mem::replace(&mut sock, scripted(None)));
    assert_eq!(
        super::write_frame(&mut sock, &shared, &frame, deadline, &closing_only, None),
        Ok(())
    );
    assert_eq!(sock.0.written, frame);
}

#[test]
fn a_waiting_request_callback_that_closes_does_not_hold_the_close_up() {
    let peer = slow(Duration::from_millis(150));
    let connection = Arc::new(connect(&peer));
    let operation = connection.create_operation().unwrap();
    let active = submit(&connection, &operation, Request::SetNumeric(address(1), 1));
    wait_until(|| parameter_uris(&peer).len() == 1);
    let (tx, inner) = mpsc::channel();
    let again = Arc::clone(&connection);
    connection.submit_adopted(
        &operation,
        Request::SetNumeric(address(2), 1),
        move |outcome| {
            let _ = tx.send((outcome, again.close(TEARDOWN)));
        },
    );
    let started = Instant::now();
    assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    assert!(started.elapsed() < Duration::from_secs(1));
    let (waiting, closed) = inner.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        waiting,
        failed(
            RequestCause::NotConnected,
            RequestPhase::Admission,
            Evidence::NotSent
        )
    );
    assert_eq!(
        closed,
        CloseOutcome::Started,
        "it runs on a thread the close waits for"
    );
    assert!(matches!(outcome(&active), Outcome::Success { .. }));
}

#[test]
fn a_callback_that_outlasts_the_teardown_budget_makes_the_close_incomplete() {
    let peer = unit(plain);
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let (tx, delivered) = mpsc::channel();
    connection.submit_adopted(&operation, Request::GetNumeric(address(1)), move |_| {
        let _ = tx.send(());
        thread::sleep(Duration::from_millis(600));
    });
    delivered.recv_timeout(Duration::from_secs(5)).unwrap();
    let started = Instant::now();
    let outcome = connection.close(Duration::from_millis(100));
    assert_eq!(
        outcome,
        CloseOutcome::Incomplete(Failure::Cause {
            code: Cause::TeardownTimeout,
            phase: Phase::Teardown
        })
    );
    assert!(
        started.elapsed() < Duration::from_millis(400),
        "{:?}",
        started.elapsed()
    );
    thread::sleep(Duration::from_millis(700));
    assert_eq!(
        connection.close(TEARDOWN),
        outcome,
        "the outcome does not change later"
    );
}

#[test]
fn a_slow_waiting_request_callback_is_bounded_by_the_teardown_budget() {
    let peer = slow(Duration::from_millis(100));
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let active = submit(&connection, &operation, Request::SetNumeric(address(1), 1));
    wait_until(|| parameter_uris(&peer).len() == 1);
    connection.submit_adopted(&operation, Request::SetNumeric(address(2), 1), |_| {
        thread::sleep(Duration::from_secs(1));
    });
    let started = Instant::now();
    assert_eq!(
        connection.close(Duration::from_millis(300)),
        CloseOutcome::Incomplete(Failure::Cause {
            code: Cause::TeardownTimeout,
            phase: Phase::Teardown
        }),
        "the waiting outcome was not delivered within the budget"
    );
    assert!(
        started.elapsed() < Duration::from_millis(700),
        "{:?}",
        started.elapsed()
    );
    assert!(matches!(outcome(&active), Outcome::Success { .. }));
}

#[test]
fn a_closed_connection_keeps_no_socket() {
    let peer = unit(plain);
    let connection = connect(&peer);
    assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    assert!(connection.sock.lock().unwrap().is_none());
}

#[test]
fn waiting_outcomes_are_delivered_before_closed_is_returned() {
    let peer = slow(Duration::from_millis(100));
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let active = submit(&connection, &operation, Request::SetNumeric(address(1), 1));
    wait_until(|| parameter_uris(&peer).len() == 1);
    let delivered = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    for id in [2, 3] {
        let delivered = Arc::clone(&delivered);
        connection.submit_adopted(&operation, Request::SetNumeric(address(id), 1), move |_| {
            thread::sleep(Duration::from_millis(50));
            delivered.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
    }
    assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    assert_eq!(delivered.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert!(matches!(outcome(&active), Outcome::Success { .. }));
}

#[test]
fn closing_is_visible_only_once_new_work_is_refused() {
    let peer = unit(plain);
    let connection = Arc::new(connect(&peer));
    let operation = connection.create_operation().unwrap();
    let (tx, seen) = mpsc::channel();
    let probe = Arc::clone(&connection);
    connection.submit_adopted(&operation, Request::GetNumeric(address(1)), move |_| {
        let outcome = probe.close(TEARDOWN);
        let _ = tx.send((outcome, probe.create_operation().is_err()));
    });
    let (outcome, refused) = seen.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(outcome, CloseOutcome::Started);
    assert!(refused);
    assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
}

#[test]
fn a_thread_seen_finished_only_after_the_deadline_is_incomplete() {
    let finished = thread::spawn(|| {});
    while !finished.is_finished() {
        thread::sleep(Duration::from_millis(1));
    }
    let past = Instant::now() - Duration::from_millis(1);
    assert_eq!(
        super::wait_for(
            [Some(finished), None, None, None],
            &Default::default(),
            past
        ),
        CloseOutcome::Incomplete(Failure::Cause {
            code: Cause::TeardownTimeout,
            phase: Phase::Teardown
        })
    );
    let done = thread::spawn(|| {});
    assert_eq!(
        super::wait_for(
            [Some(done), None, None, None],
            &Default::default(),
            Instant::now() + Duration::from_secs(1)
        ),
        CloseOutcome::Closed
    );
}

#[test]
fn a_thread_whose_exit_does_not_finish_cannot_hold_the_close_past_its_budget() {
    // A thread-local destructor blocks the thread's exit after its body
    // returned, so the thread reports finished while join() would block.
    struct Blocks(mpsc::Receiver<()>);
    impl Drop for Blocks {
        fn drop(&mut self) {
            let _ = self.0.recv_timeout(Duration::from_secs(2));
        }
    }
    thread_local! {
        static HOLD: std::cell::RefCell<Option<Blocks>> = const { std::cell::RefCell::new(None) };
    }
    let (release, hold) = mpsc::channel();
    let stuck = thread::spawn(move || HOLD.with(|slot| *slot.borrow_mut() = Some(Blocks(hold))));
    thread::sleep(Duration::from_millis(50));
    let started = Instant::now();
    assert_eq!(
        super::wait_for(
            [Some(stuck), None, None, None],
            &Default::default(),
            Instant::now() + Duration::from_millis(100)
        ),
        CloseOutcome::Incomplete(Failure::Cause {
            code: Cause::TeardownTimeout,
            phase: Phase::Teardown
        })
    );
    assert!(
        started.elapsed() < Duration::from_millis(400),
        "{:?}",
        started.elapsed()
    );
    drop(release);
}

/// Runs `f` with the system refusing threads started from this thread once
/// `allowed` more have started.
fn refusing_threads<T>(allowed: usize, f: impl FnOnce() -> T) -> T {
    super::REFUSE_SPAWN.with(|left| left.set(Some(allowed)));
    let result = f();
    super::REFUSE_SPAWN.with(|left| left.set(None));
    result
}

/// A peer that answers the opening and nothing else, and reports when the
/// connection's socket is closed from the other end.
fn silent_unit() -> (u16, mpsc::Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (closed_tx, closed) = mpsc::channel();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut requests = BufReader::new(stream);
        let mut request = String::new();
        for reply in [
            get_reply("/vd/synchronize", online(ID)),
            get_reply("/vd/device", firmware()),
        ] {
            request.clear();
            requests.read_line(&mut request).unwrap();
            writer.write_all(&reply).unwrap();
        }
        loop {
            request.clear();
            match requests.read_line(&mut request) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
        let _ = closed_tx.send(());
    });
    (port, closed)
}

/// A peer that answers the opening, reports when the first request after it
/// arrives, answers that one as a read once told to, and then nothing else;
/// it also reports when the connection's socket is closed from the other end.
fn unit_holding_its_first_read() -> (
    u16,
    mpsc::Receiver<()>,
    mpsc::Receiver<()>,
    mpsc::Sender<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (closed_tx, closed) = mpsc::channel();
    let (received_tx, received) = mpsc::channel();
    let (answer, answering) = mpsc::channel::<()>();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut requests = BufReader::new(stream);
        let mut request = String::new();
        for reply in [
            get_reply("/vd/synchronize", online(ID)),
            get_reply("/vd/device", firmware()),
        ] {
            request.clear();
            requests.read_line(&mut request).unwrap();
            writer.write_all(&reply).unwrap();
        }
        request.clear();
        if requests.read_line(&mut request).unwrap_or(0) > 0 {
            let _ = received_tx.send(());
            let read: Value = serde_json::from_str(&request).unwrap();
            if answering.recv().is_ok() {
                let _ = writer.write_all(&get_reply(
                    uri_of(&read),
                    json!({ "current_value": 7, "response_code": 200 }),
                ));
            }
        }
        loop {
            request.clear();
            match requests.read_line(&mut request) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
        let _ = closed_tx.send(());
    });
    (port, closed, received, answer)
}

/// Holds the response deadline of the next request `connection` sends from
/// starting until the returned sender is used or dropped.
fn hold_the_next_response_deadline(connection: &Connection) -> mpsc::Sender<()> {
    let (start, gate) = mpsc::channel();
    *super::lock(&connection.shared.response_gate) = Some(gate);
    start
}

/// Has the next close on this thread, once it has taken what waits, run
/// `then`, start the held read's response deadline and have the unit answer
/// the read.
fn answer_once_taken(
    deadline: mpsc::Sender<()>,
    answer: mpsc::Sender<()>,
    then: impl FnOnce() + 'static,
) {
    super::CLOSE_TAKEN.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            then();
            let _ = deadline.send(());
            let _ = answer.send(());
        }))
    });
}

fn could_not_finish() -> CloseOutcome {
    CloseOutcome::Incomplete(Failure::Cause {
        code: Cause::InternalError,
        phase: Phase::Teardown,
    })
}

#[test]
fn a_close_with_no_thread_to_start_completes_waiting_requests_and_returns() {
    // A read is on the wire and a write waits behind it when the system stops starting
    // threads. The close completes the waiting write unsent, closes the socket, and
    // returns that it could not finish, as does a second close; nothing panics. The read
    // is answered once the close has taken the write.
    let (port, closed, received, answer) = unit_holding_its_first_read();
    let connection = open(port, ID, &options(), &Control::new()).unwrap();
    let deadline = hold_the_next_response_deadline(&connection);
    let operation = connection.create_operation().unwrap();
    let _on_the_wire = submit(&connection, &operation, Request::GetNumeric(address(1)));
    received
        .recv_timeout(Duration::from_secs(5))
        .expect("the read on the wire");
    let waiting = submit(&connection, &operation, Request::SetNumeric(address(2), 5));
    answer_once_taken(deadline, answer, || {});
    let closed_with = refusing_threads(0, || connection.close(Duration::from_millis(300)));
    assert_eq!(closed_with, could_not_finish());
    assert_eq!(
        outcome(&waiting),
        failed(
            RequestCause::NotConnected,
            RequestPhase::Admission,
            Evidence::NotSent
        )
    );
    closed
        .recv_timeout(Duration::from_secs(2))
        .expect("the socket closed");
    assert_eq!(
        connection.close(Duration::from_millis(300)),
        could_not_finish()
    );
}

#[test]
fn repeated_bursts_keep_no_more_threads_than_they_need() {
    // Each burst holds up to eight threads, which end after lingering; the connection keeps
    // no more of their handles or identities than the threads that may still be ending.
    let peer = unit(plain);
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    for round in 0..3 {
        let answered: Vec<_> = (0..8)
            .map(|n| submit(&connection, &operation, Request::GetNumeric(address(n))))
            .collect();
        for rx in &answered {
            assert!(
                matches!(outcome(rx), Outcome::Success { .. }),
                "round {round}"
            );
        }
        wait_until(|| {
            let pool = super::lock(&connection.shared.expiry.pool);
            pool.alive == 0 && !pool.reaping
        });
        let pool = super::lock(&connection.shared.expiry.pool);
        assert!(pool.threads.is_empty(), "round {round}");
        assert!(
            pool.retired.len() <= 8,
            "round {round}: {} retired",
            pool.retired.len()
        );
        assert_eq!(
            pool.ids.len(),
            pool.retired.len(),
            "round {round}: an identity for each thread not yet joined"
        );
    }
}

#[test]
fn a_completing_thread_no_callback_holds_ends_after_its_linger() {
    let peer = unit(plain);
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let answered = submit(&connection, &operation, Request::GetNumeric(address(1)));
    assert!(matches!(outcome(&answered), Outcome::Success { .. }));
    let alive = || super::lock(&connection.shared.expiry.pool).alive;
    assert_eq!(alive(), 1, "held for the request at its admission");
    wait_until(|| alive() == 0);
}

#[test]
fn what_a_close_takes_is_delivered_even_when_the_end_stops_the_threads_right_after() {
    // A read is on the wire; a read, a write, an activation and two releases wait behind it.
    // Right after the close takes them, the end of the connection stops the completing
    // threads. Each callback still gets its result once, before the close returns. The read
    // on the wire is answered after that.
    let (port, _closed, received, answer) = unit_holding_its_first_read();
    let connection = open(port, ID, &options(), &Control::new()).unwrap();
    let deadline = hold_the_next_response_deadline(&connection);
    let operation = connection.create_operation().unwrap();
    let _on_the_wire = submit(&connection, &operation, Request::GetNumeric(address(1)));
    received
        .recv_timeout(Duration::from_secs(5))
        .expect("the read on the wire");
    let read = submit(&connection, &operation, Request::GetNumeric(address(2)));
    let write = submit(&connection, &operation, Request::SetNumeric(address(3), 5));
    let parameter = |param_id| {
        crate::subscription::SubscriptionAddress::Parameter(ParameterAddress {
            param_id,
            x: 0,
            y: 0,
        })
    };
    let token = connection.prepare_subscription(&[parameter(4)]).unwrap();
    let (tx, lifecycle) = mpsc::channel();
    let (activated, released, again) = (tx.clone(), tx.clone(), tx);
    token.activate(&operation, move |outcome| {
        let _ = activated.send(outcome);
    });
    token.release(move |outcome| {
        let _ = released.send(outcome);
    });
    token.release(move |outcome| {
        let _ = again.send(outcome);
    });
    let expiry = Arc::clone(&connection.shared.expiry);
    answer_once_taken(deadline, answer, move || {
        expiry.stop();
        // Every completing thread has ended: what was not queued before the stop has no
        // thread left to run it.
        wait_until(|| super::lock(&expiry.pool).alive == 0);
    });
    assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    let unsent = failed(
        RequestCause::NotConnected,
        RequestPhase::Admission,
        Evidence::NotSent,
    );
    assert_eq!(
        read.try_recv(),
        Ok(unsent.clone()),
        "the read, before the close returned"
    );
    assert_eq!(
        write.try_recv(),
        Ok(unsent),
        "the write, before the close returned"
    );
    for call in ["activate", "release", "release again"] {
        let outcome = lifecycle.try_recv().expect(call);
        assert_eq!(
            outcome.map_err(|failed| failed.failure),
            Err(Failure::Cause {
                code: Cause::NotConnected,
                phase: Phase::Subscription
            }),
            "{call}"
        );
    }
    assert!(lifecycle.try_recv().is_err(), "each once");
}

#[test]
fn a_waiting_callback_that_blocks_holds_up_no_close() {
    // A read is on the wire and a write waits behind it; the close completes the write on
    // the thread held for it at admission, whose callback does not return. With no thread
    // to start, the close returns that it could not finish; with threads, it returns at its
    // budget that the teardown ran out. Either way a later close returns the same. The read is
    // answered once the close has taken the write; a close that runs the write's callback
    // itself never gets there, and the case fails rather than waits.
    for refused in [true, false] {
        let (port, _closed, received, answer) = unit_holding_its_first_read();
        let connection = Arc::new(open(port, ID, &options(), &Control::new()).unwrap());
        let deadline = hold_the_next_response_deadline(&connection);
        let operation = connection.create_operation().unwrap();
        let _on_the_wire = submit(&connection, &operation, Request::GetNumeric(address(1)));
        received
            .recv_timeout(Duration::from_secs(5))
            .expect("the read on the wire");
        let (entered_tx, entered) = mpsc::channel();
        let (release, blocked) = mpsc::channel::<()>();
        connection.submit(
            &operation,
            Request::SetNumeric(address(2), 5),
            move |outcome, _| {
                let _ = entered_tx.send(outcome);
                let _ = blocked.recv();
            },
        );
        let (closed_tx, closed_with) = mpsc::channel();
        let closing = Arc::clone(&connection);
        thread::spawn(move || {
            answer_once_taken(deadline, answer, || {});
            let close = || closing.close(Duration::from_millis(50));
            let outcome = if refused {
                refusing_threads(0, close)
            } else {
                close()
            };
            let _ = closed_tx.send(outcome);
        });
        let expected = if refused {
            could_not_finish()
        } else {
            CloseOutcome::Incomplete(Failure::Cause {
                code: Cause::TeardownTimeout,
                phase: Phase::Teardown,
            })
        };
        assert_eq!(
            closed_with.recv_timeout(Duration::from_secs(5)),
            Ok(expected),
            "refused: {refused}"
        );
        assert_eq!(
            entered.recv_timeout(Duration::from_secs(5)).unwrap(),
            failed(
                RequestCause::NotConnected,
                RequestPhase::Admission,
                Evidence::NotSent
            ),
            "refused: {refused}"
        );
        assert_eq!(
            connection.close(Duration::from_millis(50)),
            expected,
            "refused: {refused}"
        );
        drop(release);
    }
}

#[test]
fn a_close_with_nothing_waiting_and_no_thread_to_start_returns() {
    let (port, closed) = silent_unit();
    let connection = open(port, ID, &options(), &Control::new()).unwrap();
    let outcome = refusing_threads(0, || connection.close(Duration::from_millis(300)));
    assert_eq!(outcome, could_not_finish());
    closed
        .recv_timeout(Duration::from_secs(2))
        .expect("the socket closed");
    assert_eq!(
        connection.close(Duration::from_millis(300)),
        could_not_finish()
    );
}

#[test]
fn a_close_from_a_callback_with_no_helper_thread_returns_what_it_could_do() {
    // A completion callback runs on the connection's own thread, which a close cannot wait
    // for; with no helper thread to finish on, the close stops what it can and returns.
    let (port, closed) = silent_unit();
    let options = ConnectionOptions {
        response_deadline: Duration::from_millis(100),
        ..options()
    };
    let connection = Arc::new(open(port, ID, &options, &Control::new()).unwrap());
    let operation = connection.create_operation().unwrap();
    let (tx, from_callback) = mpsc::channel();
    let inner = Arc::clone(&connection);
    connection.submit_adopted(&operation, Request::GetNumeric(address(1)), move |_| {
        let outcome = refusing_threads(0, || inner.close(Duration::from_millis(300)));
        let _ = tx.send(outcome);
    });
    assert_eq!(
        from_callback.recv_timeout(Duration::from_secs(5)).unwrap(),
        could_not_finish()
    );
    closed
        .recv_timeout(Duration::from_secs(2))
        .expect("the socket closed");
    assert_eq!(
        connection.close(Duration::from_millis(300)),
        could_not_finish()
    );
}

#[test]
fn an_opening_with_no_thread_to_start_fails_and_leaves_nothing_running() {
    // The connect attempt runs on a thread of its own; then the connection starts its
    // reader and worker. Whichever cannot start, the opening fails as an internal error and
    // the socket is closed.
    for allowed in 0..3 {
        let (port, closed) = silent_unit();
        let running = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        super::RUNNING.with(|counted| *counted.borrow_mut() = Some(Arc::clone(&running)));
        let result = refusing_threads(allowed, || open(port, ID, &options(), &Control::new()));
        let left = running.load(std::sync::atomic::Ordering::SeqCst);
        super::RUNNING.with(|counted| *counted.borrow_mut() = None);
        assert_eq!(
            result.map(|_| ()).map_err(|failed| failed.failure),
            Err(Failure::Cause {
                code: Cause::InternalError,
                phase: Phase::Connect
            }),
            "{allowed} thread(s) allowed"
        );
        assert_eq!(left, 0, "{allowed} thread(s) allowed: none still running");
        if allowed > 0 {
            closed
                .recv_timeout(Duration::from_secs(2))
                .expect("the socket closed");
        }
    }
}

// A parameter read or write counts in `sent_frames` once it is written whole,
// before its answer: each kind of request adds one to its own count while the
// unit holds its answer, and the answer, a refusal included, changes nothing.
// A request refused before it was sent does not count, and nor do the
// opening's own reads.
#[test]
fn a_request_counts_once_it_is_written_whole_whatever_its_answer() {
    let (answer, held) = mpsc::channel::<()>();
    let held = std::sync::Mutex::new(held);
    let peer = unit(move |request| {
        let uri = request["vdp"]["uri"].as_str().unwrap();
        let _ = held.lock().unwrap().recv_timeout(Duration::from_secs(5));
        if uri == "/vd/parameters/2:0:0?operation=value" {
            return vec![post_reply(uri, json!({ "response_code": 400 }))];
        }
        plain(request)
    });
    let connection = connect(&peer);
    assert_eq!(
        connection.sent_frames(),
        SentFrames::default(),
        "the opening's reads are not counted"
    );
    let operation = connection.create_operation().unwrap();
    let counts = |frames: SentFrames| (frames.gets, frames.sets);
    for (sent, request, added) in [
        (1, Request::GetNumeric(address(1)), (1, 0)),
        (2, Request::SetNumeric(address(2), 1), (0, 1)),
        (3, Request::SetText(address(3), "Vox".into()), (0, 1)),
        (4, Request::GetText(address(4)), (1, 0)),
        (5, Request::GetName(address(5)), (1, 0)),
    ] {
        let before = counts(connection.sent_frames());
        let name = format!("{request:?}");
        let pending = submit(&connection, &operation, request);
        wait_until(|| parameter_uris(&peer).len() == sent);
        let expected = (before.0 + added.0, before.1 + added.1);
        assert_eq!(
            counts(connection.sent_frames()),
            expected,
            "{name}: the unit holds the answer"
        );
        answer.send(()).unwrap();
        outcome(&pending);
        assert_eq!(
            counts(connection.sent_frames()),
            expected,
            "{name}: answered"
        );
    }
    let refused = connection.create_operation().unwrap();
    refused.cancel();
    assert_eq!(
        outcome(&submit(
            &connection,
            &refused,
            Request::SetNumeric(address(6), 1)
        )),
        cancelled()
    );
    assert_eq!(parameter_uris(&peer).len(), 5);
    assert_eq!(
        connection.sent_frames(),
        SentFrames {
            registrations: 0,
            unregistrations: 0,
            gets: 3,
            sets: 2,
        }
    );
}

mod lifecycle {
    use super::{connect, firmware, online, options, ID, TEARDOWN};
    use crate::connection::{
        open, CloseOutcome, Connection, ConnectionOptions, LinkLoss, SentFrames, Subscription,
    };
    use crate::lifecycle::{
        Cause, Cleanup, CleanupState, Control, Failure, LifecycleFailure, LifecycleOutcome, Phase,
    };
    use crate::subscription::SubscriptionAddress;
    use crate::test_peer::{get_reply, line, uri_of, Peer};
    use crate::wire::{MeterAddress, ParameterAddress};
    use serde_json::{json, Value};
    use std::io::{BufRead, BufReader, Write};
    use std::net::{Shutdown, TcpListener};
    use std::sync::mpsc::{self, Receiver};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    fn p(param_id: u32) -> SubscriptionAddress {
        SubscriptionAddress::Parameter(ParameterAddress {
            param_id,
            x: 0,
            y: 0,
        })
    }

    fn m(meter_id: u32) -> SubscriptionAddress {
        SubscriptionAddress::Meter(MeterAddress { meter_id, x: 0 })
    }

    /// A unit that answers registrations and unregistrations with
    /// `response_code` from `code(uri)`, after `delay`.
    fn unit(delay: Duration, code: impl Fn(&str) -> Option<i64> + Send + Sync + 'static) -> Peer {
        Peer::serve(move |request| match uri_of(request) {
            "/vd/synchronize" => vec![get_reply("/vd/synchronize", online(ID))],
            "/vd/device" => vec![get_reply("/vd/device", firmware())],
            uri => {
                thread::sleep(delay);
                match code(uri) {
                    Some(code) => vec![line(
                        json!({ "vdp": { "method": "post", "uri": uri, "data": { "response_code": code } } }),
                    )],
                    None => vec![],
                }
            }
        })
    }

    fn accepting() -> Peer {
        unit(Duration::ZERO, |_| Some(200))
    }

    fn posts(peer: &Peer) -> Vec<String> {
        peer.uris()
            .into_iter()
            .filter(|uri| uri.contains("operation="))
            .collect()
    }

    fn reg(id: u32) -> String {
        format!("/vd/parameters/{id}:0:0?operation=regist")
    }

    /// The frames the connection counts as sent are the ones the peer
    /// received (R1-C-A), however the calls that sent them ended.
    fn counted_as_received(connection: &Connection, peer: &Peer) {
        let posted = posts(peer);
        let of = |operation: &str| {
            posted
                .iter()
                .filter(|uri| uri.ends_with(&format!("operation={operation}")))
                .count() as u64
        };
        let parameters: Vec<String> = peer
            .uris()
            .into_iter()
            .filter(|uri| uri.starts_with("/vd/parameters"))
            .collect();
        assert_eq!(
            connection.sent_frames(),
            SentFrames {
                registrations: of("regist"),
                unregistrations: of("unregist"),
                gets: parameters.iter().filter(|uri| !uri.contains('?')).count() as u64,
                sets: of("value"),
            },
            "{posted:?}"
        );
    }

    fn unreg(id: u32) -> String {
        format!("/vd/parameters/{id}:0:0?operation=unregist")
    }

    fn activate(
        connection: &Connection,
        subscription: &Subscription,
    ) -> Receiver<LifecycleOutcome> {
        let operation = connection.create_operation().unwrap();
        let (tx, rx) = mpsc::channel();
        subscription.activate(&operation, move |outcome| {
            let _ = tx.send(outcome);
        });
        rx
    }

    fn release(subscription: &Subscription) -> Receiver<LifecycleOutcome> {
        let (tx, rx) = mpsc::channel();
        subscription.release(move |outcome| {
            let _ = tx.send(outcome);
        });
        rx
    }

    fn settled(rx: &Receiver<LifecycleOutcome>) -> LifecycleOutcome {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("an outcome")
    }

    fn failed(code: Cause, cleanup: Cleanup) -> LifecycleOutcome {
        Err(LifecycleFailure {
            failure: Failure::Cause {
                code,
                phase: Phase::Subscription,
            },
            cleanup,
        })
    }

    fn closed_by(code: Cause) -> Cleanup {
        Cleanup {
            state: CleanupState::ConnectionClosed,
            failure: Some(Failure::Cause {
                code,
                phase: Phase::Subscription,
            }),
        }
    }

    #[test]
    fn activation_registers_each_needed_address_once_and_release_unregisters_the_last_holder() {
        let peer = accepting();
        let connection = connect(&peer);
        let a = connection
            .prepare_subscription(&[p(1), p(2), p(1)])
            .unwrap();
        assert!(posts(&peer).is_empty(), "admission sends nothing");
        assert_eq!(settled(&activate(&connection, &a)), Ok(()));
        let b = connection.prepare_subscription(&[p(2), m(7)]).unwrap();
        assert_eq!(settled(&activate(&connection, &b)), Ok(()));
        assert_eq!(settled(&release(&a)), Ok(()));
        assert_eq!(settled(&release(&b)), Ok(()));
        assert_eq!(
            posts(&peer),
            [
                reg(1),
                reg(2),
                "/vd/meters/7:0?operation=regist".into(),
                unreg(1),
                unreg(2),
                "/vd/meters/7:0?operation=unregist".into()
            ]
        );
        counted_as_received(&connection, &peer);
    }

    #[test]
    fn a_rejected_replacement_keeps_the_old_set_and_unregisters_only_its_own_addition() {
        // Old {p, q}; new {q, r, s}; Device Center rejects s.
        let peer = unit(Duration::ZERO, |uri| {
            Some(if uri == reg(4) { 400 } else { 200 })
        });
        let connection = connect(&peer);
        let old = connection.prepare_subscription(&[p(1), p(2)]).unwrap();
        assert_eq!(settled(&activate(&connection, &old)), Ok(()));
        let new = connection
            .prepare_subscription(&[p(2), p(3), p(4)])
            .unwrap();
        assert_eq!(
            settled(&activate(&connection, &new)),
            failed(Cause::DeviceRejected, Cleanup::COMPLETE)
        );
        assert_eq!(posts(&peer), [reg(1), reg(2), reg(3), reg(4), unreg(3)]);
        counted_as_received(&connection, &peer);
        assert_eq!(
            connection.terminal(),
            None,
            "an ordinary rejection keeps the connection"
        );
        assert_eq!(settled(&release(&old)), Ok(()));
        assert_eq!(&posts(&peer)[5..], [unreg(1), unreg(2)]);
        counted_as_received(&connection, &peer);
    }

    // The count a write makes is made under the end gate it writes under, and
    // the two figures are read under it too: a read waits for a write in
    // progress, and never sees one figure moved and the other not yet.
    #[test]
    fn the_sent_frames_are_read_under_the_gate_a_write_counts_under() {
        let peer = accepting();
        let connection = std::sync::Arc::new(connect(&peer));
        let gate = connection.shared.link_end();
        let (tx, rx) = mpsc::channel();
        let reader = {
            let connection = std::sync::Arc::clone(&connection);
            thread::spawn(move || tx.send(connection.sent_frames()).unwrap())
        };
        assert!(
            rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "the read waits while the gate is held"
        );
        drop(gate);
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            SentFrames::default()
        );
        reader.join().unwrap();
    }

    #[test]
    fn releasing_a_token_never_activated_sends_nothing() {
        let peer = accepting();
        let connection = connect(&peer);
        let token = connection.prepare_subscription(&[p(1)]).unwrap();
        assert_eq!(settled(&release(&token)), Ok(()));
        assert!(posts(&peer).is_empty());
        counted_as_received(&connection, &peer);
    }

    #[test]
    fn repeated_releases_share_one_release() {
        let peer = unit(Duration::from_millis(100), |_| Some(200));
        let connection = connect(&peer);
        let token = connection.prepare_subscription(&[p(1)]).unwrap();
        assert_eq!(settled(&activate(&connection, &token)), Ok(()));
        let first = release(&token);
        let second = release(&token);
        assert_eq!(settled(&first), Ok(()));
        assert_eq!(settled(&second), Ok(()));
        assert_eq!(posts(&peer), [reg(1), unreg(1)]);
    }

    #[test]
    fn cancelling_or_releasing_during_activation_stops_and_cleans_up_once() {
        for by_release in [false, true] {
            let peer = unit(Duration::from_millis(150), |_| Some(200));
            let connection = connect(&peer);
            let token = connection
                .prepare_subscription(&[p(1), p(2), p(3)])
                .unwrap();
            let operation = connection.create_operation().unwrap();
            let (tx, activated) = mpsc::channel();
            token.activate(&operation, move |outcome| {
                let _ = tx.send(outcome);
            });
            super::wait_until(|| posts(&peer).len() == 1);
            let released = if by_release {
                Some(release(&token))
            } else {
                operation.cancel();
                None
            };
            assert_eq!(
                settled(&activated),
                Err(LifecycleFailure {
                    failure: Failure::Cancelled {
                        phase: Phase::Subscription
                    },
                    cleanup: Cleanup::COMPLETE
                })
            );
            if let Some(released) = released {
                assert_eq!(settled(&released), Ok(()));
            }
            assert_eq!(posts(&peer), [reg(1), unreg(1)], "release: {by_release}");
            counted_as_received(&connection, &peer);
        }
    }

    #[test]
    fn a_failed_cleanup_ends_the_connection() {
        let peer = unit(Duration::ZERO, |uri| {
            Some(if uri == reg(2) || uri == unreg(1) {
                400
            } else {
                200
            })
        });
        let connection = connect(&peer);
        let token = connection.prepare_subscription(&[p(1), p(2)]).unwrap();
        assert_eq!(
            settled(&activate(&connection, &token)),
            failed(Cause::DeviceRejected, closed_by(Cause::DeviceRejected))
        );
        assert!(connection.terminal().is_some());
        assert!(connection.prepare_subscription(&[p(9)]).is_err());
    }

    #[test]
    fn a_registration_without_an_answer_ends_the_connection() {
        let peer = unit(Duration::ZERO, |uri| (uri != reg(2)).then_some(200));
        let connection = open(
            peer.port,
            ID,
            &ConnectionOptions {
                response_deadline: Duration::from_millis(150),
                ..super::options()
            },
            &Control::new(),
        )
        .unwrap();
        let token = connection.prepare_subscription(&[p(1), p(2)]).unwrap();
        assert_eq!(
            settled(&activate(&connection, &token)),
            failed(
                Cause::ResponseTimeout,
                Cleanup {
                    state: CleanupState::ConnectionClosed,
                    failure: None
                }
            )
        );
        assert!(connection.terminal().is_some());
        assert_eq!(
            posts(&peer),
            [reg(1), reg(2)],
            "no unregistration after the end"
        );
        counted_as_received(&connection, &peer);
    }

    #[test]
    fn admission_is_refused_at_capacity_and_on_a_closed_connection() {
        let peer = accepting();
        let connection = Arc::new(connect(&peer));
        let tokens: Vec<_> = (0..crate::subscription::MAX_TOKENS as u32)
            .map(|i| connection.prepare_subscription(&[p(i)]).unwrap())
            .collect();
        let refused = connection.prepare_subscription(&[p(99)]).err().unwrap();
        assert_eq!(
            refused.failure,
            Failure::Cause {
                code: Cause::PreconditionFailed,
                phase: Phase::Admission
            }
        );
        assert!(posts(&peer).is_empty());
        drop(tokens);
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
        let refused = connection.prepare_subscription(&[p(1)]).err().unwrap();
        assert_eq!(
            refused.failure,
            Failure::Cause {
                code: Cause::NotConnected,
                phase: Phase::Admission
            }
        );
    }

    #[test]
    fn close_completes_pending_lifecycle_calls_without_traffic() {
        let peer = unit(Duration::from_millis(200), |_| Some(200));
        let connection = connect(&peer);
        let busy = connection.prepare_subscription(&[p(1)]).unwrap();
        let waiting = connection.prepare_subscription(&[p(2)]).unwrap();
        let first = activate(&connection, &busy);
        super::wait_until(|| posts(&peer).len() == 1);
        let second = activate(&connection, &waiting);
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
        assert_eq!(
            settled(&first),
            Ok(()),
            "the registration already sent settles"
        );
        assert!(matches!(
            settled(&second),
            Err(LifecycleFailure {
                failure: Failure::Cause {
                    code: Cause::NotConnected,
                    ..
                },
                ..
            })
        ));
        assert_eq!(
            posts(&peer),
            [reg(1), unreg(1)],
            "nothing for the waiting call; the close releases the accepted registration"
        );
    }

    #[test]
    fn a_release_asked_during_the_last_registration_cancels_the_activation() {
        let peer = unit(Duration::from_millis(150), |_| Some(200));
        let connection = connect(&peer);
        let token = connection.prepare_subscription(&[p(1)]).unwrap();
        let activated = activate(&connection, &token);
        super::wait_until(|| posts(&peer).len() == 1);
        let released = release(&token);
        assert_eq!(
            settled(&activated),
            Err(LifecycleFailure {
                failure: Failure::Cancelled {
                    phase: Phase::Subscription
                },
                cleanup: Cleanup::COMPLETE,
            }),
            "a release during activation cancels it (K37), though its only registration was sent"
        );
        assert_eq!(settled(&released), Ok(()));
        assert_eq!(posts(&peer), [reg(1), unreg(1)]);
        assert_eq!(
            settled(&activate(&connection, &token)),
            failed(Cause::PreconditionFailed, Cleanup::COMPLETE),
            "the released token cannot be activated again"
        );
    }

    #[test]
    fn callers_of_one_release_all_get_its_result_even_across_a_close() {
        for code in [200, 400] {
            let peer = unit(Duration::from_millis(150), move |uri| {
                Some(if uri.contains("unregist") { code } else { 200 })
            });
            let connection = connect(&peer);
            let token = connection.prepare_subscription(&[p(1)]).unwrap();
            assert_eq!(settled(&activate(&connection, &token)), Ok(()));
            let first = release(&token);
            super::wait_until(|| posts(&peer).len() == 2);
            let second = release(&token);
            if code == 200 {
                assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
            }
            let (a, b) = (settled(&first), settled(&second));
            assert_eq!(a, b, "code {code}");
            if code == 200 {
                assert_eq!(a, Ok(()));
            } else {
                assert_eq!(
                    a,
                    failed(Cause::DeviceRejected, closed_by(Cause::DeviceRejected))
                );
            }
            assert_eq!(posts(&peer), [reg(1), unreg(1)]);
        }
    }

    #[test]
    fn a_token_released_before_its_activation_runs_is_not_activated() {
        let peer = accepting();
        let connection = connect(&peer);
        let token = connection.prepare_subscription(&[p(1)]).unwrap();
        assert_eq!(settled(&release(&token)), Ok(()));
        assert_eq!(
            settled(&activate(&connection, &token)),
            failed(Cause::PreconditionFailed, Cleanup::COMPLETE)
        );
        assert!(posts(&peer).is_empty());
    }

    #[test]
    fn a_release_asked_during_an_automatic_cleanup_gets_the_cleanup_result() {
        for code in [200, 400] {
            let peer = unit(Duration::from_millis(150), move |uri| {
                Some(if uri == reg(2) {
                    400
                } else if uri == unreg(1) {
                    code
                } else {
                    200
                })
            });
            let connection = connect(&peer);
            let token = connection.prepare_subscription(&[p(1), p(2)]).unwrap();
            let activated = activate(&connection, &token);
            super::wait_until(|| posts(&peer).len() == 3);
            let (first, second) = (release(&token), release(&token));
            let outcome = settled(&activated);
            let (a, b) = (settled(&first), settled(&second));
            assert_eq!(a, b);
            if code == 200 {
                assert_eq!(outcome, failed(Cause::DeviceRejected, Cleanup::COMPLETE));
                assert_eq!(a, Ok(()));
            } else {
                assert_eq!(
                    a,
                    failed(Cause::DeviceRejected, closed_by(Cause::DeviceRejected))
                );
            }
            assert_eq!(posts(&peer), [reg(1), reg(2), unreg(1)], "code {code}");
        }
    }

    #[test]
    fn a_close_during_an_automatic_cleanup_leaves_its_release_callers_the_cleanup_result() {
        let peer = unit(Duration::from_millis(150), |uri| {
            Some(if uri == reg(2) { 400 } else { 200 })
        });
        let connection = connect(&peer);
        let token = connection.prepare_subscription(&[p(1), p(2)]).unwrap();
        let activated = activate(&connection, &token);
        super::wait_until(|| posts(&peer).len() == 3);
        let released = release(&token);
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
        assert_eq!(
            settled(&activated),
            failed(Cause::DeviceRejected, Cleanup::COMPLETE)
        );
        assert_eq!(
            settled(&released),
            Ok(()),
            "not answered not_connected by the close"
        );
    }

    #[test]
    fn a_refused_release_callback_can_release_cancel_and_close_again() {
        let peer = accepting();
        let connection = Arc::new(connect(&peer));
        let token = Arc::new(connection.prepare_subscription(&[p(1)]).unwrap());
        let other = Arc::new(connection.prepare_subscription(&[p(2)]).unwrap());
        let operation = Arc::new(connection.create_operation().unwrap());
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
        let (locks_tx, locks) = mpsc::channel();
        let (tx, finished) = mpsc::channel();
        let (again, then) = (Arc::clone(&token), Arc::clone(&other));
        let (op, conn) = (Arc::clone(&operation), Arc::clone(&connection));
        // On its own thread, so a callback that blocks fails this test on
        // the timeouts below instead of holding it up.
        let releasing = Arc::clone(&token);
        thread::spawn(move || {
            releasing.release(move |_| {
                let free = (
                    conn.shared.link_end.try_lock().is_ok(),
                    conn.shared.state.try_lock().is_ok(),
                );
                let _ = locks_tx.send(free);
                again.release(|_| {});
                then.release(|_| {});
                op.cancel();
                let _ = tx.send(conn.close(TEARDOWN));
            });
        });
        assert_eq!(
            locks.recv_timeout(Duration::from_secs(5)),
            Ok((true, true)),
            "(send gate, state) are free in the callback"
        );
        assert_eq!(
            finished.recv_timeout(Duration::from_secs(5)),
            Ok(CloseOutcome::Closed)
        );
    }

    #[test]
    fn a_release_after_the_connection_ended_is_refused_without_a_job() {
        let peer = accepting();
        let connection = connect(&peer);
        let token = connection.prepare_subscription(&[p(1)]).unwrap();
        assert_eq!(settled(&activate(&connection, &token)), Ok(()));
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
        assert!(matches!(
            settled(&release(&token)),
            Err(LifecycleFailure {
                failure: Failure::Cause {
                    code: Cause::NotConnected,
                    ..
                },
                ..
            })
        ));
    }

    fn unreg_of(uri: &str) -> String {
        uri.replace("operation=regist", "operation=unregist")
    }

    #[test]
    fn a_close_unregisters_the_remaining_ownership_once_per_address() {
        let peer = accepting();
        let connection = connect(&peer);
        let a = connection.prepare_subscription(&[p(2), p(1)]).unwrap();
        let b = connection.prepare_subscription(&[p(2), m(1)]).unwrap();
        let _never = connection.prepare_subscription(&[p(3)]).unwrap();
        assert_eq!(settled(&activate(&connection, &a)), Ok(()));
        assert_eq!(settled(&activate(&connection, &b)), Ok(()));
        let registered = posts(&peer);
        assert_eq!(registered.len(), 3, "{registered:?}");
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
        let mut expected = vec![unreg(1), unreg(2)];
        expected.push(unreg_of(&registered[2]));
        assert_eq!(
            posts(&peer)[3..],
            expected,
            "each registered address once, in address order; nothing for a token that never started"
        );
        counted_as_received(&connection, &peer);
    }

    #[test]
    fn a_rejected_unregistration_at_close_fails_it_and_stops_the_rest() {
        let peer = unit(Duration::ZERO, |uri| {
            Some(if uri == "/vd/parameters/1:0:0?operation=unregist" {
                409
            } else {
                200
            })
        });
        let connection = connect(&peer);
        let token = connection.prepare_subscription(&[p(1), p(2)]).unwrap();
        assert_eq!(settled(&activate(&connection, &token)), Ok(()));
        assert_eq!(
            connection.close(TEARDOWN),
            CloseOutcome::Failed(Failure::Cause {
                code: Cause::DeviceRejected,
                phase: Phase::Teardown
            })
        );
        assert_eq!(posts(&peer), [reg(1), reg(2), unreg(1)]);
        assert_eq!(
            connection.close(TEARDOWN),
            CloseOutcome::Failed(Failure::Cause {
                code: Cause::DeviceRejected,
                phase: Phase::Teardown
            }),
            "a repeated close shares the outcome and sends nothing"
        );
        assert_eq!(posts(&peer).len(), 3);
        counted_as_received(&connection, &peer);
    }

    #[test]
    fn a_link_lost_during_the_close_is_known_by_how_it_was_lost() {
        /// How the unit meets the close's unregistration.
        enum Meets {
            /// A device-lost push and no reply.
            LostPush,
            /// Its end of the link closing.
            Close,
            /// Nothing: the test shuts the connection's sending side down
            /// first, so the unregistration's write fails.
            Nothing,
        }
        let lost_at_close = |meets: Meets| {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let (keep, kept) = mpsc::channel::<()>();
            thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                let mut writer = stream.try_clone().unwrap();
                for request in BufReader::new(stream).lines() {
                    let Ok(request) = request else { break };
                    let request: Value = serde_json::from_str(&request).unwrap();
                    let uri = uri_of(&request).to_string();
                    let reply = match uri.as_str() {
                        "/vd/synchronize" => get_reply("/vd/synchronize", online(ID)),
                        "/vd/device" => get_reply("/vd/device", firmware()),
                        uri if uri.ends_with("operation=regist") => line(
                            json!({ "vdp": { "method": "post", "uri": uri, "data": { "response_code": 200 } } }),
                        ),
                        _ => match meets {
                            Meets::LostPush => line(
                                json!({ "vdp": { "method": "notify", "uri": "/vd/synchronize", "data": { "sync_status": "offline" } } }),
                            ),
                            Meets::Close => return,
                            Meets::Nothing => continue,
                        },
                    };
                    writer.write_all(&reply).unwrap();
                }
                // The link stays open until the test is done with it.
                let _ = kept.recv();
            });
            let connection = open(port, ID, &options(), &Control::new()).unwrap();
            let token = connection.prepare_subscription(&[p(1)]).unwrap();
            assert_eq!(settled(&activate(&connection, &token)), Ok(()));
            (connection, keep)
        };
        let lost = CloseOutcome::Failed(Failure::Cause {
            code: Cause::ConnectionLost,
            phase: Phase::Teardown,
        });

        let (connection, _keep) = lost_at_close(Meets::LostPush);
        assert_eq!(connection.close(TEARDOWN), lost);
        assert_eq!(connection.lost_link(), Some(LinkLoss::UnitLost));

        let (connection, _keep) = lost_at_close(Meets::Close);
        assert_eq!(connection.close(TEARDOWN), lost);
        assert_eq!(connection.lost_link(), Some(LinkLoss::PeerClosed));

        let (connection, _keep) = lost_at_close(Meets::Nothing);
        super::super::lock(&connection.sock)
            .as_ref()
            .unwrap()
            .shutdown(Shutdown::Write)
            .unwrap();
        assert_eq!(connection.close(TEARDOWN), lost);
        assert!(
            matches!(connection.lost_link(), Some(LinkLoss::SocketError(_))),
            "{:?}",
            connection.lost_link()
        );
    }

    #[test]
    fn unregistrations_at_close_stop_at_the_teardown_budget() {
        let peer = unit(Duration::from_millis(400), |_| Some(200));
        let connection = connect(&peer);
        let token = connection.prepare_subscription(&[p(1), p(2)]).unwrap();
        assert_eq!(settled(&activate(&connection, &token)), Ok(()));
        let started = std::time::Instant::now();
        assert_eq!(
            connection.close(Duration::from_millis(200)),
            CloseOutcome::Incomplete(Failure::Cause {
                code: Cause::TeardownTimeout,
                phase: Phase::Teardown
            })
        );
        assert!(
            started.elapsed() < Duration::from_millis(350),
            "{:?}",
            started.elapsed()
        );
        thread::sleep(Duration::from_millis(500));
        assert_eq!(
            posts(&peer),
            [reg(1), reg(2), unreg(1)],
            "nothing is sent after the budget"
        );
    }

    #[test]
    fn the_worker_stops_waiting_for_an_unregistration_at_the_budget() {
        let peer = unit(Duration::ZERO, |uri| {
            (!uri.contains("unregist")).then_some(200)
        });
        let connection = connect(&peer);
        let token = connection.prepare_subscription(&[p(1)]).unwrap();
        assert_eq!(settled(&activate(&connection, &token)), Ok(()));
        assert_eq!(
            connection.close(Duration::from_millis(200)),
            CloseOutcome::Incomplete(Failure::Cause {
                code: Cause::TeardownTimeout,
                phase: Phase::Teardown
            })
        );
        let started = std::time::Instant::now();
        super::wait_until(|| connection.shared.lock().teardown.is_some());
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(
            connection.shared.lock().teardown,
            Some(Some(Failure::Cause {
                code: Cause::TeardownTimeout,
                phase: Phase::Teardown
            }))
        );
        // The unregistration was written whole and never answered: it counts.
        counted_as_received(&connection, &peer);
    }

    #[test]
    fn an_empty_teardown_budget_sends_no_unregistration() {
        let peer = accepting();
        let connection = connect(&peer);
        let token = connection.prepare_subscription(&[p(1)]).unwrap();
        assert_eq!(settled(&activate(&connection, &token)), Ok(()));
        assert!(matches!(
            connection.close(Duration::ZERO),
            CloseOutcome::Incomplete(_)
        ));
        thread::sleep(Duration::from_millis(100));
        assert_eq!(posts(&peer), [reg(1)]);
        counted_as_received(&connection, &peer);
    }

    #[test]
    fn an_unregistration_response_deadline_before_the_budget_fails_the_close() {
        let peer = unit(Duration::ZERO, |uri| {
            (!uri.contains("unregist")).then_some(200)
        });
        let connection = open(
            peer.port,
            ID,
            &ConnectionOptions {
                response_deadline: Duration::from_millis(150),
                ..super::options()
            },
            &crate::lifecycle::Control::new(),
        )
        .unwrap();
        let token = connection.prepare_subscription(&[p(1)]).unwrap();
        assert_eq!(settled(&activate(&connection, &token)), Ok(()));
        assert_eq!(
            connection.close(Duration::from_millis(1200)),
            CloseOutcome::Failed(Failure::Cause {
                code: Cause::ResponseTimeout,
                phase: Phase::Teardown
            })
        );
    }

    /// Closes on another thread once the unit has received `count` POSTs.
    fn close_after(
        connection: &Arc<Connection>,
        peer: &Peer,
        count: usize,
    ) -> thread::JoinHandle<CloseOutcome> {
        super::wait_until(|| posts(peer).len() == count);
        let connection = Arc::clone(connection);
        thread::spawn(move || connection.close(TEARDOWN))
    }

    #[test]
    fn a_release_under_way_when_closing_unregisters_every_address() {
        let peer = unit(Duration::from_millis(150), |_| Some(200));
        let connection = Arc::new(connect(&peer));
        let token = connection.prepare_subscription(&[p(1), p(2)]).unwrap();
        assert_eq!(settled(&activate(&connection, &token)), Ok(()));
        let released = release(&token);
        let closer = close_after(&connection, &peer, 3);
        assert_eq!(settled(&released), Ok(()));
        assert_eq!(closer.join().unwrap(), CloseOutcome::Closed);
        assert_eq!(posts(&peer), [reg(1), reg(2), unreg(1), unreg(2)]);
    }

    #[test]
    fn the_teardown_budget_starts_after_a_release_under_way() {
        let peer = unit(Duration::from_millis(150), |_| Some(200));
        let connection = Arc::new(connect(&peer));
        let token = connection
            .prepare_subscription(&[p(1), p(2), p(3)])
            .unwrap();
        assert_eq!(settled(&activate(&connection, &token)), Ok(()));
        let released = release(&token);
        super::wait_until(|| posts(&peer).len() == 4);
        let closing = Arc::clone(&connection);
        let closer = thread::spawn(move || closing.close(Duration::from_millis(200)));
        assert_eq!(
            settled(&released),
            Ok(()),
            "its unregistrations outlast 200 ms"
        );
        assert_eq!(closer.join().unwrap(), CloseOutcome::Closed);
        assert_eq!(posts(&peer)[3..], [unreg(1), unreg(2), unreg(3)]);
    }

    #[test]
    fn a_cleanup_failing_after_the_close_fails_the_close() {
        for activation in [false, true] {
            let peer = unit(Duration::from_millis(150), move |uri| {
                Some(if uri == unreg(2) || (activation && uri == reg(3)) {
                    409
                } else {
                    200
                })
            });
            let connection = Arc::new(connect(&peer));
            let token = if activation {
                connection
                    .prepare_subscription(&[p(1), p(2), p(3)])
                    .unwrap()
            } else {
                let token = connection.prepare_subscription(&[p(1), p(2)]).unwrap();
                assert_eq!(settled(&activate(&connection, &token)), Ok(()));
                token
            };
            let outcome = if activation {
                activate(&connection, &token)
            } else {
                release(&token)
            };
            // The close comes while the first cleanup unregistration is sent.
            let before = if activation { 3 } else { 2 };
            let closer = close_after(&connection, &peer, before + 1);
            assert!(settled(&outcome).is_err());
            let closed = closer.join().unwrap();
            assert_eq!(
                closed,
                CloseOutcome::Failed(Failure::Cause {
                    code: Cause::DeviceRejected,
                    phase: Phase::Teardown
                }),
                "activation: {activation}"
            );
            assert_eq!(connection.close(TEARDOWN), closed, "the same outcome again");
            assert_eq!(
                posts(&peer).last(),
                Some(&unreg(2)),
                "nothing after the failed unregistration"
            );
        }
    }

    #[test]
    fn a_failed_activations_cleanup_under_way_when_closing_finishes() {
        let peer = unit(Duration::from_millis(150), |uri| {
            Some(if uri == reg(2) { 400 } else { 200 })
        });
        let connection = Arc::new(connect(&peer));
        let token = connection.prepare_subscription(&[p(1), p(2)]).unwrap();
        let activated = activate(&connection, &token);
        let closer = close_after(&connection, &peer, 3);
        assert_eq!(
            settled(&activated),
            failed(Cause::DeviceRejected, Cleanup::COMPLETE)
        );
        assert_eq!(closer.join().unwrap(), CloseOutcome::Closed);
        assert_eq!(posts(&peer), [reg(1), reg(2), unreg(1)]);
    }

    #[test]
    fn a_close_stops_an_acquisition_and_its_cleanup_still_runs() {
        let peer = unit(Duration::from_millis(150), |_| Some(200));
        let connection = Arc::new(connect(&peer));
        let token = connection.prepare_subscription(&[p(1), p(2)]).unwrap();
        let activated = activate(&connection, &token);
        let closer = close_after(&connection, &peer, 1);
        assert!(settled(&activated).is_err());
        assert_eq!(closer.join().unwrap(), CloseOutcome::Closed);
        assert_eq!(
            posts(&peer),
            [reg(1), unreg(1)],
            "no registration after the close; the accepted one is released once"
        );
    }

    #[test]
    fn a_close_after_the_link_ended_sends_nothing() {
        let peer = Peer::serve(|request| match uri_of(request) {
            "/vd/synchronize" => vec![get_reply("/vd/synchronize", online(ID))],
            "/vd/device" => vec![get_reply("/vd/device", firmware())],
            uri => vec![
                line(
                    json!({ "vdp": { "method": "post", "uri": uri, "data": { "response_code": 200 } } }),
                ),
                line(
                    json!({ "vdp": { "method": "notify", "uri": "/vd/synchronize", "data": { "sync_status": "lost" } } }),
                ),
            ],
        });
        let connection = connect(&peer);
        let token = connection.prepare_subscription(&[p(1)]).unwrap();
        let _ = settled(&activate(&connection, &token));
        super::wait_until(|| connection.terminal().is_some());
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
        assert_eq!(posts(&peer), [reg(1)]);
    }

    #[test]
    fn a_close_from_a_lifecycle_callback_still_unregisters() {
        let peer = accepting();
        let connection = Arc::new(connect(&peer));
        let token = connection.prepare_subscription(&[p(1)]).unwrap();
        let operation = connection.create_operation().unwrap();
        let (tx, inner) = mpsc::channel();
        let closing = Arc::clone(&connection);
        token.activate(&operation, move |_| {
            let _ = tx.send(closing.close(TEARDOWN));
        });
        assert_eq!(
            inner.recv_timeout(Duration::from_secs(5)).unwrap(),
            CloseOutcome::Started
        );
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
        assert_eq!(posts(&peer), [reg(1), unreg(1)]);
    }
}

// A write is asked whether it may start before each try at its first byte — a
// try a transient error ends sends nothing — and never once a byte is out.
#[test]
fn a_write_is_asked_before_each_try_at_its_first_byte_and_not_after() {
    for (interrupt_at, asked) in [(0, 2), (1, 1)] {
        let frame = vec![b'x'; 30];
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut sock = scripted(None);
        sock.interrupt_at = Some(interrupt_at);
        let shared = Arc::clone(&sock.shared);
        let asks = std::sync::atomic::AtomicUsize::new(0);
        let unstarted = |_: &super::State| {
            asks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            None
        };
        assert_eq!(
            super::write_frame(&mut sock, &shared, &frame, deadline, &unstarted, None),
            Ok(())
        );
        assert_eq!(
            asks.load(std::sync::atomic::Ordering::SeqCst),
            asked,
            "interrupted at write {interrupt_at}"
        );
        assert_eq!(sock.written, frame);
    }
}

#[test]
fn a_write_whose_operation_was_cancelled_before_its_first_byte_is_not_started() {
    let frame = vec![b'x'; 30];
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut sock = scripted(None);
    let shared = Arc::clone(&sock.shared);
    let cancelled = |_: &super::State| Some(super::Stop::Cancelled);
    assert_eq!(
        super::write_frame(&mut sock, &shared, &frame, deadline, &cancelled, None),
        Err(super::WriteError::Stopped(super::Stop::Cancelled))
    );
    assert!(sock.written.is_empty());
}

mod notifications {
    use super::{firmware, online, options, ID, TEARDOWN};
    use crate::connection::MAX_WAITING_REQUESTS;
    use crate::connection::{open_with, CloseOutcome, Connection, NotificationHandler};
    use crate::delivery::{NotificationBatch, MAX_PENDING_NOTIFICATIONS};
    use crate::lifecycle::{Cause, Control, Failure, Phase};
    use crate::request::{Outcome, Request, RequestCause};
    use crate::subscription::SubscriptionAddress;
    use crate::test_peer::{get_reply, line, uri_of};
    use crate::wire::{MeterAddress, Notification, ParameterAddress};
    use serde_json::{json, Value};
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::sync::{Arc, Mutex, OnceLock, Weak};
    use std::thread;
    use std::time::Duration;

    fn param(param_id: u32) -> ParameterAddress {
        ParameterAddress {
            param_id,
            x: 0,
            y: 0,
        }
    }

    fn p(param_id: u32) -> SubscriptionAddress {
        SubscriptionAddress::Parameter(param(param_id))
    }

    fn m(meter_id: u32) -> SubscriptionAddress {
        SubscriptionAddress::Meter(MeterAddress { meter_id, x: 0 })
    }

    fn notify_param(param_id: u32, value: i64) -> Vec<u8> {
        line(
            json!({ "vdp": { "method": "notify", "uri": format!("/vd/parameters/{param_id}:0:0"), "data": { "current_value": value } } }),
        )
    }

    /// A unit that answers the handshake, accepts every POST after `delay`
    /// and writes whatever lines the returned sender is given.
    fn pushing_unit(delay: Duration) -> (u16, Sender<Vec<u8>>) {
        pushing_unit_coded(delay, |_| 200)
    }

    /// `pushing_unit`, answering each POST with `code(request)`.
    fn pushing_unit_coded(delay: Duration, code: fn(&Value) -> i64) -> (u16, Sender<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (push, pushed) = mpsc::channel::<Vec<u8>>();
        thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let writer = Arc::new(Mutex::new(stream.try_clone().unwrap()));
            let replies = Arc::clone(&writer);
            thread::spawn(move || {
                for request in BufReader::new(stream).lines() {
                    let Ok(request) = request else { return };
                    let request: Value = serde_json::from_str(&request).unwrap();
                    let uri = uri_of(&request).to_string();
                    let reply = match uri.as_str() {
                        "/vd/synchronize" => get_reply("/vd/synchronize", online(ID)),
                        "/vd/device" => get_reply("/vd/device", firmware()),
                        _ if request["vdp"]["method"] == "get" => {
                            thread::sleep(delay);
                            get_reply(&uri, json!({ "current_value": 1, "response_code": 200 }))
                        }
                        _ => {
                            thread::sleep(delay);
                            line(
                                json!({ "vdp": { "method": "post", "uri": uri, "data": { "response_code": code(&request) } } }),
                            )
                        }
                    };
                    if replies.lock().unwrap().write_all(&reply).is_err() {
                        return;
                    }
                }
            });
            for bytes in pushed {
                if writer.lock().unwrap().write_all(&bytes).is_err() {
                    return;
                }
            }
        });
        (port, push)
    }

    fn connect(port: u16) -> (Connection, Receiver<NotificationBatch>) {
        let (tx, batches) = mpsc::channel();
        let tx = Mutex::new(tx);
        let handler: NotificationHandler = Arc::new(move |batch| {
            let _ = tx.lock().unwrap().send(batch);
        });
        let connection = open_with(port, ID, &options(), &Control::new(), Some(handler)).unwrap();
        (connection, batches)
    }

    fn activate(
        connection: &Connection,
        addresses: &[SubscriptionAddress],
    ) -> crate::connection::Subscription {
        let token = connection.prepare_subscription(addresses).unwrap();
        let operation = connection.create_operation().unwrap();
        let (tx, rx) = mpsc::channel();
        token.activate(&operation, move |outcome| {
            let _ = tx.send(outcome);
        });
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), Ok(()));
        token
    }

    fn next(batches: &Receiver<NotificationBatch>) -> NotificationBatch {
        batches
            .recv_timeout(Duration::from_secs(5))
            .expect("a batch")
    }

    fn numeric(record: &crate::delivery::NotificationRecord) -> (u32, i64) {
        match record.payload {
            Notification::Numeric { address, value } => (address.param_id, value),
            ref other => panic!("not numeric: {other:?}"),
        }
    }

    #[test]
    fn notifications_reach_their_tokens_in_order_one_acknowledged_batch_at_a_time() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (connection, batches) = connect(port);
        let a = activate(&connection, &[p(1), p(2)]);
        let b = activate(&connection, &[p(2)]);
        for bytes in [
            notify_param(9, 0),
            notify_param(1, 5),
            notify_param(2, 6),
            notify_param(2, 6),
        ] {
            push.send(bytes).unwrap();
        }
        let mut records = Vec::new();
        while records.len() < 3 {
            let batch = next(&batches);
            assert_eq!(batch.generation, connection.generation());
            records.extend(batch.records);
            assert!(connection.adopt_notifications(batch.ticket));
            assert!(
                !connection.adopt_notifications(batch.ticket),
                "a repeated acknowledgment"
            );
        }
        let seen: Vec<_> = records.iter().map(numeric).collect();
        assert_eq!(
            seen,
            [(1, 5), (2, 6), (2, 6)],
            "an unowned address is dropped; equal frames stay distinct"
        );
        assert_eq!(records[0].recipients, [a.token()]);
        assert_eq!(
            records[1].recipients,
            [a.token(), b.token()],
            "one record for both owners"
        );
        assert!(records[0].received_at_ms > 0);
    }

    #[test]
    fn the_next_batch_waits_for_the_acknowledgment() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (connection, batches) = connect(port);
        let _token = activate(&connection, &[p(1)]);
        push.send(notify_param(1, 1)).unwrap();
        let first = next(&batches);
        push.send(notify_param(1, 2)).unwrap();
        assert!(
            batches.recv_timeout(Duration::from_millis(200)).is_err(),
            "not before the acknowledgment"
        );
        assert!(connection.adopt_notifications(first.ticket));
        let second = next(&batches);
        assert_eq!(
            second.records.iter().map(numeric).collect::<Vec<_>>(),
            [(1, 2)]
        );
        assert!(
            !connection.adopt_notifications(first.ticket),
            "a stale ticket"
        );
    }

    #[test]
    fn an_admitted_token_receives_before_activation_and_bulk_changes_reach_parameter_holders() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (connection, batches) = connect(port);
        let waiting = connection.prepare_subscription(&[p(1)]).unwrap();
        let _meters = activate(&connection, &[m(1)]);
        push.send(notify_param(1, 3)).unwrap();
        push.send(line(
            json!({ "vdp": { "method": "notify", "uri": "/vd/parameters" } }),
        ))
        .unwrap();
        let mut records = Vec::new();
        while records.len() < 2 {
            let batch = next(&batches);
            records.extend(batch.records);
            connection.adopt_notifications(batch.ticket);
        }
        assert_eq!(records[0].recipients, [waiting.token()]);
        assert_eq!(records[1].payload, Notification::BulkChange);
        assert_eq!(
            records[1].recipients,
            [waiting.token()],
            "a meter-only token is not a recipient"
        );
    }

    #[test]
    fn a_result_waits_for_the_notifications_received_before_it() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect(port);
        let _token = activate(&connection, &[p(1)]);
        let operation = connection.create_operation().unwrap();
        let (tx, done) = mpsc::channel();
        connection.submit_adopted(&operation, Request::GetNumeric(param(5)), move |outcome| {
            let _ = tx.send(outcome);
        });
        thread::sleep(Duration::from_millis(50));
        push.send(notify_param(1, 7)).unwrap();
        let batch = next(&batches);
        assert_eq!(
            batch.records.iter().map(numeric).collect::<Vec<_>>(),
            [(1, 7)]
        );
        assert!(
            done.recv_timeout(Duration::from_millis(500)).is_err(),
            "the reply arrived, but its prior notification is not adopted"
        );
        assert!(connection.adopt_notifications(batch.ticket));
        assert!(matches!(
            done.recv_timeout(Duration::from_secs(5)).unwrap(),
            Outcome::Success { .. }
        ));
    }

    #[test]
    fn a_notification_beyond_the_budget_ends_the_connection() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (connection, _batches) = connect(port);
        let _token = activate(&connection, &[p(1)]);
        for value in 0..=(MAX_PENDING_NOTIFICATIONS as i64 + 1) {
            push.send(notify_param(1, value)).unwrap();
        }
        super::wait_until(|| connection.terminal().is_some());
        assert_eq!(
            connection.terminal(),
            Some(RequestCause::NotificationOverflow)
        );
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    }

    /// Submits a GET whose completion callback blocks the worker until the
    /// returned sender is used.
    fn block_worker(connection: &Connection) -> Sender<()> {
        let operation = connection.create_operation().unwrap();
        let (release, blocked) = mpsc::channel::<()>();
        let (entered_tx, entered) = mpsc::channel();
        connection.submit_adopted(&operation, Request::GetNumeric(param(5)), move |outcome| {
            // Only a success holds: a refusal may run on the submitting thread.
            let success = matches!(outcome, Outcome::Success { .. });
            let _ = entered_tx.send(outcome);
            if success {
                let _ = blocked.recv();
            }
        });
        let outcome = entered.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(outcome, Outcome::Success { .. }), "{outcome:?}");
        release
    }

    #[test]
    fn recipients_are_decided_at_receipt_while_the_worker_is_busy() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (connection, batches) = connect(port);
        let a = activate(&connection, &[p(1)]);
        let release = block_worker(&connection);
        push.send(notify_param(1, 1)).unwrap();
        let batch = next(&batches);
        assert_eq!(batch.records[0].recipients, [a.token()]);
        let b = connection.prepare_subscription(&[p(1)]).unwrap();
        assert!(connection.adopt_notifications(batch.ticket));
        push.send(notify_param(1, 2)).unwrap();
        let batch = next(&batches);
        assert_eq!(batch.records[0].recipients, [a.token(), b.token()]);
        release.send(()).unwrap();
    }

    #[test]
    fn the_budget_is_charged_at_receipt_while_the_worker_is_busy() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (connection, _batches) = connect(port);
        let _token = activate(&connection, &[p(1)]);
        let release = block_worker(&connection);
        for value in 0..MAX_PENDING_NOTIFICATIONS as i64 {
            push.send(notify_param(1, value)).unwrap();
        }
        let queue = connection.shared.notifications.as_ref().unwrap();
        super::wait_until(|| {
            crate::connection::lock(queue).retained().0 == MAX_PENDING_NOTIFICATIONS
        });
        assert_eq!(*connection.shared.link_end(), None, "exactly the limit");
        push.send(notify_param(1, -1)).unwrap();
        super::wait_until(|| connection.shared.link_end().is_some());
        assert_eq!(
            *connection.shared.link_end(),
            Some(RequestCause::NotificationOverflow)
        );
        release.send(()).unwrap();
        super::wait_until(|| connection.terminal().is_some());
        assert_eq!(
            connection.terminal(),
            Some(RequestCause::NotificationOverflow)
        );
    }

    #[test]
    fn a_reply_after_an_overflow_is_kept_and_the_connection_ends_with_the_overflow() {
        let (port, push) = pushing_unit(Duration::from_millis(300));
        let (connection, _batches) = connect(port);
        let _token = activate(&connection, &[p(1)]);
        let operation = connection.create_operation().unwrap();
        let (tx, done) = mpsc::channel();
        connection.submit_adopted(&operation, Request::GetNumeric(param(5)), move |outcome| {
            let _ = tx.send(outcome);
        });
        let (later_tx, later) = mpsc::channel();
        connection.submit_adopted(&operation, Request::GetNumeric(param(6)), move |outcome| {
            let _ = later_tx.send(outcome);
        });
        thread::sleep(Duration::from_millis(50));
        for value in 0..=(MAX_PENDING_NOTIFICATIONS as i64) {
            push.send(notify_param(1, value)).unwrap();
        }
        assert_eq!(
            done.recv_timeout(Duration::from_secs(5)).unwrap(),
            Outcome::failed(
                RequestCause::NotificationOverflow,
                crate::request::RequestPhase::Delivery,
                crate::request::Evidence::Read
            ),
            "the reply within its deadline is the evidence; its delivery fails"
        );
        assert!(matches!(
            later.recv_timeout(Duration::from_secs(5)).unwrap(),
            Outcome::Failure {
                evidence: crate::request::Evidence::NotSent,
                ..
            }
        ));
        assert_eq!(
            connection.terminal(),
            Some(RequestCause::NotificationOverflow)
        );
    }

    #[test]
    fn an_overflow_during_a_registration_is_its_cause() {
        let (port, push) = pushing_unit(Duration::from_millis(300));
        let (connection, _batches) = connect(port);
        let _token = activate(&connection, &[p(1)]);
        let token = connection.prepare_subscription(&[p(2)]).unwrap();
        let operation = connection.create_operation().unwrap();
        let (tx, rx) = mpsc::channel();
        token.activate(&operation, move |outcome| {
            let _ = tx.send(outcome);
        });
        thread::sleep(Duration::from_millis(50));
        for value in 0..=(MAX_PENDING_NOTIFICATIONS as i64) {
            push.send(notify_param(1, value)).unwrap();
        }
        let failure = rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap_err();
        assert_eq!(
            failure.failure,
            Failure::Cause {
                code: Cause::NotificationOverflow,
                phase: Phase::Subscription
            }
        );
        assert_eq!(
            connection.terminal(),
            Some(RequestCause::NotificationOverflow)
        );
    }

    #[test]
    fn a_ticket_of_another_connection_does_not_release_a_batch() {
        let (port_a, push_a) = pushing_unit(Duration::ZERO);
        let (port_b, push_b) = pushing_unit(Duration::ZERO);
        let (a, batches_a) = connect(port_a);
        let (b, batches_b) = connect(port_b);
        let _ta = activate(&a, &[p(1)]);
        let _tb = activate(&b, &[p(1)]);
        push_a.send(notify_param(1, 1)).unwrap();
        push_b.send(notify_param(1, 1)).unwrap();
        let first_a = next(&batches_a);
        let first_b = next(&batches_b);
        assert!(!b.adopt_notifications(first_a.ticket));
        assert!(b.adopt_notifications(first_b.ticket));
    }

    /// A connection whose delivery callback runs `on_batch` with it.
    fn connect_calling(
        port: u16,
        on_batch: impl Fn(&Connection, NotificationBatch) + Send + Sync + 'static,
    ) -> Arc<Connection> {
        let slot: Arc<OnceLock<Weak<Connection>>> = Arc::new(OnceLock::new());
        let seen = Arc::clone(&slot);
        let handler: NotificationHandler = Arc::new(move |batch| {
            if let Some(connection) = seen.get().and_then(Weak::upgrade) {
                on_batch(&connection, batch);
            }
        });
        let connection =
            Arc::new(open_with(port, ID, &options(), &Control::new(), Some(handler)).unwrap());
        slot.set(Arc::downgrade(&connection)).unwrap();
        connection
    }

    #[test]
    fn a_close_from_the_delivery_callback_does_not_wait_for_itself() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (tx, inner) = mpsc::channel();
        let tx = Mutex::new(tx);
        let connection = connect_calling(port, move |connection, _| {
            let _ = tx.lock().unwrap().send(connection.close(TEARDOWN));
        });
        let _token = activate(&connection, &[p(1)]);
        push.send(notify_param(1, 1)).unwrap();
        assert_eq!(
            inner.recv_timeout(Duration::from_secs(5)).unwrap(),
            CloseOutcome::Started
        );
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    }

    #[test]
    fn the_delivery_callback_joining_a_close_does_not_wait_for_it() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (entered_tx, entered) = mpsc::channel();
        let (go_tx, go) = mpsc::channel::<()>();
        let (tx, inner) = mpsc::channel();
        let state = Mutex::new((entered_tx, go, tx));
        let connection = connect_calling(port, move |connection, _| {
            let state = state.lock().unwrap();
            let _ = state.0.send(());
            let _ = state.1.recv();
            let _ = state.2.send(connection.close(TEARDOWN));
        });
        let _token = activate(&connection, &[p(1)]);
        push.send(notify_param(1, 1)).unwrap();
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        let closer = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || connection.close(TEARDOWN))
        };
        super::wait_until(|| connection.shared.lock().closing);
        go_tx.send(()).unwrap();
        assert_eq!(
            inner.recv_timeout(Duration::from_secs(5)).unwrap(),
            CloseOutcome::Started
        );
        assert_eq!(closer.join().unwrap(), CloseOutcome::Closed);
    }

    #[test]
    fn a_failed_delivery_callback_ends_the_connection() {
        for acknowledge in [false, true] {
            let (port, push) = pushing_unit(Duration::ZERO);
            let connection = connect_calling(port, move |connection, batch| {
                if acknowledge {
                    assert!(connection.adopt_notifications(batch.ticket));
                }
                panic!("the application failed");
            });
            let _token = activate(&connection, &[p(1)]);
            push.send(notify_param(1, 1)).unwrap();
            super::wait_until(|| connection.terminal().is_some());
            assert_eq!(connection.terminal(), Some(RequestCause::InternalError));
            assert!(connection.create_operation().is_err());
            assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
        }
    }

    fn lost() -> Vec<u8> {
        line(
            json!({ "vdp": { "method": "notify", "uri": "/vd/synchronize", "data": { "sync_status": "lost" } } }),
        )
    }

    /// Pushes one notification beyond the budget and waits until the reader
    /// has recorded the overflow.
    fn overflow(connection: &Connection, push: &Sender<Vec<u8>>) {
        for value in 0..=(MAX_PENDING_NOTIFICATIONS as i64) {
            push.send(notify_param(1, value)).unwrap();
        }
        super::wait_until(|| connection.shared.link_end().is_some());
        assert_eq!(
            *connection.shared.link_end(),
            Some(RequestCause::NotificationOverflow)
        );
    }

    fn unsent_with(cause: RequestCause) -> Outcome {
        Outcome::failed(
            cause,
            crate::request::RequestPhase::Admission,
            crate::request::Evidence::NotSent,
        )
    }

    #[test]
    fn budget_released_after_an_overflow_does_not_resume_delivery() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (connection, batches) = connect(port);
        let _token = activate(&connection, &[p(1)]);
        let release = block_worker(&connection);
        overflow(&connection, &push);
        let mut values = Vec::new();
        while values.len() < MAX_PENDING_NOTIFICATIONS {
            let batch = next(&batches);
            values.extend(batch.records.iter().map(|record| numeric(record).1));
            assert!(connection.adopt_notifications(batch.ticket));
        }
        push.send(notify_param(1, -2)).unwrap();
        assert!(
            batches.recv_timeout(Duration::from_millis(300)).is_err(),
            "nothing after the overflow"
        );
        assert_eq!(
            values,
            (0..MAX_PENDING_NOTIFICATIONS as i64).collect::<Vec<_>>(),
            "everything accepted before the overflow, in order"
        );
        release.send(()).unwrap();
    }

    #[test]
    fn a_later_failure_does_not_replace_an_overflow() {
        let (port, push) = pushing_unit(Duration::from_millis(500));
        let (connection, _batches) = connect(port);
        let _token = activate(&connection, &[p(1)]);
        let operation = connection.create_operation().unwrap();
        let (tx, done) = mpsc::channel();
        connection.submit_adopted(&operation, Request::GetNumeric(param(5)), move |outcome| {
            let _ = tx.send(outcome);
        });
        thread::sleep(Duration::from_millis(50));
        overflow(&connection, &push);
        push.send(lost()).unwrap();
        assert!(matches!(
            done.recv_timeout(Duration::from_secs(5)).unwrap(),
            Outcome::Failure {
                failure: crate::request::RequestFailure::Cause {
                    code: RequestCause::NotificationOverflow,
                    ..
                },
                ..
            }
        ));
        assert_eq!(
            connection.terminal(),
            Some(RequestCause::NotificationOverflow)
        );
    }

    #[test]
    fn a_failed_delivery_callback_does_not_replace_an_overflow() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (go_tx, go) = mpsc::channel::<()>();
        let go = Mutex::new(go);
        let connection = connect_calling(port, move |_, _| {
            let _ = go.lock().unwrap().recv();
            panic!("the application failed");
        });
        let _token = activate(&connection, &[p(1)]);
        overflow(&connection, &push);
        go_tx.send(()).unwrap();
        super::wait_until(|| connection.terminal().is_some());
        thread::sleep(Duration::from_millis(50));
        assert_eq!(
            connection.terminal(),
            Some(RequestCause::NotificationOverflow)
        );
    }

    type Seen = Arc<Mutex<Vec<crate::delivery::NotificationRecord>>>;

    /// A connection whose receipt observer keeps every record it is shown —
    /// panicking instead on a numeric value equal to `fail_on` — and whose
    /// delivery sends each batch with how many records had been seen by then.
    fn connect_observed(
        port: u16,
        fail_on: Option<i64>,
    ) -> (Connection, Receiver<(NotificationBatch, usize)>, Seen) {
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let (tx, batches) = mpsc::channel();
        let tx = Mutex::new(tx);
        let counted = Arc::clone(&seen);
        let handler: NotificationHandler = Arc::new(move |batch| {
            let observed = counted.lock().unwrap().len();
            let _ = tx.lock().unwrap().send((batch, observed));
        });
        let kept = Arc::clone(&seen);
        let observer: crate::connection::ReceiptObserver = Arc::new(move |record| {
            if let (Some(fail), Notification::Numeric { value, .. }) = (fail_on, &record.payload) {
                assert_ne!(*value, fail, "the observer failed");
            }
            kept.lock().unwrap().push(record.clone());
        });
        let connection = crate::connection::open_observed(
            port,
            ID,
            &options(),
            &Control::new(),
            handler,
            observer,
        )
        .unwrap();
        (connection, batches, seen)
    }

    fn values(records: &[crate::delivery::NotificationRecord]) -> Vec<i64> {
        records.iter().map(|record| numeric(record).1).collect()
    }

    #[test]
    fn the_receipt_observer_sees_each_queued_record_while_the_delivery_waits() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (connection, batches, seen) = connect_observed(port, None);
        let a = activate(&connection, &[p(1), p(2)]);
        push.send(notify_param(1, 1)).unwrap();
        let (first, observed) = batches.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(values(&first.records), [1]);
        assert_eq!(observed, 1, "seen before it is delivered");
        for bytes in [notify_param(9, 0), notify_param(2, 2), notify_param(1, 3)] {
            push.send(bytes).unwrap();
        }
        // The first batch is not acknowledged: nothing more is delivered, and
        // what arrives meanwhile is seen as it is received.
        super::wait_until(|| seen.lock().unwrap().len() == 3);
        assert!(batches.recv_timeout(Duration::from_millis(200)).is_err());
        let mut delivered = first.records.clone();
        assert!(connection.adopt_notifications(first.ticket));
        while delivered.len() < 3 {
            let (batch, observed) = batches.recv_timeout(Duration::from_secs(5)).unwrap();
            delivered.extend(batch.records.iter().cloned());
            assert!(observed >= delivered.len(), "seen before it is delivered");
            assert!(connection.adopt_notifications(batch.ticket));
        }
        assert_eq!(
            *seen.lock().unwrap(),
            delivered,
            "exactly the queued records, in receive order: not an unowned address"
        );
        assert_eq!(values(&delivered), [1, 2, 3]);
        assert_eq!(delivered[0].recipients, [a.token()]);
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    }

    #[test]
    fn the_receipt_observer_does_not_see_a_record_past_the_budget() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (connection, _batches, seen) = connect_observed(port, None);
        let _token = activate(&connection, &[p(1)]);
        for value in 0..=(MAX_PENDING_NOTIFICATIONS as i64 + 1) {
            push.send(notify_param(1, value)).unwrap();
        }
        super::wait_until(|| connection.terminal().is_some());
        assert_eq!(
            connection.terminal(),
            Some(RequestCause::NotificationOverflow)
        );
        assert_eq!(
            values(&seen.lock().unwrap()),
            (0..MAX_PENDING_NOTIFICATIONS as i64).collect::<Vec<_>>(),
            "neither the record past the budget nor any after"
        );
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    }

    #[test]
    fn a_failed_receipt_observer_ends_the_connection_and_queues_nothing_more() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (connection, batches, seen) = connect_observed(port, Some(2));
        let _token = activate(&connection, &[p(1)]);
        for value in 1..=3 {
            push.send(notify_param(1, value)).unwrap();
        }
        super::wait_until(|| connection.terminal().is_some());
        assert_eq!(connection.terminal(), Some(RequestCause::InternalError));
        assert_eq!(values(&seen.lock().unwrap()), [1]);
        let mut delivered = Vec::new();
        while let Ok((batch, _)) = batches.recv_timeout(Duration::from_millis(300)) {
            delivered.extend(values(&batch.records));
            connection.adopt_notifications(batch.ticket);
        }
        assert!(
            delivered.iter().all(|value| *value == 1),
            "neither the record it failed on nor any after: {delivered:?}"
        );
        assert!(connection.create_operation().is_err());
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    }

    // A failed observer stops the queueing as an overflow does, and the reader
    // goes on reading: the reply to the request on the wire is kept.
    #[test]
    fn a_reply_after_a_failed_receipt_observer_is_kept_and_the_connection_ends_with_it() {
        let accept: fn(&Value) -> i64 = |_| 200;
        let refuse: fn(&Value) -> i64 = |request| {
            if uri_of(request).ends_with("operation=value") {
                403
            } else {
                200
            }
        };
        for (code, request, evidence) in [
            (
                accept,
                Request::GetNumeric(param(5)),
                crate::request::Evidence::Read,
            ),
            (
                accept,
                Request::SetNumeric(param(5), 3),
                crate::request::Evidence::Accepted,
            ),
            (
                refuse,
                Request::SetNumeric(param(5), 3),
                crate::request::Evidence::Rejected(403),
            ),
        ] {
            let (port, push) = pushing_unit_coded(Duration::from_millis(300), code);
            let (connection, _batches, _seen) = connect_observed(port, Some(-1));
            let _token = activate(&connection, &[p(1)]);
            let operation = connection.create_operation().unwrap();
            let (tx, done) = mpsc::channel();
            connection.submit_adopted(&operation, request.clone(), move |outcome| {
                let _ = tx.send(outcome);
            });
            thread::sleep(Duration::from_millis(50));
            push.send(notify_param(1, -1)).unwrap();
            let outcome = done.recv_timeout(Duration::from_secs(5)).unwrap();
            match evidence {
                crate::request::Evidence::Rejected(_) => assert!(
                    matches!(&outcome, Outcome::Failure { evidence: found, .. } if *found == evidence),
                    "{request:?}: {outcome:?}"
                ),
                _ => assert_eq!(
                    outcome,
                    Outcome::failed(
                        RequestCause::InternalError,
                        crate::request::RequestPhase::Delivery,
                        evidence
                    ),
                    "{request:?}: the reply within its deadline is the evidence; its delivery fails"
                ),
            }
            assert_eq!(connection.terminal(), Some(RequestCause::InternalError));
            assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
        }
    }

    // The reader thread holds the observer, so whatever the observer holds is
    // let go once the connection is closed, whether it failed or not.
    #[test]
    fn the_transport_lets_go_of_the_receipt_observer_once_closed() {
        for fail in [false, true] {
            let (port, push) = pushing_unit(Duration::ZERO);
            let (held, gone) = mpsc::channel::<()>();
            let held = Mutex::new(held);
            let handler: NotificationHandler = Arc::new(|_| {});
            let observer: crate::connection::ReceiptObserver = Arc::new(move |_| {
                let _held = &held;
                assert!(!fail, "the observer failed");
            });
            let connection = crate::connection::open_observed(
                port,
                ID,
                &options(),
                &Control::new(),
                handler,
                observer,
            )
            .unwrap();
            let _token = activate(&connection, &[p(1)]);
            if fail {
                push.send(notify_param(1, 1)).unwrap();
                super::wait_until(|| connection.terminal().is_some());
            }
            assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
            assert_eq!(
                gone.recv_timeout(Duration::from_secs(1)),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected),
                "failed: {fail}; the connection is still held here"
            );
        }
    }

    /// A unit that answers the handshake and every POST, and hangs up once
    /// the returned sender is dropped.
    fn hanging_up_unit() -> (u16, Sender<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (hang_up, told) = mpsc::channel::<()>();
        thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut writer = stream.try_clone().unwrap();
            let closer = stream.try_clone().unwrap();
            thread::spawn(move || {
                let _ = told.recv();
                let _ = closer.shutdown(std::net::Shutdown::Both);
            });
            for request in BufReader::new(stream).lines() {
                let Ok(request) = request else { return };
                let request: Value = serde_json::from_str(&request).unwrap();
                let uri = uri_of(&request).to_string();
                let reply = match uri.as_str() {
                    "/vd/synchronize" => get_reply("/vd/synchronize", online(ID)),
                    "/vd/device" => get_reply("/vd/device", firmware()),
                    _ => line(
                        json!({ "vdp": { "method": "post", "uri": uri, "data": { "response_code": 200 } } }),
                    ),
                };
                if writer.write_all(&reply).is_err() {
                    return;
                }
            }
        });
        (port, hang_up)
    }

    /// Runs `then` when dropped: what a receipt observer holds, reporting when
    /// the reader lets go of it.
    struct OnDrop<F: FnMut()>(F);

    impl<F: FnMut()> Drop for OnDrop<F> {
        fn drop(&mut self) {
            (self.0)();
        }
    }

    // The observer is let go only once the reader has said it stopped
    // reading, so a close that drop starts finds the reader's end reported.
    #[test]
    fn the_reader_reports_its_end_before_it_lets_go_of_the_receipt_observer() {
        let (port, _hang_up) = hanging_up_unit();
        let slot: Arc<OnceLock<Weak<Connection>>> = Arc::new(OnceLock::new());
        let (tx, reading) = mpsc::channel();
        let probe = {
            let slot = Arc::clone(&slot);
            let tx = Mutex::new(tx);
            OnDrop(move || {
                let connection = slot.get().and_then(Weak::upgrade);
                let read = connection.map(|c| crate::connection::lock(&c.shared.ops).reading);
                let _ = tx.lock().unwrap().send(read);
            })
        };
        let observer: crate::connection::ReceiptObserver = Arc::new(move |_| {
            let _ = &probe;
        });
        let handler: NotificationHandler = Arc::new(|_| {});
        let connection = Arc::new(
            crate::connection::open_observed(
                port,
                ID,
                &options(),
                &Control::new(),
                handler,
                observer,
            )
            .unwrap(),
        );
        slot.set(Arc::downgrade(&connection)).unwrap();
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
        assert_eq!(
            reading.recv_timeout(Duration::from_secs(5)).unwrap(),
            Some(false),
            "the reader's end was reported when the observer was let go"
        );
    }

    /// What a receipt observer holds: the connection, dropped first, then
    /// `_then`, which reports once that drop, and the close it starts, return.
    struct Holding<F: FnMut()> {
        connection: Mutex<Option<Arc<Connection>>>,
        _then: OnDrop<F>,
    }

    // The observer can hold the last reference to the connection: the reader
    // then drops it as it ends, and the close that starts finishes on a
    // helper rather than waiting for the reader itself.
    #[test]
    fn a_connection_the_receipt_observer_holds_last_closes_at_once_when_the_unit_hangs_up() {
        let (port, hang_up) = hanging_up_unit();
        let (tx, returned) = mpsc::channel::<()>();
        let tx = Mutex::new(tx);
        let holding = Arc::new(Holding {
            connection: Mutex::new(None),
            _then: OnDrop(move || {
                let _ = tx.lock().unwrap().send(());
            }),
        });
        let held = Arc::clone(&holding);
        let observer: crate::connection::ReceiptObserver = Arc::new(move |_| {
            let _ = &held;
        });
        let handler: NotificationHandler = Arc::new(|_| {});
        let connection = crate::connection::open_observed(
            port,
            ID,
            &options(),
            &Control::new(),
            handler,
            observer,
        )
        .unwrap();
        *holding.connection.lock().unwrap() = Some(Arc::new(connection));
        drop(holding);
        drop(hang_up);
        assert_eq!(
            returned.recv_timeout(Duration::from_secs(1)),
            Ok(()),
            "the drop returned within a second, not at the end of the teardown budget"
        );
    }

    /// Submits `request` with `gate` and hands back its outcome's receiver.
    fn submit_gated_on(
        connection: &Connection,
        request: Request,
        gate: crate::connection::SendGate,
    ) -> Receiver<Outcome> {
        let operation = connection.create_operation().unwrap();
        let (tx, rx) = mpsc::channel();
        connection.submit_gated(&operation, request, gate, move |outcome, adoption| {
            adoption.adopt();
            let _ = tx.send(outcome);
        });
        rx
    }

    fn held() -> Outcome {
        Outcome::failed(
            RequestCause::PreconditionFailed,
            crate::request::RequestPhase::Admission,
            crate::request::Evidence::NotSent,
        )
    }

    // A request its gate refuses, or whose gate fails, completes unsent, and
    // the connection goes on.
    #[test]
    fn a_request_its_send_gate_refuses_is_not_sent_and_the_connection_goes_on() {
        let (port, _push) = pushing_unit(Duration::ZERO);
        let (connection, _batches) = connect(port);
        let refused = submit_gated_on(
            &connection,
            Request::SetNumeric(param(5), 3),
            Box::new(|| false),
        );
        assert_eq!(
            refused.recv_timeout(Duration::from_secs(5)).unwrap(),
            held()
        );
        let failed = submit_gated_on(
            &connection,
            Request::SetText(param(6), "Vox".to_string()),
            Box::new(|| panic!("the gate failed")),
        );
        assert_eq!(failed.recv_timeout(Duration::from_secs(5)).unwrap(), held());
        assert_eq!(connection.sent_frames().sets, 0, "neither went out");
        let allowed = submit_gated_on(
            &connection,
            Request::SetNumeric(param(5), 3),
            Box::new(|| true),
        );
        assert!(matches!(
            allowed.recv_timeout(Duration::from_secs(5)).unwrap(),
            Outcome::Success { .. }
        ));
        assert_eq!(connection.sent_frames().sets, 1);
        assert_eq!(connection.terminal(), None);
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    }

    /// A connection whose receipt observer sets `locked` from each numeric
    /// notification's value, and whose delivery acknowledges every batch.
    fn connect_locking(port: u16, locked: &Arc<std::sync::atomic::AtomicBool>) -> Arc<Connection> {
        let seen = Arc::clone(locked);
        let observer: crate::connection::ReceiptObserver = Arc::new(move |record| {
            if let Notification::Numeric { value, .. } = record.payload {
                seen.store(value != 0, std::sync::atomic::Ordering::SeqCst);
            }
        });
        let slot: Arc<OnceLock<Weak<Connection>>> = Arc::new(OnceLock::new());
        let adopting = Arc::clone(&slot);
        let handler: NotificationHandler = Arc::new(move |batch| {
            if let Some(connection) = adopting.get().and_then(Weak::upgrade) {
                connection.adopt_notifications(batch.ticket);
            }
        });
        let connection = Arc::new(
            crate::connection::open_observed(
                port,
                ID,
                &options(),
                &Control::new(),
                handler,
                observer,
            )
            .unwrap(),
        );
        assert!(slot.set(Arc::downgrade(&connection)).is_ok());
        connection
    }

    // The gate is asked as the request goes out, not as it is submitted: a
    // lock received while it waited behind another request holds it.
    #[test]
    fn a_send_gate_is_asked_as_the_request_goes_out_not_as_it_is_submitted() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let locked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let connection = connect_locking(port, &locked);
        let _token = activate(&connection, &[p(1)]);
        let release = block_worker(&connection);
        let open = Arc::clone(&locked);
        let write = submit_gated_on(
            &connection,
            Request::SetNumeric(param(5), 3),
            Box::new(move || !open.load(std::sync::atomic::Ordering::SeqCst)),
        );
        push.send(notify_param(1, 1)).unwrap();
        super::wait_until(|| locked.load(std::sync::atomic::Ordering::SeqCst));
        release.send(()).unwrap();
        assert_eq!(write.recv_timeout(Duration::from_secs(5)).unwrap(), held());
        assert_eq!(connection.sent_frames().sets, 0);
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    }

    // A record received while a write is between its gate and its first byte
    // is shown to the observer only once that byte is out: the gate and the
    // observer share the end gate, so the gate never misses a record received
    // before the byte it lets go.
    #[test]
    fn a_record_received_while_a_write_starts_is_seen_only_after_its_first_byte() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let locked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let connection = connect_locking(port, &locked);
        let _token = activate(&connection, &[p(1)]);
        let (go, wait) = mpsc::channel();
        *crate::connection::lock(&connection.shared.first_byte_gate) = Some(wait);
        let open = Arc::clone(&locked);
        let write = submit_gated_on(
            &connection,
            Request::SetNumeric(param(5), 3),
            Box::new(move || !open.load(std::sync::atomic::Ordering::SeqCst)),
        );
        // The write has passed its gate and holds before its first byte.
        super::wait_until(|| crate::connection::lock(&connection.shared.first_byte_gate).is_none());
        push.send(notify_param(1, 1)).unwrap();
        thread::sleep(Duration::from_millis(200));
        assert!(
            !locked.load(std::sync::atomic::Ordering::SeqCst),
            "not seen while the write starts"
        );
        go.send(()).unwrap();
        assert!(matches!(
            write.recv_timeout(Duration::from_secs(5)).unwrap(),
            Outcome::Success { .. }
        ));
        super::wait_until(|| locked.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    }

    // A notification taken out of the reader's buffer — received — before a
    // write's first byte is shown before that byte is decided: the write
    // submitted while it is between its receipt and its observer waits, and
    // its gate then holds it.
    #[test]
    fn a_notification_timed_before_a_writes_first_byte_holds_that_write() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let locked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let connection = connect_locking(port, &locked);
        let _token = activate(&connection, &[p(1)]);
        let (go, wait) = mpsc::channel();
        *crate::connection::lock(&connection.shared.receipt_gate) = Some(wait);
        push.send(notify_param(1, 1)).unwrap();
        // Timed, and held before its observer.
        super::wait_until(|| crate::connection::lock(&connection.shared.receipt_gate).is_none());
        let open = Arc::clone(&locked);
        let write = submit_gated_on(
            &connection,
            Request::SetNumeric(param(5), 3),
            Box::new(move || !open.load(std::sync::atomic::Ordering::SeqCst)),
        );
        thread::sleep(Duration::from_millis(100));
        go.send(()).unwrap();
        assert_eq!(write.recv_timeout(Duration::from_secs(5)).unwrap(), held());
        assert_eq!(connection.sent_frames().sets, 0);
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    }

    /// A gate whose value, when let go, cancels another owner of `connection`:
    /// a call into the connection, which must not meet the connection's locks.
    fn cancelling_gate(connection: &Connection) -> crate::connection::SendGate {
        let other = connection.create_operation().unwrap();
        let value = OnDrop(move || other.cancel());
        Box::new(move || {
            let _ = &value;
            true
        })
    }

    // A request taken off the queue by a close lets go of its gate outside
    // the connection's locks, and completes once.
    #[test]
    fn a_gate_a_close_takes_is_let_go_outside_the_locks() {
        let (port, _push) = pushing_unit(Duration::ZERO);
        let (connection, _batches) = connect(port);
        let connection = Arc::new(connection);
        let release = block_worker(&connection);
        let waiting = submit_gated_on(
            &connection,
            Request::SetNumeric(param(5), 3),
            cancelling_gate(&connection),
        );
        let closing = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || connection.close(TEARDOWN))
        };
        assert!(matches!(
            waiting.recv_timeout(Duration::from_secs(5)).unwrap(),
            Outcome::Failure {
                evidence: crate::request::Evidence::NotSent,
                ..
            }
        ));
        assert!(
            waiting.recv_timeout(Duration::from_millis(100)).is_err(),
            "once"
        );
        release.send(()).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while !closing.is_finished() {
            assert!(std::time::Instant::now() < until, "the close finishes");
            thread::sleep(Duration::from_millis(5));
        }
    }

    // A request that expires while a result is held lets go of its gate on
    // its completing thread, outside the locks, and completes once.
    #[test]
    fn a_gate_an_expiry_takes_is_let_go_outside_the_locks() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect_short(port);
        let _token = activate(&connection, &[p(1)]);
        let operation = connection.create_operation().unwrap();
        let _held = submit_held(&connection, &operation, 5);
        thread::sleep(Duration::from_millis(20));
        push.send(notify_param(1, 1)).unwrap();
        let _first = next(&batches);
        thread::sleep(Duration::from_millis(400));
        let waiting = submit_gated_on(
            &connection,
            Request::SetNumeric(param(6), 3),
            cancelling_gate(&connection),
        );
        assert_eq!(
            waiting.recv_timeout(Duration::from_secs(2)).unwrap(),
            unsent_with(RequestCause::SendTimeout)
        );
        assert!(
            waiting.recv_timeout(Duration::from_millis(100)).is_err(),
            "once"
        );
    }

    #[test]
    fn requests_waiting_at_an_overflow_end_with_it_on_close_or_cancel() {
        for close in [true, false] {
            let (port, push) = pushing_unit(Duration::ZERO);
            let (connection, _batches) = connect(port);
            let connection = Arc::new(connection);
            let _token = activate(&connection, &[p(1)]);
            let release = block_worker(&connection);
            let operation = connection.create_operation().unwrap();
            let (tx, done) = mpsc::channel();
            connection.submit_adopted(&operation, Request::GetNumeric(param(6)), move |outcome| {
                let _ = tx.send(outcome);
            });
            overflow(&connection, &push);
            let closer = if close {
                let connection = Arc::clone(&connection);
                Some(thread::spawn(move || connection.close(TEARDOWN)))
            } else {
                operation.cancel();
                None
            };
            assert_eq!(
                done.recv_timeout(Duration::from_secs(5)).unwrap(),
                unsent_with(RequestCause::NotificationOverflow),
                "close: {close}"
            );
            release.send(()).unwrap();
            if let Some(closer) = closer {
                assert_eq!(closer.join().unwrap(), CloseOutcome::Closed);
            }
        }
    }

    /// Submits a GET whose outcome and adoption are handed to the test.
    fn submit_held(
        connection: &Connection,
        operation: &crate::connection::Operation,
        param_id: u32,
    ) -> Receiver<(Outcome, crate::connection::ResultAdoption)> {
        let (tx, rx) = mpsc::channel();
        connection.submit(
            operation,
            Request::GetNumeric(param(param_id)),
            move |outcome, adoption| {
                let _ = tx.send((outcome, adoption));
            },
        );
        rx
    }

    #[test]
    fn a_result_holds_the_wire_slot_until_it_is_adopted() {
        let (port, _push) = pushing_unit(Duration::ZERO);
        let (connection, _batches) = connect(port);
        let operation = connection.create_operation().unwrap();
        let first = submit_held(&connection, &operation, 5);
        let second = submit_held(&connection, &operation, 6);
        let (outcome, adoption) = first.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(outcome, Outcome::Success { .. }));
        assert!(
            second.recv_timeout(Duration::from_millis(300)).is_err(),
            "nothing is sent before the adoption"
        );
        assert!(adoption.adopt());
        let (outcome, adoption) = second.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(outcome, Outcome::Success { .. }));
        assert!(adoption.adopt());
    }

    #[test]
    fn an_unsent_completion_holds_nothing() {
        let (port, _push) = pushing_unit(Duration::ZERO);
        let (connection, _batches) = connect(port);
        let operation = connection.create_operation().unwrap();
        operation.cancel();
        let (outcome, adoption) = submit_held(&connection, &operation, 5)
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        assert!(matches!(outcome, Outcome::Failure { .. }));
        assert!(!adoption.adopt(), "no result is held");
        let other = connection.create_operation().unwrap();
        let (outcome, _) = submit_held(&connection, &other, 6)
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        assert!(matches!(outcome, Outcome::Success { .. }));
    }

    #[test]
    fn later_notifications_do_not_move_the_cutoff() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect(port);
        let _token = activate(&connection, &[p(1)]);
        let operation = connection.create_operation().unwrap();
        let held = submit_held(&connection, &operation, 5);
        thread::sleep(Duration::from_millis(50));
        push.send(notify_param(1, 1)).unwrap();
        let first = next(&batches);
        // The reply arrives at about 200 ms; these arrive after it.
        thread::sleep(Duration::from_millis(400));
        for value in 2..6 {
            push.send(notify_param(1, value)).unwrap();
        }
        thread::sleep(Duration::from_millis(100));
        assert!(held.try_recv().is_err());
        assert!(connection.adopt_notifications(first.ticket));
        let (outcome, adoption) = held.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(outcome, Outcome::Success { .. }));
        assert!(adoption.adopt());
        let later = next(&batches);
        assert_eq!(
            later.records.iter().map(numeric).collect::<Vec<_>>(),
            [(1, 2), (1, 3), (1, 4), (1, 5)],
            "still pending, not required by the result"
        );
    }

    #[test]
    fn an_end_while_a_result_is_held_fails_its_delivery_with_its_evidence() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect(port);
        let _token = activate(&connection, &[p(1)]);
        let operation = connection.create_operation().unwrap();
        let held = submit_held(&connection, &operation, 5);
        let waiting = submit_held(&connection, &operation, 6);
        thread::sleep(Duration::from_millis(50));
        push.send(notify_param(1, 1)).unwrap();
        let _first = next(&batches);
        thread::sleep(Duration::from_millis(400));
        push.send(lost()).unwrap();
        let (outcome, adoption) = held.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            outcome,
            Outcome::failed(
                RequestCause::ConnectionLost,
                crate::request::RequestPhase::Delivery,
                crate::request::Evidence::Read
            )
        );
        assert!(!adoption.adopt());
        assert_eq!(
            waiting.recv_timeout(Duration::from_secs(5)).unwrap().0,
            unsent_with(RequestCause::ConnectionLost)
        );
        assert_eq!(connection.terminal(), Some(RequestCause::ConnectionLost));
    }

    #[test]
    fn a_close_does_not_wait_for_a_stalled_application() {
        // Held for its prior notification, then for its adoption.
        for adopt_batch in [false, true] {
            let (port, push) = pushing_unit(Duration::from_millis(200));
            let (connection, batches) = connect(port);
            let _token = activate(&connection, &[p(1)]);
            let operation = connection.create_operation().unwrap();
            let held = submit_held(&connection, &operation, 5);
            thread::sleep(Duration::from_millis(50));
            push.send(notify_param(1, 1)).unwrap();
            let first = next(&batches);
            if adopt_batch {
                assert!(connection.adopt_notifications(first.ticket));
            }
            thread::sleep(Duration::from_millis(400));
            assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
            let (outcome, _) = held.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(
                matches!(outcome, Outcome::Success { .. }),
                "an established result is not invalidated by the close"
            );
        }
    }

    #[test]
    fn a_registration_waits_for_the_notifications_received_before_its_reply() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect(port);
        let _a = activate(&connection, &[p(1)]);
        let b = connection.prepare_subscription(&[p(2)]).unwrap();
        let operation = connection.create_operation().unwrap();
        let (tx, activated) = mpsc::channel();
        b.activate(&operation, move |outcome| {
            let _ = tx.send(outcome);
        });
        thread::sleep(Duration::from_millis(50));
        push.send(notify_param(1, 1)).unwrap();
        let first = next(&batches);
        assert!(
            activated.recv_timeout(Duration::from_millis(500)).is_err(),
            "accepted, but not consumed before the prior notification"
        );
        assert!(connection.adopt_notifications(first.ticket));
        assert_eq!(
            activated.recv_timeout(Duration::from_secs(5)).unwrap(),
            Ok(())
        );
    }

    #[test]
    fn notifications_adopted_after_an_end_do_not_make_a_held_result_normal() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect(port);
        let _token = activate(&connection, &[p(1)]);
        let operation = connection.create_operation().unwrap();
        let held = submit_held(&connection, &operation, 5);
        thread::sleep(Duration::from_millis(50));
        push.send(notify_param(1, 1)).unwrap();
        let first = next(&batches);
        thread::sleep(Duration::from_millis(400));
        push.send(lost()).unwrap();
        super::wait_until(|| connection.shared.link_end().is_some());
        connection.adopt_notifications(first.ticket);
        assert_eq!(
            held.recv_timeout(Duration::from_secs(5)).unwrap().0,
            Outcome::failed(
                RequestCause::ConnectionLost,
                crate::request::RequestPhase::Delivery,
                crate::request::Evidence::Read
            )
        );
    }

    #[test]
    fn notifications_adopted_after_an_end_do_not_activate_a_subscription() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect(port);
        let _a = activate(&connection, &[p(1)]);
        let b = connection.prepare_subscription(&[p(2)]).unwrap();
        let operation = connection.create_operation().unwrap();
        let (tx, activated) = mpsc::channel();
        b.activate(&operation, move |outcome| {
            let _ = tx.send(outcome);
        });
        thread::sleep(Duration::from_millis(50));
        push.send(notify_param(1, 1)).unwrap();
        let first = next(&batches);
        thread::sleep(Duration::from_millis(400));
        push.send(lost()).unwrap();
        super::wait_until(|| connection.shared.link_end().is_some());
        connection.adopt_notifications(first.ticket);
        let failure = activated
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap_err();
        assert_eq!(
            failure.failure,
            Failure::Cause {
                code: Cause::ConnectionLost,
                phase: Phase::Subscription
            }
        );
    }

    #[test]
    fn a_cancellation_during_the_last_registrations_cutoff_cleans_it_up() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect(port);
        let _a = activate(&connection, &[p(1)]);
        let b = connection.prepare_subscription(&[p(1), p(2)]).unwrap();
        let operation = connection.create_operation().unwrap();
        let (tx, activated) = mpsc::channel();
        b.activate(&operation, move |outcome| {
            let _ = tx.send(outcome);
        });
        thread::sleep(Duration::from_millis(50));
        push.send(notify_param(1, 1)).unwrap();
        let first = next(&batches);
        thread::sleep(Duration::from_millis(400));
        operation.cancel();
        assert!(connection.adopt_notifications(first.ticket));
        let failure = activated
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap_err();
        assert_eq!(
            failure.failure,
            Failure::Cancelled {
                phase: Phase::Subscription
            }
        );
        let state = connection.shared.lock();
        assert!(!state.ledger.is_active(b.token()));
        assert!(
            state.ledger.recipients(p(2)).is_empty(),
            "only the cancelled acquisition owned it, and it was unregistered"
        );
        assert_eq!(
            state.ledger.recipients(p(1)).len(),
            1,
            "the existing owner keeps its address"
        );
    }

    #[test]
    fn a_waiting_request_expires_while_a_result_is_held() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (tx, batches) = mpsc::channel();
        let tx = Mutex::new(tx);
        let handler: NotificationHandler = Arc::new(move |batch| {
            let _ = tx.lock().unwrap().send(batch);
        });
        let short = crate::connection::ConnectionOptions {
            send_deadline: Duration::from_millis(80),
            ..options()
        };
        let connection = open_with(port, ID, &short, &Control::new(), Some(handler)).unwrap();
        let _token = activate(&connection, &[p(1)]);
        let operation = connection.create_operation().unwrap();
        let held = submit_held(&connection, &operation, 5);
        thread::sleep(Duration::from_millis(20));
        push.send(notify_param(1, 1)).unwrap();
        let _first = next(&batches);
        let other = connection.create_operation().unwrap();
        let waiting = submit_held(&connection, &other, 6);
        assert_eq!(
            waiting.recv_timeout(Duration::from_secs(2)).unwrap().0,
            unsent_with(RequestCause::SendTimeout),
            "completed while the earlier result is still held"
        );
        assert!(held.try_recv().is_err(), "still held");
        assert_eq!(connection.shared.lock().waiting_bytes, 0);
    }

    #[test]
    fn an_expired_request_completes_on_its_own_thread_while_a_registration_is_held() {
        // A registration's reply waits for a notification received before it to be adopted
        // (K12), and a request waiting behind it expires. Its callback runs on the thread held
        // for it since its admission, not on the worker carrying the registration: it can
        // close the connection, even once the system starts no more threads.
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect_short(port);
        let _a = activate(&connection, &[p(1)]);
        let b = connection.prepare_subscription(&[p(2)]).unwrap();
        let operation = connection.create_operation().unwrap();
        let (tx, activated) = mpsc::channel();
        b.activate(&operation, move |outcome| {
            let _ = tx.send(outcome);
        });
        thread::sleep(Duration::from_millis(20));
        push.send(notify_param(1, 1)).unwrap();
        let _first = next(&batches);
        let other = connection.create_operation().unwrap();
        let (tx, waiting) = mpsc::channel();
        let inner = Arc::clone(&connection);
        connection.submit(&other, Request::GetNumeric(param(6)), move |outcome, _| {
            let closed = inner.close(Duration::from_millis(50));
            let _ = tx.send((outcome, closed));
        });
        connection
            .shared
            .expiry
            .spawner
            .refuse
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let (outcome, closed) = waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(outcome, unsent_with(RequestCause::SendTimeout));
        assert_eq!(
            closed,
            CloseOutcome::Incomplete(Failure::Cause {
                code: Cause::InternalError,
                phase: Phase::Teardown
            }),
            "no helper thread to finish the close on"
        );
        assert!(activated.recv_timeout(Duration::from_secs(2)).is_ok());
        super::wait_until(|| connection.shared.expiry.charged() == (0, 0));
    }

    #[test]
    fn a_thread_held_for_a_waiting_request_outlasts_its_linger() {
        // The request waits behind a held result for longer than an idle completing thread
        // lingers; its thread is still there when it expires.
        let (port, push) = pushing_unit(Duration::from_millis(100));
        let (tx, batches) = mpsc::channel();
        let tx = Mutex::new(tx);
        let handler: NotificationHandler = Arc::new(move |batch| {
            let _ = tx.lock().unwrap().send(batch);
        });
        let long = crate::connection::ConnectionOptions {
            send_deadline: super::super::LINGER + Duration::from_millis(500),
            ..options()
        };
        let connection =
            Arc::new(open_with(port, ID, &long, &Control::new(), Some(handler)).unwrap());
        let _token = activate(&connection, &[p(1)]);
        let operation = connection.create_operation().unwrap();
        let _held = submit_held(&connection, &operation, 5);
        thread::sleep(Duration::from_millis(20));
        push.send(notify_param(1, 1)).unwrap();
        let _first = next(&batches);
        let other = connection.create_operation().unwrap();
        let waiting = submit_held(&connection, &other, 6);
        assert_eq!(
            waiting.recv_timeout(Duration::from_secs(5)).unwrap().0,
            unsent_with(RequestCause::SendTimeout)
        );
    }

    /// Holds a read's result for an unadopted notification so that a request
    /// behind it expires, and runs `expired` as that request's callback, on its
    /// completing thread. Returns once the hold is over and the link is free.
    fn expire_on_a_completing_thread(
        connection: &Arc<Connection>,
        push: &Sender<Vec<u8>>,
        batches: &Receiver<NotificationBatch>,
        expired: impl FnOnce() + Send + 'static,
    ) {
        let operation = connection.create_operation().unwrap();
        let held = submit_held(connection, &operation, 5);
        thread::sleep(Duration::from_millis(20));
        push.send(notify_param(1, 1)).unwrap();
        let first = next(batches);
        let (tx, ran) = mpsc::channel();
        connection.submit(
            &operation,
            Request::GetNumeric(param(6)),
            move |outcome, _| {
                expired();
                let _ = tx.send(outcome);
            },
        );
        assert_eq!(
            ran.recv_timeout(Duration::from_secs(2)).unwrap(),
            unsent_with(RequestCause::SendTimeout)
        );
        assert!(connection.adopt_notifications(first.ticket));
        let (_, adoption) = held.recv_timeout(Duration::from_secs(2)).unwrap();
        adoption.adopt();
    }

    // Not on Windows: there a thread-local destructor runs under the process's loader lock,
    // so one that blocks stops every thread of the test process from starting or ending,
    // and the other cases' closes with it.
    #[cfg(not(windows))]
    #[test]
    fn a_completing_thread_whose_exit_does_not_finish_holds_back_one_other_at_most() {
        // The expired request's callback leaves a thread-local whose destructor blocks, so
        // its thread does not finish ending. Bursts and pauses after it keep the threads
        // still running steady: one waits for it, and the others stay to be reused.
        struct Blocks(Sender<()>, mpsc::Receiver<()>);
        impl Drop for Blocks {
            fn drop(&mut self) {
                let _ = self.0.send(());
                let _ = self.1.recv_timeout(Duration::from_secs(20));
            }
        }
        thread_local! {
            static STUCK: std::cell::RefCell<Option<Blocks>> = const { std::cell::RefCell::new(None) };
        }
        let running = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        super::super::RUNNING.with(|counted| *counted.borrow_mut() = Some(Arc::clone(&running)));
        let (port, push) = pushing_unit(Duration::from_millis(20));
        // Long enough for a burst of four reads to be sent, short enough for the one behind
        // the hold to expire.
        let (connection, batches) = connect_sending(port, Duration::from_secs(1));
        let connected = running.load(std::sync::atomic::Ordering::SeqCst);
        let _token = activate(&connection, &[p(1)]);
        let (release, stuck) = mpsc::channel();
        let (entered, ending) = mpsc::channel();
        expire_on_a_completing_thread(&connection, &push, &batches, move || {
            STUCK.with(|slot| *slot.borrow_mut() = Some(Blocks(entered, stuck)));
        });
        ending
            .recv_timeout(Duration::from_secs(5))
            .expect("the thread that ran the callback is ending, and stuck");
        // The connection's own threads, the four a burst holds, and the one waiting for the
        // stuck thread.
        let bound = connected + 4 + 1;
        let operation = connection.create_operation().unwrap();
        let mut after = Vec::new();
        for _ in 0..4 {
            let answered: Vec<_> = (0..4)
                .map(|n| submit_held(&connection, &operation, 10 + n))
                .collect();
            for rx in answered {
                let (outcome, adoption) = rx.recv_timeout(Duration::from_secs(2)).unwrap();
                assert!(matches!(outcome, Outcome::Success { .. }), "{outcome:?}");
                adoption.adopt();
            }
            thread::sleep(super::super::LINGER * 3);
            after.push(running.load(std::sync::atomic::Ordering::SeqCst));
        }
        super::super::RUNNING.with(|counted| *counted.borrow_mut() = None);
        assert!(
            after.iter().all(|&running| running <= bound),
            "threads still running after each pause: {after:?}, at most {bound}"
        );
        drop(release);
    }

    #[test]
    fn a_close_from_a_completing_threads_exit_does_not_wait_for_itself() {
        // The expired request's callback leaves a thread-local that closes the connection
        // from its destructor, which runs as its completing thread ends after lingering.
        struct Closes(Arc<Connection>, Sender<CloseOutcome>);
        impl Drop for Closes {
            fn drop(&mut self) {
                let _ = self.1.send(self.0.close(Duration::from_millis(220)));
            }
        }
        thread_local! {
            static CLOSER: std::cell::RefCell<Option<Closes>> = const { std::cell::RefCell::new(None) };
        }
        let (port, push) = pushing_unit(Duration::from_millis(20));
        let (connection, batches) = connect_short(port);
        let _token = activate(&connection, &[p(1)]);
        let (tx, from_exit) = mpsc::channel();
        let inner = Arc::clone(&connection);
        expire_on_a_completing_thread(&connection, &push, &batches, move || {
            CLOSER.with(|slot| *slot.borrow_mut() = Some(Closes(inner, tx)));
        });
        assert_eq!(
            from_exit.recv_timeout(Duration::from_secs(5)).unwrap(),
            CloseOutcome::Started
        );
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    }

    #[test]
    fn a_request_is_refused_when_no_thread_can_be_held_for_it() {
        let (port, _push) = pushing_unit(Duration::ZERO);
        let (connection, _batches) = connect_short(port);
        let token = connection.prepare_subscription(&[p(1)]).unwrap();
        connection
            .shared
            .expiry
            .spawner
            .refuse
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let operation = connection.create_operation().unwrap();
        let refused = submit_held(&connection, &operation, 5);
        assert_eq!(
            refused.recv_timeout(Duration::from_secs(1)).unwrap().0,
            unsent_with(RequestCause::InternalError)
        );
        let (tx, lifecycle) = mpsc::channel();
        let again = tx.clone();
        token.activate(&operation, move |outcome| {
            let _ = tx.send(outcome);
        });
        token.release(move |outcome| {
            let _ = again.send(outcome);
        });
        for call in ["activate", "release"] {
            let outcome = lifecycle.recv_timeout(Duration::from_secs(1)).unwrap();
            assert_eq!(
                outcome.map_err(|failed| failed.failure),
                Err(Failure::Cause {
                    code: Cause::InternalError,
                    phase: Phase::Subscription
                }),
                "{call}"
            );
        }
    }

    #[test]
    fn a_rejection_held_for_its_cutoff_stays_a_rejection_when_the_link_ends() {
        let (port, push) = pushing_unit_coded(Duration::from_millis(200), |request| {
            if request["vdp"]["uri"] == "/vd/parameters/2:0:0?operation=regist" {
                409
            } else {
                200
            }
        });
        let (connection, batches) = connect(port);
        let _a = activate(&connection, &[p(1)]);
        let b = connection.prepare_subscription(&[p(2)]).unwrap();
        let operation = connection.create_operation().unwrap();
        let (tx, activated) = mpsc::channel();
        b.activate(&operation, move |outcome| {
            let _ = tx.send(outcome);
        });
        thread::sleep(Duration::from_millis(50));
        push.send(notify_param(1, 1)).unwrap();
        let _first = next(&batches);
        thread::sleep(Duration::from_millis(400));
        push.send(lost()).unwrap();
        let failure = activated
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap_err();
        assert_eq!(
            failure.failure,
            Failure::Cause {
                code: Cause::DeviceRejected,
                phase: Phase::Subscription
            }
        );
        super::wait_until(|| connection.terminal().is_some());
        assert_eq!(connection.terminal(), Some(RequestCause::ConnectionLost));
    }

    /// A connection with an 80 ms send deadline whose batches reach the test.
    fn connect_short(port: u16) -> (Arc<Connection>, Receiver<NotificationBatch>) {
        connect_sending(port, Duration::from_millis(80))
    }

    /// A connection whose requests may wait `send_deadline` to be sent.
    fn connect_sending(
        port: u16,
        send_deadline: Duration,
    ) -> (Arc<Connection>, Receiver<NotificationBatch>) {
        let (tx, batches) = mpsc::channel();
        let tx = Mutex::new(tx);
        let handler: NotificationHandler = Arc::new(move |batch| {
            let _ = tx.lock().unwrap().send(batch);
        });
        let short = crate::connection::ConnectionOptions {
            send_deadline,
            ..options()
        };
        let connection = open_with(port, ID, &short, &Control::new(), Some(handler)).unwrap();
        (Arc::new(connection), batches)
    }

    #[test]
    fn a_request_submitted_after_a_hold_began_still_expires() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect_short(port);
        let _token = activate(&connection, &[p(1)]);
        let operation = connection.create_operation().unwrap();
        let held = submit_held(&connection, &operation, 5);
        thread::sleep(Duration::from_millis(20));
        push.send(notify_param(1, 1)).unwrap();
        let _first = next(&batches);
        // The reply arrives at about 200 ms; the hold then waits with an
        // empty queue.
        thread::sleep(Duration::from_millis(400));
        let other = connection.create_operation().unwrap();
        let waiting = submit_held(&connection, &other, 6);
        assert_eq!(
            waiting.recv_timeout(Duration::from_secs(2)).unwrap().0,
            unsent_with(RequestCause::SendTimeout)
        );
        assert!(held.try_recv().is_err(), "still held");
    }

    #[test]
    fn a_close_from_an_expiry_callback_during_a_hold_does_not_wait_for_itself() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect_short(port);
        let _token = activate(&connection, &[p(1)]);
        let operation = connection.create_operation().unwrap();
        let _held = submit_held(&connection, &operation, 5);
        thread::sleep(Duration::from_millis(20));
        push.send(notify_param(1, 1)).unwrap();
        let _first = next(&batches);
        thread::sleep(Duration::from_millis(400));
        let other = connection.create_operation().unwrap();
        let (tx, inner) = mpsc::channel();
        let closing = Arc::clone(&connection);
        connection.submit(&other, Request::GetNumeric(param(6)), move |_, _| {
            let _ = tx.send(closing.close(TEARDOWN));
        });
        assert_eq!(
            inner.recv_timeout(Duration::from_secs(2)).unwrap(),
            CloseOutcome::Started
        );
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    }

    #[test]
    fn a_cancelled_reactivation_keeps_the_established_subscription() {
        let (port, _push) = pushing_unit(Duration::ZERO);
        let (connection, _batches) = connect(port);
        let other = activate(&connection, &[p(1)]);
        let token = activate(&connection, &[p(1), p(2)]);
        let operation = connection.create_operation().unwrap();
        operation.cancel();
        let (tx, again) = mpsc::channel();
        token.activate(&operation, move |outcome| {
            let _ = tx.send(outcome);
        });
        assert_eq!(
            again.recv_timeout(Duration::from_secs(5)).unwrap(),
            Err(crate::lifecycle::LifecycleFailure {
                failure: Failure::Cancelled {
                    phase: Phase::Subscription
                },
                cleanup: crate::lifecycle::Cleanup::COMPLETE,
            })
        );
        let state = connection.shared.lock();
        assert!(state.ledger.is_active(token.token()));
        assert_eq!(state.ledger.recipients(p(2)), [token.token()]);
        assert_eq!(
            state.ledger.recipients(p(1)),
            [other.token(), token.token()]
        );
    }

    #[test]
    fn a_blocked_expiry_callback_does_not_hold_up_the_end_of_the_connection() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect_short(port);
        let _token = activate(&connection, &[p(1)]);
        let operation = connection.create_operation().unwrap();
        let held = submit_held(&connection, &operation, 5);
        thread::sleep(Duration::from_millis(20));
        push.send(notify_param(1, 1)).unwrap();
        let _first = next(&batches);
        thread::sleep(Duration::from_millis(400));
        let other = connection.create_operation().unwrap();
        let (entered_tx, entered) = mpsc::channel();
        let (release, blocked) = mpsc::channel::<()>();
        connection.submit(&other, Request::GetNumeric(param(6)), move |_, _| {
            let _ = entered_tx.send(());
            let _ = blocked.recv();
        });
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        push.send(lost()).unwrap();
        assert_eq!(
            held.recv_timeout(Duration::from_secs(2)).unwrap().0,
            Outcome::failed(
                RequestCause::ConnectionLost,
                crate::request::RequestPhase::Delivery,
                crate::request::Evidence::Read
            ),
            "the held result is delivered while the expiry callback blocks"
        );
        super::wait_until(|| connection.terminal().is_some());
        assert_eq!(connection.terminal(), Some(RequestCause::ConnectionLost));
        release.send(()).unwrap();
        assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
    }

    /// Holds a GET for its cutoff, then submits one whose expiry callback
    /// blocks until the returned sender is used.
    fn blocked_expiry(
        connection: &Arc<Connection>,
        push: &Sender<Vec<u8>>,
        batches: &Receiver<NotificationBatch>,
        on_release: impl FnOnce() + Send + 'static,
    ) -> Sender<()> {
        let _token = activate(connection, &[p(1)]);
        std::mem::forget(_token);
        let operation = connection.create_operation().unwrap();
        let _held = submit_held(connection, &operation, 5);
        std::mem::forget(_held);
        thread::sleep(Duration::from_millis(20));
        push.send(notify_param(1, 1)).unwrap();
        let _first = next(batches);
        thread::sleep(Duration::from_millis(400));
        let other = connection.create_operation().unwrap();
        let (entered_tx, entered) = mpsc::channel();
        let (release, blocked) = mpsc::channel::<()>();
        connection.submit(&other, Request::GetNumeric(param(6)), move |_, _| {
            let _ = entered_tx.send(());
            let _ = blocked.recv();
            on_release();
        });
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        release
    }

    #[test]
    fn an_expiry_callback_joining_a_running_close_does_not_wait_for_itself() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect_short(port);
        let (tx, inner) = mpsc::channel();
        let joining = Arc::clone(&connection);
        let release = blocked_expiry(&connection, &push, &batches, move || {
            let _ = tx.send(joining.close(TEARDOWN));
        });
        let closer = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || connection.close(TEARDOWN))
        };
        super::wait_until(|| connection.shared.lock().closing);
        release.send(()).unwrap();
        assert_eq!(
            inner.recv_timeout(Duration::from_secs(2)).unwrap(),
            CloseOutcome::Started
        );
        assert_eq!(closer.join().unwrap(), CloseOutcome::Closed);
    }

    #[test]
    fn expired_requests_stay_charged_until_completed() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect_short(port);
        let release = blocked_expiry(&connection, &push, &batches, || {});
        let operation = connection.create_operation().unwrap();
        let (tx, completed) = mpsc::channel();
        // Every completion blocks until the gate opens.
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        for id in 0..(MAX_WAITING_REQUESTS - 1) as u32 {
            let tx = tx.clone();
            let gate = Arc::clone(&gate);
            connection.submit(
                &operation,
                Request::GetNumeric(param(100 + id)),
                move |outcome, _| {
                    let (open, opened) = &*gate;
                    let mut open = open.lock().unwrap();
                    while !*open {
                        open = opened.wait(open).unwrap();
                    }
                    drop(open);
                    let _ = tx.send(outcome);
                },
            );
        }
        super::wait_until(|| connection.shared.expiry.charged().0 == MAX_WAITING_REQUESTS);
        let (refused_tx, refused) = mpsc::channel();
        connection.submit(
            &operation,
            Request::GetNumeric(param(99)),
            move |outcome, _| {
                let _ = refused_tx.send(outcome);
            },
        );
        assert_eq!(
            refused.recv_timeout(Duration::from_secs(1)).unwrap(),
            unsent_with(RequestCause::PreconditionFailed),
            "the expired ones still count against the queue"
        );
        assert!(
            crate::connection::lock(&connection.shared.expiry.pool).alive
                <= MAX_WAITING_REQUESTS + 1,
            "one thread at most per admitted request: the waiting limit and the one held on the wire"
        );
        release.send(()).unwrap();
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        for _ in 0..MAX_WAITING_REQUESTS - 1 {
            assert_eq!(
                completed.recv_timeout(Duration::from_secs(2)).unwrap(),
                unsent_with(RequestCause::SendTimeout)
            );
        }
        assert!(
            completed.recv_timeout(Duration::from_millis(100)).is_err(),
            "once each"
        );
        super::wait_until(|| connection.shared.expiry.charged().0 == 0);
    }

    #[test]
    fn the_expiry_threads_end_with_the_connection_without_a_close() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect_short(port);
        let release = blocked_expiry(&connection, &push, &batches, || {});
        push.send(lost()).unwrap();
        super::wait_until(|| connection.terminal().is_some());
        release.send(()).unwrap();
        super::wait_until(|| {
            let pool = crate::connection::lock(&connection.shared.expiry.pool);
            !pool.threads.is_empty() && pool.threads.iter().all(|thread| thread.is_finished())
        });
    }

    #[test]
    fn a_blocked_expiry_callback_does_not_delay_other_expiries() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect_short(port);
        let release = blocked_expiry(&connection, &push, &batches, || {});
        let other = connection.create_operation().unwrap();
        let later = submit_held(&connection, &other, 7);
        assert_eq!(
            later.recv_timeout(Duration::from_secs(2)).unwrap().0,
            unsent_with(RequestCause::SendTimeout),
            "completed while the first expiry callback is still blocked"
        );
        super::wait_until(|| connection.shared.expiry.charged().0 == 1);
        release.send(()).unwrap();
        super::wait_until(|| connection.shared.expiry.charged().0 == 0);
    }

    #[test]
    fn the_expiry_threads_end_without_waiting_for_the_ends_completions() {
        let (port, push) = pushing_unit(Duration::from_millis(200));
        let (connection, batches) = connect_short(port);
        let release = blocked_expiry(&connection, &push, &batches, || {});
        release.send(()).unwrap();
        super::wait_until(|| connection.shared.expiry.charged().0 == 0);
        // A waiting request whose completion, run by the end, blocks.
        let operation = connection.create_operation().unwrap();
        let (entered_tx, entered) = mpsc::channel();
        let (unblock, blocked) = mpsc::channel::<()>();
        connection.submit(&operation, Request::GetNumeric(param(8)), move |_, _| {
            let _ = entered_tx.send(());
            let _ = blocked.recv();
        });
        push.send(lost()).unwrap();
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        super::wait_until(|| {
            let pool = crate::connection::lock(&connection.shared.expiry.pool);
            !pool.threads.is_empty() && pool.threads.iter().all(|thread| thread.is_finished())
        });
        unblock.send(()).unwrap();
    }
}
