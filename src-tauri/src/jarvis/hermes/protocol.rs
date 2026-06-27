//! JSON-RPC 2.0 envelope types for the tui_gateway protocol.
//!
//! Wire format: one JSON object per newline-terminated line.
//! Three message kinds — see spec §4.1.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Monotonic request id. Formatted `j{n}` to avoid collisions with anything Hermes
/// generates internally. See `process::HermesProcess::next_rid()`.
#[derive(Debug, Clone, Hash, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rid(pub String);

impl std::fmt::Display for Rid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// JSON-RPC error block on a response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// Outgoing message — Rust → Hermes.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum OutgoingMessage {
    Request {
        #[serde(rename = "jsonrpc", serialize_with = "serialize_jsonrpc_version")]
        _v: (),
        id: Rid,
        method: String,
        params: Value,
    },
}

impl OutgoingMessage {
    pub fn request(id: Rid, method: impl Into<String>, params: Value) -> Self {
        Self::Request {
            _v: (),
            id,
            method: method.into(),
            params,
        }
    }
}

fn serialize_jsonrpc_version<S: serde::Serializer>(_: &(), s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str("2.0")
}

/// Incoming message — Hermes → Rust. Either a response or an event.
#[derive(Debug, Clone)]
pub enum IncomingMessage {
    Response {
        id: Rid,
        result: Option<Value>,
        error: Option<RpcError>,
    },
    Event {
        event_type: String,
        session_id: Option<String>,
        payload: Value,
    },
}

impl<'de> Deserialize<'de> for IncomingMessage {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = Value::deserialize(d)?;
        // Response: has "id"
        if let Some(id_v) = v.get("id") {
            let id = Rid(id_v
                .as_str()
                .ok_or_else(|| serde::de::Error::custom("id must be string"))?
                .to_string());
            let result = v.get("result").cloned();
            let error = v
                .get("error")
                .map(|e| {
                    serde_json::from_value::<RpcError>(e.clone()).map_err(serde::de::Error::custom)
                })
                .transpose()?;
            return Ok(IncomingMessage::Response { id, result, error });
        }
        // Event: method == "event"
        if v.get("method").and_then(|m| m.as_str()) == Some("event") {
            let params = v
                .get("params")
                .cloned()
                .unwrap_or_else(|| Value::Object(Default::default()));
            let event_type = params
                .get("type")
                .and_then(|t| t.as_str())
                .ok_or_else(|| serde::de::Error::custom("event missing type"))?
                .to_string();
            let session_id = params
                .get("session_id")
                .and_then(|s| s.as_str())
                .map(String::from);
            // Payload = params minus "type" and "session_id"
            let mut payload = params;
            if let Some(obj) = payload.as_object_mut() {
                obj.remove("type");
                obj.remove("session_id");
            }
            return Ok(IncomingMessage::Event {
                event_type,
                session_id,
                payload,
            });
        }
        Err(serde::de::Error::custom("not a response or event"))
    }
}

/// Errors the bridge can surface to callers.
#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("hermes process not running")]
    NotRunning,
    #[error("hermes process exited before responding: {reason}")]
    ChildExited { reason: String },
    #[error("hermes process is crashed: {reason}")]
    Crashed { reason: String },
    #[error("request to method '{method}' timed out after {elapsed_ms}ms")]
    Timeout { method: String, elapsed_ms: u64 },
    #[error("hermes returned error for '{method}': [{code}] {message}")]
    RpcError {
        method: String,
        code: i32,
        message: String,
    },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("hermes home not found at {0}")]
    HermesHomeMissing(String),
    #[error("hermes venv python not found at any of: {0}")]
    VenvMissing(String),
    #[error("startup failed: gateway.ready not received within {elapsed_ms}ms")]
    StartupTimeout { elapsed_ms: u64 },
    #[error("backpressure: stdin queue full")]
    Backpressure,
    #[error("bridge is shutting down")]
    ShuttingDown,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rid_displays_as_its_inner_string() {
        assert_eq!(Rid("j7".to_string()).to_string(), "j7");
    }

    #[test]
    fn outgoing_request_injects_jsonrpc_version() {
        let msg = OutgoingMessage::request(Rid("j1".to_string()), "skill.invoke", json!({"a": 1}));
        let v = serde_json::to_value(&msg).expect("serialize");
        assert_eq!(v.get("jsonrpc").and_then(|x| x.as_str()), Some("2.0"));
        assert_eq!(v.get("id").and_then(|x| x.as_str()), Some("j1"));
        assert_eq!(v.get("method").and_then(|x| x.as_str()), Some("skill.invoke"));
        assert_eq!(v.pointer("/params/a").and_then(|x| x.as_i64()), Some(1));
    }

    #[test]
    fn incoming_response_with_result_parses() {
        let line = r#"{"jsonrpc":"2.0","id":"j1","result":{"ok":true}}"#;
        match serde_json::from_str::<IncomingMessage>(line).expect("parse") {
            IncomingMessage::Response { id, result, error } => {
                assert_eq!(id, Rid("j1".to_string()));
                assert!(error.is_none());
                assert_eq!(result.unwrap().pointer("/ok").and_then(|v| v.as_bool()), Some(true));
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[test]
    fn incoming_response_with_error_parses() {
        let line = r#"{"jsonrpc":"2.0","id":"j2","error":{"code":-32601,"message":"no method"}}"#;
        match serde_json::from_str::<IncomingMessage>(line).expect("parse") {
            IncomingMessage::Response { id, error, .. } => {
                assert_eq!(id, Rid("j2".to_string()));
                let e = error.expect("error present");
                assert_eq!(e.code, -32601);
                assert_eq!(e.message, "no method");
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[test]
    fn incoming_event_extracts_type_and_strips_envelope_keys() {
        let line = r#"{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","session_id":"s1","extra":42}}"#;
        match serde_json::from_str::<IncomingMessage>(line).expect("parse") {
            IncomingMessage::Event { event_type, session_id, payload } => {
                assert_eq!(event_type, "gateway.ready");
                assert_eq!(session_id.as_deref(), Some("s1"));
                // type/session_id stripped; domain payload preserved.
                assert!(payload.get("type").is_none());
                assert!(payload.get("session_id").is_none());
                assert_eq!(payload.get("extra").and_then(|v| v.as_i64()), Some(42));
            }
            other => panic!("expected Event, got {other:?}"),
        }
    }

    #[test]
    fn incoming_rejects_neither_response_nor_event() {
        let line = r#"{"jsonrpc":"2.0","method":"notify","params":{}}"#;
        assert!(serde_json::from_str::<IncomingMessage>(line).is_err());
    }
}
