//! Device discovery through Device Center (D13/D14, N2).
//!
//! Device Center lists every unit it has seen on its fixed list port, with
//! the `vdp` port of each. A listed unit is a candidate only when its own
//! `/vd/synchronize` reports `online`, and its identity is that response's
//! `usb_id`. Every candidate is checked within one budget; a candidate that
//! could not be checked fails the whole discovery, so no result is ever
//! selected from an incomplete list.

use crate::lifecycle::{Cause, Control, Failure, Phase};
use crate::link::{Budget, Link};
use crate::wire::{Inbound, Request};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;

/// Device Center's device-list port.
pub const DEVICE_CENTER_LIST_PORT: u16 = 51770;

const PHASE: Phase = Phase::Discovery;

const LIST_URI: &str = "/vddp_srv/devices";

/// How one discovery runs. The durations are the consumer's policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiscoveryOptions {
    /// Device Center's list port; [`DEVICE_CENTER_LIST_PORT`] outside tests.
    pub list_port: u16,
    /// The whole discovery, from connecting to the list port until the last
    /// candidate check finishes.
    pub deadline: Duration,
    /// Each request's send deadline and, once sent, its response deadline.
    pub request_deadline: Duration,
    /// Whether to read each online unit's System firmware version.
    pub metadata: bool,
}

/// A unit's System firmware version as `/vd/device` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SystemFirmware {
    Version(String),
    /// A valid response that reports no System version.
    Absent,
}

/// One online unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceEntry {
    /// The exact `usb_id`, nonempty and unique within this discovery.
    pub id: String,
    /// The model Device Center lists, nonempty.
    pub model: String,
    /// The unit's `vdp` port for this Device Center session; not an identity.
    pub port: u16,
    /// Read only when [`DiscoveryOptions::metadata`] is set.
    pub firmware: Option<SystemFirmware>,
}

/// Lists the online units, in Device Center's list order. An empty list is a
/// completed discovery with no unit online.
pub fn discover(
    options: &DiscoveryOptions,
    control: &Control,
) -> Result<Vec<DeviceEntry>, Failure> {
    let budget = Budget::starting_now(options.deadline, Cause::DiscoveryTimeout);
    let listed = list(options, &budget, control)?;
    let mut entries = Vec::new();
    let mut ids = HashSet::new();
    for (port, model) in listed {
        let Some(entry) = check(port, model, options, &budget, control)? else {
            continue;
        };
        if !ids.insert(entry.id.clone()) {
            return Err(Failure::cause(Cause::IdentityError, PHASE));
        }
        entries.push(entry);
    }
    Ok(entries)
}

fn malformed() -> Failure {
    Failure::cause(Cause::InvalidResponse, PHASE)
}

/// Every listed unit's `vdp` port and model.
fn list(
    options: &DiscoveryOptions,
    budget: &Budget,
    control: &Control,
) -> Result<Vec<(u16, String)>, Failure> {
    let mut link = Link::connect(options.list_port, budget, PHASE, control)?;
    let request = json!({ "vddp": { "method": "get", "uri": LIST_URI } });
    link.send(&request, options.request_deadline, budget)?;
    let data = link.await_frame(options.request_deadline, budget, |message| {
        let vddp = message.get("vddp")?;
        let method = vddp.get("method").and_then(Value::as_str);
        let uri = vddp.get("uri").and_then(Value::as_str).unwrap_or("");
        if method != Some("get") || uri.split('?').next() != Some(LIST_URI) {
            return None;
        }
        Some(vddp.get("data").cloned().ok_or_else(malformed))
    })?;
    parse_list(&data)
}

fn parse_list(data: &Value) -> Result<Vec<(u16, String)>, Failure> {
    let list = data
        .get("list")
        .and_then(Value::as_array)
        .ok_or_else(malformed)?;
    list.iter()
        .map(|entry| {
            let port = entry
                .get("vdpport")
                .and_then(Value::as_u64)
                .and_then(|port| u16::try_from(port).ok())
                .filter(|&port| port != 0)
                .ok_or_else(malformed)?;
            let model = entry
                .get("model")
                .and_then(Value::as_str)
                .filter(|model| !model.is_empty())
                .ok_or_else(malformed)?;
            Ok((port, model.to_string()))
        })
        .collect()
}

