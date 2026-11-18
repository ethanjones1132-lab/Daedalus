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
// forever. DD-080 applies the same rule to Ollama: a child that stays alive
// without ever opening port 11434 is counted, not reset every tick.
//
// DD-114 applies it to the two children whose start helper returns as soon as
// the process is spawned: llama.cpp and the claude_cli_proxy. An `Ok` spawn is
// not a serving backend, so a tick that finds the port still closed advances the
// same budget a failed spawn does, and only a port that answers clears it. A
// child that spawns fine and dies — or never binds — therefore reaches the
// existing cap and stops being restarted.
//
// DD-125 carves out a warm-up window for llama.cpp specifically: loading a
// multi-GB GGUF legitimately outlasts several ticks, so a child this process
// owns that is still alive but not bound yet is left alone for a bounded grace
// (`LLAMA_CPP_WARMING_GRACE_TICKS`) instead of being charged on every tick. A
// dead child never warms, and the grace is finite, so once it is spent a closed
// port is counted again and the existing five-attempt cap still bounds a start
// that never works. The grace is an allowance, not a reset: only a serving port
// (or an explicit restart) clears it, so a child that exists forever cannot keep
// the budget open forever.
//
// Boot-stage failures that never became a relaunch attempt are recorded here as
// reasons (DD-080) so `give_up_status` — the status surface `get_system_health`
// already exposes — can say why a packaged startup failed instead of leaving
// the UI at "offline" with the explanation discarded with the console.

use crate::commands::system::SupervisorStatus;
use crate::jarvis::types::{JarvisBackend, JarvisState};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const TICK: Duration = Duration::from_secs(20);
const OLLAMA_PORT: u16 = 11434;
const MAX_CONSECUTIVE_RESTARTS: u32 = 5;

/// DD-125: how many ticks a live llama.cpp child may spend loading its model
/// before a still-closed port is charged to the restart budget again.
///
/// Grounded in [`TICK`]: 30 ticks is ten minutes, long enough for the default
/// multi-GB GGUF to warm from a slow disk, while the existing five-attempt cap
/// still bounds an attempt that never works. The window is an allowance, not a
/// reset: only a serving port clears it, so a child that stays alive forever is
/// still counted once the grace is spent.
const LLAMA_CPP_WARMING_GRACE_TICKS: u32 = 30;

/// Consecutive-failure counters live at module scope so manual restart
/// commands (Bun / Ollama / proxy) can clear them. Per-instance fields would
/// be unreachable from a Tauri command — the supervisor task is the only
/// thing that owns the struct — so a forced restart would still appear
/// permanently given-up to subsequent supervisor ticks.
pub(crate) static BUN_FAILS: AtomicU32 = AtomicU32::new(0);
pub(crate) static PROXY_FAILS: AtomicU32 = AtomicU32::new(0);
pub(crate) static OLLAMA_FAILS: AtomicU32 = AtomicU32::new(0);
pub(crate) static LLAMA_CPP_FAILS: AtomicU32 = AtomicU32::new(0);

/// DD-125: consecutive ticks a live llama.cpp child has been observed warming
/// with its port still closed. Module scope like the failure counters so an
/// explicit restart can re-arm it together with the budget; otherwise only the
/// grace bound stops it from advancing.
static LLAMA_CPP_WARMING_TICKS: AtomicU32 = AtomicU32::new(0);
static BUN_LAST_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();

/// Boot-stage reasons that must outlive whatever service finally came up
/// (DD-080).
///
/// A packaged build is a `windows_subsystem = "windows"` binary, so a startup
/// failure printed with `eprintln!` is discarded with the console. Boot records
/// its reason here and `give_up_status` folds it into `bun_last_error`, the
/// field the supervisor status already exposes, so Health can say why boot
/// failed instead of only "offline". `reset_failures` never clears this: a
/// config that failed to load is still why the run is on defaults after a
/// later Bun restart.
static BOOT_FAILURES: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
const MAX_BOOT_FAILURES: usize = 8;

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

/// DD-082: whether the app has begun quitting.
///
/// The same flag DD-077 added is the single shutdown authority. The supervisor
/// tick reads it through [`may_start_child`]; managed spawn paths outside the
/// tick read it here so a child spawned late cannot race quit.
pub(crate) fn is_quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// Whether the supervisor may still start or restart a child.
///
/// Reads the flag at the moment of the decision rather than taking an earlier
/// snapshot: an exit can be requested while the tick is awaiting something, so
/// a check performed at entry alone is not enough. Pure read of one atomic, so
/// the shutdown gate is unit-testable without a real process.
fn may_start_child() -> bool {
    !is_quitting()
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

/// Why a live-but-unready Ollama child is charged to the escalation budget.
///
/// Same reason DD-079 names for Bun: a child that is still running is not a
/// serving backend, and "did not open its port" is the whole diagnosis. Kept
/// as a named reason so the supervisor's durable log line says that, not just
/// a bare counter increment.
const OLLAMA_STILL_STARTING_REASON: &str =
    "Ollama child is alive but has not opened port 11434 within the start budget";

/// What the Ollama block of one tick reports for an owned child it left alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OllamaTickVerdict {
    /// A listener answered: the counter was cleared.
    Healthy,
    /// The owned child is alive but never opened its port: counted.
    StillStarting,
}

