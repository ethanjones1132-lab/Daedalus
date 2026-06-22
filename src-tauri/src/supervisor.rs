// ═══════════════════════════════════════════════════════════════
// Process supervisor — keep the three boot children alive
// ═══════════════════════════════════════════════════════════════
//
// Jarvis spawns three long-lived children at boot: Ollama (only when it's the
// active backend), the claude_cli_proxy (:19878), and the Bun server (:19877).
// Nothing previously brought them back if they died mid-session — the same
// class of silent degradation that took down the Hermes gateway. This module
// runs a lightweight watchdog: every tick it probes each REQUIRED service and,
// if it's down, relaunches it via the existing idempotent spawn helpers.
//
// Restarts are bounded: after `MAX_CONSECUTIVE_RESTARTS` failed attempts in a
// row a service is left alone (loudly logged) until it is observed healthy
// again, so a permanently-broken dependency can't cause an endless respawn
// loop. The tick interval itself also bounds restart frequency.

use crate::jarvis::types::{JarvisBackend, JarvisState};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const TICK: Duration = Duration::from_secs(20);
const BUN_PORT: u16 = 19877;
const PROXY_PORT: u16 = 19878;
const OLLAMA_PORT: u16 = 11434;
const MAX_CONSECUTIVE_RESTARTS: u32 = 5;

/// Whether another restart attempt is allowed given the consecutive-failure
/// count. Pure so the backoff bound is unit-testable.
fn may_restart(consecutive_failures: u32) -> bool {
    consecutive_failures < MAX_CONSECUTIVE_RESTARTS
}

#[derive(Default)]
struct Supervisor {
    bun_fails: u32,
    proxy_fails: u32,
    ollama_fails: u32,
}

/// Spawn the supervisor loop. Gives boot one tick of grace before the first
/// check so the eager boot-time starts have a chance to come up first.
pub fn spawn_supervisor(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut sup = Supervisor::default();
        tokio::time::sleep(TICK).await;
        loop {
            sup.tick(&handle).await;
            tokio::time::sleep(TICK).await;
        }
    });
}

impl Supervisor {
    async fn tick(&mut self, handle: &AppHandle) {
        // Read the active backend + model once per tick.
        let (is_ollama, ollama_model) = {
            let state = handle.state::<JarvisState>();
            let cfg = state.config.lock().await;
            (
                matches!(cfg.active_backend, JarvisBackend::Ollama),
                cfg.ollama.model.clone(),
            )
        };

        // ── Bun server (required by every backend for tools/skills/models) ──
        if crate::is_port_listening(BUN_PORT) {
            self.bun_fails = 0;
        } else if may_restart(self.bun_fails) {
            // ensure_* is idempotent (it health-probes before spawning).
            match crate::ensure_jarvis_server_started().await {
                Ok(_) => {
                    self.bun_fails = 0;
                    println!("[supervisor] Bun server was down — relaunched.");
                }
                Err(e) => {
                    self.bun_fails += 1;
                    eprintln!(
                        "[supervisor] Bun server restart failed ({}/{}): {e}",
                        self.bun_fails, MAX_CONSECUTIVE_RESTARTS
                    );
                    if self.bun_fails == MAX_CONSECUTIVE_RESTARTS {
                        eprintln!(
                            "[supervisor] Bun server: giving up auto-restart until it is healthy again."
                        );
                    }
                }
            }
        }

        // ── claude_cli_proxy (routes to whichever backend is active) ──
        if crate::is_port_listening(PROXY_PORT) {
            self.proxy_fails = 0;
        } else if may_restart(self.proxy_fails) {
            // Drop any stale tracked handle (the process is gone if the port is down).
            if let Some(m) = crate::PROXY_PROCESS.get() {
                if let Ok(mut g) = m.lock() {
                    if let Some(mut old) = g.take() {
                        let _ = old.kill();
                    }
                }
            }
            match crate::spawn_claude_cli_proxy(ollama_model.clone()) {
                Some(child) => {
                    if let Some(m) = crate::PROXY_PROCESS.get() {
                        if let Ok(mut g) = m.lock() {
                            *g = Some(child);
                        }
                    }
                    self.proxy_fails = 0;
                    println!("[supervisor] claude_cli_proxy was down — relaunched.");
                }
                None => {
                    self.proxy_fails += 1;
                    eprintln!(
                        "[supervisor] claude_cli_proxy restart failed ({}/{}).",
                        self.proxy_fails, MAX_CONSECUTIVE_RESTARTS
                    );
                }
            }
        }

        // ── Ollama (only required when it is the active backend) ──
        if !is_ollama {
            self.ollama_fails = 0;
        } else if crate::is_port_listening(OLLAMA_PORT) {
            self.ollama_fails = 0;
        } else if may_restart(self.ollama_fails) {
            crate::start_ollama_and_warm(ollama_model).await;
            if crate::is_port_listening(OLLAMA_PORT) {
                self.ollama_fails = 0;
                println!("[supervisor] Ollama was down — relaunched.");
            } else {
                self.ollama_fails += 1;
                eprintln!(
                    "[supervisor] Ollama restart failed ({}/{}).",
                    self.ollama_fails, MAX_CONSECUTIVE_RESTARTS
                );
            }
        }

        // Heartbeat for any UI that wants to show supervisor activity.
        let _ = handle.emit(
            "jarvis://supervisor",
            serde_json::json!({
                "bun_up": crate::is_port_listening(BUN_PORT),
                "proxy_up": crate::is_port_listening(PROXY_PORT),
                "ollama_up": crate::is_port_listening(OLLAMA_PORT),
                "ollama_required": is_ollama,
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_stops_after_max_consecutive_failures() {
        assert!(may_restart(0));
        assert!(may_restart(MAX_CONSECUTIVE_RESTARTS - 1));
        assert!(!may_restart(MAX_CONSECUTIVE_RESTARTS));
        assert!(!may_restart(MAX_CONSECUTIVE_RESTARTS + 1));
    }
}
