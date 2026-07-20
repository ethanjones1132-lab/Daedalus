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

use crate::commands::system::SupervisorStatus;
use crate::jarvis::types::{JarvisBackend, JarvisState};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const TICK: Duration = Duration::from_secs(20);
const BUN_PORT: u16 = 19877;
const PROXY_PORT: u16 = 19878;
const OLLAMA_PORT: u16 = 11434;
const MAX_CONSECUTIVE_RESTARTS: u32 = 5;

/// Consecutive-failure counters live at module scope so manual restart
/// commands (Bun / Ollama / proxy) can clear them. Per-instance fields would
/// be unreachable from a Tauri command — the supervisor task is the only
/// thing that owns the struct — so a forced restart would still appear
/// permanently given-up to subsequent supervisor ticks.
pub(crate) static BUN_FAILS: AtomicU32 = AtomicU32::new(0);
pub(crate) static PROXY_FAILS: AtomicU32 = AtomicU32::new(0);
pub(crate) static OLLAMA_FAILS: AtomicU32 = AtomicU32::new(0);
static BUN_LAST_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SupervisedService {
    Bun,
    Proxy,
    Ollama,
}

/// Whether another restart attempt is allowed given the consecutive-failure
/// count. Pure so the backoff bound is unit-testable.
fn may_restart(consecutive_failures: u32) -> bool {
    consecutive_failures < MAX_CONSECUTIVE_RESTARTS
}

fn failure_counter(service: SupervisedService) -> &'static AtomicU32 {
    match service {
        SupervisedService::Bun => &BUN_FAILS,
        SupervisedService::Proxy => &PROXY_FAILS,
        SupervisedService::Ollama => &OLLAMA_FAILS,
    }
}

fn bun_last_error() -> Option<String> {
    BUN_LAST_ERROR
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

fn record_restart_failure(service: SupervisedService, error: &str) -> u32 {
    let counter = failure_counter(service);
    let previous = counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            Some(current.saturating_add(1).min(MAX_CONSECUTIVE_RESTARTS))
        })
        .unwrap_or_else(|current| current);
    let next = previous.saturating_add(1).min(MAX_CONSECUTIVE_RESTARTS);

    if matches!(service, SupervisedService::Bun) {
        *BUN_LAST_ERROR
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(error.to_string());
    }
    next
}

fn bun_diagnostic(failures: u32, last_error: Option<&str>) -> Option<String> {
    if failures == 0 {
        return None;
    }
    let error = last_error.unwrap_or("unknown Bun startup failure");
    if failures >= MAX_CONSECUTIVE_RESTARTS {
        Some(format!(
            "Bun server auto-restart exhausted ({failures}/{MAX_CONSECUTIVE_RESTARTS}). \
             Last error: {error}. Automatic retries are paused; use Restart to re-arm the budget."
        ))
    } else {
        Some(format!(
            "Bun server restart failed ({failures}/{MAX_CONSECUTIVE_RESTARTS}). \
             Last error: {error}. Automatic retry remains enabled."
        ))
    }
}

/// Reset a service's consecutive-failure counter so the supervisor resumes
/// auto-restarting it. Called when the user forces a manual restart.
pub(crate) fn reset_failures(service: SupervisedService) {
    failure_counter(service).store(0, Ordering::Relaxed);
    if matches!(service, SupervisedService::Bun) {
        *BUN_LAST_ERROR
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
    }
}

/// Snapshot of which services the supervisor has given up auto-restarting.
/// Exposed to the UI via `get_system_health` so a down service can show
/// "auto-restart paused — use Restart" instead of leaving the user guessing
/// why the watchdog is no longer poking the port. Pure read of the existing
/// atomic counters, safe to call from any task.
pub fn give_up_status() -> SupervisorStatus {
    let bun_restart_failures = BUN_FAILS.load(Ordering::Relaxed);
    let bun_last_error = bun_last_error();
    SupervisorStatus {
        bun_give_up: bun_restart_failures >= MAX_CONSECUTIVE_RESTARTS,
        proxy_give_up: PROXY_FAILS.load(Ordering::Relaxed) >= MAX_CONSECUTIVE_RESTARTS,
        ollama_give_up: OLLAMA_FAILS.load(Ordering::Relaxed) >= MAX_CONSECUTIVE_RESTARTS,
        bun_restart_failures,
        restart_limit: MAX_CONSECUTIVE_RESTARTS,
        bun_diagnostic: bun_diagnostic(bun_restart_failures, bun_last_error.as_deref()),
        bun_last_error,
    }
}

