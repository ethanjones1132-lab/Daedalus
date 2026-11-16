// ═══════════════════════════════════════════════════════════════
// Process supervisor — keep the long-running native children alive
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
//
// Bun is also required to be *healthy*, not merely alive (DD-079). A child that
// is still running but never answers `/health` is counted like a failed attempt
// and is never reported as a relaunch, so a server that can never become ready
// still ends in the bounded give-up path instead of resetting its own budget
// forever.

use crate::commands::system::SupervisorStatus;
use crate::jarvis::types::{JarvisBackend, JarvisState};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const TICK: Duration = Duration::from_secs(20);
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
pub(crate) static LLAMA_CPP_FAILS: AtomicU32 = AtomicU32::new(0);
static BUN_LAST_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();

/// Set once the app has begun quitting (DD-077).
///
/// `RunEvent::ExitRequested` tears every owned child down via
/// `process_lifecycle::stop_all()`. A tick that was already in flight — waiting
/// on a config lock or a health probe — would otherwise relaunch exactly what
/// the exit path is reaping, and that child would outlive the window because
/// nothing stops it after `stop_all` has run. Every start or restart in the
/// tick therefore re-reads this flag immediately before spawning.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Mark the app as quitting so the supervisor stops starting or restarting
/// children. Idempotent, and the single ordering point is the exit handler:
/// it is called before `stop_all()` so no tick can slip a spawn in afterwards.
pub(crate) fn mark_quitting() {
    QUITTING.store(true, Ordering::SeqCst);
}

/// Whether the supervisor may still start or restart a child.
///
/// Reads the flag at the moment of the decision rather than taking an earlier
/// snapshot: an exit can be requested while the tick is awaiting something, so
/// a check performed at entry alone is not enough. Pure read of one atomic, so
/// the shutdown gate is unit-testable without a real process.
fn may_start_child() -> bool {
    !QUITTING.load(Ordering::SeqCst)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SupervisedService {
    Bun,
    Proxy,
    Ollama,
    LlamaCpp,
}

/// Whether another restart attempt is allowed given the consecutive-failure
/// count. Pure so the backoff bound is unit-testable.
fn may_restart(consecutive_failures: u32) -> bool {
    consecutive_failures < MAX_CONSECUTIVE_RESTARTS
}

/// What one supervisor tick should do about Ollama. Pure and separate from the
/// tick so the two ownership rules are unit-testable without a live backend:
/// a closed port does not mean "down" when this process still owns a child that
/// is coming up, and switching the backend off must stop the owned child
/// (DD-063).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OllamaAction {
    /// Ollama is not the active backend: stop the child this process started.
    StopOwned,
    /// Listening, or an owned child is still warming: leave it alone.
    Leave,
    /// No listener and no owned child: start one.
    Start,
}

fn ollama_tick_action(is_ollama: bool, listening: bool, owned_live: bool) -> OllamaAction {
    if !is_ollama {
        return OllamaAction::StopOwned;
    }
    if listening || owned_live {
        return OllamaAction::Leave;
    }
    OllamaAction::Start
}

/// Whether the supervisor should treat the Bun port as this app's Bun server
/// (DD-072). Pure so the identity rule is unit-testable without a live port:
/// only `BunPortState::ThisApp` is healthy — a foreign or stale listener
/// accepts the same TCP connection, so it must not read as healthy and reset
/// the failure counter.
fn bun_tick_is_healthy(state: crate::BunPortState) -> bool {
    state == crate::BunPortState::ThisApp
}

/// Why a still-starting Bun is charged to the escalation budget (DD-079).
///
/// Kept as a named reason because it is what the operator sees in
/// `bun_last_error`: "alive but never healthy" is not a spawn error, and saying
/// so is the whole point of counting it separately from a failed restart.
const BUN_STILL_STARTING_REASON: &str =
    "Bun server is still starting: alive but has not answered /health within the start budget";

/// What the Bun block of one tick reports after one ensure attempt (DD-079).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BunTickVerdict {
    /// `/health` answered: the counter was cleared and a relaunch may be claimed.
    Healthy,
    /// The owned child is alive but never answered: counted, never a relaunch.
    StillStarting,
    /// The attempt failed: counted with its error.
    Failed,
}

