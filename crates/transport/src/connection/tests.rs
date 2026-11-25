//! The operational connection against a fake unit endpoint.

use super::{
    open, CloseOutcome, Connection, ConnectionOptions, MAX_WAITING_BYTES, MAX_WAITING_REQUESTS,
};
use crate::discovery::SystemFirmware;
use crate::frame;
use crate::lifecycle::{Cause, Control, Failure, Phase};
use crate::request::{
    Evidence, Outcome, ReadValue, Request, RequestCause, RequestFailure, RequestPhase,
};
use crate::test_peer::{get_reply, line, uri_of, Peer};
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
    connection.submit(operation, request, move |outcome| {
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
        (
            json!({ "sync_status": "" }),
            identity(Cause::InvalidResponse),
        ),
    ];
    for (sync, expected) in cases {
        let peer = Peer::serve(move |request| match uri_of(request) {
            "/vd/synchronize" => vec![get_reply("/vd/synchronize", sync.clone())],
            _ => vec![get_reply("/vd/device", firmware())],
        });
        let result = open(peer.port, ID, &options(), &Control::new()).map(|_| ());
        assert_eq!(result, expected);
        assert_eq!(
            peer.uris(),
            ["/vd/synchronize"],
            "no firmware read for a refused unit"
        );
    }
}

