//! Device Center `vdp` messages: the requests this crate sends, and how an
//! inbound frame is recognised as a reply, a notification or a device-lost push.
//!
//! The protocol carries no request id. A reply is recognised by its verb, its
//! address with the query removed and, for a POST, its `operation`, so a
//! notification for the address in flight, the other verb's reply, or the reply
//! to another operation on the same address never answers a request.

use serde_json::{json, Value};

const PARAMETERS: &str = "/vd/parameters";
const METERS: &str = "/vd/meters";
const SYNCHRONIZE: &str = "/vd/synchronize";
const DEVICE: &str = "/vd/device";

/// A parameter instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ParameterAddress {
    pub param_id: u32,
    pub x: i64,
    pub y: i64,
}

impl ParameterAddress {
    fn uri(&self) -> String {
        format!("{PARAMETERS}/{}:{}:{}", self.param_id, self.x, self.y)
    }
}

/// A meter instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MeterAddress {
    pub meter_id: u32,
    pub x: i64,
}

impl MeterAddress {
    fn uri(&self) -> String {
        format!("{METERS}/{}:{}", self.meter_id, self.x)
    }
}

/// The value a parameter write sends. Numeric and text writes stay distinct;
/// the kind is never inferred from the content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteValue {
    Integer(i64),
    Text(String),
}

/// One outgoing request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    /// Read a parameter instance's current value.
    GetParameter(ParameterAddress),
    /// Write a parameter instance's current value.
    SetParameter(ParameterAddress, WriteValue),
    /// Register a parameter address for change notifications.
    RegisterParameter(ParameterAddress),
    /// Remove a parameter address registration.
    UnregisterParameter(ParameterAddress),
    /// Register a meter address for readings.
    RegisterMeter(MeterAddress),
    /// Remove a meter address registration.
    UnregisterMeter(MeterAddress),
    /// Read the unit's link state.
    GetSynchronize,
    /// Read the unit's device description.
    GetDevice,
}

/// What a reply to one request carries: its verb, its address without query
/// and, for a POST, its `operation` (K9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyKey {
    method: &'static str,
    base: String,
    operation: Option<&'static str>,
}

impl Request {
    /// The `{"vdp": ...}` message for this request.
    pub fn message(&self) -> Value {
        let vdp = match self {
            Request::GetParameter(address) => json!({ "method": "get", "uri": address.uri() }),
            Request::SetParameter(address, value) => {
                let current_value = match value {
                    WriteValue::Integer(v) => json!(v),
                    WriteValue::Text(s) => json!(s),
                };
                json!({
                    "method": "post",
                    "uri": format!("{}?operation=value", address.uri()),
                    "data": { "current_value": current_value },
                })
            }
            Request::RegisterParameter(address) => registration(&address.uri(), "regist"),
            Request::UnregisterParameter(address) => registration(&address.uri(), "unregist"),
            Request::RegisterMeter(address) => registration(&address.uri(), "regist"),
            Request::UnregisterMeter(address) => registration(&address.uri(), "unregist"),
            Request::GetSynchronize => json!({ "method": "get", "uri": SYNCHRONIZE }),
            Request::GetDevice => json!({ "method": "get", "uri": DEVICE }),
        };
        json!({ "vdp": vdp })
    }

    /// The verb, address and operation a reply to this request carries.
    pub fn reply_key(&self) -> ReplyKey {
        let (method, base, operation) = match self {
            Request::GetParameter(address) => ("get", address.uri(), None),
            Request::SetParameter(address, _) => ("post", address.uri(), Some("value")),
            Request::RegisterParameter(address) => ("post", address.uri(), Some("regist")),
            Request::UnregisterParameter(address) => ("post", address.uri(), Some("unregist")),
            Request::RegisterMeter(address) => ("post", address.uri(), Some("regist")),
            Request::UnregisterMeter(address) => ("post", address.uri(), Some("unregist")),
            Request::GetSynchronize => ("get", SYNCHRONIZE.to_string(), None),
            Request::GetDevice => ("get", DEVICE.to_string(), None),
        };
        ReplyKey {
            method,
            base,
            operation,
        }
    }
}