/// The listed unit at `port` if it is online, or `None` when it reports any
/// other nonempty link state. Once the unit has reported `online`, a
/// device-lost push received before its firmware reply fails the check: the
/// unit was unplugged while it was being checked, and Device Center keeps
/// answering `/vd/device` from its cache.
fn check(
    port: u16,
    model: String,
    options: &DiscoveryOptions,
    budget: &Budget,
    control: &Control,
) -> Result<Option<DeviceEntry>, Failure> {
    let mut link = Link::connect(port, budget, PHASE, control)?;
    let synchronize = get(
        &mut link,
        Request::GetSynchronize,
        false,
        options.request_deadline,
        budget,
        PHASE,
    )?;
    let status = synchronize
        .get("sync_status")
        .and_then(Value::as_str)
        .filter(|status| !status.is_empty())
        .ok_or_else(malformed)?;
    if status != "online" {
        return Ok(None);
    }
    let id = synchronize
        .get("usb_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or(Failure::cause(Cause::IdentityError, PHASE))?
        .to_string();
    let firmware = if options.metadata {
        let device = get(
            &mut link,
            Request::GetDevice,
            true,
            options.request_deadline,
            budget,
            PHASE,
        )?;
        Some(system_firmware(&device).ok_or_else(malformed)?)
    } else {
        None
    };
    Ok(Some(DeviceEntry {
        id,
        model,
        port,
        firmware,
    }))
}

/// Whether `message` is a `/vd/synchronize` notification whose nonempty
/// status is not `online`: Device Center's push when the unit is unplugged.
/// Replies and notifications without a readable status are not.
pub(crate) fn lost_notification(message: &Value) -> bool {
    let notification = message
        .get("vdp")
        .and_then(|vdp| vdp.get("method"))
        .and_then(Value::as_str)
        == Some("notify");
    notification
        && Inbound::new(message.clone())
            .device_lost()
            .is_some_and(|status| !status.is_empty())
}

/// Sends a GET and returns its reply's `data`, failing in `phase`. With
/// `watch_lost`, a [`lost_notification`] received while waiting fails it as
/// `connection_lost`.
pub(crate) fn get(
    link: &mut Link<'_>,
    request: Request,
    watch_lost: bool,
    request_deadline: Duration,
    budget: &Budget,
    phase: Phase,
) -> Result<Value, Failure> {
    link.send(&request.message(), request_deadline, budget)?;
    let key = request.reply_key();
    link.await_frame(request_deadline, budget, |message| {
        if watch_lost && lost_notification(message) {
            return Some(Err(Failure::cause(Cause::ConnectionLost, phase)));
        }
        let inbound = Inbound::new(message.clone());
        let reply = inbound.reply(&key)?;
        Some(
            reply
                .data()
                .cloned()
                .ok_or(Failure::cause(Cause::InvalidResponse, phase)),
        )
    })
}

/// The System version in `/vd/device`'s `firm_list`, whose entries are
/// matched by name without case. `None` when the response is malformed: no
/// `firm_list` array, an entry without a nonempty string `firm_name`, a System
/// entry without a string `firm_version`, or System entries that disagree.
/// Entry order does not change the result.
pub(crate) fn system_firmware(device: &Value) -> Option<SystemFirmware> {
    let list = device.get("firm_list")?.as_array()?;
    let mut version: Option<&str> = None;
    for entry in list {
        let name = entry
            .get("firm_name")?
            .as_str()
            .filter(|name| !name.is_empty())?;
        if !name.eq_ignore_ascii_case("system") {
            continue;
        }
        let this = entry.get("firm_version")?.as_str()?;
        if version.is_some_and(|seen| seen != this) {
            return None;
        }
        version = Some(this);
    }
    match version {
        None | Some("") => Some(SystemFirmware::Absent),
        Some(version) => Some(SystemFirmware::Version(version.to_string())),
    }
}

#[cfg(test)]
mod tests;