#[test]
fn open_fails_on_a_lost_push_malformed_firmware_or_an_unreachable_unit() {
    let lost = Peer::serve(|request| match uri_of(request) {
        "/vd/synchronize" => vec![
            get_reply("/vd/synchronize", online(ID)),
            line(
                json!({ "vdp": { "method": "notify", "uri": "/vd/synchronize", "data": { "sync_status": "lost" } } }),
            ),
        ],
        _ => vec![get_reply("/vd/device", firmware())],
    });
    let malformed = Peer::serve(|request| match uri_of(request) {
        "/vd/synchronize" => vec![get_reply("/vd/synchronize", online(ID))],
        _ => vec![get_reply("/vd/device", json!({ "firm_list": {} }))],
    });
    let result = |peer: &Peer| open(peer.port, ID, &options(), &Control::new()).map(|_| ());
    assert_eq!(
        result(&lost),
        Err(Failure::Cause {
            code: Cause::ConnectionLost,
            phase: Phase::Identity
        })
    );
    assert_eq!(
        result(&malformed),
        Err(Failure::Cause {
            code: Cause::InvalidResponse,
            phase: Phase::Identity
        })
    );

    let closed = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    assert_eq!(
        open(closed, ID, &options(), &Control::new()).map(|_| ()),
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
        open(silent.port, ID, &short, &Control::new()).map(|_| ()),
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
    let peer = slow(Duration::from_millis(300));
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let active = submit(&connection, &operation, Request::GetNumeric(address(1)));
    wait_until(|| parameter_uris(&peer).len() == 1);
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
    drop(admitted);
    drop(active);
    assert_eq!(
        connection.terminal(),
        None,
        "a full queue does not end the connection"
    );
    assert_eq!(connection.close(TEARDOWN), CloseOutcome::Closed);
}

#[test]
fn the_waiting_queue_admits_exactly_its_byte_limit() {
    let peer = slow(Duration::from_millis(300));
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let active = submit(&connection, &operation, Request::GetNumeric(address(1)));
    wait_until(|| parameter_uris(&peer).len() == 1);

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
    drop((admitted, active));
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
    connection.submit(
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
    connection.submit(&operation, Request::GetNumeric(address(1)), |_| {
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
    connection.submit(&operation, Request::GetNumeric(address(1)), |_| {
        panic!("callback failure")
    });
    connection.submit(&operation, Request::GetNumeric(address(2)), |_| {
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
        connection.submit(
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
    connection.submit(
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
    connection.submit(
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
}

impl super::Outgoing for Scripted {
    fn set_write_timeout(&self, _: Option<Duration>) -> std::io::Result<()> {
        if self.end_before_write == Some(self.writes) {
            self.shared
                .link_end()
                .get_or_insert(RequestCause::ConnectionLost);
        }
        Ok(())
    }

    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.shared.link_end.try_lock().is_ok() {
            self.recordable_during_write = true;
        }
        self.writes += 1;
        let n = bytes.len().min(8);
        self.written.extend_from_slice(&bytes[..n]);
        Ok(n)
    }
}

fn scripted(end_before_write: Option<usize>) -> Scripted {
    Scripted {
        shared: Arc::new(super::Shared {
            state: std::sync::Mutex::new(super::State::default()),
            link_end: std::sync::Mutex::new(None),
            settled: std::sync::Condvar::new(),
        }),
        written: Vec::new(),
        end_before_write,
        writes: 0,
        recordable_during_write: false,
    }
}

#[test]
fn a_write_never_starts_after_the_reader_records_the_end() {
    let frame = vec![b'x'; 30];
    let deadline = Instant::now() + Duration::from_secs(5);

    // Recorded while the first write is being prepared: nothing goes out.
    let mut sock = scripted(Some(0));
    let shared = Arc::clone(&sock.shared);
    assert_eq!(
        super::write_frame(&mut sock, &shared, &frame, deadline),
        Err((RequestCause::ConnectionLost, 0))
    );
    assert!(sock.written.is_empty());

    // Recorded after the first 8 bytes, while the next part is being
    // prepared: no more bytes go out, and the count says how many did.
    let mut sock = scripted(Some(1));
    let shared = Arc::clone(&sock.shared);
    assert_eq!(
        super::write_frame(&mut sock, &shared, &frame, deadline),
        Err((RequestCause::ConnectionLost, 8))
    );
    assert_eq!(sock.written.len(), 8);

    // Without an end the whole frame goes out, and no write ran while the
    // reader could have recorded one.
    let mut sock = scripted(None);
    let shared = Arc::clone(&sock.shared);
    assert_eq!(
        super::write_frame(&mut sock, &shared, &frame, deadline),
        Ok(())
    );
    assert_eq!(sock.written, frame);
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
    connection.submit(&operation, Request::GetNumeric(address(1)), move |_| {
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
    connection.submit(&operation, Request::GetNumeric(address(1)), move |_| {
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
        super::write_frame(&mut sock, &shared, &frame, deadline),
        Err((RequestCause::NotConnected, 0))
    );
    assert!(sock.written.is_empty());

    // A write already under way finishes: its bytes are on the wire.
    let mut sock = scripted(None);
    let shared = Arc::clone(&sock.shared);
    struct CloseAfterFirst(Scripted);
    impl super::Outgoing for CloseAfterFirst {
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
        super::write_frame(&mut sock, &shared, &frame, deadline),
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
    connection.submit(
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
    assert_eq!(closed, CloseOutcome::Closed);
    assert!(matches!(outcome(&active), Outcome::Success { .. }));
}

#[test]
fn a_callback_that_outlasts_the_teardown_budget_makes_the_close_incomplete() {
    let peer = unit(plain);
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let (tx, delivered) = mpsc::channel();
    connection.submit(&operation, Request::GetNumeric(address(1)), move |_| {
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
fn a_slow_waiting_request_callback_does_not_delay_the_close() {
    let peer = slow(Duration::from_millis(100));
    let connection = connect(&peer);
    let operation = connection.create_operation().unwrap();
    let active = submit(&connection, &operation, Request::SetNumeric(address(1), 1));
    wait_until(|| parameter_uris(&peer).len() == 1);
    connection.submit(&operation, Request::SetNumeric(address(2), 1), |_| {
        thread::sleep(Duration::from_secs(1));
    });
    let started = Instant::now();
    assert_eq!(
        connection.close(Duration::from_millis(300)),
        CloseOutcome::Closed
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
