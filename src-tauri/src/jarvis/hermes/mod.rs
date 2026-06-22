//! Hermes bridge: JSON-RPC 2.0 over newline-delimited stdio to the
//! `tui_gateway` Python process. See `protocol.rs` for the wire format.

pub mod commands;
pub mod process;
pub mod protocol;
pub mod state;