/// Record one Ollama liveness observation against the escalation budget.
///
/// DD-079's rule, applied to Ollama: only a listening port is evidence the
/// backend works, so only it clears the counter. A child this process owns that
/// stays alive without ever opening port 11434 advances the same budget as a
/// failed restart — otherwise the `Leave` arm reset the count on every tick and
/// a warming child that never becomes ready never reached the give-up path.
/// Returns the verdict plus the new count.
fn record_ollama_tick_outcome(listening: bool, owned_live: bool) -> (OllamaTickVerdict, u32) {
    if listening {
        reset_failures(SupervisedService::Ollama);
        return (OllamaTickVerdict::Healthy, 0);
    }
    debug_assert!(
        owned_live,
        "the count path is only reached for an owned child the tick chose to leave"
    );
    (
        OllamaTickVerdict::StillStarting,
        record_restart_failure(SupervisedService::Ollama, OLLAMA_STILL_STARTING_REASON),
    )
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

/// Why a proxy child that has not opened its port is charged to the escalation
/// budget (DD-114).
///
/// The same reason DD-079/DD-080 name for Bun and Ollama: a child handle that
/// is still alive is not a serving proxy, and "the port never opened" is the
/// whole diagnosis. Named so the supervisor's durable log line says that
/// instead of only showing a counter.
const PROXY_STILL_STARTING_REASON: &str =
    "claude_cli_proxy child is alive but has not opened its port";

/// What the proxy block of one tick reports after one observation or attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProxyTickVerdict {
    /// The port answered: the counter was cleared and a relaunch may be claimed.
    Healthy,
    /// The child did not serve: counted, never reported as a relaunch.
    NotServing,
}

/// Record one proxy observation against the escalation budget.
///
/// DD-114: the port answering is the only evidence the proxy works, so it is
/// the only observation that clears the counter. A tick that finds the port
/// still closed — whether the child was just spawned or was already running —
/// is counted exactly like a failed restart, so a proxy that keeps dying (or
/// never binds) reaches the existing cap instead of being reloaded every tick.
/// Returns the verdict plus the new count.
fn record_proxy_tick_outcome(listening: bool) -> (ProxyTickVerdict, u32) {
    if listening {
        reset_failures(SupervisedService::Proxy);
        return (ProxyTickVerdict::Healthy, 0);
    }
    (
        ProxyTickVerdict::NotServing,
        record_restart_failure(SupervisedService::Proxy, PROXY_STILL_STARTING_REASON),
    )
}

/// Why llama.cpp that spawned but has not opened its port is charged to the
/// escalation budget (DD-114).
///
/// `start_llama_cpp_server` returns as soon as the child is spawned — model
/// loading can take far longer than one tick — so `Ok` says nothing about the
/// server. The port is the only evidence it serves.
const LLAMA_CPP_STILL_STARTING_REASON: &str =
    "llama.cpp child was spawned but has not opened its port within the start budget";

/// What the llama.cpp block of one tick reports after one observation or
/// attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LlamaCppTickVerdict {
    /// The port answered: the counter was cleared and a relaunch may be claimed.
    Serving,
    /// The child did not serve: counted, never reported as a relaunch.
    NotServing,
}

/// Record one llama.cpp observation against the escalation budget.
///
/// DD-114: `start_llama_cpp_server` returning `Ok` only means the child exists,
/// so the counter must not be cleared there. A tick with the port still closed
/// advances the same budget an `Err` spawn does — that is what makes the
/// existing cap engage for a child that spawns fine and dies every tick — and
/// only a port that answers clears it.
/// Returns the verdict plus the new count.
fn record_llama_cpp_tick_outcome(serving: bool) -> (LlamaCppTickVerdict, u32) {
    if serving {
        reset_failures(SupervisedService::LlamaCpp);
        return (LlamaCppTickVerdict::Serving, 0);
    }
    (
        LlamaCppTickVerdict::NotServing,
        record_restart_failure(SupervisedService::LlamaCpp, LLAMA_CPP_STILL_STARTING_REASON),
    )
}

/// What the llama.cpp block of one tick should do when its port is closed
/// (DD-125).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LlamaCppStartDecision {
    /// A child this process owns is still loading: leave it alone this tick and
    /// remember the warm-up tick count that was just spent.
    LeaveWarming(u32),
    /// Nothing is loading (no live child) or the grace is spent: take the
    /// existing start path, whose closed port is charged to the budget.
    Start,
}

/// Decide whether a closed llama.cpp port belongs to a model load in progress
/// (DD-125).
///
/// Pure so the bound is unit-testable without a live process. `warming_ticks`
/// is how many ticks the current warm-up has already been observed for. Only an
/// owned live child warms: a child that died mid-load reports no live handle,
/// so its tick goes straight to the start path and the failure counter — that is
/// what keeps recovery bounded when the child really is broken. The grace is
/// finite, so a live child that never binds is counted again after
/// [`LLAMA_CPP_WARMING_GRACE_TICKS`] and still reaches the existing cap.
fn llama_cpp_start_decision(owned_live: bool, warming_ticks: u32) -> LlamaCppStartDecision {
    if owned_live && warming_ticks < LLAMA_CPP_WARMING_GRACE_TICKS {
        LlamaCppStartDecision::LeaveWarming(warming_ticks + 1)
    } else {
        LlamaCppStartDecision::Start
    }
}

