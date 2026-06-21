//! HermesProcess — owns the child Python process and the IPC pipes.
//!
//! Lifecycle states transition as: Cold → Starting → Ready ⇄ Draining → (Cold | Crashed)
//! Crashed is a terminal state; the user must explicitly restart.

use crate::jarvis::hermes::protocol::{BridgeError, IncomingMessage, OutgoingMessage, Rid};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::process::Command;
use std::process::Stdio;
use tokio::io::{AsyncWriteExt, BufReader, AsyncBufReadExt};
use tokio::sync::{broadcast, oneshot, Mutex};

#[derive(Debug, Clone)]
pub enum HermesState {
    Cold,
    Starting,
    Ready,
    Draining,
    Crashed { reason: String },
}

impl std::fmt::Display for HermesState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cold => f.write_str("cold"),
            Self::Starting => f.write_str("starting"),
            Self::Ready => f.write_str("ready"),
            Self::Draining => f.write_str("draining"),
            Self::Crashed { reason } => write!(f, "crashed: {reason}"),
        }
    }
}

/// Configuration for spawning a Hermes child process.
#[derive(Debug, Clone)]
pub struct HermesConfig {
    /// HERMES_HOME — pinned to Jarvis's dedicated profile.
    pub hermes_home: PathBuf,
    /// Path to the Python interpreter inside the Hermes venv.
    pub python: PathBuf,
    /// Path to the tui_gateway entry point (e.g. `-m tui_gateway`).
    pub entry: String,
    /// Per-request timeout, in milliseconds.
    pub request_timeout_ms: u64,
    /// Initial startup timeout, in milliseconds.
    pub startup_timeout_ms: u64,
    /// Extra env vars passed to the child.
    pub extra_env: HashMap<String, String>,
}

impl Default for HermesConfig {
    fn default() -> Self {
        Self {
            hermes_home: PathBuf::from("/tmp/hermes-home"),
            python: PathBuf::from("python3"),
            entry: "-m tui_gateway".to_string(),
            request_timeout_ms: 30_000,
            startup_timeout_ms: 15_000,
            extra_env: HashMap::new(),
        }
    }
}

/// A Hermes-emitted event, fanned out to subscribers via a broadcast channel.
#[derive(Debug, Clone)]
pub struct HermesEvent {
    pub event_type: String,
    pub session_id: Option<String>,
    pub payload: serde_json::Value,
}

/// The owning process for the Hermes child. Exposes the lifecycle API
/// (`start`, `shutdown`) plus the JSON-RPC call surface (`invoke`).
pub struct HermesProcess {
    config: HermesConfig,
    state: Arc<Mutex<HermesState>>,
    /// Pending calls keyed by Rid. Each carries a oneshot for the response.
    pending: Arc<Mutex<HashMap<Rid, oneshot::Sender<Result<serde_json::Value, BridgeError>>>>>,
    /// Monotonic request id counter, formatted as `j{n}`.
    next_rid: AtomicU64,
    /// Stdin writer side of the child's IPC pipe.
    writer: Mutex<Option<tokio::process::ChildStdin>>,
    /// Child handle (kept so we can wait/kill).
    child: Arc<Mutex<Option<tokio::process::Child>>>,
    /// Broadcast channel for events.
    events: broadcast::Sender<HermesEvent>,
}

