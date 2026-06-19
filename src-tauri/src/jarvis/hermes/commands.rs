//! Tauri command surface for the Hermes bridge.
//!
//! Six lifecycle commands + a single generic `hermes_invoke` that handles every
//! JSON-RPC method. The frontend looks up `long` flags from the YAML manifest
//! (shipped alongside the JS bundle) and passes them along.

use crate::jarvis::hermes::process::HermesState;
use crate::jarvis::hermes::state::{require_process, HermesAppState};
use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Serialize)]
pub struct HermesStatus {
    pub state: String,
    pub reason: Option<String>,
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
        HermesState::Crashed {