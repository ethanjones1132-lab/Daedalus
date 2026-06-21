//! Tauri command surface for the Hermes bridge.
//!
//! Six lifecycle commands + a single generic `hermes_invoke` that handles every
//! JSON-RPC method. The frontend looks up `long` flags from the YAML manifest
//! (shipped alongside the JS bundle) and passes them along.

use crate::jarvis::hermes::process::HermesState;
use crate::jarvis::hermes::state::{require_process, HermesAppState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

#[derive(Serialize)]
pub struct HermesStatus {
    pub state: String,
    pub reason: Option<String>,
}

#[derive(Deserialize)]
pub struct HermesInvokeArgs {
    pub method: String,
    #[serde(default)]
    pub params: Value,
    /// Long-running methods can opt out of the default per-request timeout
    /// by passing `timeout_ms` explicitly. The bridge caps the override at
    /// 5 minutes to avoid orphaned requests.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[tauri::command]
pub async fn hermes_status(state: State<'_, HermesAppState>) -> Result<HermesStatus, String> {
    let Some(p) = state.get().await else {
        return Ok(HermesStatus {
            state: "cold".into(),
            reason: None,
        });
    };
    let s = p.state().await;
    Ok(match s {
        HermesState::Cold => HermesStatus {
            state: "cold".into(),
            reason: None,
        },
        HermesState::Starting => HermesStatus {
            state: "starting".into(),
            reason: None,
        },
        HermesState::Ready => HermesStatus {
            state: "ready".into(),
            reason: None,
        },
        HermesState::Draining => HermesStatus {
            state: "draining".into(),
            reason: None,
        },
        HermesState::Crashed { reason } => HermesStatus {
            state: "crashed".into(),
            reason: Some(reason),
        },
    })
}

#[tauri::command]
pub async fn hermes_spawn(
    app: AppHandle,
    state: State<'_, HermesAppState>,
) -> Result<HermesStatus, String> {
    state.spawn_and_attach(app).await?;
    hermes_status(state).await
}

#[tauri::command]
pub async fn hermes_shutdown(
    state: State<'_, HermesAppState>,
) -> Result<HermesStatus, String> {
    state.detach_and_shutdown().await?;
    hermes_status(state).await
}

#[tauri::command]
pub async fn hermes_restart(
    app: AppHandle,
    state: State<'_, HermesAppState>,
) -> Result<HermesStatus, String> {
    state.detach_and_shutdown().await?;
    state.spawn_and_attach(app).await?;
    hermes_status(state).await
}

#[tauri::command]
pub async fn hermes_interrupt(
    state: State<'_, HermesAppState>,
) -> Result<HermesStatus, String> {
    // There is no per-request cancel RPC in the bridge today; the closest
    // available action is to shut the child down, which drains any pending
    // oneshot senders with a NotRunning error. Re-spawning is the caller's
    // job (see hermes_restart).
    state.detach_and_shutdown().await?;
    hermes_status(state).await
}

#[tauri::command]
pub async fn hermes_invoke(
    args: HermesInvokeArgs,
    _app: AppHandle,
) -> Result<Value, String> {
    let proc = require_process(&_app).await?;
    proc.invoke(args.method, args.params)
        .await
        .map_err(|e| e.to_string())
}