/// Record one Bun ensure outcome against the escalation budget.
///
/// The counter is the supervisor's memory of "how many swings have failed", so
/// this is the whole DD-079 rule: only a healthy probe clears it. A child that
/// stays alive without ever answering `/health` is not evidence the server
/// works, so it advances the same budget as a failed restart — a Bun that can
/// never become healthy still ends in the give-up path instead of being reset
/// forever by its own liveness. Returns the verdict plus the new count.
fn record_bun_start_outcome(outcome: &crate::BunServerStart) -> (BunTickVerdict, u32) {
    match outcome {
        crate::BunServerStart::Healthy => {
            reset_failures(SupervisedService::Bun);
            (BunTickVerdict::Healthy, 0)
        }
        crate::BunServerStart::StillStarting => (
            BunTickVerdict::StillStarting,
            record_restart_failure(SupervisedService::Bun, BUN_STILL_STARTING_REASON),
        ),
        crate::BunServerStart::Failed(error) => (
            BunTickVerdict::Failed,
            record_restart_failure(SupervisedService::Bun, error),
        ),
    }
}

/// What one supervisor tick should do about the claude_cli_proxy. The same
/// ownership rule the Ollama decision applies: a closed port does not mean
/// "down" when this process still owns a child that is coming up, and
/// switching the proxy off must stop the owned child (DD-063). Pure and
/// separate from the tick so the rule is unit-testable without a live port.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProxyAction {
    /// The proxy is not required: stop the child this process started.
    StopOwned,
    /// Listening, or an owned child is still starting: leave it alone.
    Leave,
    /// No listener and no owned child: relaunch.
    Start,
}

fn proxy_tick_action(proxy_required: bool, listening: bool, owned_live: bool) -> ProxyAction {
    if !proxy_required {
        return ProxyAction::StopOwned;
    }
    if listening || owned_live {
        return ProxyAction::Leave;
    }
    ProxyAction::Start
}

