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

/// The stop rule ordinary requests use, without an operation to cancel.
fn closing_only(state: &super::State) -> Option<super::Stop> {
    state.closing.then_some(super::Stop::Closing)
}

fn scripted(end_before_write: Option<usize>) -> Scripted {
    Scripted {
        shared: Arc::new(super::Shared {
            state: std::sync::Mutex::new(super::State::default()),
            link_end: std::sync::Mutex::new(None),
            settled: std::sync::Condvar::new(),
            advance: std::sync::Condvar::new(),
            expired: std::sync::Mutex::new(std::sync::mpsc::channel().0),
            notifications: None,
            deliverable: std::sync::Condvar::new(),
            delivery_stop: std::sync::atomic::AtomicBool::new(false),
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
        super::write_frame(&mut sock, &shared, &frame, deadline, &closing_only),
        Err(super::WriteError::Failed {
            cause: RequestCause::ConnectionLost,
            written: 0
        })
    );
    assert!(sock.written.is_empty());

    // Recorded after the first 8 bytes, while the next part is being
    // prepared: no more bytes go out, and the count says how many did.
    let mut sock = scripted(Some(1));
    let shared = Arc::clone(&sock.shared);
    assert_eq!(
        super::write_frame(&mut sock, &shared, &frame, deadline, &closing_only),
        Err(super::WriteError::Failed {
            cause: RequestCause::ConnectionLost,
            written: 8
        })
    );
    assert_eq!(sock.written.len(), 8);

    // Without an end the whole frame goes out, and no write ran while the
    // reader could have recorded one.
    let mut sock = scripted(None);
    let shared = Arc::clone(&sock.shared);
    assert_eq!(
        super::write_frame(&mut sock, &shared, &frame, deadline, &closing_only),
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
        super::write_frame(&mut sock, &shared, &frame, deadline, &closing_only),
        Err(super::WriteError::Stopped(super::Stop::Closing))
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
        super::write_frame(&mut sock, &shared, &frame, deadline, &closing_only),
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
        super::wait_for([Some(finished), None, None, None], past),
        CloseOutcome::Incomplete(Failure::Cause {
            code: Cause::TeardownTimeout,
            phase: Phase::Teardown
        })
    );
    let done = thread::spawn(|| {});
    assert_eq!(
        super::wait_for(
            [Some(done), None, None, None],
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

mod lifecycle {
    use super::{connect, firmware, online, ID, TEARDOWN};
    use crate::connection::{open, CloseOutcome, Connection, ConnectionOptions, Subscription};
    use crate::lifecycle::{
        Cause, Cleanup, CleanupState, Control, Failure, LifecycleFailure, LifecycleOutcome, Phase,
    };
    use crate::subscription::SubscriptionAddress;
    use crate::test_peer::{get_reply, line, uri_of, Peer};
    use crate::wire::{MeterAddress, ParameterAddress};
    use serde_json::json;
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
        assert_eq!(
            connection.terminal(),
            None,
            "an ordinary rejection keeps the connection"
        );
        assert_eq!(settled(&release(&old)), Ok(()));
        assert_eq!(&posts(&peer)[5..], [unreg(1), unreg(2)]);
    }

    #[test]
    fn releasing_a_token_never_activated_sends_nothing() {
        let peer = accepting();
        let connection = connect(&peer);
        let token = connection.prepare_subscription(&[p(1)]).unwrap();
        assert_eq!(settled(&release(&token)), Ok(()));
        assert!(posts(&peer).is_empty());
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

#[test]
fn a_write_whose_operation_was_cancelled_before_its_first_byte_is_not_started() {
    let frame = vec![b'x'; 30];
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut sock = scripted(None);
    let shared = Arc::clone(&sock.shared);
    let cancelled = |_: &super::State| Some(super::Stop::Cancelled);
    assert_eq!(
        super::write_frame(&mut sock, &shared, &frame, deadline, &cancelled),
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
    fn block_worker(connection: &Connection) -> (Sender<()>, Receiver<()>) {
        let operation = connection.create_operation().unwrap();
        let (release, blocked) = mpsc::channel::<()>();
        let (entered_tx, entered) = mpsc::channel();
        connection.submit_adopted(&operation, Request::GetNumeric(param(5)), move |_| {
            let _ = entered_tx.send(());
            let _ = blocked.recv();
        });
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        (release, entered)
    }

    #[test]
    fn recipients_are_decided_at_receipt_while_the_worker_is_busy() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (connection, batches) = connect(port);
        let a = activate(&connection, &[p(1)]);
        let (release, _) = block_worker(&connection);
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
        let (release, _) = block_worker(&connection);
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
        let (release, _) = block_worker(&connection);
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

    #[test]
    fn requests_waiting_at_an_overflow_end_with_it_on_close_or_cancel() {
        for close in [true, false] {
            let (port, push) = pushing_unit(Duration::ZERO);
            let (connection, _batches) = connect(port);
            let connection = Arc::new(connection);
            let _token = activate(&connection, &[p(1)]);
            let (release, _) = block_worker(&connection);
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
        for id in 0..(MAX_WAITING_REQUESTS - 1) as u32 {
            let tx = tx.clone();
            connection.submit(
                &operation,
                Request::GetNumeric(param(100 + id)),
                move |outcome, _| {
                    let _ = tx.send(outcome);
                },
            );
        }
        super::wait_until(|| connection.shared.lock().expiring == MAX_WAITING_REQUESTS);
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
        release.send(()).unwrap();
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
        super::wait_until(|| connection.shared.lock().expiring == 0);
    }

    #[test]
    fn the_expiry_thread_ends_with_the_connection_without_a_close() {
        let (port, push) = pushing_unit(Duration::ZERO);
        let (connection, _batches) = connect(port);
        push.send(lost()).unwrap();
        super::wait_until(|| connection.terminal().is_some());
        super::wait_until(|| {
            crate::connection::lock(&connection.expiry)
                .as_ref()
                .is_some_and(|thread| thread.is_finished())
        });
    }
}
