//! Device Center transport for YAMAHA URX series audio interfaces.
//!
//! This crate owns discovery, connections, request/reply matching,
//! notifications and subscriptions. It depends on neither Tauri nor
//! Node-API; each application wraps it in its own adapter.

#![forbid(unsafe_code)]

pub mod discovery;
pub mod frame;
pub mod i64_text;
pub mod lifecycle;
mod link;
#[cfg(test)]
mod test_peer;
pub mod wire;