fn registration(uri: &str, operation: &str) -> Value {
    json!({ "method": "post", "uri": format!("{uri}?operation={operation}") })
}

fn without_query(uri: &str) -> &str {
    uri.split('?').next().unwrap_or(uri)
}

/// The value of the single `operation` query parameter, or `None` when the
/// query has none or more than one.
fn operation_of(uri: &str) -> Option<&str> {
    let (_, query) = uri.split_once('?')?;
    let mut values = query.split('&').filter_map(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        (name == "operation").then_some(value)
    });
    let value = values.next()?;
    values.next().is_none().then_some(value)
}

/// A reply's `vdp` object.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Reply<'a> {
    vdp: &'a Value,
}

/// A malformed reply: a field the request needs is missing or has the wrong type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MalformedReply;

/// What a POST reply says about the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostVerdict {
    /// Integer `response_code` 200.
    Accepted,
    /// Any other integer `response_code`.
    Rejected(i64),
    /// No integer `response_code`: the request may have taken effect.
    Malformed,
}

/// A name read's value as received. An integer is not yet a preset label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NameValue {
    Text(String),
    Integer(i64),
}

impl<'a> Reply<'a> {
    /// The reply's `data`, if any.
    pub fn data(&self) -> Option<&'a Value> {
        self.vdp.get("data")
    }

    fn current_value(&self) -> Result<&'a Value, MalformedReply> {
        self.vdp
            .pointer("/data/current_value")
            .ok_or(MalformedReply)
    }

    /// The verdict of a parameter write or a registration.
    pub fn post_verdict(&self) -> PostVerdict {
        match self
            .vdp
            .pointer("/data/response_code")
            .and_then(Value::as_i64)
        {
            Some(200) => PostVerdict::Accepted,
            Some(code) => PostVerdict::Rejected(code),
            None => PostVerdict::Malformed,
        }
    }

    /// A numeric read's value: an integer within `i64`.
    pub fn numeric_value(&self) -> Result<i64, MalformedReply> {
        self.current_value()?.as_i64().ok_or(MalformedReply)
    }

    /// A text read's value: a string, including a digit-only or empty one.
    pub fn text_value(&self) -> Result<&'a str, MalformedReply> {
        self.current_value()?.as_str().ok_or(MalformedReply)
    }

    /// A name read's value, keeping whether the unit sent text or an integer.
    pub fn name_value(&self) -> Result<NameValue, MalformedReply> {
        let value = self.current_value()?;
        if let Some(text) = value.as_str() {
            return Ok(NameValue::Text(text.to_string()));
        }
        value.as_i64().map(NameValue::Integer).ok_or(MalformedReply)
    }
}

/// A notification pushed by Device Center.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notification {
    /// A parameter changed to an integer value.
    Numeric {
        address: ParameterAddress,
        value: i64,
    },
    /// A parameter changed to a text value.
    Text {
        address: ParameterAddress,
        value: String,
    },
    /// A meter reading.
    Meter { address: MeterAddress, value: i64 },
    /// The parameter namespace changed as a whole, with no address or value.
    BulkChange,
}

/// One inbound JSON frame, classified on demand.
#[derive(Debug, Clone, PartialEq)]
pub struct Inbound {
    message: Value,
}

impl Inbound {
    pub fn new(message: Value) -> Self {
        Inbound { message }
    }

    fn vdp(&self) -> Option<&Value> {
        self.message.get("vdp")
    }

    fn field(&self, key: &str) -> Option<&str> {
        self.vdp()?.get(key).and_then(Value::as_str)
    }