fn failure_counter(service: SupervisedService) -> &'static AtomicU32 {
    match service {
        SupervisedService::Bun => &BUN_FAILS,
        SupervisedService::Proxy => &PROXY_FAILS,
        SupervisedService::Ollama => &OLLAMA_FAILS,
        SupervisedService::LlamaCpp => &LLAMA_CPP_FAILS,
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
        llama_cpp_give_up: LLAMA_CPP_FAILS.load(Ordering::Relaxed) >= MAX_CONSECUTIVE_RESTARTS,
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
    // DD-077: once the app is quitting, a tick does no work at all — no config
    // read, no probe, and above all no start or restart of a child that the
    // exit path has already reaped (or is about to).
    if !may_start_child() {
        return;
    }

    // Read the active backend + model once per tick.
    let (
        is_ollama,
        ollama_model,
        is_llama_cpp,
        llama_cpp_config,
        proxy_required,
        openrouter_api_key,
    ) = {
        let state = handle.state::<JarvisState>();
        let cfg = state.config.lock().await;
        (
            matches!(cfg.active_backend, JarvisBackend::Ollama),
            cfg.ollama.model.clone(),
            matches!(cfg.active_backend, JarvisBackend::LlamaCpp),
            cfg.llama_cpp.clone(),
            crate::claude_proxy_enabled(&cfg),
            cfg.openrouter.api_key.clone(),
        )
    };

    // DD-054: how each backend is launched decides whether a closed local port
    // may also be probed inside WSL. A native backend reads as closed without
    // paying for a helper-process spawn; a WSL-hosted one still gets its guest probe, so it is
    // not reported down and relaunched on every tick (same rule as the boot paths).
    let ollama_uses_wsl = crate::ollama_uses_wsl();
    let llama_cpp_uses_wsl = crate::command_uses_wsl(Some(llama_cpp_config.server_path.as_str()));

    // ── Bun server (required by every backend for tools/skills/models) ──
    // DD-072: port occupancy is not identity. A foreign or stale listener on
    // the Bun port accepts the same TCP connection, so the tick asks the
    // identity-probing state who holds the port instead of bare occupancy —
    // a stranger must not read as healthy and reset the failure counter.
    if bun_tick_is_healthy(crate::probe_bun_port_state()) {
        reset_failures(SupervisedService::Bun);
    } else {
        let fails = BUN_FAILS.load(Ordering::Relaxed);
        if may_restart(fails) {
            // DD-077: the exit path may have set the flag while this tick was
            // reading config or probing; check again immediately before the
            // start, which is the last moment a relaunch can be prevented.
            if !may_start_child() {
                return;
            }
            // ensure_* is idempotent (it health-probes before spawning, and
            // leaves a live child of this app's alone — DD-073).
            //
            // DD-079: alive is not healthy. The ensure path reports a child it
            // is still waiting on separately from a serving server, so only a
            // healthy probe clears the budget and only that arm may claim a
            // relaunch.
            let outcome = crate::ensure_jarvis_server_started_outcome().await;
            match record_bun_start_outcome(&outcome) {
                (BunTickVerdict::Healthy, _) => {
                    println!("[supervisor] Bun server was down — relaunched.");
                }
                (BunTickVerdict::StillStarting, next) => {
                    log::warn!(
                        target: "jarvis::supervisor",
                        "Bun server is still starting — alive but has not answered /health \
                         ({next}/{MAX_CONSECUTIVE_RESTARTS}); counted against the restart \
                         budget, not reported as a relaunch"
                    );
                    if next == MAX_CONSECUTIVE_RESTARTS {
                        if let Some(diagnostic) =
                            bun_diagnostic(next, Some(BUN_STILL_STARTING_REASON))
                        {
                            log::error!(target: "jarvis::supervisor", "{diagnostic}");
                        }
                    }
                }
                (BunTickVerdict::Failed, next) => {
                    let error = outcome.failure().unwrap_or("unknown Bun startup failure");
                    log::warn!(
                        target: "jarvis::supervisor",
                        "Bun server restart failed ({next}/{MAX_CONSECUTIVE_RESTARTS}): {error}"
                    );
                    if next == MAX_CONSECUTIVE_RESTARTS {
                        if let Some(diagnostic) = bun_diagnostic(next, Some(error)) {
                            log::error!(target: "jarvis::supervisor", "{diagnostic}");
                        }
                    }
                }
            }
        }
    }

    // ── claude_cli_proxy (routes to whichever backend is active) ──
    // Same owned-liveness rule as the Ollama block below: a closed port is not
    // proof the proxy is down when the child this process spawned is still
    // coming up. Reloading on every tick would kill the startup in progress,
    // so liveness is read from the ownership slot first and the proxy-off
    // branch stops that child instead of orphaning it.
    let proxy_owned =
        crate::process_lifecycle::is_live(crate::process_lifecycle::ManagedProcess::ClaudeProxy);

    match proxy_tick_action(proxy_required, crate::claude_proxy_is_listening(), proxy_owned) {
        ProxyAction::StopOwned => {
            PROXY_FAILS.store(0, Ordering::Relaxed);
            crate::process_lifecycle::stop(crate::process_lifecycle::ManagedProcess::ClaudeProxy);
        }
        ProxyAction::Leave => {
            PROXY_FAILS.store(0, Ordering::Relaxed);
        }
        ProxyAction::Start => {
            let fails = PROXY_FAILS.load(Ordering::Relaxed);
            if may_restart(fails) {
                // DD-077: no restart may begin after the app started quitting.
                if !may_start_child() {
                    return;
                }
                match crate::restart_claude_cli_proxy(ollama_model.clone(), openrouter_api_key.clone())
                {
                    Ok(_) => {
                        PROXY_FAILS.store(0, Ordering::Relaxed);
                        println!("[supervisor] claude_cli_proxy was down — relaunched.");
                    }
                    Err(error) => {
                        let next = record_restart_failure(SupervisedService::Proxy, &error);
                        eprintln!(
                            "[supervisor] claude_cli_proxy restart failed ({next}/{MAX_CONSECUTIVE_RESTARTS}): {error}"
                        );
                    }
                }
            }
        }
    }

    // ── Ollama (only required when it is the active backend) ──
    // A closed port is not proof the backend is down: the child this process
    // owns may still be warming behind a model load. Restarting it on the next
    // tick would kill the work in progress, so liveness is read from the slot
    // first and the backend-off branch stops that child instead of orphaning it.
    let ollama_owned =
        crate::process_lifecycle::is_live(crate::process_lifecycle::ManagedProcess::Ollama);

    match ollama_tick_action(
        is_ollama,
        crate::backend_port_is_listening(OLLAMA_PORT, ollama_uses_wsl),
        ollama_owned,
    ) {
        OllamaAction::StopOwned => {
            OLLAMA_FAILS.store(0, Ordering::Relaxed);
            crate::process_lifecycle::stop(crate::process_lifecycle::ManagedProcess::Ollama);
        }
        OllamaAction::Leave => {
            OLLAMA_FAILS.store(0, Ordering::Relaxed);
        }
        OllamaAction::Start => {
            let fails = OLLAMA_FAILS.load(Ordering::Relaxed);
            if may_restart(fails) {
                // DD-077: the exit path stops the Ollama child; a tick must not
                // resurrect it while that teardown is in progress.
                if !may_start_child() {
                    return;
                }
                crate::start_ollama_and_warm(ollama_model).await;
                if crate::backend_port_is_listening(OLLAMA_PORT, ollama_uses_wsl) {
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
    }

    // ── llama.cpp (only required when Gemma is the active backend) ──
    if !is_llama_cpp || crate::backend_port_is_listening(llama_cpp_config.port, llama_cpp_uses_wsl) {
        LLAMA_CPP_FAILS.store(0, Ordering::Relaxed);
        if !is_llama_cpp {
            crate::process_lifecycle::stop(crate::process_lifecycle::ManagedProcess::LlamaCpp);
        }
    } else {
        let fails = LLAMA_CPP_FAILS.load(Ordering::Relaxed);
        if may_restart(fails) {
            // DD-077: no start after the app started quitting.
            if !may_start_child() {
                return;
            }
            match crate::start_llama_cpp_server(llama_cpp_config.clone()).await {
                Ok(_) => {
                    LLAMA_CPP_FAILS.store(0, Ordering::Relaxed);
                    println!("[supervisor] llama.cpp is starting or was relaunched.");
                }
                Err(error) => {
                    let next = record_restart_failure(SupervisedService::LlamaCpp, &error);
                    eprintln!("[supervisor] llama.cpp restart failed ({next}/{MAX_CONSECUTIVE_RESTARTS}): {error}");
                }
            }
        }
    }

    // Heartbeat for any UI that wants to show supervisor activity.
    let supervisor = give_up_status();
    let _ = handle.emit(
        "jarvis://supervisor",
        serde_json::json!({
            "bun_up": crate::bun_server_is_listening(),
            "proxy_up": proxy_heartbeat_status(proxy_required, || {
                crate::claude_proxy_is_listening()
            }),
            "ollama_up": crate::backend_port_is_listening(OLLAMA_PORT, ollama_uses_wsl),
            "ollama_required": is_ollama,
            "bun_give_up": supervisor.bun_give_up,
            "proxy_give_up": supervisor.proxy_give_up,
            "ollama_give_up": supervisor.ollama_give_up,
            "llama_cpp_up": crate::backend_port_is_listening(llama_cpp_config.port, llama_cpp_uses_wsl),
            "llama_cpp_required": is_llama_cpp,
            "llama_cpp_give_up": supervisor.llama_cpp_give_up,
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

    /// Clears the process-wide quitting flag when a test ends — including when
    /// it panics — so one test's shutdown state cannot leak into another.
    struct QuittingFlagReset;

    impl Drop for QuittingFlagReset {
        fn drop(&mut self) {
            QUITTING.store(false, Ordering::SeqCst);
        }
    }

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
    fn a_warming_ollama_is_never_replaced_and_switching_off_stops_it() {
        // Closed port, but the child this process owns is still loading a model:
        // the next tick must leave it alone instead of replace=true killing it.
        assert_eq!(
            ollama_tick_action(true, false, true),
            OllamaAction::Leave,
            "an owned child that has not opened its port yet is coming up, not down"
        );
        // No listener and no owned child is the only reason to start one.
        assert_eq!(ollama_tick_action(true, false, false), OllamaAction::Start);
        // A listener — ours or someone else's — must not be restarted around.
        assert_eq!(ollama_tick_action(true, true, false), OllamaAction::Leave);
        // Switching the backend off stops the child this app started; leaving
        // it running is the DD-063 orphan.
        assert_eq!(
            ollama_tick_action(false, false, true),
            OllamaAction::StopOwned,
            "the child must not survive the backend being switched off"
        );
        assert_eq!(ollama_tick_action(false, true, false), OllamaAction::StopOwned);

        // The decision only fixes the tick if the tick routes through it and
        // acts on the stop, so pin the wiring in the production half too.
        let production = supervisor_production_source();
        let ollama = production
            .split_once("// ── Ollama")
            .and_then(|(_, rest)| rest.split_once("// ── llama.cpp"))
            .map(|(block, _)| block)
            .expect("the Ollama supervisor block must sit between its section markers");
        assert!(
            ollama.contains("process_lifecycle::is_live"),
            "the tick must read owned liveness before deciding Ollama is down:\n{ollama}"
        );
        let liveness_read = ollama
            .find("process_lifecycle::is_live")
            .expect("liveness read must appear in the Ollama block");
        let decision = ollama
            .find("ollama_tick_action(")
            .expect("the Ollama block must route through the decision seam");
        assert!(
            liveness_read < decision,
            "owned liveness must be read before the tick decides Ollama is down:\n{ollama}"
        );
        assert!(
            ollama.contains("ollama_tick_action("),
            "the tick must route through the tested decision seam:\n{ollama}"
        );
        assert!(
            ollama.contains("OllamaAction::StopOwned")
                && ollama.contains("process_lifecycle::stop(")
                && ollama.contains("ManagedProcess::Ollama"),
            "the backend-off arm must stop the owned Ollama child:\n{ollama}"
        );
    }

    #[test]
    fn a_foreign_bun_listener_is_not_healthy_and_does_not_reset_failures() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // DD-072: the tick decides health from the identity-probing state, not
        // port occupancy. Only a port that answers /health as this Jarvis is
        // healthy; a foreign or stale listener accepts the same TCP connection
        // and must not count as healthy.
        assert!(
            !bun_tick_is_healthy(crate::BunPortState::ForeignListener),
            "a listener that is not this app's Bun server is not healthy"
        );
        assert!(
            !bun_tick_is_healthy(crate::BunPortState::Free),
            "an absent Bun server is not healthy either"
        );
        assert!(
            bun_tick_is_healthy(crate::BunPortState::ThisApp),
            "this app's serving Bun is healthy"
        );

        // The counter consequence: a foreign listener takes the not-healthy
        // branch, so the failure counter is left where it was instead of
        // being reset by mere occupancy.
        BUN_FAILS.store(1, Ordering::Relaxed);
        if bun_tick_is_healthy(crate::BunPortState::ForeignListener) {
            reset_failures(SupervisedService::Bun);
        }
        assert_eq!(
            BUN_FAILS.load(Ordering::Relaxed),
            1,
            "a foreign listener must not reset the Bun failure counter"
        );

        // A genuinely serving Bun does reset it.
        if bun_tick_is_healthy(crate::BunPortState::ThisApp) {
            reset_failures(SupervisedService::Bun);
        }
        assert_eq!(BUN_FAILS.load(Ordering::Relaxed), 0);

        // Pin the wiring: the tick's Bun block must consult the identity probe
        // and route through the seam above, never bare port occupancy. This is
        // the half that fails if the fix is reverted to `bun_server_is_listening`.
        let production = supervisor_production_source();
        let bun = production
            .split_once("// ── Bun server")
            .and_then(|(_, rest)| rest.split_once("// ── claude_cli_proxy"))
            .map(|(block, _)| block)
            .expect("the Bun supervisor block must sit between its section markers");
        assert!(
            bun.contains("crate::probe_bun_port_state()"),
            "the Bun tick must read the DD-072 identity state, not bare occupancy:\n{bun}"
        );
        assert!(
            bun.contains("bun_tick_is_healthy("),
            "the Bun tick must route health through the tested seam:\n{bun}"
        );
        assert!(
            !bun.contains("bun_server_is_listening"),
            "a foreign listener accepts the same TCP connection; bare port occupancy must not decide the Bun tick's health:\n{bun}"
        );
    }

    /// DD-079: a Bun child that is alive but never answers `/health` is not a
    /// healthy server. The counter must keep (and advance) instead of being
    /// reset, and the tick must not claim a relaunch for a wait that ran out.
    #[test]
    fn a_bun_that_is_alive_but_never_healthy_is_counted_not_relaunched() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_failures(SupervisedService::Bun);

        let (verdict, first) = record_bun_start_outcome(&crate::BunServerStart::StillStarting);
        assert_eq!(verdict, BunTickVerdict::StillStarting);
        assert_eq!(first, 1);
        assert_eq!(
            BUN_FAILS.load(Ordering::Relaxed),
            1,
            "alive is not healthy: a child that never answered /health must not \
             reset the Bun failure count"
        );

        // The next tick finds the same child still silent, so the budget
        // advances instead of starting over.
        let (verdict, second) = record_bun_start_outcome(&crate::BunServerStart::StillStarting);
        assert_eq!(verdict, BunTickVerdict::StillStarting);
        assert_eq!(second, 2);
        assert_eq!(BUN_FAILS.load(Ordering::Relaxed), 2);

        // A child that can never become healthy still reaches the give-up cap,
        // so the watchdog stops retrying instead of resetting forever.
        for _ in 2..MAX_CONSECUTIVE_RESTARTS {
            record_bun_start_outcome(&crate::BunServerStart::StillStarting);
        }
        assert_eq!(
            BUN_FAILS.load(Ordering::Relaxed),
            MAX_CONSECUTIVE_RESTARTS
        );
        assert!(!may_restart(BUN_FAILS.load(Ordering::Relaxed)));
        assert_eq!(
            give_up_status().bun_last_error.as_deref(),
            Some(BUN_STILL_STARTING_REASON),
            "the counted outcome must say the server was alive but never healthy"
        );

        // The tick's still-starting arm must never print the relaunch claim:
        // no spawn happened, only a wait that outlasted its budget. The single
        // "relaunched" line belongs to the healthy arm, before it.
        let production = supervisor_production_source();
        let bun = production
            .split_once("// ── Bun server")
            .and_then(|(_, rest)| rest.split_once("// ── claude_cli_proxy"))
            .map(|(block, _)| block)
            .expect("the Bun supervisor block must sit between its section markers");
        let relaunched = bun
            .find("relaunched")
            .expect("the healthy arm must still report a relaunch");
        let still_starting = bun
            .find("BunTickVerdict::StillStarting")
            .expect("the tick must keep a still-starting arm");
        assert!(
            relaunched < still_starting,
            "the relaunch claim must sit in the healthy arm, not the still-starting one:\n{bun}"
        );
        assert_eq!(
            bun.matches("relaunched").count(),
            1,
            "a still-starting Bun must not be reported as relaunched:\n{bun}"
        );
        let still_starting_arm = &bun[still_starting..];
        assert!(
            still_starting_arm.contains("log::warn!")
                && still_starting_arm.contains("BUN_STILL_STARTING_REASON"),
            "the still-starting arm must log its own counted outcome:\n{bun}"
        );
        assert!(
            bun.contains("crate::ensure_jarvis_server_started_outcome()"),
            "the tick must ask the three-state ensure path, not the flattened one:\n{bun}"
        );

        reset_failures(SupervisedService::Bun);
    }

    /// DD-079: a healthy probe is still the only thing that clears the Bun
    /// failure count, and a failed attempt still records its own error.
    #[test]
    fn a_healthy_bun_probe_clears_the_still_starting_count() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_failures(SupervisedService::Bun);
        record_bun_start_outcome(&crate::BunServerStart::StillStarting);
        record_bun_start_outcome(&crate::BunServerStart::StillStarting);
        assert_eq!(BUN_FAILS.load(Ordering::Relaxed), 2);

        let (verdict, next) = record_bun_start_outcome(&crate::BunServerStart::Healthy);
        assert_eq!(verdict, BunTickVerdict::Healthy);
        assert_eq!(next, 0);
        assert_eq!(BUN_FAILS.load(Ordering::Relaxed), 0);
        let status = give_up_status();
        assert!(!status.bun_give_up);
        assert!(
            status.bun_last_error.is_none(),
            "a healthy probe must also clear the stale still-starting reason"
        );

        // The third state is not folded into either live one.
        let (verdict, next) = record_bun_start_outcome(&crate::BunServerStart::Failed(
            "server bundle missing: index.js was not found".to_string(),
        ));
        assert_eq!(verdict, BunTickVerdict::Failed);
        assert_eq!(next, 1);
        assert_eq!(
            give_up_status().bun_last_error.as_deref(),
            Some("server bundle missing: index.js was not found")
        );

        reset_failures(SupervisedService::Bun);
    }

    #[test]
    fn a_live_owned_proxy_child_is_left_alone_not_reloaded() {
        // Same rule as the Ollama block (DD-063): a closed port with a child
        // this process spawned still running means "coming up", not "down",
        // so the tick must leave it alone instead of reloading it.
        assert_eq!(
            proxy_tick_action(true, false, true),
            ProxyAction::Leave,
            "an owned child that has not opened its port yet is coming up, not down"
        );
        // A listener — ours or someone else's — must not be reloaded around.
        assert_eq!(proxy_tick_action(true, true, false), ProxyAction::Leave);
        // No listener and no owned child is the only reason to relaunch.
        assert_eq!(proxy_tick_action(true, false, false), ProxyAction::Start);
        // Switching the proxy off stops the child this app started.
        assert_eq!(
            proxy_tick_action(false, false, true),
            ProxyAction::StopOwned,
            "the child must not survive the proxy being switched off"
        );
        assert_eq!(proxy_tick_action(false, true, false), ProxyAction::StopOwned);

        // Pin the wiring: the tick's proxy block must read owned liveness
        // through process_lifecycle before deciding to reload. This is the
        // half that fails if the owned-liveness arm is reverted away.
        let production = supervisor_production_source();
        let proxy = production
            .split_once("// ── claude_cli_proxy")
            .and_then(|(_, rest)| rest.split_once("// ── Ollama"))
            .map(|(block, _)| block)
            .expect("the proxy supervisor block must sit between its section markers");
        assert!(
            proxy.contains("proxy_tick_action("),
            "the proxy tick must route through the tested decision seam:\n{proxy}"
        );
        assert!(
            proxy.contains("process_lifecycle::is_live"),
            "the proxy tick must read owned liveness before reloading:\n{proxy}"
        );
        assert!(
            proxy.contains("ManagedProcess::ClaudeProxy"),
            "owned liveness must be read for the proxy's own slot:\n{proxy}"
        );
        let liveness_read = proxy
            .find("process_lifecycle::is_live")
            .expect("liveness read must appear in the proxy block");
        let decision = proxy
            .find("proxy_tick_action(")
            .expect("the proxy block must route through the decision seam");
        assert!(
            liveness_read < decision,
            "owned liveness must be read before the tick decides the proxy is down:\n{proxy}"
        );
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

    /// Production half of this file: everything above the test module.
    fn supervisor_production_source() -> &'static str {
        include_str!("supervisor.rs")
            .split_once("#[cfg(test)]")
            .map(|(production, _)| production)
            .expect("supervisor.rs must keep its test module after the production code")
    }

    /// The body of the supervisor tick, from its signature to the end of the
    /// production half. Reads the source because calling `tick` would need an
    /// `AppHandle` and could reach a real spawn.
    fn supervisor_tick_source() -> &'static str {
        supervisor_production_source()
            .split_once("async fn tick(handle: &AppHandle) {")
            .map(|(_, body)| body)
            .expect("the supervisor tick must still be the function under test")
    }

    /// Every start/restart the tick can perform, in source order. Naming them
    /// here means a new spawn site added without a gate fails this test.
    const TICK_SPAWN_SITES: [&str; 4] = [
        "crate::ensure_jarvis_server_started_outcome(",
        "crate::restart_claude_cli_proxy(",
        "crate::start_ollama_and_warm(",
        "crate::start_llama_cpp_server(",
    ];

    /// DD-077: after the app starts quitting, the tick must never reach a spawn.
    ///
    /// Fails if the quitting read is removed from the gate (the flag no longer
    /// closes anything) or if any spawn site loses its guard (the flag would be
    /// set and ignored). No process is started: the gate is a pure atomic read.
    #[test]
    fn a_quitting_app_never_reaches_the_ticks_start_or_restart_step() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _reset = QuittingFlagReset;

        // The exit handler's setter is what the tick must observe.
        mark_quitting();
        assert!(
            !may_start_child(),
            "once the app is quitting the supervisor must neither start nor restart a child"
        );

        let tick = supervisor_tick_source();

        // The entry check runs before the tick reads config or probes anything,
        // so a tick that wakes during shutdown does no work at all.
        let entry_gate = tick
            .find("if !may_start_child()")
            .expect("the tick must return early at its entry once the app is quitting");
        let first_work = tick
            .find("handle.state::<JarvisState>()")
            .expect("the tick must still read its config");
        assert!(
            entry_gate < first_work,
            "the quitting check must come before any tick work:\n{tick}"
        );

        // And every spawn site re-reads the flag: an exit can be requested while
        // the tick is awaiting a lock or a health probe, so an entry-only check
        // would still let a relaunch through after the app began quitting.
        assert!(
            tick.matches("if !may_start_child()").count() >= 1 + TICK_SPAWN_SITES.len(),
            "expected the entry gate plus one gate per spawn site, found {}:\n{tick}",
            tick.matches("if !may_start_child()").count()
        );
        let mut cursor = entry_gate + "if !may_start_child()".len();
        for spawn in TICK_SPAWN_SITES {
            let at = tick[cursor..]
                .find(spawn)
                .map(|offset| cursor + offset)
                .unwrap_or_else(|| panic!("the tick must still call {spawn}:\n{tick}"));
            assert!(
                tick[cursor..at].contains("if !may_start_child()"),
                "{spawn} must be gated on the quitting flag, so no start or restart \
                 can happen after it is set:\n{}",
                &tick[cursor..at]
            );
            cursor = at;
        }
    }

    /// The complement: with the flag clear, the same seam still permits the
    /// watchdog's work. A gate that refused unconditionally would pass the test
    /// above while silently disabling auto-restart.
    #[test]
    fn a_running_app_still_lets_the_tick_start_and_restart() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _reset = QuittingFlagReset;

        // Start from a known state: the app is running, not quitting.
        QUITTING.store(false, Ordering::SeqCst);
        assert!(
            may_start_child(),
            "with the app running the supervisor must still be allowed to start and restart"
        );

        // The gate reads the live flag rather than caching an earlier answer:
        // setting it closes the seam, and clearing it opens the seam again.
        mark_quitting();
        assert!(
            !may_start_child(),
            "with the app quitting the gate must close for that same tick"
        );
        QUITTING.store(false, Ordering::SeqCst);
        assert!(
            may_start_child(),
            "the gate must read the flag each time, not remember a stale answer"
        );
    }

    #[test]
    fn backend_checks_use_the_launch_mode_aware_probe_not_the_generic_one() {
        let production = supervisor_production_source();

        // `crate::is_port_listening` spawns `wsl.exe` on every closed local port.
        // The Ollama and llama.cpp checks (and the heartbeat reporting them) must
        // go through `backend_port_is_listening`, which only probes WSL for a
        // backend that is actually launched there (DD-054, DD-049).
        assert!(
            !production.contains("crate::is_port_listening"),
            "Ollama/llama.cpp liveness must not use the generic wsl.exe-spawning probe"
        );
        assert!(
            !production.contains("is_wsl_port_listening"),
            "the supervisor must not reach for the guest-hosted probe directly"
        );
        assert!(
            !production.to_ascii_lowercase().contains("wsl.exe"),
            "no supervisor production path may name wsl.exe"
        );

        // Guard against passing vacuously: the two Ollama sites, the llama.cpp
        // site and the two heartbeat fields must all use the aware probe.
        let aware = production.matches("crate::backend_port_is_listening(").count();
        assert!(
            aware >= 5,
            "expected five Ollama/llama.cpp probe call sites, found {aware}"
        );
    }

    #[test]
    fn a_wsl_hosted_backend_is_not_hard_coded_native() {
        let production = supervisor_production_source();

        // Hard-coding the native probe would read a WSL-hosted Ollama or
        // llama.cpp as permanently down and relaunch it on every tick. Both
        // launch modes must be resolved from the same rule the boot paths use.
        assert!(
            production.contains("crate::ollama_uses_wsl()"),
            "Ollama launch mode must come from ollama_uses_wsl"
        );
        assert!(
            production.contains("crate::command_uses_wsl(Some(llama_cpp_config.server_path.as_str()))"),
            "llama.cpp launch mode must come from its configured server_path"
        );
        assert!(
            production.contains("backend_port_is_listening(OLLAMA_PORT, ollama_uses_wsl)")
                && production
                    .contains("backend_port_is_listening(llama_cpp_config.port, llama_cpp_uses_wsl)"),
            "the probes must be passed the resolved launch mode"
        );
    }
}