/// Clear the DD-125 warm-up observation.
///
/// Called when the port answers (the load clearly worked), when the backend is
/// switched off, and by an explicit restart so the next attempt gets the full
/// grace. Never called merely because a child process exists.
fn reset_llama_cpp_warming() {
    LLAMA_CPP_WARMING_TICKS.store(0, Ordering::Relaxed);
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

/// The boot-stage reasons recorded so far, joined for the status surface.
fn boot_failure_summary() -> Option<String> {
    let slot = BOOT_FAILURES.get_or_init(|| Mutex::new(Vec::new()));
    let guard = slot.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_empty() {
        None
    } else {
        Some(guard.join("; "))
    }
}

/// Record a boot-stage failure where the supervisor status already reads it
/// (DD-080).
///
/// Boot has no relaunch attempt to charge, so this only records the reason: the
/// consecutive-failure counter is left alone and the give-up booleans keep
/// meaning "the supervisor paused retries". The reason survives `reset_failures`
/// because the condition it describes (for example "the config never loaded")
/// is still true after a service recovers.
pub(crate) fn record_boot_failure(reason: &str) {
    let slot = BOOT_FAILURES.get_or_init(|| Mutex::new(Vec::new()));
    let mut guard = slot.lock().unwrap_or_else(|p| p.into_inner());
    if guard.iter().any(|existing| existing == reason) {
        return;
    }
    if guard.len() >= MAX_BOOT_FAILURES {
        guard.remove(0);
    }
    guard.push(reason.to_string());
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
    if matches!(service, SupervisedService::LlamaCpp) {
        // DD-125: a serving port, or a restart the user asked for, re-arms the
        // warm-up window together with the budget so the next load gets the
        // full grace instead of inheriting a spent one.
        reset_llama_cpp_warming();
    }
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
/// atomics plus the boot-failure record, safe to call from any task.
pub fn give_up_status() -> SupervisorStatus {
    let bun_restart_failures = BUN_FAILS.load(Ordering::Relaxed);
    let boot_failure = boot_failure_summary();
    // DD-080: a boot-stage reason is what the UI reads when no relaunch has
    // failed yet. A live relaunch error wins because it is the more recent
    // cause, and the boot reason remains in the log.
    let bun_last_error = bun_last_error().or_else(|| boot_failure.clone());
    let restart_diagnostic = bun_diagnostic(bun_restart_failures, bun_last_error.as_deref());
    let boot_diagnostic = boot_failure.map(|reason| {
        format!(
            "Startup failed at boot: {reason}. Services may still come up; see the app log for the full sequence."
        )
    });
    SupervisorStatus {
        bun_give_up: bun_restart_failures >= MAX_CONSECUTIVE_RESTARTS,
        proxy_give_up: PROXY_FAILS.load(Ordering::Relaxed) >= MAX_CONSECUTIVE_RESTARTS,
        ollama_give_up: OLLAMA_FAILS.load(Ordering::Relaxed) >= MAX_CONSECUTIVE_RESTARTS,
        llama_cpp_give_up: LLAMA_CPP_FAILS.load(Ordering::Relaxed) >= MAX_CONSECUTIVE_RESTARTS,
        bun_restart_failures,
        restart_limit: MAX_CONSECUTIVE_RESTARTS,
        // DD-084: read the DD-082 reap ledger, so a quit that could not confirm a
        // child had exited is visible in the status instead of looking clean.
        reap_failures: crate::process_lifecycle::reap_failure_count(),
        bun_diagnostic: restart_diagnostic.or(boot_diagnostic),
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
    // Probed once: the action and the counter decision must see the same
    // observation, or a port that opened mid-tick could be counted after the
    // tick already decided the child was still warming (DD-114).
    let proxy_listening = crate::claude_proxy_is_listening();

    match proxy_tick_action(proxy_required, proxy_listening, proxy_owned) {
        ProxyAction::StopOwned => {
            PROXY_FAILS.store(0, Ordering::Relaxed);
            crate::process_lifecycle::stop(crate::process_lifecycle::ManagedProcess::ClaudeProxy);
        }
        ProxyAction::Leave => {
            // DD-114: a child left alone is only healthy when its port answers.
            // An owned proxy that never binds is counted, exactly as DD-080
            // counts a warming Ollama, so it reaches the give-up path instead of
            // resetting its own budget every tick.
            let previous = PROXY_FAILS.load(Ordering::Relaxed);
            match record_proxy_tick_outcome(proxy_listening) {
                (ProxyTickVerdict::Healthy, _) => {}
                // One durable line per advance, not once per tick forever: after
                // the cap the give-up status is the signal.
                (ProxyTickVerdict::NotServing, next) if next > previous => {
                    log::warn!(
                        target: "jarvis::supervisor",
                        "claude_cli_proxy is not serving — the child is alive but its port \
                         is closed ({next}/{MAX_CONSECUTIVE_RESTARTS}); counted against the \
                         restart budget, not reported as a relaunch: {PROXY_STILL_STARTING_REASON}"
                    );
                    if next >= MAX_CONSECUTIVE_RESTARTS {
                        log::error!(
                            target: "jarvis::supervisor",
                            "claude_cli_proxy never opened its port \
                             ({next}/{MAX_CONSECUTIVE_RESTARTS}); automatic restarts are paused. \
                             Use Restart to re-arm the budget."
                        );
                    }
                }
                (ProxyTickVerdict::NotServing, _) => {}
            }
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
                        // DD-114: the spawn returning is not the proxy serving.
                        // Re-probe the port before claiming a relaunch or
                        // clearing the budget.
                        match record_proxy_tick_outcome(crate::claude_proxy_is_listening()) {
                            (ProxyTickVerdict::Healthy, _) => {
                                println!("[supervisor] claude_cli_proxy was down — relaunched.");
                            }
                            (ProxyTickVerdict::NotServing, next) => {
                                log::warn!(
                                    target: "jarvis::supervisor",
                                    "claude_cli_proxy was spawned but has not opened its port \
                                     ({next}/{MAX_CONSECUTIVE_RESTARTS}); counted against the \
                                     restart budget: {PROXY_STILL_STARTING_REASON}"
                                );
                                if next >= MAX_CONSECUTIVE_RESTARTS {
                                    log::error!(
                                        target: "jarvis::supervisor",
                                        "claude_cli_proxy never opened its port \
                                         ({next}/{MAX_CONSECUTIVE_RESTARTS}); automatic restarts \
                                         are paused. Use Restart to re-arm the budget."
                                    );
                                }
                            }
                        }
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
    // Probed once: the action and the counter decision must see the same
    // observation, or a port that opened mid-tick could be counted after the
    // tick decided the child was still warming.
    let ollama_listening = crate::backend_port_is_listening(OLLAMA_PORT, ollama_uses_wsl);

    match ollama_tick_action(is_ollama, ollama_listening, ollama_owned) {
        OllamaAction::StopOwned => {
            OLLAMA_FAILS.store(0, Ordering::Relaxed);
            crate::process_lifecycle::stop(crate::process_lifecycle::ManagedProcess::Ollama);
        }
        OllamaAction::Leave => {
            // DD-080: a child left alone is only healthy when its port answers.
            // A warming child that never opens port 11434 is counted, exactly
            // like DD-079 counts a Bun that never answers /health, so it still
            // reaches the give-up path instead of resetting its budget forever.
            let previous = OLLAMA_FAILS.load(Ordering::Relaxed);
            match record_ollama_tick_outcome(ollama_listening, ollama_owned) {
                (OllamaTickVerdict::Healthy, _) => {}
                // Log one durable line per advance, not once per tick forever:
                // after the cap the give-up status is the signal.
                (OllamaTickVerdict::StillStarting, next) if next > previous => {
                    log::warn!(
                        target: "jarvis::supervisor",
                        "Ollama is still starting — alive but has not opened port 11434 \
                         ({next}/{MAX_CONSECUTIVE_RESTARTS}); counted against the restart \
                         budget, not reported as a relaunch: {OLLAMA_STILL_STARTING_REASON}"
                    );
                    if next >= MAX_CONSECUTIVE_RESTARTS {
                        log::error!(
                            target: "jarvis::supervisor",
                            "Ollama child never became ready ({next}/{MAX_CONSECUTIVE_RESTARTS}); \
                             automatic restarts are paused. Last observation: \
                             {OLLAMA_STILL_STARTING_REASON}. Use Restart to re-arm the budget."
                        );
                    }
                }
                (OllamaTickVerdict::StillStarting, _) => {}
            }
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
                    let next = record_restart_failure(
                        SupervisedService::Ollama,
                        OLLAMA_STILL_STARTING_REASON,
                    );
                    // DD-080: a packaged build discards stderr, so this failure
                    // is only diagnosable if the same line reaches the log.
                    log::warn!(
                        target: "jarvis::supervisor",
                        "Ollama restart failed ({next}/{MAX_CONSECUTIVE_RESTARTS}): \
                         {OLLAMA_STILL_STARTING_REASON}"
                    );
                    eprintln!(
                        "[supervisor] Ollama restart failed ({next}/{MAX_CONSECUTIVE_RESTARTS})."
                    );
                }
            }
        }
    }

    // ── llama.cpp (only required when Gemma is the active backend) ──
    // Probed once: the branch and the counter decision must see the same
    // observation, or a port that opened mid-tick could still be counted.
    let llama_cpp_listening =
        crate::backend_port_is_listening(llama_cpp_config.port, llama_cpp_uses_wsl);
    if !is_llama_cpp {
        LLAMA_CPP_FAILS.store(0, Ordering::Relaxed);
        reset_llama_cpp_warming();
        crate::process_lifecycle::stop(crate::process_lifecycle::ManagedProcess::LlamaCpp);
    } else if llama_cpp_listening {
        // DD-114: the port answering is the only evidence the child serves, so
        // it is the only observation that clears the budget. Recording it also
        // clears the DD-125 warm-up window.
        let _ = record_llama_cpp_tick_outcome(true);
    } else {
        let fails = LLAMA_CPP_FAILS.load(Ordering::Relaxed);
        if may_restart(fails) {
            // DD-125: a closed port with a child this process still owns may be
            // a model load in progress. Give that child a bounded warm-up window
            // instead of charging the budget on every tick, so a slow but
            // healthy load is not reported as given up before it can bind.
            let warming_ticks = LLAMA_CPP_WARMING_TICKS.load(Ordering::Relaxed);
            let owned_live = crate::process_lifecycle::is_live(
                crate::process_lifecycle::ManagedProcess::LlamaCpp,
            );
            match llama_cpp_start_decision(owned_live, warming_ticks) {
                LlamaCppStartDecision::LeaveWarming(next) => {
                    LLAMA_CPP_WARMING_TICKS.store(next, Ordering::Relaxed);
                    if next == 1 {
                        log::info!(
                            target: "jarvis::supervisor",
                            "llama.cpp child is alive but port {} has not opened yet; leaving \
                             it to load (warm-up {next}/{LLAMA_CPP_WARMING_GRACE_TICKS} ticks)",
                            llama_cpp_config.port
                        );
                    }
                }
                LlamaCppStartDecision::Start => {
                    // Only a child that outlived the grace is worth a durable
                    // line here; a dead child is diagnosed by the counted arm.
                    if owned_live && warming_ticks >= LLAMA_CPP_WARMING_GRACE_TICKS {
                        log::warn!(
                            target: "jarvis::supervisor",
                            "llama.cpp warm-up grace spent \
                             ({warming_ticks}/{LLAMA_CPP_WARMING_GRACE_TICKS} ticks); port {} is \
                             still closed, so it is counted against the restart budget again",
                            llama_cpp_config.port
                        );
                    }
                    // DD-077: no start after the app started quitting.
                    if !may_start_child() {
                        return;
                    }
                    match crate::start_llama_cpp_server(llama_cpp_config.clone()).await {
                        Ok(_) => {
                            // DD-114: `Ok` only means the child was spawned (or was
                            // already running). Model loading outlasts a tick, so the
                            // port — not the spawn — decides whether this attempt
                            // worked. A tick with the port still closed is counted
                            // exactly like an `Err` spawn, so a child that keeps dying
                            // reaches the existing cap instead of being restarted every
                            // tick.
                            let serving = crate::backend_port_is_listening(
                                llama_cpp_config.port,
                                llama_cpp_uses_wsl,
                            );
                            match record_llama_cpp_tick_outcome(serving) {
                                (LlamaCppTickVerdict::Serving, _) => {
                                    println!(
                                        "[supervisor] llama.cpp is starting or was relaunched."
                                    );
                                }
                                (LlamaCppTickVerdict::NotServing, next) => {
                                    log::warn!(
                                        target: "jarvis::supervisor",
                                        "llama.cpp was spawned but port {} is still closed \
                                         ({next}/{MAX_CONSECUTIVE_RESTARTS}); counted against the \
                                         restart budget, not reported as a relaunch: \
                                         {LLAMA_CPP_STILL_STARTING_REASON}",
                                        llama_cpp_config.port
                                    );
                                    if next >= MAX_CONSECUTIVE_RESTARTS {
                                        log::error!(
                                            target: "jarvis::supervisor",
                                            "llama.cpp never opened port {} \
                                             ({next}/{MAX_CONSECUTIVE_RESTARTS}); automatic \
                                             restarts are paused. Last observation: \
                                             {LLAMA_CPP_STILL_STARTING_REASON}. Use Restart to \
                                             re-arm the budget.",
                                            llama_cpp_config.port
                                        );
                                    }
                                }
                            }
                        }
                        Err(error) => {
                            let next =
                                record_restart_failure(SupervisedService::LlamaCpp, &error);
                            eprintln!("[supervisor] llama.cpp restart failed ({next}/{MAX_CONSECUTIVE_RESTARTS}): {error}");
                        }
                    }
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

    /// Clears the process-wide boot-failure record when a test ends — including
    /// when it panics — so one test's boot reasons cannot leak into another
    /// test's status assertions.
    struct BootFailuresReset;

    impl Drop for BootFailuresReset {
        fn drop(&mut self) {
            BOOT_FAILURES
                .get_or_init(|| Mutex::new(Vec::new()))
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clear();
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
    fn a_live_but_unready_ollama_is_counted_not_reset() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_failures(SupervisedService::Ollama);

        // DD-080, following DD-079's Bun rule: a child this process owns that
        // is still alive but has not opened port 11434 is not a healthy backend
        // and must not clear the count it is responsible for.
        let (verdict, first) = record_ollama_tick_outcome(false, true);
        assert_eq!(verdict, OllamaTickVerdict::StillStarting);
        assert_eq!(first, 1);
        assert_eq!(
            OLLAMA_FAILS.load(Ordering::Relaxed),
            1,
            "alive is not ready: a warming child must not reset the Ollama failure count"
        );

        // The next tick finds the same child still silent, so the budget
        // advances instead of starting over.
        let (verdict, second) = record_ollama_tick_outcome(false, true);
        assert_eq!(verdict, OllamaTickVerdict::StillStarting);
        assert_eq!(second, 2);

        // A child that never opens its port still reaches the give-up cap, so
        // the watchdog stops relaunching instead of resetting forever.
        for _ in 2..MAX_CONSECUTIVE_RESTARTS {
            record_ollama_tick_outcome(false, true);
        }
        assert_eq!(OLLAMA_FAILS.load(Ordering::Relaxed), MAX_CONSECUTIVE_RESTARTS);
        assert!(!may_restart(OLLAMA_FAILS.load(Ordering::Relaxed)));
        assert!(
            give_up_status().ollama_give_up,
            "a live-but-never-ready Ollama must end in the existing give-up path"
        );

        // A listener is the only observation that clears the budget.
        let (verdict, next) = record_ollama_tick_outcome(true, true);
        assert_eq!(verdict, OllamaTickVerdict::Healthy);
        assert_eq!(next, 0);
        assert!(!give_up_status().ollama_give_up);

        // Pin the wiring: the Leave arm must count the owned-but-unready child
        // and log it, never blank the counter. This is the half that fails if
        // the fix is reverted to the old unconditional reset.
        let production = supervisor_production_source();
        let ollama = production
            .split_once("// ── Ollama")
            .and_then(|(_, rest)| rest.split_once("// ── llama.cpp"))
            .map(|(block, _)| block)
            .expect("the Ollama supervisor block must sit between its section markers");
        let leave_arm = ollama
            .split_once("OllamaAction::Leave =>")
            .and_then(|(_, rest)| rest.split_once("OllamaAction::Start =>"))
            .map(|(arm, _)| arm)
            .expect("the Ollama block must keep its Leave and Start arms");
        assert!(
            leave_arm.contains("record_ollama_tick_outcome("),
            "the Leave arm must route the counter decision through the tested seam:\n{leave_arm}"
        );
        assert!(
            !leave_arm.contains("OLLAMA_FAILS.store(0"),
            "a child that is alive but unready must not have its failure count reset:\n{leave_arm}"
        );
        assert!(
            leave_arm.contains("OLLAMA_STILL_STARTING_REASON") && leave_arm.contains("log::warn!"),
            "the counted outcome must be named in the durable log:\n{leave_arm}"
        );

        reset_failures(SupervisedService::Ollama);
    }

    /// DD-114: `start_llama_cpp_server` returns as soon as the child is
    /// spawned — model loading outlasts a tick — so its `Ok` used to clear the
    /// budget and a child that spawned and died was relaunched forever. A tick
    /// whose port is still closed must count exactly like an `Err` spawn, so
    /// the existing cap engages, and only a serving port may reset.
    #[test]
    fn a_llama_cpp_that_spawns_ok_but_never_serves_reaches_the_cap_and_stops_restarting() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_failures(SupervisedService::LlamaCpp);

        // One tick after an `Ok` spawn: the child exists, the port is closed.
        let (verdict, first) = record_llama_cpp_tick_outcome(false);
        assert_eq!(verdict, LlamaCppTickVerdict::NotServing);
        assert_eq!(first, 1);
        assert_eq!(
            LLAMA_CPP_FAILS.load(Ordering::Relaxed),
            1,
            "a spawn that returned Ok is not evidence the server serves: the \
             closed port must count"
        );

        // The next ticks find the same closed port, so the budget advances
        // instead of starting over.
        for expected in 2..=MAX_CONSECUTIVE_RESTARTS {
            let (verdict, next) = record_llama_cpp_tick_outcome(false);
            assert_eq!(verdict, LlamaCppTickVerdict::NotServing);
            assert_eq!(next, expected);
        }
        assert_eq!(
            LLAMA_CPP_FAILS.load(Ordering::Relaxed),
            MAX_CONSECUTIVE_RESTARTS
        );
        assert!(
            !may_restart(LLAMA_CPP_FAILS.load(Ordering::Relaxed)),
            "a llama.cpp that spawns Ok and never serves must reach the existing cap"
        );
        assert!(
            give_up_status().llama_cpp_give_up,
            "hitting the cap must surface as the existing llama.cpp give-up state"
        );

        // Only a serving port clears the budget.
        let (verdict, next) = record_llama_cpp_tick_outcome(true);
        assert_eq!(verdict, LlamaCppTickVerdict::Serving);
        assert_eq!(next, 0);
        assert!(!give_up_status().llama_cpp_give_up);

        // Pin the wiring: after the start the tick must re-probe the port and
        // route the counter decision through the tested seam. A bare `Ok` may
        // not clear the counter — that is the half that fails if this reverts.
        let production = supervisor_production_source();
        let llama = production
            .split_once("// ── llama.cpp")
            .map(|(_, block)| block)
            .expect("the llama.cpp supervisor block must keep its section marker");
        let ok_arm = llama
            .split_once("Ok(_) => {")
            .and_then(|(_, rest)| rest.split_once("Err(error) =>"))
            .map(|(arm, _)| arm)
            .expect("the llama.cpp block must keep its Ok and Err arms");
        let probe = ok_arm
            .find("backend_port_is_listening(")
            .expect("the Ok arm must re-probe the port after the spawn decides the budget");
        let decision = ok_arm
            .find("record_llama_cpp_tick_outcome(")
            .unwrap_or_else(|| panic!("the Ok arm must route through the tested seam:\n{ok_arm}"));
        assert!(
            probe < decision,
            "the port must be observed before the counter decision:\n{ok_arm}"
        );
        assert!(
            !ok_arm.contains("LLAMA_CPP_FAILS.store(0"),
            "a spawn that returned Ok must not clear the failure count:\n{ok_arm}"
        );
        assert!(
            ok_arm.contains("LLAMA_CPP_STILL_STARTING_REASON")
                && llama.contains("log::warn!")
                && llama.contains("log::error!"),
            "the counted outcome and the give-up must be named in the durable log:\n{ok_arm}"
        );

        // A closed port at the top of the block must not reset either: only the
        // arm that saw the port answer may clear the budget.
        let healthy_arm = llama
            .split_once("} else if llama_cpp_listening {")
            .and_then(|(_, rest)| rest.split_once("} else {"))
            .map(|(arm, _)| arm)
            .expect("the llama.cpp block must keep its listening and start arms");
        assert!(
            healthy_arm.contains("record_llama_cpp_tick_outcome(true)"),
            "the listening arm must clear the budget through the tested seam:\n{healthy_arm}"
        );
        assert!(
            !healthy_arm.contains("LLAMA_CPP_FAILS.store(0"),
            "clearing the budget must stay on the serving path:\n{healthy_arm}"
        );

        reset_failures(SupervisedService::LlamaCpp);
    }

    /// DD-125: `start_llama_cpp_server` spawns and returns; loading a large GGUF
    /// can outlast the old five-tick budget. A live child that has not bound yet
    /// must be left warming instead of being charged every tick, or a healthy
    /// install is reported as given up before the server ever had a chance to
    /// bind.
    #[test]
    fn a_slow_live_llama_cpp_warm_up_outlives_the_old_five_attempt_budget() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_failures(SupervisedService::LlamaCpp);
        assert_eq!(LLAMA_CPP_WARMING_TICKS.load(Ordering::Relaxed), 0);

        // The tick that spawned the child re-probes the port once, and that
        // observation is the existing attempt charge (DD-114).
        let (verdict, first) = record_llama_cpp_tick_outcome(false);
        assert_eq!(verdict, LlamaCppTickVerdict::NotServing);
        assert_eq!(first, 1);

        // Every following tick sees the same live, unbound child. The grace is
        // longer than the old budget, so the counter must not move past that
        // single charge while the load is still in progress.
        assert!(
            LLAMA_CPP_WARMING_GRACE_TICKS > MAX_CONSECUTIVE_RESTARTS,
            "the warm-up window must outlast the old five-tick budget"
        );
        let mut warming = 0;
        for tick in 1..=LLAMA_CPP_WARMING_GRACE_TICKS {
            match llama_cpp_start_decision(true, warming) {
                LlamaCppStartDecision::LeaveWarming(next) => {
                    warming = next;
                    LLAMA_CPP_WARMING_TICKS.store(next, Ordering::Relaxed);
                }
                LlamaCppStartDecision::Start => {
                    panic!("tick {tick} of a live warm-up must not restart or count the child")
                }
            }
            assert_eq!(
                LLAMA_CPP_FAILS.load(Ordering::Relaxed),
                1,
                "a live warm-up must not advance the restart budget"
            );
            assert!(
                !give_up_status().llama_cpp_give_up,
                "a live warm-up must not reach llama_cpp_give_up"
            );
        }
        assert_eq!(warming, LLAMA_CPP_WARMING_GRACE_TICKS);

        // The port answering is the evidence the load worked: it clears both
        // the budget and the warm-up observation, so a later restart gets the
        // full grace again instead of inheriting a spent one.
        let (verdict, next) = record_llama_cpp_tick_outcome(true);
        assert_eq!(verdict, LlamaCppTickVerdict::Serving);
        assert_eq!(next, 0);
        assert_eq!(LLAMA_CPP_WARMING_TICKS.load(Ordering::Relaxed), 0);
        assert!(!give_up_status().llama_cpp_give_up);
        assert_eq!(
            llama_cpp_start_decision(true, LLAMA_CPP_WARMING_TICKS.load(Ordering::Relaxed)),
            LlamaCppStartDecision::LeaveWarming(1),
            "a serving port must re-arm the warm-up window for the next load"
        );

        // Pin the wiring in the production half: the closed-port arm must read
        // owned liveness and route through the tested decision, and the warm
        // arm must neither clear the budget nor record a failure.
        let production = supervisor_production_source();
        let llama = production
            .split_once("// ── llama.cpp")
            .map(|(_, block)| block)
            .expect("the llama.cpp supervisor block must keep its section marker");
        let liveness = llama
            .find("process_lifecycle::is_live")
            .expect("the closed-port arm must read owned liveness before deciding");
        let decision = llama
            .find("llama_cpp_start_decision(")
            .expect("the closed-port arm must route through the tested decision");
        assert!(
            liveness < decision,
            "owned liveness must be read before the tick decides the child is down"
        );
        let warming_arm = llama
            .split_once("LlamaCppStartDecision::LeaveWarming(next) => {")
            .and_then(|(_, rest)| rest.split_once("LlamaCppStartDecision::Start =>"))
            .map(|(arm, _)| arm)
            .expect("the llama.cpp block must keep its LeaveWarming and Start arms");
        assert!(
            !warming_arm.contains("LLAMA_CPP_FAILS.store(0")
                && !warming_arm.contains("record_llama_cpp_tick_outcome("),
            "warming must not count or clear the budget:\n{warming_arm}"
        );
        assert!(
            llama.contains("LLAMA_CPP_WARMING_GRACE_TICKS"),
            "the warm-up bound must stay grounded in the named grace:\n{llama}"
        );

        reset_failures(SupervisedService::LlamaCpp);
    }

    /// DD-125: the warm-up window must not turn a broken child into an endless
    /// restart. A child that dies (no live handle) never warms, and a live child
    /// that outlives the grace is counted again — both still reach the bounded
    /// give-up cap.
    #[test]
    fn a_llama_cpp_that_dies_or_outlives_the_grace_still_reaches_the_bounded_give_up() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_failures(SupervisedService::LlamaCpp);

        // A dead child never warms: its tick goes straight to the start path,
        // even when earlier ticks of the same load were spent warming.
        assert_eq!(
            llama_cpp_start_decision(false, 0),
            LlamaCppStartDecision::Start,
            "a child that is gone is down, not warming"
        );
        assert_eq!(
            llama_cpp_start_decision(false, LLAMA_CPP_WARMING_GRACE_TICKS - 1),
            LlamaCppStartDecision::Start,
            "a child that dies mid-load loses the warm path immediately"
        );

        // Repeated spawn-then-die ticks are DD-114's counted path and still end
        // at the existing cap.
        for expected in 1..=MAX_CONSECUTIVE_RESTARTS {
            let (verdict, next) = record_llama_cpp_tick_outcome(false);
            assert_eq!(verdict, LlamaCppTickVerdict::NotServing);
            assert_eq!(next, expected);
            assert_eq!(
                LLAMA_CPP_WARMING_TICKS.load(Ordering::Relaxed),
                0,
                "a dead child must not accrue warm-up ticks"
            );
        }
        assert!(give_up_status().llama_cpp_give_up);
        assert!(!may_restart(LLAMA_CPP_FAILS.load(Ordering::Relaxed)));

        // A live child that never binds: once the grace is spent the next tick
        // takes the start path, so the same cap still bounds it.
        reset_failures(SupervisedService::LlamaCpp);
        assert_eq!(
            llama_cpp_start_decision(true, LLAMA_CPP_WARMING_GRACE_TICKS),
            LlamaCppStartDecision::Start,
            "the warm-up window must be bounded, not endless"
        );
        for _ in 0..MAX_CONSECUTIVE_RESTARTS {
            record_llama_cpp_tick_outcome(false);
        }
        assert!(
            give_up_status().llama_cpp_give_up,
            "a live child whose grace is spent must still reach the bounded give-up path"
        );

        reset_failures(SupervisedService::LlamaCpp);
    }

    /// DD-114: the proxy has the same shape as llama.cpp — a closed port with an
    /// owned child used to blank the counter on every tick, and a spawn that
    /// returned `Ok` cleared it before the port ever answered.
    #[test]
    fn a_proxy_that_is_alive_but_never_serving_is_counted_not_reset() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_failures(SupervisedService::Proxy);

        for expected in 1..=MAX_CONSECUTIVE_RESTARTS {
            let (verdict, next) = record_proxy_tick_outcome(false);
            assert_eq!(verdict, ProxyTickVerdict::NotServing);
            assert_eq!(next, expected);
        }
        assert!(
            !may_restart(PROXY_FAILS.load(Ordering::Relaxed)),
            "an owned proxy that never binds must reach the existing cap"
        );
        assert!(
            give_up_status().proxy_give_up,
            "hitting the cap must surface as the existing proxy give-up state"
        );

        // A listening port is the only observation that clears the budget.
        let (verdict, next) = record_proxy_tick_outcome(true);
        assert_eq!(verdict, ProxyTickVerdict::Healthy);
        assert_eq!(next, 0);
        assert!(!give_up_status().proxy_give_up);

        // Pin the wiring: the Leave arm must count the unready child, and the
        // Ok arm must re-probe the port before it claims a relaunch.
        let production = supervisor_production_source();
        let proxy = production
            .split_once("// ── claude_cli_proxy")
            .and_then(|(_, rest)| rest.split_once("// ── Ollama"))
            .map(|(block, _)| block)
            .expect("the proxy supervisor block must sit between its section markers");
        let leave_arm = proxy
            .split_once("ProxyAction::Leave =>")
            .and_then(|(_, rest)| rest.split_once("ProxyAction::Start =>"))
            .map(|(arm, _)| arm)
            .expect("the proxy block must keep its Leave and Start arms");
        assert!(
            leave_arm.contains("record_proxy_tick_outcome("),
            "the Leave arm must route the counter decision through the tested seam:\n{leave_arm}"
        );
        assert!(
            !leave_arm.contains("PROXY_FAILS.store(0"),
            "a proxy whose port never opened must not have its failure count reset:\n{leave_arm}"
        );
        let ok_arm = proxy
            .split_once("Ok(_) => {")
            .and_then(|(_, rest)| rest.split_once("Err(error) =>"))
            .map(|(arm, _)| arm)
            .expect("the proxy block must keep its Ok and Err arms");
        assert!(
            ok_arm.contains("claude_proxy_is_listening()"),
            "the Ok arm must re-probe the port after the spawn:\n{ok_arm}"
        );
        assert!(
            ok_arm.contains("record_proxy_tick_outcome("),
            "the Ok arm must route through the tested seam:\n{ok_arm}"
        );
        assert!(
            !ok_arm.contains("PROXY_FAILS.store(0"),
            "a spawn that returned Ok must not clear the proxy failure count:\n{ok_arm}"
        );

        reset_failures(SupervisedService::Proxy);
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

    /// DD-080: a packaged build's startup reason must reach the status surface
    /// the UI reads, not only a discarded stderr line. A config that failed to
    /// load is why the run is on defaults, and a Bun boot failure is why the
    /// server is offline; both belong in `bun_last_error` before any relaunch
    /// has been attempted.
    #[test]
    fn boot_failures_are_visible_in_the_supervisor_status() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _boot = BootFailuresReset;
        reset_failures(SupervisedService::Bun);
        BOOT_FAILURES
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();

        let config_reason =
            crate::boot_config_failure_reason("database is locked while reading settings");
        let bun_reason = crate::boot_bun_failure_reason("bun executable not found");
        record_boot_failure(&config_reason);
        record_boot_failure(&bun_reason);

        let status = give_up_status();
        let last_error = status
            .bun_last_error
            .as_deref()
            .expect("a boot-stage failure must reach the status surface");
        assert!(
            last_error.contains("default configuration")
                && last_error.contains("database is locked while reading settings"),
            "the recorded reason must say the run is on defaults and why: {last_error}"
        );
        assert!(
            last_error.contains("bun executable not found"),
            "the boot-stage Bun failure must reach the same surface: {last_error}"
        );
        let diagnostic = status
            .bun_diagnostic
            .as_deref()
            .expect("Health must be able to show why boot failed");
        assert!(
            diagnostic.contains("Startup failed at boot") && diagnostic.contains("default"),
            "the diagnostic must explain the boot failure, not just say offline: {diagnostic}"
        );
        assert_eq!(
            status.bun_restart_failures, 0,
            "recording a boot reason must not fake a failed relaunch attempt"
        );
        assert!(!status.bun_give_up);

        // A later Bun reset clears the live relaunch error, but the boot
        // reason still describes how this run started.
        reset_failures(SupervisedService::Bun);
        let after_reset = give_up_status();
        assert!(
            after_reset
                .bun_last_error
                .as_deref()
                .is_some_and(|reason| reason.contains("default configuration")),
            "a recovered Bun must not erase why boot ran on defaults"
        );

        // Duplicate boot reasons must not accumulate in the status surface.
        record_boot_failure(&config_reason);
        assert_eq!(
            give_up_status()
                .bun_last_error
                .as_deref()
                .unwrap_or_default()
                .matches("default configuration")
                .count(),
            1
        );
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