/// Spawn the supervisor loop. Gives boot one tick of grace before the first
/// check so the eager boot-time starts have a chance to come up first.
///
/// This deliberately uses the caller's Tokio runtime. Startup calls it from
/// the dedicated `jarvis-bootstrap` OS thread, keeping the synchronous Windows
/// and WSL process probes below off Tauri's WebView/IPC runtime.
pub fn spawn_supervisor(handle: AppHandle) {
    tokio::spawn(async move {
        tokio::time::sleep(TICK).await;
        loop {
            tick(&handle).await;
            tokio::time::sleep(TICK).await;
        }
    });
}

fn proxy_heartbeat_status(proxy_required: bool, probe: impl FnOnce() -> bool) -> bool {
    proxy_required && probe()
}

async fn tick(handle: &AppHandle) {
    // Read the active backend + model once per tick.
    let (is_ollama, ollama_model, proxy_required, openrouter_api_key) = {
        let state = handle.state::<JarvisState>();
        let cfg = state.config.lock().await;
        (
            matches!(cfg.active_backend, JarvisBackend::Ollama),
            cfg.ollama.model.clone(),
            crate::claude_proxy_enabled(&cfg),
            cfg.openrouter.api_key.clone(),
        )
    };

    // ── Bun server (required by every backend for tools/skills/models) ──
    if crate::is_port_listening(BUN_PORT) {
        reset_failures(SupervisedService::Bun);
    } else {
        let fails = BUN_FAILS.load(Ordering::Relaxed);
        if may_restart(fails) {
            // ensure_* is idempotent (it health-probes before spawning).
            match crate::ensure_jarvis_server_started().await {
                Ok(_) => {
                    reset_failures(SupervisedService::Bun);
                    println!("[supervisor] Bun server was down — relaunched.");
                }
                Err(e) => {
                    let next = record_restart_failure(SupervisedService::Bun, &e);
                    log::warn!(
                        target: "jarvis::supervisor",
                        "Bun server restart failed ({next}/{MAX_CONSECUTIVE_RESTARTS}): {e}"
                    );
                    if next == MAX_CONSECUTIVE_RESTARTS {
                        if let Some(diagnostic) = bun_diagnostic(next, Some(e.as_str())) {
                            log::error!(target: "jarvis::supervisor", "{diagnostic}");
                        }
                    }
                }
            }
        }
    }

    // ── claude_cli_proxy (routes to whichever backend is active) ──
    if !proxy_required {
        PROXY_FAILS.store(0, Ordering::Relaxed);
        if let Some(m) = crate::PROXY_PROCESS.get() {
            if let Ok(mut g) = m.lock() {
                if let Some(mut old) = g.take() {
                    let _ = old.kill();
                    println!("[supervisor] claude_cli_proxy stopped; proxy auth is not enabled.");
                }
            }
        }
    } else if crate::is_port_listening(PROXY_PORT) {
        PROXY_FAILS.store(0, Ordering::Relaxed);
    } else {
        let fails = PROXY_FAILS.load(Ordering::Relaxed);
        if may_restart(fails) {
            // Drop any stale tracked handle (the process is gone if the port is down).
            if let Some(m) = crate::PROXY_PROCESS.get() {
                if let Ok(mut g) = m.lock() {
                    if let Some(mut old) = g.take() {
                        let _ = old.kill();
                    }
                }
            }
            match crate::spawn_claude_cli_proxy(ollama_model.clone(), openrouter_api_key.clone()) {
                Some(child) => {
                    if let Some(m) = crate::PROXY_PROCESS.get() {
                        if let Ok(mut g) = m.lock() {
                            *g = Some(child);
                        }
                    }
                    PROXY_FAILS.store(0, Ordering::Relaxed);
                    println!("[supervisor] claude_cli_proxy was down — relaunched.");
                }
                None => {
                    let next = PROXY_FAILS.fetch_add(1, Ordering::Relaxed) + 1;
                    eprintln!(
                        "[supervisor] claude_cli_proxy restart failed ({next}/{MAX_CONSECUTIVE_RESTARTS})."
                    );
                }
            }
        }
    }

    // ── Ollama (only required when it is the active backend) ──
    if !is_ollama || crate::is_port_listening(OLLAMA_PORT) {
        OLLAMA_FAILS.store(0, Ordering::Relaxed);
    } else {
        let fails = OLLAMA_FAILS.load(Ordering::Relaxed);
        if may_restart(fails) {
            crate::start_ollama_and_warm(ollama_model).await;
            if crate::is_port_listening(OLLAMA_PORT) {
                OLLAMA_FAILS.store(0, Ordering::Relaxed);
                println!("[supervisor] Ollama was down — relaunched.");
            } else {
                let next = OLLAMA_FAILS.fetch_add(1, Ordering::Relaxed) + 1;
                eprintln!(
                    "[supervisor] Ollama restart failed ({next}/{MAX_CONSECUTIVE_RESTARTS})."
                );
            }
        }
    }

    // Heartbeat for any UI that wants to show supervisor activity.
    let supervisor = give_up_status();
    let _ = handle.emit(
        "jarvis://supervisor",
        serde_json::json!({
            "bun_up": crate::is_port_listening(BUN_PORT),
            "proxy_up": proxy_heartbeat_status(proxy_required, || {
                crate::is_port_listening(PROXY_PORT)
            }),
            "ollama_up": crate::is_port_listening(OLLAMA_PORT),
            "ollama_required": is_ollama,
            "bun_give_up": supervisor.bun_give_up,
            "proxy_give_up": supervisor.proxy_give_up,
            "ollama_give_up": supervisor.ollama_give_up,
            "bun_restart_failures": supervisor.bun_restart_failures,
            "restart_limit": supervisor.restart_limit,
            "bun_last_error": supervisor.bun_last_error,
            "bun_diagnostic": supervisor.bun_diagnostic,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn heartbeat_skips_proxy_probe_when_runtime_gate_is_closed() {
        let mut config = crate::jarvis::types::JarvisConfig::default();
        config.claude_cli.enabled = false;
        assert!(!proxy_heartbeat_status(
            crate::claude_proxy_enabled(&config),
            || panic!("disabled proxy must not be probed by heartbeat")
        ));

        config.claude_cli.enabled = true;
        config.claude_cli.auth_mode = crate::jarvis::types::ClaudeCliAuthMode::Subscription;
        assert!(!proxy_heartbeat_status(
            crate::claude_proxy_enabled(&config),
            || panic!("subscription proxy must not be probed by heartbeat")
        ));

        config.claude_cli.auth_mode = crate::jarvis::types::ClaudeCliAuthMode::Proxy;
        assert!(proxy_heartbeat_status(
            crate::claude_proxy_enabled(&config),
            || true
        ));
    }

    #[test]
    fn backoff_stops_after_max_consecutive_failures() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        assert!(may_restart(0));
        assert!(may_restart(MAX_CONSECUTIVE_RESTARTS - 1));
        assert!(!may_restart(MAX_CONSECUTIVE_RESTARTS));
        assert!(!may_restart(MAX_CONSECUTIVE_RESTARTS + 1));
    }

    #[test]
    fn reset_failures_clears_counter_so_supervisor_resumes() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // Simulate a service that has hit the give-up threshold.
        BUN_FAILS.store(MAX_CONSECUTIVE_RESTARTS, Ordering::Relaxed);
        assert!(!may_restart(BUN_FAILS.load(Ordering::Relaxed)));

        // After a forced restart the counter must be back at zero so the
        // next supervisor tick can take another swing.
        reset_failures(SupervisedService::Bun);
        assert_eq!(BUN_FAILS.load(Ordering::Relaxed), 0);
        assert!(may_restart(BUN_FAILS.load(Ordering::Relaxed)));

        // Same contract for the other two services.
        PROXY_FAILS.store(MAX_CONSECUTIVE_RESTARTS, Ordering::Relaxed);
        OLLAMA_FAILS.store(MAX_CONSECUTIVE_RESTARTS, Ordering::Relaxed);
        reset_failures(SupervisedService::Proxy);
        reset_failures(SupervisedService::Ollama);
        assert_eq!(PROXY_FAILS.load(Ordering::Relaxed), 0);
        assert_eq!(OLLAMA_FAILS.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn give_up_status_reflects_atomic_counters_for_each_service() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // Default: fresh boot, nothing has failed — every field is false.
        BUN_FAILS.store(0, Ordering::Relaxed);
        PROXY_FAILS.store(0, Ordering::Relaxed);
        OLLAMA_FAILS.store(0, Ordering::Relaxed);
        let status = give_up_status();
        assert!(!status.bun_give_up);
        assert!(!status.proxy_give_up);
        assert!(!status.ollama_give_up);

        // Below the threshold is still "trying".
        BUN_FAILS.store(MAX_CONSECUTIVE_RESTARTS - 1, Ordering::Relaxed);
        assert!(!give_up_status().bun_give_up);

        // Hitting the threshold flips the bit for that service only.
        BUN_FAILS.store(MAX_CONSECUTIVE_RESTARTS, Ordering::Relaxed);
        let status = give_up_status();
        assert!(status.bun_give_up);
        assert!(!status.proxy_give_up);
        assert!(!status.ollama_give_up);

        // Recovery: reset clears the bit again.
        reset_failures(SupervisedService::Bun);
        assert!(!give_up_status().bun_give_up);

        // All three can be in give-up simultaneously (e.g. a single bad
        // config that breaks every spawn). The snapshot must report each
        // independently — no all-or-nothing leakage.
        BUN_FAILS.store(MAX_CONSECUTIVE_RESTARTS, Ordering::Relaxed);
        PROXY_FAILS.store(MAX_CONSECUTIVE_RESTARTS, Ordering::Relaxed);
        OLLAMA_FAILS.store(MAX_CONSECUTIVE_RESTARTS, Ordering::Relaxed);
        let status = give_up_status();
        assert!(status.bun_give_up);
        assert!(status.proxy_give_up);
        assert!(status.ollama_give_up);

        // Tidy up so we don't leak state to the next test.
        BUN_FAILS.store(0, Ordering::Relaxed);
        PROXY_FAILS.store(0, Ordering::Relaxed);
        OLLAMA_FAILS.store(0, Ordering::Relaxed);
    }

    #[test]
    fn exhausted_bun_budget_exposes_actionable_diagnostic() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_failures(SupervisedService::Bun);

        for _ in 0..MAX_CONSECUTIVE_RESTARTS {
            record_restart_failure(
                SupervisedService::Bun,
                "server bundle missing: index.js was not found",
            );
        }

        let status = give_up_status();
        assert!(status.bun_give_up);
        assert_eq!(status.bun_restart_failures, MAX_CONSECUTIVE_RESTARTS);
        assert_eq!(status.restart_limit, MAX_CONSECUTIVE_RESTARTS);
        assert_eq!(
            status.bun_last_error.as_deref(),
            Some("server bundle missing: index.js was not found")
        );
        let diagnostic = status
            .bun_diagnostic
            .as_deref()
            .expect("exhausted Bun policy should explain itself");
        assert!(diagnostic.contains("5/5"));
        assert!(diagnostic.contains("server bundle missing"));
        assert!(diagnostic.contains("Restart"));

        reset_failures(SupervisedService::Bun);
    }
}