impl HermesProcess {
    pub fn new(config: HermesConfig) -> Self {
        let (events, _rx) = broadcast::channel(128);
        Self {
            config,
            state: Arc::new(Mutex::new(HermesState::Cold)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_rid: AtomicU64::new(1),
            writer: Mutex::new(None),
            child: Arc::new(Mutex::new(None)),
            events,
        }
    }

    /// Build the next request id.
    pub fn next_rid(&self) -> Rid {
        let n = self.next_rid.fetch_add(1, Ordering::Relaxed);
        Rid(format!("j{n}"))
    }

    /// Subscribe to events emitted by Hermes.
    pub fn subscribe_events(&self) -> broadcast::Receiver<HermesEvent> {
        self.events.subscribe()
    }

    /// Current lifecycle state.
    pub async fn state(&self) -> HermesState {
        self.state.lock().await.clone()
    }

    /// Spawn the child process, wire up stdin/stdout, and run the reader task.
    /// Transitions Cold → Starting → Ready on the first `gateway.ready` event,
    /// or → Crashed if the child exits before that.
    pub async fn start(&self) -> Result<(), BridgeError> {
        if !matches!(self.state().await, HermesState::Cold) {
            return Ok(()); // idempotent
        }
        *self.state.lock().await = HermesState::Starting;

        let mut command = Command::new(&self.config.python);
        command
            .arg("-u") // unbuffered, so the parent reads lines as they're written
            .arg(&self.config.entry)
            .env("HERMES_HOME", &self.config.hermes_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in &self.config.extra_env {
            command.env(k, v);
        }
        let mut child = command
            .spawn()
            .map_err(|e| BridgeError::Io(e))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| BridgeError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "child stdin not captured",
            )))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BridgeError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "child stdout not captured",
            )))?;

        *self.writer.lock().await = Some(stdin);
        *self.child.lock().await = Some(child);

        // Reader task: parses newline-delimited JSON, dispatches responses and
        // events. Runs until the child closes stdout or we mark the process
        // Draining/Crashed. The pending map, state, and child slot are all
        // Arc-wrapped, so we can move owned Arcs into the spawned task.
        let pending = Arc::clone(&self.pending);
        let events_tx = self.events.clone();
        let state = Arc::clone(&self.state);
        let child_slot = Arc::clone(&self.child);

        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let parsed: Result<IncomingMessage, _> = serde_json::from_str(&line);
                match parsed {
                    Ok(IncomingMessage::Response { id, result, error }) => {
                        let mut p = pending.lock().await;
                        if let Some(tx) = p.remove(&id) {
                            let v = if let Some(err) = error {
                                Err(BridgeError::RpcError {
                                    method: String::new(),
                                    code: err.code,
                                    message: err.message,
                                })
                            } else {
                                Ok(result.unwrap_or(serde_json::Value::Null))
                            };
                            let _ = tx.send(v);
                        }
                    }
                    Ok(IncomingMessage::Event {
                        event_type,
                        session_id,
                        payload,
                    }) => {
                        if event_type == "gateway.ready" {
                            *state.lock().await = HermesState::Ready;
                        }
                        let _ = events_tx.send(HermesEvent {
                            event_type,
                            session_id,
                            payload,
                        });
                    }
                    Err(_e) => {
                        // Malformed line — drop it. The bridge is resilient to
                        // stray logging output from the Python side.
                    }
                }
            }
            // stdout closed: the child has exited. Mark Crashed unless the
            // process was intentionally drained.
            let current = state.lock().await.clone();
            if !matches!(current, HermesState::Draining) {
                *state.lock().await = HermesState::Crashed {
                    reason: "child stdout closed".to_string(),
                };
            }
            // Drop the child handle to release the OS process; if the user
            // wants to restart, they call `start` again.
            let mut g = child_slot.lock().await;
            if let Some(mut c) = g.take() {
                let _ = c.kill().await;
            }
        });

        // Wait for gateway.ready, with a timeout.
        let deadline = std::time::Duration::from_millis(self.config.startup_timeout_ms);
        let mut sub = self.events.subscribe();
        let start = std::time::Instant::now();
        loop {
            if start.elapsed() > deadline {
                *self.state.lock().await = HermesState::Crashed {
                    reason: format!("startup timeout after {}ms", deadline.as_millis()),
                };
                return Err(BridgeError::StartupTimeout {
                    elapsed_ms: deadline.as_millis() as u64,
                });
            }
            match tokio::time::timeout(std::time::Duration::from_millis(250), sub.recv()).await {
                Ok(Ok(HermesEvent { event_type, .. })) if event_type == "gateway.ready" => {
                    *self.state.lock().await = HermesState::Ready;
                    return Ok(());
                }
                Ok(_) => continue,
                Err(_) => continue, // tick
            }
        }
    }

    /// Send a JSON-RPC request and await the response.
    pub async fn invoke(
        &self,
        method: impl Into<String>,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, BridgeError> {
        if !matches!(self.state().await, HermesState::Ready) {
            return Err(BridgeError::NotRunning);
        }
        let id = self.next_rid();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        let msg = OutgoingMessage::request(id.clone(), method, params);
        let line = serde_json::to_string(&msg).map_err(BridgeError::Json)?;
        {
            let mut w = self.writer.lock().await;
            let w = w.as_mut().ok_or(BridgeError::NotRunning)?;
            w.write_all(line.as_bytes()).await.map_err(BridgeError::Io)?;
            w.write_all(b"\n").await.map_err(BridgeError::Io)?;
        }

        let timeout = std::time::Duration::from_millis(self.config.request_timeout_ms);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_canceled)) => Err(BridgeError::NotRunning),
            Err(_) => {
                // Timed out — drop the pending sender to free memory.
                self.pending.lock().await.remove(&id);
                Err(BridgeError::Timeout {
                    method: String::new(),
                    elapsed_ms: timeout.as_millis() as u64,
                })
            }
        }
    }

    /// Politely shut the child down. Marks Draining, then kills the OS process
    /// (the Python side does not currently expose a graceful-shutdown RPC).
    pub async fn shutdown(&self) -> Result<(), BridgeError> {
        *self.state.lock().await = HermesState::Draining;
        let mut g = self.child.lock().await;
        if let Some(mut c) = g.take() {
            let _ = c.kill().await;
        }
        *self.state.lock().await = HermesState::Cold;
        Ok(())
    }
}

// (the broken CloneArc trait helper was removed in the recovery; Arc::clone
// on the now-Arc-wrapped fields is sufficient.)