    /// This frame as the reply `key` describes, or `None` for any other frame:
    /// a notification, the other verb's reply, a reply for another address, or
    /// a POST reply whose single `operation` is not the request's (missing,
    /// unknown and repeated operations included).
    pub fn reply(&self, key: &ReplyKey) -> Option<Reply<'_>> {
        let vdp = self.vdp()?;
        if self.field("method") != Some(key.method) {
            return None;
        }
        let uri = self.field("uri").unwrap_or("");
        if without_query(uri) != key.base {
            return None;
        }
        if let Some(operation) = key.operation {
            if operation_of(uri) != Some(operation) {
                return None;
            }
        }
        Some(Reply { vdp })
    }

    /// This frame as a notification, or `None` for any other frame. A parameter
    /// notification whose value is neither an integer nor a string, a meter
    /// notification whose value is not an integer, and an address that does
    /// not parse or has more coordinates than its kind are not notifications.
    pub fn notification(&self) -> Option<Notification> {
        if self.field("method") != Some("notify") {
            return None;
        }
        let address = without_query(self.field("uri")?);
        let value = self.vdp()?.pointer("/data/current_value");
        if address == PARAMETERS {
            return Some(Notification::BulkChange);
        }
        if let Some(rest) = address
            .strip_prefix(METERS)
            .and_then(|r| r.strip_prefix('/'))
        {
            let mut parts = rest.split(':');
            let address = MeterAddress {
                meter_id: parts.next()?.parse().ok()?,
                x: parts.next()?.parse().ok()?,
            };
            if parts.next().is_some() {
                return None;
            }
            return Some(Notification::Meter {
                address,
                value: value?.as_i64()?,
            });
        }
        let rest = address.strip_prefix(PARAMETERS)?.strip_prefix('/')?;
        let mut parts = rest.split(':');
        let address = ParameterAddress {
            param_id: parts.next()?.parse().ok()?,
            x: parts.next()?.parse().ok()?,
            y: parts.next()?.parse().ok()?,
        };
        if parts.next().is_some() {
            return None;
        }
        let value = value?;
        if let Some(v) = value.as_i64() {
            return Some(Notification::Numeric { address, value: v });
        }
        Some(Notification::Text {
            address,
            value: value.as_str()?.to_string(),
        })
    }

    /// The `sync_status` of a `/vd/synchronize` frame that reports the unit as
    /// anything but `online`: Device Center pushes one when the unit is unplugged,
    /// while it keeps accepting writes. `None` for any other frame.
    pub fn device_lost(&self) -> Option<&str> {
        if without_query(self.field("uri")?) != SYNCHRONIZE {
            return None;
        }
        let status = self.vdp()?.pointer("/data/sync_status")?.as_str()?;
        (status != "online").then_some(status)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Inbound, MeterAddress, NameValue, Notification, ParameterAddress, PostVerdict, Request,
        WriteValue,
    };
    use serde_json::{json, Value};

    const ADDRESS: ParameterAddress = ParameterAddress {
        param_id: 142,
        x: 0,
        y: 1,
    };

    fn frame(method: &str, uri: &str, data: Value) -> Inbound {
        Inbound::new(json!({ "vdp": { "method": method, "uri": uri, "data": data } }))
    }

    #[test]
    fn requests_encode_the_messages_device_center_expects() {
        let meter = MeterAddress { meter_id: 7, x: -1 };
        let cases = [
            (
                Request::GetParameter(ADDRESS),
                json!({ "method": "get", "uri": "/vd/parameters/142:0:1" }),
            ),
            (
                Request::SetParameter(ADDRESS, WriteValue::Integer(-32768)),
                json!({ "method": "post", "uri": "/vd/parameters/142:0:1?operation=value",
                        "data": { "current_value": -32768 } }),
            ),
            (
                Request::SetParameter(ADDRESS, WriteValue::Text("01".into())),
                json!({ "method": "post", "uri": "/vd/parameters/142:0:1?operation=value",
                        "data": { "current_value": "01" } }),
            ),
            (
                Request::RegisterParameter(ADDRESS),
                json!({ "method": "post", "uri": "/vd/parameters/142:0:1?operation=regist" }),
            ),
            (
                Request::UnregisterParameter(ADDRESS),
                json!({ "method": "post", "uri": "/vd/parameters/142:0:1?operation=unregist" }),
            ),
            (
                Request::RegisterMeter(meter),
                json!({ "method": "post", "uri": "/vd/meters/7:-1?operation=regist" }),
            ),
            (
                Request::UnregisterMeter(meter),
                json!({ "method": "post", "uri": "/vd/meters/7:-1?operation=unregist" }),
            ),
            (
                Request::GetSynchronize,
                json!({ "method": "get", "uri": "/vd/synchronize" }),
            ),
            (
                Request::GetDevice,
                json!({ "method": "get", "uri": "/vd/device" }),
            ),
        ];
        for (request, vdp) in cases {
            assert_eq!(request.message(), json!({ "vdp": vdp }), "{request:?}");
        }
    }

    #[test]
    fn a_reply_matches_its_verb_and_address_with_the_query_removed() {
        let get = Request::GetParameter(ADDRESS).reply_key();
        let post = Request::SetParameter(ADDRESS, WriteValue::Integer(1)).reply_key();
        let value = frame(
            "get",
            "/vd/parameters/142:0:1",
            json!({ "current_value": 1 }),
        );
        let ack = frame(
            "post",
            "/vd/parameters/142:0:1?operation=value",
            json!({ "response_code": 200 }),
        );
        assert!(value.reply(&get).is_some());
        assert!(ack.reply(&post).is_some());
        assert!(value.reply(&post).is_none(), "the other verb's reply");
        assert!(ack.reply(&get).is_none(), "the other verb's reply");
    }

    #[test]
    fn a_notification_or_another_address_is_not_the_reply() {
        let get = Request::GetParameter(ADDRESS).reply_key();
        let post = Request::SetParameter(ADDRESS, WriteValue::Integer(1)).reply_key();
        let push = frame(
            "notify",
            "/vd/parameters/142:0:1",
            json!({ "current_value": 1 }),
        );
        assert!(push.reply(&get).is_none());
        assert!(push.reply(&post).is_none());
        for uri in [
            "/vd/parameters/142:0:12",
            "/vd/parameters/142:0",
            "/vd/parameters/14:0:1",
        ] {
            assert!(
                frame("get", uri, json!({ "current_value": 1 }))
                    .reply(&get)
                    .is_none(),
                "{uri}"
            );
        }
        assert!(Inbound::new(json!({ "vddp": {} })).reply(&get).is_none());
        assert!(Inbound::new(json!([1])).reply(&get).is_none());
    }

    #[test]
    fn a_post_reply_matches_only_its_own_single_operation() {
        let meter = MeterAddress { meter_id: 7, x: -1 };
        let posts = [
            (
                Request::SetParameter(ADDRESS, WriteValue::Integer(1)),
                "/vd/parameters/142:0:1",
                "value",
            ),
            (
                Request::SetParameter(ADDRESS, WriteValue::Text("a".into())),
                "/vd/parameters/142:0:1",
                "value",
            ),
            (
                Request::RegisterParameter(ADDRESS),
                "/vd/parameters/142:0:1",
                "regist",
            ),
            (
                Request::UnregisterParameter(ADDRESS),
                "/vd/parameters/142:0:1",
                "unregist",
            ),
            (Request::RegisterMeter(meter), "/vd/meters/7:-1", "regist"),
            (
                Request::UnregisterMeter(meter),
                "/vd/meters/7:-1",
                "unregist",
            ),
        ];
        let queries = [
            "?operation=value",
            "?operation=regist",
            "?operation=unregist",
            "",
            "?",
            "?operation",
            "?operation=",
            "?operation=foo",
            "?operation=Value",
            "?x=1&operation=value",
            "?operation=value&operation=value",
            "?operation=regist&operation=value",
        ];
        for (request, base, operation) in posts {
            let key = request.reply_key();
            for query in queries {
                let reply = frame(
                    "post",
                    &format!("{base}{query}"),
                    json!({ "response_code": 200 }),
                );
                let own = query == format!("?operation={operation}")
                    || (operation == "value" && query == "?x=1&operation=value");
                assert_eq!(reply.reply(&key).is_some(), own, "{request:?} {query}");
            }
        }
    }

    #[test]
    fn a_get_reply_matches_with_any_query() {
        let key = Request::GetSynchronize.reply_key();
        for uri in [
            "/vd/synchronize",
            "/vd/synchronize?x=1",
            "/vd/synchronize?operation=value",
        ] {
            assert!(
                frame("get", uri, json!({ "sync_status": "online" }))
                    .reply(&key)
                    .is_some(),
                "{uri}"
            );
        }
    }

    #[test]
    fn the_post_verdict_reads_only_a_present_integer_response_code() {
        let post = Request::SetParameter(ADDRESS, WriteValue::Integer(1)).reply_key();
        let verdict = |data: Value| {
            frame("post", "/vd/parameters/142:0:1?operation=value", data)
                .reply(&post)
                .expect("the reply")
                .post_verdict()
        };
        assert_eq!(
            verdict(json!({ "response_code": 200 })),
            PostVerdict::Accepted
        );
        assert_eq!(
            verdict(json!({ "response_code": 400 })),
            PostVerdict::Rejected(400)
        );
        assert_eq!(
            verdict(json!({ "response_code": -1 })),
            PostVerdict::Rejected(-1)
        );
        for data in [
            json!({}),
            json!({ "response_code": "200" }),
            json!({ "response_code": 200.5 }),
            json!({ "response_code": 200.0 }),
            json!({ "response_code": 9_223_372_036_854_775_808u64 }),
            json!({ "response_code": null }),
        ] {
            assert_eq!(verdict(data.clone()), PostVerdict::Malformed, "{data}");
        }
    }

    #[test]
    fn reads_decode_their_own_raw_type_strictly() {
        let get = Request::GetParameter(ADDRESS).reply_key();
        let read = |value: Value| {
            frame(
                "get",
                "/vd/parameters/142:0:1",
                json!({ "current_value": value }),
            )
        };

        assert_eq!(
            read(json!(i64::MIN)).reply(&get).unwrap().numeric_value(),
            Ok(i64::MIN)
        );
        assert_eq!(
            read(json!(i64::MAX)).reply(&get).unwrap().numeric_value(),
            Ok(i64::MAX)
        );
        for value in [json!("1"), json!(1.5), json!(u64::MAX), json!(null)] {
            assert!(
                read(value.clone())
                    .reply(&get)
                    .unwrap()
                    .numeric_value()
                    .is_err(),
                "{value}"
            );
        }

        assert_eq!(
            read(json!("01")).reply(&get).unwrap().text_value(),
            Ok("01")
        );
        assert_eq!(read(json!("")).reply(&get).unwrap().text_value(), Ok(""));
        assert!(read(json!(3)).reply(&get).unwrap().text_value().is_err());

        assert_eq!(
            read(json!("Vocal")).reply(&get).unwrap().name_value(),
            Ok(NameValue::Text("Vocal".into()))
        );
        assert_eq!(
            read(json!(4)).reply(&get).unwrap().name_value(),
            Ok(NameValue::Integer(4))
        );
        assert!(read(json!(4.5)).reply(&get).unwrap().name_value().is_err());

        let empty = frame("get", "/vd/parameters/142:0:1", json!({}));
        assert!(empty.reply(&get).unwrap().numeric_value().is_err());
        assert!(empty.reply(&get).unwrap().text_value().is_err());
        assert!(empty.reply(&get).unwrap().name_value().is_err());
    }

    #[test]
    fn notifications_carry_their_address_and_raw_value() {
        let notify = |uri: &str, data: Value| frame("notify", uri, data).notification();
        assert_eq!(
            notify("/vd/parameters/142:0:1", json!({ "current_value": -5 })),
            Some(Notification::Numeric {
                address: ADDRESS,
                value: -5
            })
        );
        assert_eq!(
            notify(
                "/vd/parameters/142:0:1?x=1",
                json!({ "current_value": "12" })
            ),
            Some(Notification::Text {
                address: ADDRESS,
                value: "12".into()
            })
        );
        assert_eq!(
            notify("/vd/meters/7:-1", json!({ "current_value": -12000 })),
            Some(Notification::Meter {
                address: MeterAddress { meter_id: 7, x: -1 },
                value: -12000
            })
        );
        assert_eq!(
            notify("/vd/parameters", json!({})),
            Some(Notification::BulkChange)
        );
        assert_eq!(
            notify("/vd/parameters?all", json!({})),
            Some(Notification::BulkChange)
        );
    }

    #[test]
    fn a_frame_that_is_not_a_well_formed_notification_is_none() {
        let notify = |uri: &str, data: Value| frame("notify", uri, data).notification();
        for (uri, data) in [
            ("/vd/parameters/142:0:1", json!({ "current_value": 1.5 })),
            ("/vd/parameters/142:0:1", json!({ "current_value": null })),
            ("/vd/parameters/142:0:1", json!({})),
            ("/vd/parameters/142:0", json!({ "current_value": 1 })),
            ("/vd/parameters/x:0:1", json!({ "current_value": 1 })),
            (
                "/vd/parameters/4294967296:0:1",
                json!({ "current_value": 1 }),
            ),
            ("/vd/meters/7:-1", json!({ "current_value": "1" })),
            ("/vd/meters/7", json!({ "current_value": 1 })),
            ("/vd/parameters/142:0:1:9", json!({ "current_value": 1 })),
            ("/vd/parameters/142:0:1:", json!({ "current_value": "a" })),
            ("/vd/parameters/142:0:1:x", json!({ "current_value": 1 })),
            ("/vd/meters/7:-1:0", json!({ "current_value": 1 })),
            ("/vd/meters/7:-1:", json!({ "current_value": 1 })),
            ("/vd/meters/7:-1:x", json!({ "current_value": 1 })),
            ("/vd/parametersX/1:0:1", json!({ "current_value": 1 })),
            ("/vd/synchronize", json!({ "sync_status": "lost" })),
        ] {
            assert_eq!(notify(uri, data.clone()), None, "{uri} {data}");
        }
        let reply = frame(
            "get",
            "/vd/parameters/142:0:1",
            json!({ "current_value": 1 }),
        );
        assert_eq!(reply.notification(), None, "a reply is not a notification");
    }

    #[test]
    fn a_synchronize_frame_that_is_not_online_reports_the_unit_lost() {
        let sync = |status: Value| {
            frame(
                "notify",
                "/vd/synchronize",
                json!({ "sync_status": status }),
            )
        };
        assert_eq!(sync(json!("lost")).device_lost(), Some("lost"));
        assert_eq!(sync(json!("offline")).device_lost(), Some("offline"));
        assert_eq!(sync(json!("online")).device_lost(), None);
        assert_eq!(sync(json!(1)).device_lost(), None);
        assert_eq!(
            frame("get", "/vd/synchronize?x", json!({ "sync_status": "lost" })).device_lost(),
            Some("lost")
        );
        assert_eq!(
            frame(
                "notify",
                "/vd/parameters/142:0:1",
                json!({ "sync_status": "lost" })
            )
            .device_lost(),
            None
        );
    }
}
