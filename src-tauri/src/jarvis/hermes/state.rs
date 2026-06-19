//! Tauri-managed wrapper around HermesProcess. Owns the singleton instance per
//! window. Re-emits HermesEvents as typed Tauri events under name "hermes-event".

use crate::jarvis::hermes::process::{HermesConfig, HermesProcess};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

pub struct HermesAppState {
    pub process: Mutex<Option<Arc<HermesProcess>>>,
    pub config: HermesConfig,
}

impl HermesAppState {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            config: HermesConfig::default(),
        }
    }

    /// Get the running process or return None.
    pub async fn get(&self) -> Option<Arc<HermesProcess>> {
        self.process.lock().await.clone()
    }

    /// Spawn a new HermesProcess and start it. Stores the Arc on success. Bridges
    /// events to Tauri's emit system.
    pub async fn spawn_and_attach(&self, app: AppHandle) -> Result<(), String> {
        let mut guard = self.process.lock().await;
        if guard.is_some() {
            return Ok(()); // already running — idempotent
        }
        let proc = HermesProcess::new(self.config.clone());
        // Subscribe before start so we don't miss early events.
        let mut sub = proc.subscribe_events();
        let app_clone = app.clone();
        tokio::spawn(async move {
            while let Ok(ev) = sub.recv().await {
                let payload = serde_json::json!({
                    "type": ev.event_type,
                    "session_id": ev.session_id,
                    "params": ev.payload,
                });
                let _ = app_clone.emit("hermes-event", payload);
            }
        });
        proc.start().await.map_err(|e| e.to_string())?;
        *guard = Some(proc);
        Ok(())
    }

    pub async fn detach_and_shutdown(&self) -> Result<(), String> {
        let proc = self.process.lock().await.take();
        if let Some(p) = proc {
            p.shutdown().await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

impl Default for HermesAppState {
    fn default() -> Self {
        Self::new()
    }
}

/// Helper used by commands: get the running process or surface a clean error.
pub async fn require_process(app: &AppHandle) -> Result<Arc<HermesProcess>, String> {
    let state = app.state::<HermesAppState>();
    state
        .get()
        .await
        .ok_or_else(|| "hermes process is not running".to_string())
}
