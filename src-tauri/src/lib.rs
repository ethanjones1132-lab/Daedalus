mod bun_startup_policy;
pub mod commands;
pub mod cron_scheduler;
pub mod db;
pub mod jarvis;
pub mod notifications;
pub mod parsers;
mod process_lifecycle;
pub mod supervisor;
pub mod types;
pub mod wsl;

#[cfg(test)]
#[path = "../release_resource_staging.rs"]
mod release_resource_staging;

pub use commands::*;
pub use jarvis::types as jarvis_types;

use crate::jarvis::hermes::commands::{
    hermes_interrupt, hermes_invoke, hermes_restart, hermes_shutdown, hermes_spawn, hermes_status,
};
use crate::jarvis::hermes::state::{HermesAppState, InterpreterResolver};
use jarvis::types::JarvisState;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

// ─── Jarvis Bun Server Auto-Start ────────────────────────────────────────────

static BUN_ENSURE_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

// ─── WSL Home ────────────────────────────────────────────────────────────────
// Resolves the WSL home directory on Windows (via `wsl.exe`), falling back to
// the canonical WSL-home resolver, which derives the guest home from the
// environment or reports a miss.  Result is cached for the process lifetime.

pub(crate) fn wsl_home() -> String {
    static WSL_HOME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    WSL_HOME
        .get_or_init(|| {
            if cfg!(target_os = "windows") {
                let mut cmd = std::process::Command::new("wsl.exe");
                cmd.args(["--", "sh", "-c", "echo ~"]);
                if let Some(out) =
                    crate::wsl::command_output_timeout(cmd, std::time::Duration::from_secs(15))
                {
                    let h = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !h.is_empty() && h.starts_with('/') {
                        return h;
                    }
                }
            }
            // The probe did not answer (or does not apply). The canonical
            // resolver tries its own probe, then this machine's environment,
            // and returns an empty home rather than another PC's directory.
            crate::wsl::wsl_home()
        })
        .clone()
}

// ─── Ollama + Claude-CLI Proxy Auto-Start ────────────────────────────────────
// Two extra child processes that must outlive setup() but die on app exit:
//   • Ollama serve  (port 11434) — runs the local model
//   • claude_cli_proxy.py (port 19878) — Anthropic /v1/messages -> claude CLI
// Both are spawned lazily off the main thread so the window paints fast.

/// The port `ollama serve` binds. Kept in sync with `supervisor.rs`.
pub(crate) const OLLAMA_PORT: u16 = 11434;

/// `ollama` ships as `ollama.exe` on Windows.
fn ollama_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "ollama.exe"
    } else {
        "ollama"
    }
}

/// The host's `PATH` separator (`;` on Windows, `:` elsewhere).
fn ollama_path_separator() -> char {
    if cfg!(target_os = "windows") {
        ';'
    } else {
        ':'
    }
}

/// Every location `find_ollama_binary` searches, in priority order.
///
/// Pure — it only reads injected environment values — so the Windows install
/// locations and the `PATH` walk are unit-testable without a real Ollama
/// install and without depending on the host's own environment.
///
/// Order: an explicit `JARVIS_OLLAMA_BIN`, the Unix install dirs that predate
/// the Windows lookup, the per-user Windows installer location
/// (`%LOCALAPPDATA%\Programs\Ollama\ollama.exe`), then every `PATH` directory.
fn ollama_candidate_paths(
    env: impl Fn(&str) -> Option<String>,
    path_separator: char,
    executable: &str,
) -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();

    if let Some(explicit) = env("JARVIS_OLLAMA_BIN").map(|value| value.trim().to_string()) {
        if !explicit.is_empty() {
            candidates.push(std::path::PathBuf::from(explicit));
        }
    }
    if let Some(home) = env("HOME").filter(|home| !home.trim().is_empty()) {
        candidates.push(
            std::path::PathBuf::from(home.trim())
                .join(".local")
                .join("bin")
                .join(executable),
        );
    }
    candidates.push(std::path::PathBuf::from("/usr/local/bin").join(executable));
    candidates.push(std::path::PathBuf::from("/usr/bin").join(executable));
    // DD-061: the per-user install the Windows installer writes. Without it a
    // native Windows install never finds `ollama` and never starts the backend.
    if let Some(local_app_data) = env("LOCALAPPDATA").filter(|dir| !dir.trim().is_empty()) {
        candidates.push(
            std::path::PathBuf::from(local_app_data.trim())
                .join("Programs")
                .join("Ollama")
                .join(executable),
        );
    }
    if let Some(path) = env("PATH") {
        for directory in path.split(path_separator) {
            let directory = directory.trim().trim_matches('"');
            if !directory.is_empty() {
                candidates.push(std::path::PathBuf::from(directory).join(executable));
            }
        }
    }

    candidates
}

fn ollama_candidates_from_env() -> Vec<std::path::PathBuf> {
    ollama_candidate_paths(
        |key| std::env::var(key).ok(),
        ollama_path_separator(),
        ollama_executable_name(),
    )
}

/// Pure lookup seam: candidate list and filesystem probe are injected so a
/// test can prove precedence and misses without touching the machine.
fn find_ollama_binary_with(
    env: impl Fn(&str) -> Option<String>,
    path_separator: char,
    executable: &str,
    exists: impl Fn(&std::path::Path) -> bool,
) -> Option<String> {
    ollama_candidate_paths(env, path_separator, executable)
        .into_iter()
        .find(|candidate| exists(candidate))
        .map(|candidate| candidate.to_string_lossy().into_owned())
}

fn find_ollama_binary() -> Option<String> {
    find_ollama_binary_with(
        |key| std::env::var(key).ok(),
        ollama_path_separator(),
        ollama_executable_name(),
        |candidate| candidate.exists(),
    )
}

/// Actionable text for a lookup miss: names every searched location so the
/// health surface says how to fix it (install Ollama, add it to `PATH`, or set
/// the `JARVIS_OLLAMA_BIN` override).
fn ollama_missing_binary_diagnostic(candidates: &[std::path::PathBuf]) -> String {
    let searched = candidates
        .iter()
        .map(|candidate| candidate.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Ollama binary not found; install Ollama, add it to PATH, or set \
         JARVIS_OLLAMA_BIN. Searched: {searched}"
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PythonInvocation {
    pub(crate) program: std::path::PathBuf,
    pub(crate) prefix_args: Vec<String>,
}

fn find_jarvis_python_with(
    home: Option<&std::path::Path>,
    mut works: impl FnMut(&PythonInvocation) -> bool,
) -> Option<PythonInvocation> {
    let mut candidates = Vec::new();
    if let Some(home) = home {
        for rel in [
            ".openclaw/jarvis/hermes/.venv/Scripts/python.exe",
            ".openclaw/jarvis/hermes/.venv/bin/python",
            ".openclaw/jarvis/hermes/venv/Scripts/python.exe",
            ".openclaw/jarvis/hermes/venv/bin/python",
        ] {
            let program = home.join(rel);
            if program.exists() {
                candidates.push(PythonInvocation {
                    program,
                    prefix_args: Vec::new(),
                });
            }
        }
    }
    candidates.extend([
        PythonInvocation {
            program: "py".into(),
            prefix_args: vec!["-3".to_string()],
        },
        PythonInvocation {
            program: "python".into(),
            prefix_args: Vec::new(),
        },
        PythonInvocation {
            program: "python3".into(),
            prefix_args: Vec::new(),
        },
    ]);
    candidates.into_iter().find(|candidate| works(candidate))
}

/// Upper bound for a single interpreter discovery probe. A hung `py` launcher
/// must not hold the first Hermes start open indefinitely.
const PYTHON_DISCOVERY_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[cfg(test)]
static PYTHON_DISCOVERY_PROBES: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

fn note_python_discovery_probe() {
    #[cfg(test)]
    PYTHON_DISCOVERY_PROBES.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// Run one interpreter probe with a deadline. On timeout only the child created
/// here is killed and reaped; callers never touch a process they do not own.
/// Returning `false` lets discovery continue with the next candidate.
fn probe_python_command(command: &mut std::process::Command, timeout: std::time::Duration) -> bool {
    use std::time::Instant;

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return false,
    };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn find_jarvis_python() -> Option<PythonInvocation> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from);
    find_jarvis_python_with(home.as_deref(), |candidate| {
        note_python_discovery_probe();
        let mut command = std::process::Command::new(&candidate.program);
        command
            .args(&candidate.prefix_args)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        crate::wsl::hide_windows_console(&mut command);
        probe_python_command(&mut command, PYTHON_DISCOVERY_PROBE_TIMEOUT)
    })
}

/// Deferred resolver used by the managed Hermes state. Discovery happens on the
/// first Hermes process start, never before the window exists.
fn resolve_hermes_python() -> Result<PythonInvocation, String> {
    find_jarvis_python().ok_or_else(|| {
        format!(
            "Python interpreter not found for Hermes: none of the Hermes venv, `py -3`, `python`, \
             or `python3` answered `--version` within {}ms. Install Python 3 or repair the Hermes venv.",
            PYTHON_DISCOVERY_PROBE_TIMEOUT.as_millis()
        )
    })
}

pub(crate) fn apply_python_invocation_to_hermes(
    config: &mut crate::jarvis::hermes::process::HermesConfig,
    invocation: PythonInvocation,
) {
    config.python = invocation.program;
    config.python_prefix_args = invocation.prefix_args;
}

/// Pre-window Hermes configuration. Interpreter discovery is deliberately not
/// part of this: it is resolved lazily by `HermesAppState` on first spawn.
fn build_hermes_config() -> crate::jarvis::hermes::process::HermesConfig {
    use std::path::PathBuf;
    let mut config = crate::jarvis::hermes::process::HermesConfig::default();
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        config.hermes_home = PathBuf::from(home)
            .join(".openclaw")
            .join("jarvis")
            .join("hermes");
    }
    config
}

/// Production wiring for the managed Hermes state. Constructing it must not
/// spawn interpreter probes (DD-034, DS-03).
fn build_hermes_app_state() -> HermesAppState {
    let resolver: InterpreterResolver = Arc::new(resolve_hermes_python);
    HermesAppState::with_lazy_interpreter(build_hermes_config(), resolver)
}

/// Resolve and spawn `ollama serve`. A miss is an `Err` carrying the searched
/// locations so the caller can surface it on the health counter instead of
/// losing it to the console.
fn spawn_ollama() -> Result<std::process::Child, String> {
    use std::process::{Command, Stdio};
    let bin = find_ollama_binary()
        .ok_or_else(|| ollama_missing_binary_diagnostic(&ollama_candidates_from_env()))?;
    let mut command = Command::new(&bin);
    command
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::wsl::hide_windows_console(&mut command);
    let child = process_lifecycle::spawn_managed(&mut command)
        .map_err(|error| format!("could not spawn Ollama ({bin}): {error}"))?;
    println!("[Jarvis] Ollama started (PID {}, bin {})", child.id(), bin);
    Ok(child)
}

/// Log a failed Ollama start and count it where the rest of the app already
/// looks: `get_system_health` derives `supervisor.ollama_give_up` from this
/// counter. A missing binary used to be an `eprintln!` only, so the health row
/// showed "not running" with no sign that startup was even attempted.
/// Counting here as well as in the supervisor tick is intentional: an absent
/// binary is a hard failure, so its retry budget is spent faster.
fn record_ollama_startup_failure(counter: &std::sync::atomic::AtomicU32, error: &str) -> u32 {
    log::error!(target: "jarvis::supervisor", "Ollama startup failed: {error}");
    counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
}

fn report_ollama_startup_failure(error: &str) {
    record_ollama_startup_failure(&crate::supervisor::OLLAMA_FAILS, error);
}

/// DD-065: ownership of the single in-flight Ollama warm request.
///
/// A warm blocks its thread for up to 180 s, so a second caller (boot, config
/// save, supervisor tick) must not stack another blocking thread while one is
/// still running. The flag is held by the worker through this guard and
/// released in `Drop`, so a warm that has finished never blocks the next one.
struct OllamaWarmGuard {
    in_flight: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl OllamaWarmGuard {
    /// Returns `None` when another caller still owns the in-flight warm.
    fn try_acquire(in_flight: &std::sync::Arc<std::sync::atomic::AtomicBool>) -> Option<Self> {
        in_flight
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .ok()
            .map(|_| Self {
                in_flight: std::sync::Arc::clone(in_flight),
            })
    }
}

impl Drop for OllamaWarmGuard {
    fn drop(&mut self) {
        self.in_flight
            .store(false, std::sync::atomic::Ordering::Release);
    }
}

fn warm_model(model: String) {
    // Best-effort: send a 1-token generate request so the model is hot when
    // the user fires their first chat. Failures are non-fatal.
    let _ = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .and_then(|c| {
            c.post("http://127.0.0.1:11434/api/generate")
                .json(&serde_json::json!({
                    "model": model,
                    "prompt": "ok",
                    "stream": false,
                    "options": {"num_predict": 1}
                }))
                .send()
        });
}

/// Ensure the local Ollama server is running and warm. Idempotent and best-effort:
/// if Ollama is already listening it does nothing but warm the model; otherwise it
/// spawns `ollama serve`, waits up to ~15s for the port, registers the child for
/// shutdown, and warms the model off-thread. Only called when Ollama is the active
/// backend, so OpenRouter/Claude-CLI sessions don't pay for a local model server.
///
/// A warm that is already in flight is not duplicated (DD-065); the caller returns
/// without spawning a second blocking thread.
///
/// `model` is the configured `ollama.model` from the active config. Defaults to
/// `"qwen3:8b"` only when an empty string is passed (e.g. from the reconcile path
/// before a config is fully loaded).
pub(crate) async fn start_ollama_and_warm(model: String) {
    static OLLAMA_START_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> =
        std::sync::OnceLock::new();
    let _start_guard = OLLAMA_START_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;

    let model = if model.is_empty() {
        "qwen3:8b".to_string()
    } else {
        model
    };
    // DD-049: `spawn_ollama` launches the resolved binary directly, so a native
    // Windows Ollama cannot be listening inside WSL. Only pay for the `wsl.exe`
    // probe when the resolved command is itself a WSL-side (non-`.exe`) binary.
    let uses_wsl = ollama_uses_wsl();
    if backend_port_is_listening(OLLAMA_PORT, uses_wsl) {
        println!("[Jarvis] Ollama already running on port 11434");
    } else {
        // DD-063: a live tracked child is a server that is still starting (model
        // load can outlast one supervisor tick). Replacing it would kill the warm
        // server and restart the same work; `false` reports AlreadyRunning and
        // the wait below gives that child time to open its port.
        let launch = process_lifecycle::launch(
            process_lifecycle::ManagedProcess::Ollama,
            false,
            || {
                if backend_port_is_listening(OLLAMA_PORT, uses_wsl) {
                    return Err(
                        "Ollama port 11434 is occupied by a process this app does not own; leaving it untouched".into(),
                    );
                }
                spawn_ollama()
            },
        );
        match launch {
            Ok(process_lifecycle::StartOutcome::Started(pid)) => {
                println!("[Jarvis] Ollama child registered (PID {pid})");
            }
            Ok(process_lifecycle::StartOutcome::AlreadyRunning(pid)) => {
                println!("[Jarvis] Ollama start already in progress (PID {pid})");
            }
            Ok(process_lifecycle::StartOutcome::AlreadyListening) => {
                println!("[Jarvis] Ollama port is already listening");
            }
            Err(error) => {
                report_ollama_startup_failure(&error);
                return;
            }
        }
        let mut ready = false;
        for _ in 0..30 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if backend_port_is_listening(OLLAMA_PORT, uses_wsl) {
                ready = true;
                break;
            }
        }
        if !ready {
            eprintln!("[Jarvis] Ollama did not become ready within 15s");
        } else {
            println!("[Jarvis] Ollama ready on 11434");
        }
    }
    // Warm the model off the async runtime so we don't block the boot task.
    // DD-065: at most one warm may be in flight. A config save or supervisor
    // tick that overlaps the boot warm skips instead of stacking a second
    // thread that could block for another 180 s. The guard is dropped when the
    // worker returns, so a later call after a completed warm warms again.
    static OLLAMA_WARM_IN_FLIGHT: std::sync::OnceLock<
        std::sync::Arc<std::sync::atomic::AtomicBool>,
    > = std::sync::OnceLock::new();
    let in_flight = OLLAMA_WARM_IN_FLIGHT
        .get_or_init(|| std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)));
    match OllamaWarmGuard::try_acquire(in_flight) {
        Some(guard) => {
            std::thread::spawn(move || {
                let _guard = guard;
                warm_model(model);
            });
        }
        None => {
            println!("[Jarvis] Ollama warm already in flight; not warming again");
        }
    }
}

/// Start the configured local llama.cpp server with the placement, speculation
/// and reasoning budget from `LlamaCppConfig::server_args`. The Child is owned by
/// the shared lifecycle manager, so switching backends or exiting Daedalus
/// only stops a server that this process actually spawned.
pub(crate) async fn start_llama_cpp_server(
    config: crate::jarvis::types::LlamaCppConfig,
) -> Result<process_lifecycle::StartOutcome, String> {
    use crate::jarvis::types::{LLAMA_MODEL_PATH_ENV, LLAMA_SERVER_PATH_ENV};

    // A server that is already listening (started by this process earlier or
    // by the user by hand) is usable even when no artifact paths are set.
    // Env fallbacks are applied first only so the launch mode can be read from
    // the resolved command; the early return is unchanged.
    let config = config.with_env_fallbacks();
    // DD-049: `llama-server` is spawned directly from `server_path`. A Windows
    // `.exe` never listens inside WSL, so do not spawn `wsl.exe` to find out.
    let uses_wsl = command_uses_wsl(Some(config.server_path.as_str()));
    if backend_port_is_listening(config.port, uses_wsl) {
        return Ok(process_lifecycle::StartOutcome::AlreadyListening);
    }

    if config.server_path.trim().is_empty() {
        return Err(format!(
            "llama.cpp server_path is not configured: set llama_cpp.server_path in Settings or the {LLAMA_SERVER_PATH_ENV} environment variable to the llama-server executable"
        ));
    }
    if config.model_path.trim().is_empty() {
        return Err(format!(
            "llama.cpp model_path is not configured: set llama_cpp.model_path in Settings or the {LLAMA_MODEL_PATH_ENV} environment variable to the GGUF model file"
        ));
    }
    let server_path = std::path::PathBuf::from(config.server_path.trim());
    let model_path = std::path::PathBuf::from(config.model_path.trim());
    let mtp_path = std::path::PathBuf::from(config.mtp_path.trim());
    if !server_path.is_file() {
        return Err(format!(
            "llama-server executable not found: {}",
            server_path.display()
        ));
    }
    if !model_path.is_file() {
        return Err(format!(
            "llama.cpp model GGUF not found: {}",
            model_path.display()
        ));
    }
    let mtp_head_exists = mtp_path.is_file();
    if mtp_path.as_os_str().is_empty() {
        println!("[Daedalus] no separate MTP head configured; draft-mtp uses the model's embedded MTP layer");
    } else if !mtp_head_exists {
        eprintln!(
            "[Daedalus] MTP head not found at {}; starting without draft-mtp",
            mtp_path.display()
        );
    }
    let server_args = config.server_args(mtp_head_exists);

    let outcome = process_lifecycle::launch(
        process_lifecycle::ManagedProcess::LlamaCpp,
        false,
        || {
            if backend_port_is_listening(config.port, uses_wsl) {
                return Err(format!(
                    "llama.cpp port {} became occupied by an untracked listener; leaving it untouched",
                    config.port
                ));
            }

            use std::process::{Command, Stdio};
            let mut command = Command::new(&server_path);
            command.args(&server_args);

            let log_dir = std::env::var_os("USERPROFILE")
                .map(std::path::PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(std::path::PathBuf::from))
                .unwrap_or_else(std::env::temp_dir)
                .join(".openclaw")
                .join("jarvis")
                .join("logs");
            std::fs::create_dir_all(&log_dir)
                .map_err(|error| format!("could not create llama.cpp log directory: {error}"))?;
            let log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_dir.join("llama-server.log"))
                .map_err(|error| format!("could not open llama.cpp log: {error}"))?;
            let stderr = log
                .try_clone()
                .map_err(|error| format!("could not duplicate llama.cpp log handle: {error}"))?;
            command.stdout(Stdio::from(log)).stderr(Stdio::from(stderr));
            crate::wsl::hide_windows_console(&mut command);
            process_lifecycle::spawn_managed(&mut command).map_err(|error| {
                format!(
                    "failed to spawn llama-server {}: {error}",
                    server_path.display()
                )
            })
        },
    )?;

    // Model loading can take longer than app bootstrap. Return as soon as the
    // child is spawned; the supervisor and health probes observe readiness
    // without delaying Bun/UI startup.
    Ok(outcome)
}

/// Bring up the servers the given backend needs, in the background. Idempotent —
/// starting an already-running service is a no-op — so it is safe to call on every
/// config save / backend switch. Ollama is started + warmed only for the Ollama
/// backend; the Bun server (needed by every backend for tools/skills/models) is
/// ensured for all. Fire-and-forget so the caller (e.g. the Save button) returns
/// immediately rather than blocking on Ollama warm-up.
///
/// `ollama_model` is forwarded to `start_ollama_and_warm`; pass an empty string when
/// the model is not yet known (falls back to the `qwen3:8b` default).
pub fn reconcile_backend_services(
    backend: crate::jarvis::types::JarvisBackend,
    ollama_model: String,
    llama_cpp: crate::jarvis::types::LlamaCppConfig,
) {
    tauri::async_runtime::spawn(async move {
        if matches!(backend, crate::jarvis::types::JarvisBackend::Ollama) {
            start_ollama_and_warm(ollama_model).await;
        }
        if matches!(backend, crate::jarvis::types::JarvisBackend::LlamaCpp) {
            if let Err(error) = start_llama_cpp_server(llama_cpp).await {
                eprintln!("[Daedalus] llama.cpp server startup failed: {error}");
            }
        } else {
            process_lifecycle::stop(process_lifecycle::ManagedProcess::LlamaCpp);
        }
        if let Err(e) = ensure_jarvis_server_started().await {
            eprintln!(
                "[Jarvis] ensure server after backend reconcile failed: {}",
                e
            );
        }
    });
}

pub(crate) fn claude_proxy_enabled(config: &crate::jarvis::types::JarvisConfig) -> bool {
    config.claude_cli.enabled
        && matches!(
            config.claude_cli.auth_mode,
            crate::jarvis::types::ClaudeCliAuthMode::Proxy
        )
}

fn configure_proxy_credential(
    command: &mut std::process::Command,
    openrouter_api_key: &str,
    through_wsl: bool,
) {
    if openrouter_api_key.trim().is_empty() {
        return;
    }
    const KEY: &str = "JARVIS_OPENROUTER_API_KEY";
    command.env(KEY, openrouter_api_key);
    if through_wsl {
        forward_env_to_wsl(command, &[KEY]);
    }
}

fn forward_env_to_wsl(command: &mut std::process::Command, required: &[&str]) {
    let staged = command
        .get_envs()
        .find(|(name, _)| *name == std::ffi::OsStr::new("WSLENV"))
        .and_then(|(_, value)| value)
        .map(|value| value.to_string_lossy().into_owned())
        .or_else(|| std::env::var("WSLENV").ok())
        .unwrap_or_default();
    let mut forwarded = Vec::new();
    for entry in staged.split(':').filter(|name| !name.is_empty()) {
        let base = entry.split('/').next().unwrap_or(entry);
        let normalized = if required.contains(&base) {
            base
        } else {
            entry
        };
        if !forwarded.iter().any(|existing| existing == normalized) {
            forwarded.push(normalized.to_owned());
        }
    }
    for name in required {
        if !forwarded.iter().any(|entry| entry == name) {
            forwarded.push((*name).to_string());
        }
    }
    command.env("WSLENV", forwarded.join(":"));
}

fn configure_proxy_runtime(command: &mut std::process::Command, model: &str, through_wsl: bool) {
    const RUNTIME_ENV: [&str; 4] = [
        "JARVIS_CLAUDE_PROXY_PORT",
        "JARVIS_CLAUDE_PROXY_BIND",
        "JARVIS_OLLAMA_URL",
        "JARVIS_DEFAULT_MODEL",
    ];
    command
        .env(RUNTIME_ENV[0], "19878")
        .env(RUNTIME_ENV[1], "127.0.0.1")
        .env(RUNTIME_ENV[2], "http://127.0.0.1:11434")
        .env(RUNTIME_ENV[3], model);
    if through_wsl {
        forward_env_to_wsl(command, &RUNTIME_ENV);
    }
}

/// The port `claude_cli_proxy.py` binds. Shared with `supervisor.rs` so both
/// sides agree on what "the proxy port" means.
pub(crate) const CLAUDE_PROXY_PORT: u16 = 19878;
static PROXY_USES_WSL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn claude_proxy_is_listening() -> bool {
    local_port_is_listening(CLAUDE_PROXY_PORT)
        || (PROXY_USES_WSL.load(std::sync::atomic::Ordering::Relaxed)
            && is_wsl_port_listening(CLAUDE_PROXY_PORT))
}

/// The proxy runs through `wsl.exe` when its script only exists inside WSL. The
/// lifecycle slot has to record that, so stopping it reaches the guest python
/// process instead of only the wrapper (DD-063).
fn claude_proxy_slot_launch() -> process_lifecycle::SlotLaunch {
    if PROXY_USES_WSL.load(std::sync::atomic::Ordering::Relaxed) {
        process_lifecycle::SlotLaunch::Wsl {
            port: CLAUDE_PROXY_PORT,
        }
    } else {
        process_lifecycle::SlotLaunch::Direct
    }
}

/// Parse `netstat -ano` output for PIDs LISTENING on `port` (Windows-format
/// rows: `  TCP    127.0.0.1:19878   0.0.0.0:0   LISTENING   29084`). Pure and
/// unit-tested; the real netstat invocation is a thin, untested wrapper below
/// (consistent with `is_port_listening` itself doing real I/O, untested).
fn parse_listening_pids(netstat_output: &str, port: u16) -> Vec<u32> {
    let local_suffix = format!(":{port}");
    let mut pids = Vec::new();
    for line in netstat_output.lines() {
        if !line.contains("LISTENING") {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        // Expected shape: [Proto, LocalAddress, ForeignAddress, State, PID].
        let Some(local_addr) = cols.get(1) else {
            continue;
        };
        if !local_addr.ends_with(&local_suffix) {
            continue;
        }
        if let Some(pid) = cols.last().and_then(|s| s.parse::<u32>().ok()) {
            pids.push(pid);
        }
    }
    pids
}

fn pids_listening_on_port(port: u16) -> Vec<u32> {
    if !cfg!(target_os = "windows") {
        return Vec::new();
    }
    let Ok(output) = std::process::Command::new("netstat")
        .args(["-ano"])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_listening_pids(&String::from_utf8_lossy(&output.stdout), port)
}

/// The port the Bun server binds. Shared with `supervisor.rs`.
pub(crate) const BUN_SERVER_PORT: u16 = 19877;

/// True when `tasklist` cannot find a process for `pid` (Windows). Used to
/// detect "ghost sockets": netstat still shows LISTENING with a PID that no
/// longer exists, so taskkill is a no-op and every bind gets EADDRINUSE /
/// access-denied until reboot. Pure wrapper so the diagnostic string is testable.
fn process_exists_windows(pid: u32) -> bool {
    if !cfg!(target_os = "windows") {
        return true;
    }
    let Ok(output) = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
    else {
        return true; // unknown — don't claim ghost
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    // tasklist prints "INFO: No tasks are running which match..." when missing,
    // or a row containing the PID when present.
    stdout.contains(&pid.to_string()) && !stdout.to_ascii_lowercase().contains("no tasks")
}

/// PIDs that netstat reports as LISTENING on `port` but that are not live
/// processes. Non-empty → Windows ghost socket; only a reboot (or a winsock
/// reset) frees the port.
fn ghost_pids_holding_port(port: u16) -> Vec<u32> {
    pids_listening_on_port(port)
        .into_iter()
        .filter(|pid| *pid > 0 && !process_exists_windows(*pid))
        .collect()
}

fn bun_port_ghost_diagnostic(port: u16, ghosts: &[u32]) -> String {
    format!(
        "Port {port} is held by dead PID(s) {ghosts:?} (Windows ghost socket). \
         taskkill cannot free a process that no longer exists, so every Bun spawn \
         fails with EADDRINUSE / 'access permissions'. Reboot the machine (or \
         `netsh winsock reset` + reboot) to release the port. Root cause is usually \
         a mid-turn kill of a hung Bun process that left CLOSE_WAIT/LISTEN state behind."
    )
}

#[cfg(test)]
mod proxy_reap_tests {
    use super::parse_listening_pids;

    // Realistic `netstat -ano` excerpt: the multi-listener situation actually
    // observed live (3 stale processes bound to :19878 from prior sessions),
    // plus an unrelated port and a non-LISTENING row that must be ignored.
    const NETSTAT_FIXTURE: &str = "\
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:19878        0.0.0.0:0              LISTENING       29084
  TCP    127.0.0.1:19878        0.0.0.0:0              LISTENING       33496
  TCP    127.0.0.1:19878        0.0.0.0:0              LISTENING       32900
  TCP    127.0.0.1:19877        0.0.0.0:0              LISTENING       11223
  TCP    127.0.0.1:53872        127.0.0.1:19878        TIME_WAIT       0
";

    #[test]
    fn finds_every_pid_listening_on_the_target_port() {
        let pids = parse_listening_pids(NETSTAT_FIXTURE, 19878);
        assert_eq!(pids, vec![29084, 33496, 32900]);
    }

    #[test]
    fn ignores_a_different_port() {
        let pids = parse_listening_pids(NETSTAT_FIXTURE, 19877);
        assert_eq!(pids, vec![11223]);
    }

    #[test]
    fn ignores_non_listening_rows_on_the_target_port() {
        // The TIME_WAIT row's Local Address is an ephemeral client port, not
        // :19878, and its state isn't LISTENING either -- verify neither
        // condition alone produces a false match.
        assert!(!NETSTAT_FIXTURE
            .lines()
            .any(|l| l.contains("53872") && l.contains("LISTENING")));
    }

    #[test]
    fn empty_output_yields_no_pids() {
        assert_eq!(parse_listening_pids("", 19878), Vec::<u32>::new());
    }

    #[test]
    fn a_port_with_nothing_listening_yields_no_pids() {
        assert_eq!(
            parse_listening_pids(NETSTAT_FIXTURE, 60000),
            Vec::<u32>::new()
        );
    }

    #[test]
    fn ghost_diagnostic_names_the_port_and_dead_pids() {
        let msg = super::bun_port_ghost_diagnostic(19877, &[25352]);
        assert!(msg.contains("19877"), "{msg}");
        assert!(msg.contains("25352"), "{msg}");
        assert!(msg.to_ascii_lowercase().contains("reboot"), "{msg}");
        assert!(msg.contains("ghost"), "{msg}");
    }
}

pub(crate) fn start_claude_cli_proxy(
    ollama_model: String,
    openrouter_api_key: String,
) -> Result<process_lifecycle::StartOutcome, String> {
    if local_port_is_listening(CLAUDE_PROXY_PORT) {
        return Ok(process_lifecycle::StartOutcome::AlreadyListening);
    }
    let (script, py) = prepare_claude_cli_proxy()?;
    if claude_proxy_is_listening() {
        return Ok(process_lifecycle::StartOutcome::AlreadyListening);
    }

    process_lifecycle::launch_with(
        process_lifecycle::ManagedProcess::ClaudeProxy,
        false,
        claude_proxy_slot_launch(),
        || {
            if claude_proxy_is_listening() {
                return Err(format!(
                    "Claude proxy port {CLAUDE_PROXY_PORT} became occupied by an untracked listener; leaving it untouched"
                ));
            }
            spawn_claude_cli_proxy_child(script, py, ollama_model, openrouter_api_key)
        },
    )
}

pub(crate) fn restart_claude_cli_proxy(
    ollama_model: String,
    openrouter_api_key: String,
) -> Result<process_lifecycle::StartOutcome, String> {
    let (script, py) = prepare_claude_cli_proxy()?;
    process_lifecycle::launch_with(
        process_lifecycle::ManagedProcess::ClaudeProxy,
        true,
        claude_proxy_slot_launch(),
        || {
            if claude_proxy_is_listening() {
                return Err(format!(
                    "Claude proxy port {CLAUDE_PROXY_PORT} remains occupied by a listener this app does not own; leaving it untouched"
                ));
            }
            spawn_claude_cli_proxy_child(script, py, ollama_model, openrouter_api_key)
        },
    )
}

fn prepare_claude_cli_proxy() -> Result<(ProxyScript, PythonInvocation), String> {
    let script = find_claude_cli_proxy().ok_or("Claude proxy script not found")?;
    let py = match script.kind {
        ProxyScriptKind::Native => find_jarvis_python().ok_or("Python interpreter not found")?,
        ProxyScriptKind::Wsl => PythonInvocation {
            program: "wsl.exe".into(),
            prefix_args: vec!["--".to_string(), "python3".to_string()],
        },
    };
    PROXY_USES_WSL.store(
        matches!(script.kind, ProxyScriptKind::Wsl),
        std::sync::atomic::Ordering::Relaxed,
    );
    Ok((script, py))
}

fn spawn_claude_cli_proxy_child(
    script: ProxyScript,
    py: PythonInvocation,
    ollama_model: String,
    openrouter_api_key: String,
) -> Result<std::process::Child, String> {
    use std::process::Command;
    let model = if ollama_model.is_empty() {
        "qwen3:8b".to_string()
    } else {
        ollama_model
    };
    let mut command = Command::new(&py.program);
    command.args(&py.prefix_args).arg(&script.path);
    let through_wsl = matches!(script.kind, ProxyScriptKind::Wsl);
    configure_proxy_runtime(&mut command, &model, through_wsl);
    command
        .stdout(jarvis_server_log_stdio("claude-proxy.log"))
        .stderr(jarvis_server_log_stdio("claude-proxy.err.log"));
    configure_proxy_credential(&mut command, &openrouter_api_key, through_wsl);
    crate::wsl::hide_windows_console(&mut command);
    let child = match process_lifecycle::spawn_managed(&mut command) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "[Jarvis] claude_cli_proxy spawn failed: {e} (interpreter={:?} {:?}, script={}, source={:?}, model={model})",
                py.program,
                py.prefix_args,
                script.path.display(),
                script.kind,
            );
            return Err(format!("Claude proxy spawn failed: {e}"));
        }
    };
    println!(
        "[Jarvis] claude_cli_proxy started (PID {}, interpreter {:?} {:?}, script {}, source {:?}, model {})",
        child.id(),
        py.program,
        py.prefix_args,
        script.path.display(),
        script.kind,
        model,
    );
    Ok(child)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProxyScriptKind {
    Native,
    Wsl,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProxyScript {
    path: std::path::PathBuf,
    kind: ProxyScriptKind,
}

struct ProxyDiscoveryContext {
    override_path: Option<std::path::PathBuf>,
    exe_path: Option<std::path::PathBuf>,
    cwd: Option<std::path::PathBuf>,
    /// Script under a checkout root named by [`PROXY_REPO_ROOT_ENV`]. `None`
    /// when the environment names no checkout.
    repo_root_script: Option<std::path::PathBuf>,
    user_profile: Option<std::path::PathBuf>,
    wsl_candidates: Vec<std::path::PathBuf>,
}

/// The proxy script's path inside a source checkout.
const PROXY_SCRIPT_REPO_RELATIVE: &str = "scripts/claude_cli_proxy.py";

/// Optional checkout root, for a build whose repo does not sit on the
/// executable's own ancestry (for example a packaged app pointed at a checkout).
/// The script itself can also be named directly with
/// `JARVIS_CLAUDE_PROXY_PATH`. Neither is a default: without them, only paths
/// derived from the running app are searched.
const PROXY_REPO_ROOT_ENV: &str = "JARVIS_REPO_ROOT";

/// How many parent directories the proxy ancestry walk inspects.
const PROXY_ANCESTRY_DEPTH: usize = 8;

/// Reads an environment value as a non-empty path.
fn env_path(
    env: &impl Fn(&str) -> Option<std::ffi::OsString>,
    name: &str,
) -> Option<std::path::PathBuf> {
    env(name)
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
}

/// The proxy discovery inputs this app can actually observe: its own
/// environment, the executable's location, and the working directory. Nothing
/// here names a directory the app has not derived.
fn proxy_discovery_context(
    env: impl Fn(&str) -> Option<std::ffi::OsString>,
    exe_path: Option<std::path::PathBuf>,
    cwd: Option<std::path::PathBuf>,
) -> ProxyDiscoveryContext {
    ProxyDiscoveryContext {
        override_path: env_path(&env, "JARVIS_CLAUDE_PROXY_PATH"),
        exe_path,
        cwd,
        repo_root_script: env_path(&env, PROXY_REPO_ROOT_ENV)
            .map(|root| root.join(PROXY_SCRIPT_REPO_RELATIVE)),
        user_profile: env_path(&env, "USERPROFILE"),
        wsl_candidates: Vec::new(),
    }
}

/// Every native proxy script candidate, nearest first: an explicit
/// `JARVIS_CLAUDE_PROXY_PATH`, the app's resource directory beside the
/// executable, the checkout layout reached by walking up from the executable
/// and then from the working directory, a configured [`PROXY_REPO_ROOT_ENV`]
/// checkout, and the per-user install under the profile.
///
/// Candidates are not existence-checked here; discovery accepts only the first
/// one that exists, so a path that is merely shaped right never wins.
fn native_proxy_candidates(context: &ProxyDiscoveryContext) -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = &context.override_path {
        candidates.push(path.clone());
    }
    if let Some(exe_dir) = context.exe_path.as_deref().and_then(std::path::Path::parent) {
        candidates.push(exe_dir.join("resources").join("claude_cli_proxy.py"));
    }
    for start in [context.exe_path.as_deref(), context.cwd.as_deref()]
        .into_iter()
        .flatten()
    {
        candidates.extend(ancestry_proxy_candidates(start));
    }
    if let Some(path) = &context.repo_root_script {
        candidates.push(path.clone());
    }
    if let Some(profile) = &context.user_profile {
        candidates.push(
            profile
                .join(".openclaw")
                .join("jarvis")
                .join("hermes")
                .join("claude_cli_proxy.py"),
        );
    }
    candidates
}

/// Every `scripts/claude_cli_proxy.py` above `start`, nearest first.
fn ancestry_proxy_candidates(start: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    let mut cursor = if start.is_dir() {
        Some(start.to_path_buf())
    } else {
        start.parent().map(std::path::Path::to_path_buf)
    };
    for _ in 0..PROXY_ANCESTRY_DEPTH {
        let Some(dir) = cursor.as_ref() else { break };
        candidates.push(dir.join("scripts").join("claude_cli_proxy.py"));
        cursor = dir.parent().map(std::path::Path::to_path_buf);
    }
    candidates
}

fn find_claude_cli_proxy_with(
    context: &ProxyDiscoveryContext,
    mut wsl_exists: impl FnMut(&std::path::Path) -> bool,
) -> Option<ProxyScript> {
    if let Some(path) = native_proxy_candidates(context)
        .into_iter()
        .find(|candidate| candidate.exists())
    {
        return Some(ProxyScript {
            path,
            kind: ProxyScriptKind::Native,
        });
    }
    context
        .wsl_candidates
        .iter()
        .find(|path| wsl_exists(path))
        .cloned()
        .map(|path| ProxyScript {
            path,
            kind: ProxyScriptKind::Wsl,
        })
}

fn find_claude_cli_proxy() -> Option<ProxyScript> {
    let native = proxy_discovery_context(
        |name| std::env::var_os(name),
        std::env::current_exe().ok(),
        std::env::current_dir().ok(),
    );
    if let Some(script) = find_claude_cli_proxy_with(&native, |_| false) {
        return Some(script);
    }

    let home = wsl_home();
    let wsl = ProxyDiscoveryContext {
        override_path: None,
        exe_path: None,
        cwd: None,
        repo_root_script: None,
        user_profile: None,
        wsl_candidates: vec![
            format!(
                "{home}/.openclaw/agents/coderclaw/workspace/home-base/scripts/claude_cli_proxy.py"
            )
            .into(),
            format!("{home}/.openclaw/jarvis/hermes/claude_cli_proxy.py").into(),
        ],
    };
    let mut script = find_claude_cli_proxy_with(&wsl, |path| {
        if cfg!(target_os = "windows") {
            let path = path.to_string_lossy();
            let mut command = std::process::Command::new("wsl.exe");
            command.args(["--", "test", "-f", path.as_ref()]);
            crate::wsl::command_output_timeout(command, std::time::Duration::from_secs(15))
                .map(|output| output.status.success())
                .unwrap_or(false)
        } else {
            path.exists()
        }
    })?;
    if !cfg!(target_os = "windows") {
        script.kind = ProxyScriptKind::Native;
    }
    Some(script)
}

/// Bundled server entry points checked beside the running executable, in
/// priority order. These are the only packaged entries a release build launches.
#[cfg(any(target_os = "windows", test))]
const BESIDE_EXE_BUNDLE_CANDIDATES: &[&str] = &[
    "index.js",
    "resources/index.js",
    "server-jarvis/dist/index.js",
    "server.js",
];

/// The only repo-relative entry an ancestry walk may return. A packaged install
/// must never fall back to a TypeScript source tree.
#[cfg(any(target_os = "windows", test))]
const ANCESTRY_BUNDLE_CANDIDATE: &str = "server-jarvis/dist/index.js";

/// How many parent directories an ancestry walk inspects.
#[cfg(any(target_os = "windows", test))]
const ANCESTRY_WALK_DEPTH: usize = 8;

/// Chooses a bundled server next to `dir`, then in up to `ANCESTRY_WALK_DEPTH`
/// of its ancestors. Only built bundle paths are considered, so a packaged
/// install that finds none reports a miss instead of silently starting the
/// developer source tree. `exists` is injected so this policy is testable
/// without a real executable or filesystem.
#[cfg(any(target_os = "windows", test))]
fn find_bundled_server(
    dir: Option<&std::path::Path>,
    exists: impl Fn(&std::path::Path) -> bool,
) -> Option<std::path::PathBuf> {
    let dir = dir?;
    for rel in BESIDE_EXE_BUNDLE_CANDIDATES {
        let cand = dir.join(rel);
        if exists(&cand) {
            return Some(cand);
        }
    }
    find_bundle_in_ancestry(dir, &exists)
}

/// Walks `start` and its ancestors looking only for the bundled dist entry, so a
/// sibling `server-jarvis/src/index.ts` is never treated as the server.
#[cfg(any(target_os = "windows", test))]
fn find_bundle_in_ancestry<F>(
    start: &std::path::Path,
    exists: &F,
) -> Option<std::path::PathBuf>
where
    F: Fn(&std::path::Path) -> bool,
{
    let mut cursor = Some(start.to_path_buf());
    for _ in 0..ANCESTRY_WALK_DEPTH {
        let Some(dir) = cursor.as_ref() else { break };
        let cand = dir.join(ANCESTRY_BUNDLE_CANDIDATE);
        if exists(&cand) {
            return Some(cand);
        }
        cursor = dir.parent().map(|p| p.to_path_buf());
    }
    None
}

fn find_jarvis_server() -> Option<String> {
    // Explicit override — useful for dev without WSL.
    if let Ok(path) = std::env::var("JARVIS_SERVER_PATH") {
        if std::path::Path::new(&path).exists() {
            println!("[Jarvis] Using JARVIS_SERVER_PATH override: {}", path);
            return Some(path);
        }
    }

    // Bundled server next to the EXE (production installer / cargo tauri build).
    // A packaged install that finds no bundle must report a miss: never fall
    // back to a developer source tree, or release builds depend on a checkout.
    #[cfg(target_os = "windows")]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(found) = find_bundled_server(exe.parent(), |path| path.exists()) {
                return Some(found.to_string_lossy().into_owned());
            }
        }

        // Same bundle-only search relative to CWD — useful when the binary is
        // launched from a sibling of the repo (e.g. `target\release\home-base.exe`
        // run from the repo root, or from a CI workspace).
        if let Ok(cwd) = std::env::current_dir() {
            if let Some(found) =
                find_bundle_in_ancestry(&cwd, &|path: &std::path::Path| path.exists())
            {
                return Some(found.to_string_lossy().into_owned());
            }
        }
    }

    // No bundle found — do not silently start a TypeScript source tree.
    None
}

/// Async health probe with a local fast path. WSL hostname discovery can take
/// 15s on a cold distro, so it only runs when this install launches Bun through
/// WSL and all configured/loopback URLs have failed.
async fn probe_jarvis_healthy() -> bool {
    let client = reqwest::Client::new();
    let local_candidates = crate::wsl::local_jarvis_api_candidates();
    if probe_jarvis_candidates(&client, &local_candidates).await {
        return true;
    }
    if !bun_uses_wsl() {
        return false;
    }

    let candidates = tokio::task::spawn_blocking(crate::wsl::jarvis_api_candidates)
        .await
        .unwrap_or_default();
    let wsl_candidates: Vec<String> = candidates
        .into_iter()
        .filter(|candidate| !local_candidates.contains(candidate))
        .collect();
    probe_jarvis_candidates(&client, &wsl_candidates).await
}

async fn probe_jarvis_candidates(client: &reqwest::Client, candidates: &[String]) -> bool {
    for base in candidates {
        let trimmed = base.trim_end_matches('/').to_string();
        let probe = format!("{}/health", trimmed);
        // A 2xx is not enough: anything else on the port (a Vite preview, a
        // stale process, some other app's health route) answers 2xx too. The
        // body must identify this Jarvis before the origin is adopted.
        let accepted = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            let resp = match client.get(&probe).send().await {
                Ok(resp) => resp,
                Err(_) => return false,
            };
            if !resp.status().is_success() {
                return false;
            }
            match resp.text().await {
                Ok(body) => jarvis_health_identifies(&body),
                Err(_) => false,
            }
        })
        .await
        .unwrap_or(false);

        if accepted {
            crate::wsl::set_cached_bun_url(trimmed);
            return true;
        }
    }
    false
}

/// Does this `/health` body come from *this* Jarvis?
///
/// The server's `/health` handler (`server-jarvis/src/index.ts`, the
/// `path === "/health"` branch) sends no `name` or `service` field, so the
/// identity it does report is `git_sha` — the build identity it carries so
/// one build can be told apart from "any other build". Jarvis also always
/// sends a boolean `ok`, a non-empty `version`, and a non-empty `backend`, so
/// the body has to match that shape too. `git_sha` is `"dev"` for a build
/// without the release provenance bake, and that is still Jarvis; a
/// stranger's health route has no `git_sha` at all.
///
/// Anything that fails this is not healthy, so the app keeps looking and
/// eventually spawns the server it owns.
fn jarvis_health_identifies(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return false;
    };

    let non_empty_str = |key: &str| {
        object
            .get(key)
            .and_then(|value| value.as_str())
            .is_some_and(|text| !text.trim().is_empty())
    };

    object.get("ok").and_then(|value| value.as_bool()) == Some(true)
        && non_empty_str("version")
        && non_empty_str("git_sha")
        && non_empty_str("backend")
}

#[cfg(test)]
mod probe_jarvis_health_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::{Mutex, OnceLock};

    /// `set_cached_bun_url` is process-global, so these probes take turns.
    fn cache_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    /// A one-shot loopback stand-in for whatever is listening on a Jarvis port.
    /// It answers the first request with `status` and `body` over real HTTP, so
    /// the probe is exercised end to end instead of against a stub client.
    fn spawn_health_listener(
        status: &'static str,
        body: &'static str,
    ) -> (String, std::thread::JoinHandle<()>) {
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("bind a loopback listener");
        listener
            .set_nonblocking(true)
            .expect("make loopback listener non-blocking");
        let addr = listener.local_addr().expect("read loopback address");
        let handle = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0u8; 2048];
                        let _ = stream.read(&mut request);
                        let response = format!(
                            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(response.as_bytes());
                        let _ = stream.flush();
                        return;
                    }
                    Err(_) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(_) => return,
                }
            }
        });
        (format!("http://127.0.0.1:{}", addr.port()), handle)
    }

    async fn probe_one(candidate: &str) -> bool {
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("build loopback probe client");
        let candidates = [candidate.to_string()];
        probe_jarvis_candidates(&client, &candidates).await
    }

    /// The body `GET /health` really returns today: `ok`, `version`, the
    /// active backend, and the build-provenance fields (`git_sha` included).
    const OWN_HEALTH: &str = r#"{"ok":true,"uptime":12.5,"version":"1.0.0","backend":"ollama","model":"qwen3:8b","configured_model":"qwen3:8b","model_resolved":true,"git_sha":"dev","built_at":null,"git_dirty":null,"source_tree_sha256":null}"#;

    #[tokio::test]
    async fn probe_jarvis_accepts_own_health() {
        let _guard = cache_lock().lock().unwrap_or_else(|poison| poison.into_inner());
        crate::wsl::clear_cached_bun_url();
        let (origin, server) = spawn_health_listener("200 OK", OWN_HEALTH);

        assert!(
            probe_one(&origin).await,
            "a /health body that identifies this Jarvis must be accepted"
        );
        assert_eq!(
            crate::wsl::get_cached_bun_url(),
            Some(origin),
            "the accepted origin is the only origin cached as the Bun URL"
        );

        let _ = server.join();
        crate::wsl::clear_cached_bun_url();
    }

    #[tokio::test]
    async fn probe_jarvis_rejects_foreign_health() {
        let _guard = cache_lock().lock().unwrap_or_else(|poison| poison.into_inner());
        crate::wsl::clear_cached_bun_url();
        // A stranger's 200: healthy and JSON, but nothing says "this Jarvis" —
        // no git_sha, and a version/service that belong to another app.
        let (origin, server) = spawn_health_listener(
            "200 OK",
            r#"{"status":"ok","service":"vite-preview","version":"5.4.0"}"#,
        );

        assert!(
            !probe_one(&origin).await,
            "a stranger's 200 must not count as healthy, or the app never spawns \
             its own server"
        );
        assert_ne!(
            crate::wsl::get_cached_bun_url(),
            Some(origin),
            "a stranger's 200 must not become the cached Bun origin"
        );

        let _ = server.join();
        crate::wsl::clear_cached_bun_url();
    }

    #[tokio::test]
    async fn probe_jarvis_rejects_health_without_a_json_body() {
        let _guard = cache_lock().lock().unwrap_or_else(|poison| poison.into_inner());
        crate::wsl::clear_cached_bun_url();
        let (origin, server) = spawn_health_listener("200 OK", "");

        assert!(
            !probe_one(&origin).await,
            "2xx with an empty body cannot identify anything"
        );
        assert_ne!(crate::wsl::get_cached_bun_url(), Some(origin));

        let _ = server.join();
        crate::wsl::clear_cached_bun_url();
    }

    #[tokio::test]
    async fn probe_jarvis_rejects_health_that_is_not_json() {
        let _guard = cache_lock().lock().unwrap_or_else(|poison| poison.into_inner());
        crate::wsl::clear_cached_bun_url();
        let (origin, server) = spawn_health_listener("200 OK", "<html><body>ok</body></html>");

        assert!(
            !probe_one(&origin).await,
            "a 200 whose body is not JSON cannot identify this Jarvis"
        );
        assert_ne!(crate::wsl::get_cached_bun_url(), Some(origin));

        let _ = server.join();
        crate::wsl::clear_cached_bun_url();
    }

    /// A stranger's 2xx: healthy and JSON, but nothing says "this Jarvis".
    const FOREIGN_HEALTH: &str = r#"{"status":"ok","service":"vite-preview","version":"5.4.0"}"#;

    /// The state this app derives from a bound port whose listener answers with
    /// `origin`'s body: occupancy is only half the answer.
    fn state_of_a_held_port(origin: &str) -> BunPortState {
        bun_port_state_from(true, || bun_health_identifies(origin))
    }

    /// DD-T1: the `/health` body — not the open port — decides who is there. A
    /// foreign 2xx must not read as this app's server, or a first run either
    /// adopts a stranger or refuses to start for no stated reason.
    #[test]
    fn the_health_body_decides_who_holds_the_bun_port() {
        // A free port is decided without spending an HTTP probe, so a cold
        // first run never waits on one.
        assert_eq!(
            bun_port_state_from(false, || panic!("a free port must not be probed")),
            BunPortState::Free,
            "occupancy alone must not require an identity probe"
        );

        // The fixture really is a body the identifying rule rejects.
        assert!(
            !jarvis_health_identifies(FOREIGN_HEALTH),
            "the foreign fixture must be a body jarvis_health_identifies rejects"
        );
        let (origin, server) = spawn_health_listener("200 OK", FOREIGN_HEALTH);
        assert_eq!(
            state_of_a_held_port(&origin),
            BunPortState::ForeignListener,
            "a held port whose /health does not identify this Jarvis is not ours"
        );
        let _ = server.join();

        // This Jarvis's real /health body is ours.
        let (origin, server) = spawn_health_listener("200 OK", OWN_HEALTH);
        assert_eq!(
            state_of_a_held_port(&origin),
            BunPortState::ThisApp,
            "an identifying /health body is this app's server"
        );
        let _ = server.join();
    }

    /// DD-T1: the guard's refusal comes from the identity probe, not from "the
    /// port is held". A stub reporting a held port with a foreign body must keep
    /// the refusal and name the stranger; a free port still spawns as today.
    #[test]
    fn the_start_guard_refuses_from_the_probe_not_from_occupancy() {
        let foreign_held = bun_port_state_from(true, || false);
        let refusal = bun_start_guard(foreign_held)
            .expect_err("a listener that is not this app's server must be refused");
        assert!(
            refusal.contains("not this app's server"),
            "the refusal must say the listener is not this app's server: {refusal}"
        );
        assert!(
            refusal.contains("leaving it untouched"),
            "the foreign listener must still be left untouched: {refusal}"
        );

        assert_eq!(
            bun_start_guard(BunPortState::Free),
            Ok(()),
            "a free port must keep the existing spawn path"
        );

        let ours = bun_start_guard(bun_port_state_from(true, || true))
            .expect_err("a listener this app does not own must never be replaced");
        assert!(
            ours.contains("leaving it untouched"),
            "an identifying listener must still be left untouched: {ours}"
        );
        assert!(
            !ours.contains("not this app's server"),
            "a listener that identifies as Jarvis is not a stranger: {ours}"
        );
    }

    /// DD-T1 wiring: the guard inside the real starter asks the injected
    /// identity probe before it reaches the spawn, so the decision cannot fall
    /// back to bare port occupancy.
    #[test]
    fn the_start_guard_takes_its_decision_from_the_identity_probe() {
        let asked = std::cell::Cell::new(false);
        let error = start_jarvis_server("unused-entry.ts", false, || {
            asked.set(true);
            BunPortState::ForeignListener
        })
        .expect_err("a foreign listener must stop the spawn path");

        assert!(
            asked.get(),
            "the start guard must ask the identity probe, not port occupancy"
        );
        assert!(
            error.contains("not this app's server"),
            "the guard's refusal must name the stranger: {error}"
        );
    }
}

pub(crate) fn find_bun_executable() -> String {
    // NEW: Support bundled / portable Windows execution for installers on new hardware.
    // If a "bun.exe" is present next to the current executable (or in ./resources or ./bin next to it),
    // prefer the local one (no WSL required). This + the bundled server js in resources
    // lets the NSIS installer launch a full successful app on fresh Windows installs.
    #[cfg(target_os = "windows")]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for candidate in [
                    dir.join("bun.exe"),
                    dir.join("resources").join("bun.exe"),
                    dir.join("bin").join("bun.exe"),
                ] {
                    if candidate.exists() {
                        return candidate.to_string_lossy().into_owned();
                    }
                }
            }
        }
    }

    if cfg!(target_os = "windows") {
        // Check the standard Windows-native bun installation (bun install on Windows).
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            let native_bun = std::path::PathBuf::from(profile)
                .join(".bun")
                .join("bin")
                .join("bun.exe");
            if native_bun.exists() {
                return native_bun.to_string_lossy().into_owned();
            }
        }
        // Fall back: bun lives inside WSL.  Return the WSL path; callers that
        // run it via `wsl.exe -- bash -lc` will resolve it through WSL PATH.
        // This value is consumed by `bash -lc` below. Avoid invoking `wsl.exe`
        // just to expand the distro home; the shell already knows `$HOME`.
        return "$HOME/.bun/bin/bun".to_string();
    }
    if std::path::Path::new("/usr/bin/bun").exists() {
        return "/usr/bin/bun".to_string();
    }
    let home = wsl_home();
    let user_bun = format!("{}/.bun/bin/bun", home);
    if std::path::Path::new(&user_bun).exists() {
        return user_bun;
    }
    "bun".to_string()
}

fn jarvis_server_log_stdio(file_name: &str) -> std::process::Stdio {
    let log_dir = if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("com.jarvis.desktop")
            .join("logs")
    } else {
        std::path::PathBuf::from(wsl_home())
            .join(".openclaw")
            .join("jarvis")
            .join("logs")
    };

    let _ = std::fs::create_dir_all(&log_dir);
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join(file_name))
        .map(std::process::Stdio::from)
        .unwrap_or_else(|_| std::process::Stdio::null())
}

fn should_hide_jarvis_server_console(is_windows: bool, _looks_like_local_bun: bool) -> bool {
    is_windows
}

/// The one decision on whether the Bun server runs inside WSL. `spawn_jarvis_server`
/// and the lifecycle slot must agree on it: the slot records how the server was
/// launched, so a mismatch would make the stop path hunt a guest listener that
/// was never started (DD-063).
fn bun_launches_through_wsl(is_windows: bool, bun: &str) -> bool {
    is_windows && !(bun.to_ascii_lowercase().ends_with(".exe") && !bun.contains("wsl"))
}

/// The exact shell line `wsl.exe -- bash -lc` runs to start the Bun server.
///
/// Both values are Windows paths when the app is installed on Windows (the
/// bundled server lives beside the EXE), and bash can open neither a drive
/// letter nor a backslash. Each path is therefore rewritten to its `/mnt`
/// form and single-quoted, so bash sees exactly one word per path no matter
/// how many spaces the install directory has. Values that are already shell
/// words (`$HOME/.bun/bin/bun` from `find_bun_executable`, or a bare `bun`)
/// are left alone so the guest shell can still expand them.
fn wsl_server_command(bun: &str, entry: &str) -> String {
    format!("exec {} {}", wsl_shell_word(bun), wsl_shell_word(entry))
}

fn wsl_shell_word(value: &str) -> String {
    if let Some(posix) = wsl_posix_path(value) {
        return sh_single_quote(&posix);
    }
    // A `$HOME`-relative command must stay bare to expand; anything with
    // whitespace would otherwise be split into several arguments.
    if value.chars().any(char::is_whitespace) {
        sh_single_quote(value)
    } else {
        value.to_string()
    }
}

/// `C:\Users\x\index.js` -> `/mnt/c/Users/x/index.js`. `None` for anything that
/// is not a Windows drive path, so POSIX paths and shell expressions from
/// `find_bun_executable` are never rewritten.
fn wsl_posix_path(value: &str) -> Option<String> {
    let mut chars = value.chars();
    let drive = chars.next()?;
    if !drive.is_ascii_alphabetic() || chars.next()? != ':' {
        return None;
    }
    let rest = chars.as_str();
    let rest = rest
        .strip_prefix('\\')
        .or_else(|| rest.strip_prefix('/'))?;
    Some(format!(
        "/mnt/{}/{}",
        drive.to_ascii_lowercase(),
        rest.replace('\\', "/")
    ))
}

/// Quote a value for a POSIX shell, including any embedded apostrophes.
fn sh_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// What the last Bun server launch actually ran, for timeout diagnostics.
/// Recorded before the spawn so "did not become healthy" can name the command
/// instead of leaving the operator to guess which path was attempted.
static LAST_BUN_LAUNCH: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();

fn record_bun_launch(invocation: &str) {
    let slot = LAST_BUN_LAUNCH.get_or_init(|| std::sync::Mutex::new(None));
    let mut guard = slot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some(invocation.to_string());
}

fn last_bun_launch() -> Option<String> {
    let slot = LAST_BUN_LAUNCH.get()?;
    let guard = slot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.clone()
}

fn unhealthy_jarvis_server_error(base: &str) -> String {
    match last_bun_launch() {
        Some(invocation) => format!("{base} (ran: {invocation})"),
        None => base.to_string(),
    }
}

fn spawn_jarvis_server(entry: &str) -> Result<std::process::Child, String> {
    let bun = find_bun_executable();
    let is_windows = cfg!(target_os = "windows");
    let launches_through_wsl = bun_launches_through_wsl(is_windows, &bun);
    let looks_like_local_bun = is_windows && !launches_through_wsl;

    // Owned-process authority: only this spawned child receives the private
    // capability and app instance id. Never logged, never persisted to config.
    let (cap_name, cap_value, app_name, app_value) =
        crate::jarvis::memory::transport::owned_memory_env();

    let spawn_result = if launches_through_wsl {
        // Original WSL path for dev / full WSL setups.
        let cmd = wsl_server_command(&bun, entry);
        record_bun_launch(&format!("wsl.exe -- bash -lc \"{cmd}\""));
        let mut command = std::process::Command::new("wsl.exe");
        command
            .args(["--", "bash", "-lc", &cmd])
            .env(cap_name, &cap_value)
            .env(app_name, &app_value)
            .stdout(jarvis_server_log_stdio("server-jarvis.log"))
            .stderr(jarvis_server_log_stdio("server-jarvis.err.log"));
        // WSL does not inherit the Windows environment; WSLENV lists the
        // variables to forward. The values are passed via `.env`, never
        // interpolated into the shell command.
        forward_env_to_wsl(&mut command, &[cap_name, app_name]);
        crate::wsl::hide_windows_console(&mut command);
        let spawn_started = std::time::Instant::now();
        log::info!(target: "jarvis::startup", "Bun Command::spawn starting; monotonic={:?}", spawn_started);
        let result = process_lifecycle::spawn_managed(&mut command);
        let spawn_returned = std::time::Instant::now();
        log::info!(
            target: "jarvis::startup",
            "Bun Command::spawn returned; monotonic={:?}, elapsed_ms={}",
            spawn_returned,
            spawn_returned.duration_since(spawn_started).as_millis()
        );
        result
    } else if looks_like_local_bun {
        // NEW: Native Windows execution using bundled/portable bun.exe + bundled server .js .
        // This path is taken for installers on new hardware (no WSL checkout needed).
        // The entry should be a .js (the one we added via tauri resources or placed next to exe).
        let mut command = std::process::Command::new(&bun);
        record_bun_launch(&format!("{bun} {entry}"));
        command
            .arg(entry)
            .env(cap_name, &cap_value)
            .env(app_name, &app_value)
            .stdout(jarvis_server_log_stdio("server-jarvis.log"))
            .stderr(jarvis_server_log_stdio("server-jarvis.err.log"));
        if should_hide_jarvis_server_console(is_windows, looks_like_local_bun) {
            crate::wsl::hide_windows_console(&mut command);
        }
        let spawn_started = std::time::Instant::now();
        log::info!(target: "jarvis::startup", "Bun Command::spawn starting; monotonic={:?}", spawn_started);
        let result = process_lifecycle::spawn_managed(&mut command);
        let spawn_returned = std::time::Instant::now();
        log::info!(
            target: "jarvis::startup",
            "Bun Command::spawn returned; monotonic={:?}, elapsed_ms={}",
            spawn_returned,
            spawn_returned.duration_since(spawn_started).as_millis()
        );
        result
    } else {
        let bun = find_bun_executable();
        let mut command = std::process::Command::new(&bun);
        record_bun_launch(&format!("{bun} {entry}"));
        command
            .arg(entry)
            .env("JARVIS_HOME", wsl_home())
            .env(cap_name, &cap_value)
            .env(app_name, &app_value)
            .stdout(jarvis_server_log_stdio("server-jarvis.log"))
            .stderr(jarvis_server_log_stdio("server-jarvis.err.log"));
        let spawn_started = std::time::Instant::now();
        log::info!(target: "jarvis::startup", "Bun Command::spawn starting; monotonic={:?}", spawn_started);
        let result = process_lifecycle::spawn_managed(&mut command);
        let spawn_returned = std::time::Instant::now();
        log::info!(
            target: "jarvis::startup",
            "Bun Command::spawn returned; monotonic={:?}, elapsed_ms={}",
            spawn_returned,
            spawn_returned.duration_since(spawn_started).as_millis()
        );
        result
    };
    let child = match spawn_result {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Jarvis] Bun spawn failed: {e} (bun={bun}, entry={entry})");
            return Err(format!("Bun spawn failed: {e}"));
        }
    };
    println!("[Jarvis] Bun server spawned (PID {})", child.id());
    Ok(child)
}

/// Whether the Bun server is launched inside WSL. Shares the spawn rule so the
/// port probe and the lifecycle slot can never disagree about the launch mode.
pub(crate) fn bun_uses_wsl() -> bool {
    bun_launches_through_wsl(cfg!(target_os = "windows"), &find_bun_executable())
}

/// Port-only check used by the supervisor. Native desktop launches do not
/// start `wsl.exe` just to learn that the local Bun listener is absent.
///
/// This answers "is anything bound", which is the right question for the
/// supervisor's watchdog (`supervisor.rs`, restart when the port is gone) and
/// for the doctor row (`commands/system.rs`): both report on the port, not on
/// who owns it. Anything claiming *this* server is running — the start guard
/// and the health payload's `bun_server.running` — must use
/// [`probe_bun_port_state`] instead, because a stranger on the port accepts the
/// same TCP connection (DD-T1).
pub(crate) fn bun_server_is_listening() -> bool {
    if local_port_is_listening(BUN_SERVER_PORT) {
        return true;
    }
    bun_uses_wsl() && is_wsl_port_listening(BUN_SERVER_PORT)
}

/// Who holds the Bun port, as far as this app can prove (DD-T1).
///
/// A bound port is not evidence of this server: a Vite preview, another app's
/// health route, or a stale process accepts the TCP connection (and usually
/// answers 2xx) too. Only a `/health` body that passes
/// [`jarvis_health_identifies`] counts as this Jarvis, so a first run neither
/// adopts a stranger nor refuses to start without saying who is in the way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BunPortState {
    /// Nothing is bound to the Bun port.
    Free,
    /// A listener answered `/health` with this Jarvis's identity.
    ThisApp,
    /// The port is bound, but the answer is not this app's server.
    ForeignListener,
}

/// Whether this app's Jarvis is what a client would reach on the Bun origin.
///
/// Used by the health payload so a port held by a foreign listener is reported
/// honestly as "not running" instead of as a live Bun server.
pub(crate) fn bun_server_is_serving() -> bool {
    probe_bun_port_state() == BunPortState::ThisApp
}

/// Decide the Bun port's state from occupancy *and* identity.
///
/// Occupancy is the cheap question [`bun_server_is_listening`] answers; identity
/// is one `GET {origin}/health` whose body must pass
/// [`jarvis_health_identifies`]. A free port is decided without any HTTP call,
/// so a cold first run never waits on a probe.
pub(crate) fn probe_bun_port_state() -> BunPortState {
    // The origin this app reports to clients: the cached (WSL-discovered) Bun
    // URL when one exists, otherwise the documented loopback default. Reading
    // the cache is not discovery; no `wsl.exe` is started here.
    let origin = crate::commands::system::bun_origin_from(crate::wsl::get_cached_bun_url());
    bun_port_state_from(bun_server_is_listening(), || bun_health_identifies(&origin))
}

/// Pure form of [`probe_bun_port_state`]: `health_identifies` is consulted only
/// when something actually holds the port.
fn bun_port_state_from(
    port_has_listener: bool,
    health_identifies: impl FnOnce() -> bool,
) -> BunPortState {
    if !port_has_listener {
        return BunPortState::Free;
    }
    if health_identifies() {
        BunPortState::ThisApp
    } else {
        BunPortState::ForeignListener
    }
}

/// One identifying `GET {origin}/health`.
///
/// A 2xx is not enough — the body must pass [`jarvis_health_identifies`] — and
/// the whole request is bounded by a short timeout so a listener that accepts
/// the connection and never answers cannot stall the start guard or the health
/// snapshot. Synchronous on purpose: both callers already run on blocking
/// threads (`spawn_blocking`), off the async IPC workers.
fn bun_health_identifies(origin: &str) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    let Ok(response) = client
        .get(format!("{}/health", origin.trim_end_matches('/')))
        .send()
    else {
        return false;
    };
    response.status().is_success()
        && response
            .text()
            .is_ok_and(|body| jarvis_health_identifies(&body))
}

/// The start guard's decision, taken from the identity probe rather than from
/// port occupancy alone.
///
/// A held port is never adopted and its listener is never killed. The wording
/// names what was found, so a first run that lands behind a stranger says that
/// instead of claiming the port belongs to this app.
fn bun_start_guard(state: BunPortState) -> Result<(), String> {
    match state {
        BunPortState::Free => Ok(()),
        BunPortState::ForeignListener => Err(format!(
            "Bun port {BUN_SERVER_PORT} is occupied by a listener that is not this app's server; leaving it untouched"
        )),
        // Bound by a Jarvis build, but this process owns no such child: replacing
        // it would mean killing something this app cannot stop cleanly.
        BunPortState::ThisApp => Err(format!(
            "Bun port {BUN_SERVER_PORT} is occupied by a listener this app does not own; leaving it untouched"
        )),
    }
}

/// What the ensure path does about the Bun child this app already owns (DD-073).
///
/// The tracked `Child` handle is the only proof of ownership. A child that is
/// still live has not exited, so it is a server that has not finished binding
/// inside the start budget this call grants it — not somebody else's listener.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OwnedBunChildStart {
    /// This app owns a live Bun child: leave it alone and keep waiting.
    StillStarting,
    /// No live Bun child of this app's: start one exactly as before.
    Spawn,
}

/// DD-073: liveness of the tracked Bun child decides whether ensure may spawn.
///
/// `live` comes from [`process_lifecycle::is_live`] — the same rule the
/// supervisor and the Ollama arm use — so this adds no second liveness test.
/// Replacing a live child would kill a startup already in flight and charge a
/// give-up failure to work the app is still waiting on.
fn owned_bun_child_start(live: bool) -> OwnedBunChildStart {
    if live {
        OwnedBunChildStart::StillStarting
    } else {
        OwnedBunChildStart::Spawn
    }
}

/// `port_state` is the identity probe, injected so the guard's decision can be
/// tested without a real listener or a spawned child. It runs after any tracked
/// child has been reaped and before the spawn, and only its answer — not bare
/// port occupancy — decides whether this app starts its own server.
fn start_jarvis_server(
    entry: &str,
    replace: bool,
    port_state: impl Fn() -> BunPortState,
) -> Result<process_lifecycle::StartOutcome, String> {
    let entry = entry.to_string();
    // Record how this spawn will launch the server: the tracked `Child` is only
    // the `wsl.exe` wrapper in a WSL setup, so the stop path needs the guest port
    // to reach the server that actually holds the listener (DD-063).
    let bun = find_bun_executable();
    let slot_launch = if bun_launches_through_wsl(cfg!(target_os = "windows"), &bun) {
        process_lifecycle::SlotLaunch::Wsl {
            port: BUN_SERVER_PORT,
        }
    } else {
        process_lifecycle::SlotLaunch::Direct
    };
    process_lifecycle::launch_with(
        process_lifecycle::ManagedProcess::BunServer,
        replace,
        slot_launch,
        || {
            bun_start_guard(port_state())?;
            spawn_jarvis_server(&entry)
        },
    )
}

/// Force-restart the Bun server. Bypasses the HEALTHY_TTL fast-path in
/// `ensure_jarvis_server_started` (the symptom of "clicked restart, nothing
/// happened" when the server is actually down) and clears the supervisor's
/// consecutive-failure counter so the auto-restart loop stays healthy after
/// a user-driven restart. Returns a specific error string on failure so the
/// UI can show why (missing server bundle, spawn error, health timeout).
pub async fn force_restart_jarvis_server() -> Result<(), String> {
    let _start_guard = BUN_ENSURE_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;

    // 1. Re-arm the supervisor so a subsequent auto-restart is allowed even
    //    if previous ticks drove the counter to the give-up cap.
    crate::supervisor::reset_failures(crate::supervisor::SupervisedService::Bun);

    // 2. Locate the server entry (the cheap part; surfaces a real error if
    //    the bundle is genuinely missing on this machine).
    let server_entry = find_jarvis_server().ok_or_else(|| {
        "server bundle not found (no index.js / index.ts beside the app or in the repo)".to_string()
    })?;

    // 3. Replace only the child owned by this app. A listener on :19877 that
    //    does not identify as this app's server is reported and left untouched.
    let spawn_result = spawn_blocking_on_current_runtime(move || {
        start_jarvis_server(&server_entry, true, probe_bun_port_state)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    spawn_result?;

    // 4. Probe the freshly spawned server (up to ~20s).
    let start = std::time::Instant::now();
    while start.elapsed() < std::time::Duration::from_secs(20) {
        if probe_jarvis_healthy().await {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    let ghosts = ghost_pids_holding_port(BUN_SERVER_PORT);
    if !ghosts.is_empty() {
        let diagnostic = bun_port_ghost_diagnostic(BUN_SERVER_PORT, &ghosts);
        log::error!(target: "jarvis::startup", "{diagnostic}");
        return Err(diagnostic);
    }
    Err(unhealthy_jarvis_server_error(
        "Bun server did not become healthy within 20s of restart",
    ))
}

/// Why a startup attempt failed. `TimedOut` is kept distinct so the caller can
/// attach host-specific diagnostics (Windows ghost sockets) without the driver
/// knowing about ports or processes.
#[derive(Debug, PartialEq, Eq)]
enum StartupFailure {
    Spawn(String),
    TimedOut,
}

/// What one driven start attempt proved (DD-079).
///
/// The driver can only prove the positive states; a spawn error or a spent
/// budget is its `Err` arm. [`BunServerStart`] widens that into the three
/// states the ensure path reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BunStartAttempt {
    /// `/health` answered as this app's Jarvis.
    Healthy,
    /// The tracked child is alive and never answered `/health` inside the budget.
    StillStarting,
}

/// The three states one ensure attempt can end in (DD-079).
///
/// "Alive" and "healthy" are different facts. DD-073 made the still-starting
/// arm a success so the app would stop killing a child that is still binding;
/// the supervisor then read every `Ok` as healthy and cleared its failure
/// count for a server that had never answered. Keeping the states apart lets
/// the supervisor count a child that never becomes healthy while the ensure
/// path keeps DD-073's behaviour of leaving that child running.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BunServerStart {
    /// `/health` answered as this app's Jarvis.
    Healthy,
    /// The child this app owns is still live but never answered `/health`.
    StillStarting,
    /// The attempt failed; the string is the operator-facing reason.
    Failed(String),
}

impl BunServerStart {
    /// The reason a failed attempt could not reach either live state.
    pub(crate) fn failure(&self) -> Option<&str> {
        match self {
            Self::Failed(error) => Some(error.as_str()),
            Self::Healthy | Self::StillStarting => None,
        }
    }
}

/// The owned-child startup sequence with every out-of-process effect injected.
///
/// Ordering is the point: when the native listener is closed and no configured
/// endpoint can live outside it, an HTTP probe cannot succeed, so the owned
/// child is spawned before any probe budget is spent. An open listener, a
/// configured remote/WSL endpoint, or a WSL-launched Bun keeps the probe-first
/// path and the open-listener second chance. The child is always verified
/// healthy afterwards; spawning alone is not success.
///
/// `spawn_owned_child` reports whether it spawned a child or left a live one
/// where it was (DD-073). A child left in place is still waited on for the same
/// health budget; reaching the end of that budget while it has not exited is
/// [`BunStartAttempt::StillStarting`], not success and not a failed start
/// (DD-079).
async fn drive_jarvis_server_start<P, PF, D, DF, L, S, SF, E, M>(
    remote_endpoint_requires_probe: bool,
    probe_healthy: P,
    delay: D,
    listener_present: L,
    spawn_owned_child: S,
    elapsed_since_spawn: E,
    mark_healthy: M,
) -> Result<BunStartAttempt, StartupFailure>
where
    P: Fn() -> PF,
    PF: std::future::Future<Output = bool>,
    D: Fn(u64) -> DF,
    DF: std::future::Future<Output = ()>,
    L: Fn() -> bool,
    S: Fn() -> SF,
    SF: std::future::Future<Output = Result<OwnedBunChildStart, String>>,
    E: Fn() -> u64,
    M: Fn(),
{
    const SPAWN_HEALTH_BUDGET_MS: u64 = 20_000;

    // Remote/WSL endpoints keep their probe-first order: a closed native
    // listener says nothing about them, and a reachable remote endpoint must
    // not even pay a native/WSL listener probe.
    if remote_endpoint_requires_probe && probe_healthy().await {
        mark_healthy();
        return Ok(BunStartAttempt::Healthy);
    }

    let listener_open = listener_present();
    if !remote_endpoint_requires_probe && listener_open && probe_healthy().await {
        mark_healthy();
        return Ok(BunStartAttempt::Healthy);
    }

    if listener_open {
        // Second chance: TCP is up but the first HTTP probe failed. A single
        // overloaded event-loop tick can miss a 2s budget; killing a live server
        // mid-turn is far worse than waiting one more second.
        log::info!(
            target: "jarvis::startup",
            "Bun port :{BUN_SERVER_PORT} is open but /health missed the first probe; retrying once"
        );
        delay(750).await;
        if probe_healthy().await {
            mark_healthy();
            return Ok(BunStartAttempt::Healthy);
        }
        log::warn!(
            target: "jarvis::startup",
            "Bun port open but /health still failing — handing the port over to the owned-child start"
        );
    } else if !remote_endpoint_requires_probe {
        // Closed native listener and nothing to reach outside it: the probe is
        // a guaranteed miss, so go straight to the owned-child start.
        log::info!(
            target: "jarvis::startup",
            "Bun port :{BUN_SERVER_PORT} is closed with no remote/WSL endpoint configured; \
             spawning the owned child without a pre-spawn HTTP probe"
        );
    }

    // Replace the tracked child once. Port listeners without an owned Child
    // handle are never terminated by startup recovery. The effect reports
    // whether it spawned; DD-073 leaves a live owned child in place instead.
    let owned_start = spawn_owned_child().await.map_err(StartupFailure::Spawn)?;
    match owned_start {
        OwnedBunChildStart::Spawn => {
            log::info!(target: "jarvis::startup", "Bun child spawn returned")
        }
        OwnedBunChildStart::StillStarting => log::info!(
            target: "jarvis::startup",
            "Bun child this app owns is still starting; waiting for it instead of replacing it"
        ),
    }

    // Wait (off the main thread) for the freshly spawned server to come up.
    while elapsed_since_spawn() < SPAWN_HEALTH_BUDGET_MS {
        if probe_healthy().await {
            mark_healthy();
            return Ok(BunStartAttempt::Healthy);
        }
        delay(500).await;
    }
    if owned_start == OwnedBunChildStart::StillStarting {
        // DD-073: the child this app spawned has not exited, so this is a wait
        // that outlasted one health budget, not a failed start. Leave the child
        // running, so the next ensure waits on it again instead of replacing it.
        // DD-079: say "still starting", not "healthy" — the supervisor counts
        // this attempt instead of clearing its failure budget for it.
        log::warn!(
            target: "jarvis::startup",
            "Bun child this app owns has not answered /health within one health budget; \
             leaving it running"
        );
        return Ok(BunStartAttempt::StillStarting);
    }
    Err(StartupFailure::TimedOut)
}

/// Ensure this app's Bun server is running. Its own live child is never
/// replaced: the spawn is only reached when the tracked child has exited or no
/// child was ever tracked (DD-073).
///
/// Both live states map to `Ok` for callers that only gate on "the child this
/// app owns is in place" (boot, session commands, recovery). The supervisor
/// uses [`ensure_jarvis_server_started_outcome`] instead, because a server
/// that is alive but never answers must not clear its failure budget (DD-079).
pub async fn ensure_jarvis_server_started() -> Result<(), String> {
    match ensure_jarvis_server_started_outcome().await {
        BunServerStart::Healthy | BunServerStart::StillStarting => Ok(()),
        BunServerStart::Failed(error) => Err(error),
    }
}

/// The same attempt with "healthy" and "alive but never healthy" kept apart
/// (DD-079).
pub(crate) async fn ensure_jarvis_server_started_outcome() -> BunServerStart {
    use std::sync::atomic::{AtomicI64, Ordering};
    // Last time the server was confirmed healthy (epoch ms). A short TTL lets the
    // many callers (boot + every frontend status poll) skip all probing/spawning.
    static LAST_HEALTHY_MS: AtomicI64 = AtomicI64::new(0);
    const HEALTHY_TTL_MS: i64 = 10_000;

    let fresh = || {
        chrono::Utc::now().timestamp_millis() - LAST_HEALTHY_MS.load(Ordering::Relaxed)
            < HEALTHY_TTL_MS
    };

    // Fast path: confirmed healthy very recently — no probing, no spawning.
    if fresh() {
        return BunServerStart::Healthy;
    }

    // Only one probe/spawn sequence at a time; queued callers fall through to the
    // re-check below and return immediately once the first call succeeds.
    let lock = BUN_ENSURE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;
    if fresh() {
        return BunServerStart::Healthy;
    }

    // A closed native listener only proves the server absent when every
    // candidate endpoint is that listener. A configured remote endpoint, a
    // cached WSL URL, or a WSL-launched Bun is still probed first.
    let remote_endpoint_requires_probe = bun_startup_policy::pre_spawn_probe_required(
        bun_uses_wsl(),
        &crate::wsl::local_jarvis_api_candidates(),
        BUN_SERVER_PORT,
    );

    let spawned_at = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
    let spawn_clock = Arc::clone(&spawned_at);

    match drive_jarvis_server_start(
        remote_endpoint_requires_probe,
        probe_jarvis_healthy,
        |millis: u64| tokio::time::sleep(std::time::Duration::from_millis(millis)),
        // Occupancy only: the driver decides *ordering* — spawn before probing
        // when nothing is bound. Ownership is the start guard's question, and
        // the guard asks `probe_bun_port_state` inside the spawn (DD-T1); the
        // child this app already owns is checked first (DD-073).
        bun_server_is_listening,
        move || {
            let spawn_clock = Arc::clone(&spawn_clock);
            async move {
                // DD-073: a Bun child this app spawned and still owns is a
                // server that has not finished binding, not somebody else's
                // listener. Consult the same liveness rule the supervisor and
                // the Ollama arm use, before the spawn: `replace = true` below
                // would reap that child and kill the start already in flight.
                if owned_bun_child_start(process_lifecycle::is_live(
                    process_lifecycle::ManagedProcess::BunServer,
                )) == OwnedBunChildStart::StillStarting
                {
                    log::info!(
                        target: "jarvis::startup",
                        "Bun child this app owns has not exited; leaving it alone and waiting for it"
                    );
                    return Ok(OwnedBunChildStart::StillStarting);
                }
                let server_entry = find_jarvis_server()
                    .ok_or_else(|| "server-jarvis index.ts not found".to_string())?;
                log::info!(target: "jarvis::startup", "Bun server entry resolved: {server_entry}");
                spawn_blocking_on_current_runtime(move || {
                    start_jarvis_server(&server_entry, true, probe_bun_port_state)
                })
                .await
                .map_err(|e| format!("Task join error: {}", e))??;
                *spawn_clock
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = std::time::Instant::now();
                Ok::<OwnedBunChildStart, String>(OwnedBunChildStart::Spawn)
            }
        },
        move || {
            spawned_at
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .elapsed()
                .as_millis() as u64
        },
        || {
            LAST_HEALTHY_MS.store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
        },
    )
    .await
    {
        Ok(BunStartAttempt::Healthy) => BunServerStart::Healthy,
        Ok(BunStartAttempt::StillStarting) => BunServerStart::StillStarting,
        Err(StartupFailure::Spawn(error)) => BunServerStart::Failed(error),
        Err(StartupFailure::TimedOut) => {
            // Surface the ghost-socket case explicitly — a generic timeout leaves the
            // operator hunting EADDRINUSE in err logs with no recovery path.
            let ghosts = ghost_pids_holding_port(BUN_SERVER_PORT);
            if !ghosts.is_empty() {
                let diagnostic = bun_port_ghost_diagnostic(BUN_SERVER_PORT, &ghosts);
                log::error!(target: "jarvis::startup", "{diagnostic}");
                return BunServerStart::Failed(diagnostic);
            }
            BunServerStart::Failed(unhealthy_jarvis_server_error(
                "Bun server did not become healthy within timeout",
            ))
        }
    }
}

/// Generic listener probe, used where the caller cannot know how the backend is
/// launched (status/health surfaces, where a WSL-hosted backend is still a real
/// possibility). Boot paths that own a specific backend must use
/// `backend_port_is_listening` instead, so a native Windows backend does not
/// pay a `wsl.exe` spawn to learn that its port is closed (DD-049).
pub fn is_port_listening(port: u16) -> bool {
    if local_port_is_listening(port) {
        return true;
    }
    is_wsl_port_listening(port)
}

fn local_port_is_listening(port: u16) -> bool {
    if let Ok(addrs) = std::net::ToSocketAddrs::to_socket_addrs(&format!("127.0.0.1:{}", port)) {
        for addr in addrs {
            if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(200))
                .is_ok()
            {
                return true;
            }
        }
    }
    false
}

fn is_wsl_port_listening(port: u16) -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }

    let script = format!(
        "import socket,sys;s=socket.socket();s.settimeout(0.5);sys.exit(0 if s.connect_ex(('127.0.0.1',{}))==0 else 1)",
        port
    );
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["--", "python3", "-c", &script]);
    crate::wsl::command_output_timeout(cmd, std::time::Duration::from_secs(2))
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// The `bun_uses_wsl` rule generalised to any local backend command: only a
/// Windows build whose resolved command is *not* a native `.exe` launches that
/// backend through `wsl.exe`, and only such a backend can be listening inside
/// WSL. `None`/blank means nothing would be launched through WSL at all, so the
/// probe is never warranted (DD-049).
pub(crate) fn command_uses_wsl(command: Option<&str>) -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }
    match command.map(str::trim) {
        Some(value) if !value.is_empty() => !value.to_ascii_lowercase().ends_with(".exe"),
        _ => false,
    }
}

/// `spawn_ollama` runs the resolved Ollama binary directly. Reuse the launch-mode
/// rule on that command so the WSL probe is kept for a WSL-side binary and
/// dropped for a native one (or when Ollama is not installed at all).
pub(crate) fn ollama_uses_wsl() -> bool {
    command_uses_wsl(find_ollama_binary().as_deref())
}

/// Port-only liveness check for a backend whose launch mode is known.
/// A closed local port on a backend this process would launch natively reads as
/// closed without spawning `wsl.exe`; a WSL-launched backend may still probe.
pub(crate) fn backend_port_is_listening(port: u16, uses_wsl: bool) -> bool {
    backend_port_is_listening_with(
        port,
        uses_wsl,
        local_port_is_listening,
        is_wsl_port_listening,
    )
}

/// Pure decision seam: the WSL probe is reachable only when the backend is
/// launched through `wsl.exe`, so the native path can never build one.
fn backend_port_is_listening_with(
    port: u16,
    uses_wsl: bool,
    probe_local: impl FnOnce(u16) -> bool,
    probe_wsl: impl FnOnce(u16) -> bool,
) -> bool {
    if probe_local(port) {
        return true;
    }
    uses_wsl && probe_wsl(port)
}

/// The current user's home directory, derived from this machine's environment.
///
/// A missing variable is never filled in with a hardcoded user path: an empty
/// result means the home could not be derived, so nothing writes to a directory
/// that only exists on the developer's PC.
pub fn get_home_dir() -> String {
    crate::wsl::home_dir_from_env(|name| std::env::var(name).ok()).unwrap_or_default()
}

/// Default workspace path for a fresh install.
///
/// The native home is used for a native install: resolving a filesystem default
/// must never spawn `wsl.exe`, which on a cold distro can take seconds and sits
/// directly on the pre-Bun startup path (DD-023, DS-06). A WSL-launched Bun
/// still reads a guest path, so only that launch mode resolves the WSL home.
pub(crate) fn default_jarvis_workspace_path() -> String {
    let home = if cfg!(target_os = "windows") && bun_uses_wsl() {
        crate::wsl::wsl_home()
    } else {
        get_home_dir()
    };
    default_jarvis_workspace_path_from(&home)
}

/// Pure form of [`default_jarvis_workspace_path`] so the shape is testable
/// without reading the environment or probing any process.
pub(crate) fn default_jarvis_workspace_path_from(home: &str) -> String {
    std::path::Path::new(home)
        .join(".openclaw")
        .join("agents")
        .join("coderclaw")
        .join("workspace")
        .join("Jarvis")
        .to_string_lossy()
        .into_owned()
}

fn spawn_background_thread<F>(name: &str, task: F) -> std::io::Result<std::thread::JoinHandle<()>>
where
    F: FnOnce() + Send + 'static,
{
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(task)
}

/// Run synchronous boot/process work on the runtime that owns the caller.
/// Boot now lives on a dedicated current-thread runtime, so routing this
/// through Tauri's global runtime can leave the bootstrap task waiting on a
/// different executor and prevent the Bun spawn from completing.
async fn spawn_blocking_on_current_runtime<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| format!("blocking boot task join error: {error}"))
}

/// Start the active backend's own local dependency.
///
/// Only the configured backend's service is started: an OpenRouter or Claude CLI
/// session must not spawn a local model server it will never use.
async fn start_backend_dependency(cfg: &crate::jarvis::types::JarvisConfig) {
    match &cfg.active_backend {
        crate::jarvis::types::JarvisBackend::Ollama => {
            crate::start_ollama_and_warm(cfg.ollama.model.clone()).await;
        }
        crate::jarvis::types::JarvisBackend::LlamaCpp => {
            if let Err(error) = crate::start_llama_cpp_server(cfg.llama_cpp.clone()).await {
                eprintln!("[Daedalus] llama.cpp server startup failed: {error}");
            }
        }
        crate::jarvis::types::JarvisBackend::OpenRouter => {
            if cfg.openrouter.api_key.trim().is_empty() {
                eprintln!(
                    "[Jarvis] OpenRouter is the active backend but no API key is set \
                     — chats will fail until a key is configured in Control."
                );
            }
            println!("[Jarvis] OpenRouter backend — skipping local Ollama startup.");
        }
        crate::jarvis::types::JarvisBackend::ClaudeCli => {
            println!("[Jarvis] Claude CLI backend — skipping local Ollama startup.");
        }
    }
}

/// Boot the Bun server and the backend dependency in the order the desktop
/// needs them (DS-01).
///
/// Bun is the UI's only data source and is required by every backend, while no
/// Bun path needs the inference backend. `join!` with `biased;` polls the Bun
/// future first, so its first poll reaches the owned-child startup path
/// (`ensure_jarvis_server_started` → resolve entry → `spawn_blocking`) before
/// the backend dependency is polled at all; the two then converge
/// concurrently. Polling first *initiates* startup, it does not prove the child
/// exists yet: `spawn_blocking` hands the real spawn to a blocking thread and
/// returns `Pending` before that thread has necessarily spawned anything, and
/// the readiness gate still has to observe `/health`. The point is that the
/// backend's own local startup can no longer queue in front of that
/// initiation. A failed Bun start is reported back to the caller; the backend
/// dependency is best-effort and never fails boot.
async fn start_bun_and_backend<U, B>(start_bun: U, start_backend: B) -> Result<(), String>
where
    U: std::future::Future<Output = Result<(), String>>,
    B: std::future::Future<Output = ()>,
{
    // `biased;` makes the polling order deterministic and Bun-first; unbiased
    // `join!` rotates which branch is polled first on every wake.
    let (bun_result, ()) = tokio::join!(biased; start_bun, start_backend);
    bun_result
}

async fn bootstrap_services(handle: tauri::AppHandle) {
    log::info!(target: "jarvis::startup", "bootstrap thread entered");
    // Hydrate the in-memory config from SQLite — the single source of truth
    // for JarvisConfig. This runs on the dedicated startup runtime because
    // migration and SQLite access are synchronous.
    let db_state = handle.state::<crate::db::AppDb>();
    match crate::commands::migrate_file_config_into_sqlite_if_needed(&db_state) {
        Ok(true) => {
            println!("[Jarvis] Imported legacy file config into SQLite (one-time migration).")
        }
        Ok(false) => {}
        Err(e) => eprintln!("[Jarvis] config migration check failed: {e}"),
    }
    log::info!(target: "jarvis::startup", "bootstrap config migration complete");
    // Phase 2.2 recovery: a native restart leaves no Bun registry, so pending
    // preparations are stale and started-but-unsynced turns are unterminated.
    // Never re-registers an old turn; explicit retries get new turn ids.
    match crate::jarvis::memory::transport::recover_pending_memory_turns(
        &db_state,
        chrono::Utc::now(),
    ) {
        Ok(count) if count > 0 => {
            log::info!(target: "jarvis::startup", "memory turn recovery updated {count} stale turn(s)");
        }
        Ok(_) => {}
        Err(e) => log::warn!(target: "jarvis::startup", "memory turn recovery failed: {e:?}"),
    }
    // Phase 3.3 recovery: capture recorded explicit user directives on any
    // persisted turn that never received a capture receipt, through the same
    // derived gate as the live paths. Idempotent and best-effort; a Bun that is
    // not yet live leaves derived cleanup in the durable outbox.
    match crate::commands::memory_capture::recover_recorded_memory_captures(
        &db_state,
        crate::jarvis::memory::transport::native_memory_transport(),
        chrono::Utc::now(),
    ) {
        Ok(count) if count > 0 => {
            log::info!(target: "jarvis::startup", "memory capture recovery committed {count} turn(s)");
        }
        Ok(_) => {}
        Err(e) => log::warn!(target: "jarvis::startup", "memory capture recovery failed: {e:?}"),
    }
    let cfg = crate::commands::load_jarvis_config(&db_state).unwrap_or_default();
    log::info!(target: "jarvis::startup", "bootstrap config load complete");
    {
        let state = handle.state::<crate::jarvis::types::JarvisState>();
        *state.config.lock().await = cfg.clone();
    }
    let backend = cfg.active_backend.clone();
    println!("[Jarvis] Boot backend = {}", backend);

    // Backend-specific local dependency, started together with Bun below: only
    // the active backend's service is brought up.
    let backend_dependency = start_backend_dependency(&cfg);

    // DS-01: Bun is required by every backend and is the UI's only data source,
    // so its cold startup must not queue behind the backend's local dependency.
    // Bun is polled first and the two converge concurrently; a cold/misconfigured
    // WSL install must still not prevent the desktop's core HTTP runtime from
    // starting, and the Claude-proxy discovery below still waits for Bun to be
    // settled.
    match start_bun_and_backend(crate::ensure_jarvis_server_started(), backend_dependency).await {
        Ok(()) => log::info!(target: "jarvis::startup", "Bun server healthy at boot"),
        Err(e) => {
            log::error!(target: "jarvis::startup", "Bun server startup failed at boot: {e}")
        }
    }

    // Proxy auth requires the compatibility listener. Subscription auth uses
    // the stock Claude CLI directly and must never require or spawn port 19878.
    if crate::claude_proxy_enabled(&cfg) {
        let proxy_model = cfg.ollama.model.clone();
        let openrouter_api_key = cfg.openrouter.api_key.clone();
        let proxy_result = spawn_blocking_on_current_runtime(move || {
            crate::start_claude_cli_proxy(proxy_model, openrouter_api_key)
        })
        .await;
        match proxy_result {
            Ok(Ok(process_lifecycle::StartOutcome::Started(pid))) => {
                println!("[Jarvis] Claude CLI proxy registered at startup (PID {pid})")
            }
            Ok(Ok(process_lifecycle::StartOutcome::AlreadyRunning(pid))) => {
                println!("[Jarvis] Claude CLI proxy already managed (PID {pid})")
            }
            Ok(Ok(process_lifecycle::StartOutcome::AlreadyListening)) => println!(
                "[Jarvis] Claude CLI proxy port already has a listener; leaving it in place"
            ),
            Ok(Err(error)) => eprintln!("[Jarvis] Claude CLI proxy not started: {error}"),
            Err(error) => eprintln!("[Jarvis] Claude CLI proxy start task failed: {error}"),
        }
    } else {
        println!(
            "[Jarvis] Claude CLI proxy not required (enabled={}, auth_mode={:?})",
            cfg.claude_cli.enabled, cfg.claude_cli.auth_mode
        );
    }

    // Keep the three boot children alive (Ollama/proxy/Bun): detect a dead
    // required service and relaunch it under the bounded supervisor policy.
    crate::supervisor::spawn_supervisor(handle.clone());

    // The scheduler loop owns this dedicated runtime after boot completes.
    crate::cron_scheduler::start_cron_scheduler(handle).await;
}

fn spawn_bootstrap_services(handle: tauri::AppHandle) -> std::io::Result<()> {
    spawn_background_thread("jarvis-bootstrap", move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(e) => {
                log::error!(target: "jarvis::startup", "failed to build startup runtime: {e}");
                return;
            }
        };
        runtime.block_on(bootstrap_services(handle));
    })
    .map(|_| ())
}

/// The one diagnostic for a first-run boot that cannot establish `jarvis.db`.
///
/// The boot log line and the native error dialog both print exactly this text,
/// so a user whose app-data directory cannot hold `jarvis.db` learns where the
/// database was meant to live and why the open failed, instead of the process
/// simply disappearing.
pub(crate) fn db_open_failure_diagnostic(db_path: &std::path::Path, error: &str) -> String {
    format!(
        "Jarvis could not open its database at {}: {error}. The app cannot start without that database and is closing now.",
        db_path.display()
    )
}

/// `MessageBoxW` from `user32`, called with no owner window.
#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(
        hwnd: *mut core::ffi::c_void,
        text: *const u16,
        caption: *const u16,
        box_type: u32,
    ) -> i32;
}

/// Show the fail-closed boot diagnostic in a native error dialog.
///
/// The Tauri builder — and with it the app window and the log plugin — has not
/// been constructed at this point, and `tauri-plugin-dialog` is not a dependency
/// of this crate, so on Windows this calls `MessageBoxW` directly. The line is
/// written to the app log separately, so the dialog is the user-visible half.
#[cfg(target_os = "windows")]
fn show_boot_failure_dialog(diagnostic: &str) {
    const MB_OK: u32 = 0x0000_0000;
    const MB_ICONERROR: u32 = 0x0000_0010;
    const MB_SETFOREGROUND: u32 = 0x0001_0000;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let text = wide(diagnostic);
    let caption = wide("Jarvis cannot start");
    // SAFETY: both buffers are NUL-terminated UTF-16 owned by this frame and
    // outlive the call, and a message box needs no owner window handle.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
        );
    }
}

/// No windowing system is guaranteed before the Tauri app exists on this
/// platform, so the diagnostic stays in the boot log and on stderr.
#[cfg(not(target_os = "windows"))]
fn show_boot_failure_dialog(_diagnostic: &str) {}

/// The run-loop events that require owned-child teardown (DD-082).
///
/// `ExitRequested` is the normal clean-quit event. `Exit` is the last chance:
/// it also fires for exits that never raised `ExitRequested`, and it is what
/// makes teardown run on that path instead of only on a window close.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TeardownEvent {
    ExitRequested,
    Exit,
    Other,
}

impl TeardownEvent {
    fn tears_down(self) -> bool {
        matches!(self, Self::ExitRequested | Self::Exit)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let jarvis_config = Arc::new(Mutex::new(crate::jarvis::types::JarvisConfig::default()));
    let jarvis_queue = Arc::new(crate::jarvis::queue::MessageQueue::new(
        jarvis_config.clone(),
    ));

    let jarvis_state = JarvisState {
        config: jarvis_config.clone(),
        queue: jarvis_queue,
        http_client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .pool_max_idle_per_host(10)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new()),
    };

    let home = crate::get_home_dir();
    let app_data_dir = std::path::PathBuf::from(&home).join(".local/share/com.jarvis.desktop");

    // Both initialization paths go through `AppDb::new`, which retains the
    // app-data root handle and binds the opened `jarvis.db` to that same
    // directory inode before publishing AppDb. A failure to establish the
    // binding fails closed here rather than serving a path-only database.
    let db = match crate::db::AppDb::new(&app_data_dir) {
        Ok(db) => {
            let _ = crate::commands::skills::seed_skills(&db);
            db
        }
        Err(e) => {
            let db_path = app_data_dir.join("jarvis.db");
            let diagnostic = db_open_failure_diagnostic(&db_path, &e);
            eprintln!("[Jarvis] {diagnostic}");

            // The log plugin is registered below, so it is not up yet: append to
            // the file it will own instead of registering a second logger. The
            // log plugin's directory is app-data/logs on Unix and
            // %LOCALAPPDATA%\com.jarvis.desktop\logs on Windows. A failed log
            // write must not hide the dialog.
            let log_dir = if cfg!(target_os = "windows") {
                std::env::var_os("LOCALAPPDATA")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(std::env::temp_dir)
                    .join("com.jarvis.desktop")
                    .join("logs")
            } else {
                app_data_dir.join("logs")
            };
            let _ = std::fs::create_dir_all(&log_dir);
            if let Ok(mut log) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_dir.join("Jarvis.log"))
            {
                use std::io::Write as _;
                let _ = writeln!(
                    log,
                    "[{}] [jarvis::startup] {diagnostic}",
                    chrono::Utc::now().to_rfc3339()
                );
            }

            show_boot_failure_dialog(&diagnostic);

            // Fail closed: never continue boot with a path-only database.
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .manage(jarvis_state)
        .manage(db)
        .manage(build_hermes_app_state())
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(e) = spawn_bootstrap_services(handle) {
                log::error!(target: "jarvis::startup", "failed to dispatch startup thread: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            jarvis_send_message,
            jarvis_test_orchestration_route,
            jarvis_cancel_orchestration_route_test,
            cancel_chat_stream,
            jarvis_new_session,
            jarvis_list_sessions,
            jarvis_delete_session,
            jarvis_tool_decision,
            jarvis_get_config,
            jarvis_save_config,
            jarvis_check_status,
            jarvis_get_skills,
            jarvis_get_tools,
            jarvis_invoke_skill,
            jarvis_ping,
            jarvis_discover_models,
            jarvis_test_connection,
            jarvis_switch_backend,
            jarvis_get_companion,
            jarvis_save_companion,
            jarvis_start_bridge,
            jarvis_stop_bridge,
            jarvis_restart_server,
            jarvis_restart_ollama,
            jarvis_restart_proxy,
            list_mcp_servers,
            save_mcp_servers,
            jarvis_get_session_grants,
            jarvis_revoke_session_grant,
            get_build_info,
            get_all_settings,
            get_setting,
            set_setting,
            get_jarvis_config,
            get_backend_readiness,
            save_jarvis_config,
            list_model_profiles,
            get_active_profile,
            set_active_profile,
            create_profile,
            delete_profile,
            discover_models_ollama,
            discover_models_openrouter,
            import_model,
            list_sessions,
            create_session,
            delete_session,
            get_session_history,
            get_session_runs,
            get_all_session_runs,
            get_learning_source_choices,
            record_terminal_run,
            record_goal_terminal_run,
            export_session,
            compact_session_db,
            update_token_count,
            append_message,
            memory_list,
            memory_read,
            memory_save,
            memory_update,
            memory_delete,
            memory_search,
            memory_restore,
            memory_recall_preview,
            memory_events_list,
            memory_runs_list,
            memory_run_now,
            memory_bind_session_workspace,
            memory_scoped_save,
            memory_scoped_read,
            memory_scoped_list,
            memory_scoped_update,
            memory_scoped_delete,
            memory_scoped_restore,
            memory_scoped_recall_preview,
            memory_injectability,
            memory_scoped_classify,
            memory_adopt_legacy,
            memory_prepare_turn,
            memory_turn_history,
            memory_sync_turn,
            memory_turn_diagnostic,
            memory_capture_turn,
            memory_capture_receipts,
            memory_continuity_read,
            memory_continuity_set,
            memory_scoped_correct,
            memory_scoped_forget,
            memory_stage_proposal,
            goal_create,
            goal_list,
            goal_get,
            goal_update,
            goal_transition,
            goal_links_list,
            goal_link_add,
            goal_link_remove,
            goal_prepare_run,
            goal_run_progress,
            project_steward_workspace_snapshot,
            list_memory_files,
            read_memory_file,
            list_workspace_files,
            read_workspace_file,
            list_recent_memories,
            jarvis_review_session,
            jarvis_commit_session_end,
            jarvis_get_tier_stats,
            jarvis_list_memories_by_tier,
            jarvis_recall_cold_memory,
            run_learning_session,
            get_learning_research_receipt,
            list_skills,
            get_skill,
            enable_skill,
            disable_skill,
            invoke_skill,
            skill_revisions_list,
            skill_restore_revision,
            sync_distilled_skill_candidates,
            bun_server_origin,
            list_channels,
            add_channel,
            remove_channel,
            login_channel,
            logout_channel,
            list_cron_jobs,
            add_cron_job,
            edit_cron_job,
            enable_cron_job,
            disable_cron_job,
            cancel_cron_job,
            delete_cron_job,
            run_cron_job,
            get_cron_runs,
            get_cron_activations,
            get_in_flight_cron_jobs,
            list_pending_missed_jobs,
            dismiss_missed_cron_job,
            trigger_missed_cron_job,
            list_agents,
            get_agent,
            add_agent,
            delete_agent,
            set_agent_identity,
            set_agent_enabled,
            list_agent_projections,
            activate_agent_projection,
            deactivate_agent_projection,
            bind_agent_channel,
            unbind_agent_channel,
            list_agent_channel_bindings,
            get_gateway_status,
            optimize_claude_settings,
            check_updates,
            restart_bridge,
            get_system_health,
            get_doctor_report,
            get_logs,
            get_approvals,
            approve_request,
            reject_request,
            get_devices,
            add_device,
            remove_device,
            get_nodes,
            add_node,
            remove_node,
            get_hooks,
            register_hook,
            unregister_hook,
            get_commitments,
            add_commitment,
            set_commitment_goal,
            complete_commitment,
            delete_commitment,
            get_action_registry_summary,
            get_action_registry_bucket,
            get_action_registry_alerts,
            sync_action_registry,
            update_action_approval,
            dispatch_action,
            list_trusted_acceptance_manifests,
            create_trusted_acceptance_manifest,
            replace_trusted_acceptance_manifest,
            remove_trusted_acceptance_manifest,
            execute_trusted_manifest_action,
            get_trusted_execution,
            list_trusted_executions,
            cancel_trusted_execution,
            run_trusted_acceptance,
            get_trusted_acceptance,
            get_plugins,
            enable_plugin,
            disable_plugin,
            hermes_status,
            hermes_spawn,
            hermes_shutdown,
            hermes_restart,
            hermes_interrupt,
            hermes_invoke,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            let teardown = match event {
                tauri::RunEvent::ExitRequested { .. } => TeardownEvent::ExitRequested,
                tauri::RunEvent::Exit => TeardownEvent::Exit,
                _ => TeardownEvent::Other,
            };
            if teardown.tears_down() {
                // DD-077: close the supervisor's start/restart gate *before* any
                // child is torn down. A tick already in flight would otherwise
                // relaunch the server stop_all is reaping, leaving it running
                // after the window is gone. One ordering point: set the flag
                // here, then reap. DD-082: `Exit` runs the same teardown as the
                // backstop for an exit that never emitted `ExitRequested`.
                supervisor::mark_quitting();
                process_lifecycle::stop_all();
            }
        });
}

#[cfg(test)]
mod startup_thread_tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;

    fn test_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "jarvis-proxy-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).expect("create test directory");
        path
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().expect("test file parent"))
            .expect("create test file parent");
        std::fs::write(path, b"# test\n").expect("write test file");
    }

    #[test]
    fn python_discovery_prefers_venv_and_preserves_launcher_prefix_args() {
        let home = test_dir("python");
        let venv = home.join(".openclaw/jarvis/hermes/.venv/Scripts/python.exe");
        touch(&venv);

        let selected = find_jarvis_python_with(Some(&home), |candidate| {
            candidate.program == venv || candidate.program == PathBuf::from("py")
        })
        .expect("a working interpreter");
        assert_eq!(selected.program, venv);
        assert!(selected.prefix_args.is_empty());

        std::fs::remove_file(&selected.program).expect("remove venv interpreter");
        let launcher = find_jarvis_python_with(Some(&home), |candidate| {
            candidate.program == PathBuf::from("py")
                && candidate.prefix_args == vec!["-3".to_string()]
        })
        .expect("py launcher should be retained with its selector");
        assert_eq!(launcher.program, PathBuf::from("py"));
        assert_eq!(launcher.prefix_args, vec!["-3"]);

        std::fs::remove_dir_all(home).expect("remove test directory");
    }

    #[test]
    fn hermes_config_keeps_python_launcher_prefix_args() {
        let invocation = PythonInvocation {
            program: PathBuf::from("py"),
            prefix_args: vec!["-3".to_string()],
        };
        let mut config = crate::jarvis::hermes::process::HermesConfig::default();
        apply_python_invocation_to_hermes(&mut config, invocation);

        assert_eq!(config.python, PathBuf::from("py"));
        assert_eq!(config.python_prefix_args, vec!["-3"]);
    }

    fn hanging_command() -> std::process::Command {
        let mut command = if cfg!(windows) {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "ping -n 6 -w 1000 127.0.0.1 >NUL"]);
            command
        } else {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "sleep 5"]);
            command
        };
        command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        command
    }

    #[test]
    fn default_workspace_path_is_derived_from_the_given_home() {
        let home = std::path::Path::new("jarvis-home");
        let expected = home
            .join(".openclaw")
            .join("agents")
            .join("coderclaw")
            .join("workspace")
            .join("Jarvis")
            .to_string_lossy()
            .into_owned();

        assert_eq!(
            default_jarvis_workspace_path_from("jarvis-home"),
            expected,
            "the fresh-install default must be a pure path join over the native home"
        );
    }

    #[test]
    fn hermes_config_construction_probes_no_python() {
        let before = PYTHON_DISCOVERY_PROBES.load(std::sync::atomic::Ordering::SeqCst);
        let config = build_hermes_config();
        let after = PYTHON_DISCOVERY_PROBES.load(std::sync::atomic::Ordering::SeqCst);

        assert_eq!(
            before, after,
            "build_hermes_config must not run interpreter probes before the window exists"
        );
        assert_eq!(
            config.python,
            PathBuf::from("python3"),
            "no interpreter may be claimed until one has actually been probed"
        );
    }

    #[test]
    fn production_hermes_state_wiring_defers_python_discovery() {
        let before = PYTHON_DISCOVERY_PROBES.load(std::sync::atomic::Ordering::SeqCst);
        let state = build_hermes_app_state();
        let after = PYTHON_DISCOVERY_PROBES.load(std::sync::atomic::Ordering::SeqCst);

        assert_eq!(
            before, after,
            "constructing the managed Hermes state must not probe for a Python interpreter"
        );
        assert!(
            state.has_pending_interpreter(),
            "production wiring must keep interpreter discovery deferred until the first Hermes start"
        );
        assert_eq!(
            state.config.python,
            PathBuf::from("python3"),
            "the managed state must not arrive with a pre-resolved interpreter"
        );
    }

    #[test]
    fn python_discovery_falls_back_after_a_timed_out_candidate() {
        let home = test_dir("python-timeout-fallback");
        let venv = home.join(".openclaw/jarvis/hermes/.venv/Scripts/python.exe");
        touch(&venv);

        let selected = find_jarvis_python_with(Some(&home), |candidate| {
            if candidate.program == venv {
                let mut command = hanging_command();
                assert!(
                    !probe_python_command(&mut command, std::time::Duration::from_millis(150)),
                    "a probe that outlives its deadline must not count as working"
                );
                return false;
            }
            candidate.program == PathBuf::from("py")
                && candidate.prefix_args == vec!["-3".to_string()]
        })
        .expect("discovery continues past a timed-out candidate");

        assert_eq!(selected.program, PathBuf::from("py"));
        assert_eq!(selected.prefix_args, vec!["-3"]);

        std::fs::remove_dir_all(home).expect("remove test directory");
    }

    #[test]
    fn python_probe_is_bounded_and_reaps_only_its_own_child() {
        let mut command = hanging_command();
        let started = std::time::Instant::now();
        assert!(!probe_python_command(
            &mut command,
            std::time::Duration::from_millis(200)
        ));
        assert!(
            started.elapsed() < std::time::Duration::from_secs(4),
            "a hung candidate must be stopped at its deadline, not waited out"
        );
    }

    #[test]
    fn proxy_discovery_prefers_windows_candidates_before_wsl() {
        let root = test_dir("discovery");
        let exe = root.join("repo/target/release/home-base.exe");
        touch(&exe);
        let ancestry_script = root.join("repo/scripts/claude_cli_proxy.py");
        touch(&ancestry_script);
        let user_script = root.join("user/.openclaw/jarvis/hermes/claude_cli_proxy.py");
        touch(&user_script);
        let wsl_script = PathBuf::from("/home/test/.openclaw/jarvis/hermes/claude_cli_proxy.py");
        let context = ProxyDiscoveryContext {
            override_path: None,
            exe_path: Some(exe),
            cwd: None,
            repo_root_script: Some(root.join("missing/claude_cli_proxy.py")),
            user_profile: Some(root.join("user")),
            wsl_candidates: vec![wsl_script],
        };

        let selected = find_claude_cli_proxy_with(&context, |_| true)
            .expect("native ancestry script should win");
        assert_eq!(selected.path, ancestry_script);
        assert_eq!(selected.kind, ProxyScriptKind::Native);

        let override_script = root.join("override/claude_cli_proxy.py");
        touch(&override_script);
        let selected = find_claude_cli_proxy_with(
            &ProxyDiscoveryContext {
                override_path: Some(override_script.clone()),
                ..context
            },
            |_| panic!("WSL must not be probed when a native override exists"),
        )
        .expect("override script should win");
        assert_eq!(selected.path, override_script);

        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    /// The candidate list must be built only from paths the running app can
    /// observe. This models a buyer's PC: the binary lives under that buyer's
    /// profile, the working directory is an unrelated scratch folder, and no
    /// environment value names the developer's machine.
    #[test]
    fn proxy_candidates_name_no_developer_path() {
        let profile = PathBuf::from(r"C:\Users\buyer");
        let exe = profile.join("AppData/Local/Programs/home-base/home-base.exe");
        let cwd = PathBuf::from(r"C:\Work\scratch");

        let context = proxy_discovery_context(
            |name| match name {
                "USERPROFILE" => Some(profile.clone().into_os_string()),
                _ => None,
            },
            Some(exe),
            Some(cwd),
        );
        let candidates = native_proxy_candidates(&context);
        assert!(
            !candidates.is_empty(),
            "a build beside a profile-scoped install still has candidates"
        );

        for candidate in &candidates {
            let text = candidate.to_string_lossy();
            for forbidden in [
                "home-base-recovered",
                r"Users\ethan",
                "Users/ethan",
                "/home/ethan",
                "/home/buyer",
            ] {
                assert!(
                    !text.contains(forbidden),
                    "candidate {text} names a path this app did not derive \
                     ({forbidden}); candidates: {candidates:?}"
                );
            }
        }

        assert!(
            candidates.contains(&profile.join(".openclaw/jarvis/hermes/claude_cli_proxy.py")),
            "the per-user candidate must come from the injected profile: {candidates:?}"
        );

        // With no environment, executable, or working directory there is no
        // observable path to search, so the resolver must invent nothing. A
        // restored hardcoded checkout path makes this list non-empty.
        let empty = native_proxy_candidates(&proxy_discovery_context(
            |_: &str| -> Option<std::ffi::OsString> { None },
            None,
            None,
        ));
        assert!(
            empty.is_empty(),
            "the resolver must derive no candidate from nothing: {empty:?}"
        );
    }

    /// A checkout outside the executable's ancestry is named by configuration,
    /// never by a hardcoded path.
    #[test]
    fn proxy_candidates_accept_a_configured_checkout_root() {
        let root = PathBuf::from(r"D:\src\home-base");
        let context = proxy_discovery_context(
            |name| match name {
                "JARVIS_REPO_ROOT" => Some(root.clone().into_os_string()),
                _ => None,
            },
            None,
            None,
        );

        assert_eq!(
            native_proxy_candidates(&context),
            vec![root.join("scripts").join("claude_cli_proxy.py")],
            "the configured checkout root must contribute exactly its script"
        );
    }

    #[test]
    fn proxy_credential_is_forwarded_through_native_and_wsl_launches() {
        let mut native = std::process::Command::new("python");
        configure_proxy_credential(&mut native, "secret-key", false);
        let native_env: std::collections::HashMap<_, _> = native.get_envs().collect();
        assert_eq!(
            native_env.get(std::ffi::OsStr::new("JARVIS_OPENROUTER_API_KEY")),
            Some(&Some(std::ffi::OsStr::new("secret-key")))
        );

        let mut wsl = std::process::Command::new("wsl.exe");
        wsl.env(
            "WSLENV",
            "EXISTING/u:JARVIS_OLLAMA_URL/w:JARVIS_DEFAULT_MODEL/p",
        );
        configure_proxy_runtime(&mut wsl, "qwen3:8b", true);
        configure_proxy_credential(&mut wsl, "secret-key", true);
        let wsl_env: std::collections::HashMap<_, _> = wsl.get_envs().collect();
        for (name, expected) in [
            ("JARVIS_CLAUDE_PROXY_PORT", "19878"),
            ("JARVIS_CLAUDE_PROXY_BIND", "127.0.0.1"),
            ("JARVIS_OLLAMA_URL", "http://127.0.0.1:11434"),
            ("JARVIS_DEFAULT_MODEL", "qwen3:8b"),
        ] {
            assert_eq!(
                wsl_env.get(std::ffi::OsStr::new(name)),
                Some(&Some(std::ffi::OsStr::new(expected)))
            );
        }
        let wslenv = wsl_env
            .get(std::ffi::OsStr::new("WSLENV"))
            .and_then(|value| *value)
            .expect("WSL launch should opt the credential into environment forwarding");
        let forwarded = wslenv.to_string_lossy();
        for required in [
            "EXISTING/u",
            "JARVIS_CLAUDE_PROXY_PORT",
            "JARVIS_CLAUDE_PROXY_BIND",
            "JARVIS_OLLAMA_URL",
            "JARVIS_DEFAULT_MODEL",
            "JARVIS_OPENROUTER_API_KEY",
        ] {
            assert!(
                forwarded.split(':').any(|name| name == required),
                "missing WSLENV entry {required}: {forwarded}"
            );
        }
        for disallowed in ["JARVIS_OLLAMA_URL/w", "JARVIS_DEFAULT_MODEL/p"] {
            assert!(
                !forwarded.split(':').any(|name| name == disallowed),
                "required WSLENV entry kept an incompatible flag {disallowed}: {forwarded}"
            );
        }
    }

    #[test]
    fn proxy_launch_and_python_default_are_loopback_only() {
        let mut command = std::process::Command::new("python");
        configure_proxy_runtime(&mut command, "qwen3:8b", false);
        let env: std::collections::HashMap<_, _> = command.get_envs().collect();
        assert_eq!(
            env.get(std::ffi::OsStr::new("JARVIS_CLAUDE_PROXY_BIND")),
            Some(&Some(std::ffi::OsStr::new("127.0.0.1")))
        );

        let source = include_str!("../../scripts/claude_cli_proxy.py");
        assert!(
            source.contains(
                "BIND_HOST = os.environ.get(\"JARVIS_CLAUDE_PROXY_BIND\", \"127.0.0.1\")"
            ),
            "the shipped Python fallback must not expose the proxy on all interfaces"
        );
    }

    #[test]
    fn release_resource_staging_replaces_newer_stale_proxy() {
        let root = test_dir("release-resource-staging");
        let source = root.join("source").join("claude_cli_proxy.py");
        let destination = root
            .join("release")
            .join("resources")
            .join("claude_cli_proxy.py");
        std::fs::create_dir_all(source.parent().expect("source parent"))
            .expect("create source directory");
        std::fs::write(&source, b"current proxy\n").expect("write source proxy");
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::fs::create_dir_all(destination.parent().expect("destination parent"))
            .expect("create destination directory");
        std::fs::write(&destination, b"stale proxy\n").expect("write stale proxy");
        assert!(
            destination.metadata().unwrap().modified().unwrap()
                >= source.metadata().unwrap().modified().unwrap(),
            "test precondition requires the stale destination to be at least as new"
        );

        assert!(
            release_resource_staging::copy_if_different(&source, &destination)
                .expect("replace stale proxy")
        );
        assert_eq!(
            std::fs::read(&destination).expect("read staged proxy"),
            b"current proxy\n"
        );
        assert!(
            !release_resource_staging::copy_if_different(&source, &destination)
                .expect("skip identical proxy")
        );

        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn release_and_desktop_contracts_ship_the_proxy_with_hash_provenance() {
        let tauri: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri config should be valid JSON");
        assert_eq!(
            tauri["bundle"]["resources"]["../scripts/claude_cli_proxy.py"],
            "resources/claude_cli_proxy.py"
        );
        assert_eq!(
            tauri["bundle"]["resources"]["../scripts/opencode_go_openai_models.json"],
            "resources/opencode_go_openai_models.json"
        );

        let build = include_str!("../../scripts/build-and-deploy.ps1");
        assert!(build.contains("$proxyScript = Join-Path $repo 'scripts\\claude_cli_proxy.py'"));
        assert!(build.contains("Deploy-File $proxyScript 'resources\\claude_cli_proxy.py'"));
        assert!(build
            .contains("Deploy-File $proxyModelsJson 'resources\\opencode_go_openai_models.json'"));
        assert!(build.contains("claude_proxy_sha256 ="));
        assert!(build.contains("opencode_go_models_sha256 ="));

        let verify = include_str!("../../scripts/verify-deploy.ps1");
        assert!(verify.contains("'resources\\claude_cli_proxy.py'"));
        assert!(verify.contains("$manifest.claude_proxy_sha256"));
        assert!(verify.contains("'resources\\opencode_go_openai_models.json'"));

        let build_helper = include_str!("../build.rs").replace("\r\n", "\n");
        assert!(build_helper.contains("cargo:rerun-if-changed=../scripts/claude_cli_proxy.py"));
        assert!(build_helper
            .contains("cargo:rerun-if-changed=../scripts/opencode_go_openai_models.json"));
        assert!(build_helper.contains(
            "let proxy_dest = release_dir.join(\"resources\").join(\"claude_cli_proxy.py\")"
        ));
        assert!(build_helper
            .contains("release_resource_staging::copy_if_different(&proxy_src, &proxy_dest)"));
        assert!(build_helper.contains(
            "let proxy_models_dest = release_dir\n        .join(\"resources\")\n        .join(\"opencode_go_openai_models.json\");"
        ));
    }

    #[test]
    fn startup_dispatch_returns_before_slow_boot_work_finishes() {
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let started = std::time::Instant::now();

        let worker = spawn_background_thread("jarvis-startup-test", move || {
            let _ = release_rx.recv_timeout(std::time::Duration::from_secs(1));
        })
        .expect("startup thread should spawn");

        assert!(
            started.elapsed() < std::time::Duration::from_millis(250),
            "startup dispatch waited for blocking boot work"
        );
        release_tx.send(()).expect("release startup worker");
        worker.join().expect("startup worker should exit cleanly");
    }

    #[test]
    fn dedicated_boot_runtime_completes_blocking_boot_work() {
        let (result_tx, result_rx) = mpsc::channel::<i32>();
        let worker = spawn_background_thread("jarvis-startup-blocking-test", move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime should build");
            runtime.block_on(async move {
                let value = spawn_blocking_on_current_runtime(|| 42)
                    .await
                    .expect("blocking boot work should join");
                result_tx
                    .send(value)
                    .expect("test receiver should be alive");
            });
        })
        .expect("startup blocking test thread should spawn");

        assert_eq!(
            result_rx
                .recv_timeout(std::time::Duration::from_secs(2))
                .expect("dedicated runtime should complete its blocking work"),
            42
        );
        worker
            .join()
            .expect("startup blocking test should exit cleanly");
    }

    #[test]
    fn native_windows_bun_launch_uses_hidden_console_policy() {
        assert!(should_hide_jarvis_server_console(true, true));
        assert!(should_hide_jarvis_server_console(true, false));
        assert!(!should_hide_jarvis_server_console(false, true));
    }
}

/// Behavioral regressions for the ordered startup gate. Every effect (probe,
/// listener check, spawn, delay, clock) is injected, so the tests pin ordering
/// without ports, sleeps, WSL state or real child processes.
#[cfg(test)]
mod bun_startup_tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;
    use std::rc::Rc;

    #[derive(Clone, Default)]
    struct Effects {
        trace: Rc<RefCell<Vec<String>>>,
        probe_script: Rc<RefCell<VecDeque<bool>>>,
        elapsed_script: Rc<RefCell<VecDeque<u64>>>,
        healthy: Rc<Cell<bool>>,
    }

    impl Effects {
        fn note(&self, event: &str) {
            self.trace.borrow_mut().push(event.to_string());
        }

        fn set_healthy(&self, healthy: bool) {
            self.healthy.set(healthy);
        }

        fn push_probe(&self, healthy: bool) {
            self.probe_script.borrow_mut().push_back(healthy);
        }

        fn push_elapsed(&self, millis: u64) {
            self.elapsed_script.borrow_mut().push_back(millis);
        }

        fn probe(&self) -> impl std::future::Future<Output = bool> + 'static {
            let effects = self.clone();
            async move {
                effects.note("probe");
                match effects.probe_script.borrow_mut().pop_front() {
                    Some(scripted) => scripted,
                    None => effects.healthy.get(),
                }
            }
        }

        fn delay(&self, millis: u64) -> impl std::future::Future<Output = ()> + 'static {
            let effects = self.clone();
            async move {
                effects.note(&format!("delay:{millis}"));
            }
        }

        fn elapsed_ms(&self) -> u64 {
            // Default past the budget so a scripted failure cannot loop forever.
            self.elapsed_script
                .borrow_mut()
                .pop_front()
                .unwrap_or(20_001)
        }

        fn snapshot(&self) -> Vec<String> {
            self.trace.borrow().clone()
        }
    }

    /// Drive the production startup gate with a scripted spawn outcome.
    async fn run_driver_with(
        effects: &Effects,
        remote_endpoint_requires_probe: bool,
        listener_open: bool,
        spawn: Result<OwnedBunChildStart, String>,
    ) -> Result<BunStartAttempt, StartupFailure> {
        drive_jarvis_server_start(
            remote_endpoint_requires_probe,
            {
                let effects = effects.clone();
                move || effects.probe()
            },
            {
                let effects = effects.clone();
                move |millis: u64| effects.delay(millis)
            },
            {
                let effects = effects.clone();
                move || {
                    effects.note("listen");
                    listener_open
                }
            },
            {
                let effects = effects.clone();
                move || {
                    let effects = effects.clone();
                    let spawn = spawn.clone();
                    async move {
                        match spawn {
                            Ok(OwnedBunChildStart::Spawn) => {
                                effects.note("spawn");
                                effects.set_healthy(true);
                                Ok(OwnedBunChildStart::Spawn)
                            }
                            Ok(OwnedBunChildStart::StillStarting) => {
                                effects.note("still-starting");
                                Ok(OwnedBunChildStart::StillStarting)
                            }
                            Err(error) => {
                                effects.note("spawn");
                                Err(error)
                            }
                        }
                    }
                }
            },
            {
                let effects = effects.clone();
                move || effects.elapsed_ms()
            },
            {
                let effects = effects.clone();
                move || effects.note("healthy")
            },
        )
        .await
    }

    /// The long-standing signature: `spawn_succeeds` is a fresh spawn or a
    /// reported spawn error, exactly as before DD-073.
    async fn run_driver(
        effects: &Effects,
        remote_endpoint_requires_probe: bool,
        listener_open: bool,
        spawn_succeeds: bool,
    ) -> Result<BunStartAttempt, StartupFailure> {
        let spawn = if spawn_succeeds {
            Ok(OwnedBunChildStart::Spawn)
        } else {
            Err("spawn failed".to_string())
        };
        run_driver_with(
            effects,
            remote_endpoint_requires_probe,
            listener_open,
            spawn,
        )
        .await
    }

    #[tokio::test]
    async fn closed_native_listener_spawns_before_any_pre_spawn_http_probe() {
        let effects = Effects::default();
        effects.push_elapsed(0);
        let outcome = run_driver(&effects, false, false, true).await;

        assert_eq!(outcome, Ok(BunStartAttempt::Healthy));
        assert_eq!(
            effects.snapshot(),
            vec!["listen", "spawn", "probe", "healthy"],
            "a closed local listener must reach the owned-child spawn before any HTTP probe"
        );
    }

    #[tokio::test]
    async fn healthy_open_listener_is_reused_without_spawning() {
        let effects = Effects::default();
        effects.set_healthy(true);
        let outcome = run_driver(&effects, false, true, true).await;

        assert_eq!(outcome, Ok(BunStartAttempt::Healthy));
        assert_eq!(effects.snapshot(), vec!["listen", "probe", "healthy"]);
    }

    #[tokio::test]
    async fn open_but_unhealthy_listener_gets_a_second_health_chance() {
        let effects = Effects::default();
        effects.push_probe(false);
        effects.push_probe(true);
        let outcome = run_driver(&effects, false, true, true).await;

        assert_eq!(outcome, Ok(BunStartAttempt::Healthy));
        assert_eq!(
            effects.snapshot(),
            vec!["listen", "probe", "delay:750", "probe", "healthy"],
            "an open listener must not be replaced on a single missed probe"
        );
    }

    #[tokio::test]
    async fn open_listener_that_stays_unhealthy_is_replaced_by_the_owned_child() {
        let effects = Effects::default();
        effects.push_elapsed(0);
        effects.push_probe(false);
        effects.push_probe(false);
        let outcome = run_driver(&effects, false, true, true).await;

        assert_eq!(outcome, Ok(BunStartAttempt::Healthy));
        assert_eq!(
            effects.snapshot(),
            vec![
                "listen",
                "probe",
                "delay:750",
                "probe",
                "spawn",
                "probe",
                "healthy"
            ]
        );
    }

    #[tokio::test]
    async fn closed_port_with_a_healthy_remote_endpoint_never_spawns() {
        let effects = Effects::default();
        effects.push_probe(true);
        let outcome = run_driver(&effects, true, false, true).await;

        assert_eq!(outcome, Ok(BunStartAttempt::Healthy));
        assert_eq!(
            effects.snapshot(),
            vec!["probe", "healthy"],
            "a reachable configured endpoint must be trusted before any local listener check or spawn"
        );
    }

    #[tokio::test]
    async fn closed_port_with_an_unreachable_remote_endpoint_still_probes_then_spawns() {
        let effects = Effects::default();
        effects.push_elapsed(0);
        effects.push_probe(false);
        let outcome = run_driver(&effects, true, false, true).await;

        assert_eq!(outcome, Ok(BunStartAttempt::Healthy));
        assert_eq!(
            effects.snapshot(),
            vec!["probe", "listen", "spawn", "probe", "healthy"],
            "remote/WSL endpoints are not assumed absent from a closed local port"
        );
    }

    #[tokio::test]
    async fn spawned_child_must_still_become_healthy() {
        let effects = Effects::default();
        effects.push_elapsed(0);
        effects.push_elapsed(20_001);
        effects.push_probe(false);
        let outcome = run_driver(&effects, false, false, true).await;

        assert_eq!(outcome, Err(StartupFailure::TimedOut));
        assert_eq!(
            effects.snapshot(),
            vec!["listen", "spawn", "probe", "delay:500"],
            "a successful spawn is not success until health is confirmed"
        );
    }

    #[tokio::test]
    async fn owned_child_spawn_failure_is_reported() {
        let effects = Effects::default();
        let outcome = run_driver(&effects, false, false, false).await;

        assert_eq!(
            outcome,
            Err(StartupFailure::Spawn("spawn failed".to_string()))
        );
        assert_eq!(effects.snapshot(), vec!["listen", "spawn"]);
    }

    /// DD-073 and DD-079: a Bun child this app spawned and still owns is still
    /// starting, not somebody else's listener. Even after one health budget
    /// without `/health`, the ensure path must not spawn a replacement, must not
    /// claim a failed start, and must report that waiting state distinctly
    /// instead of as healthy — otherwise the supervisor clears its failure
    /// budget for a server that never answered.
    #[tokio::test]
    async fn an_owned_child_inside_its_start_budget_is_left_alone() {
        let effects = Effects::default();
        // The budget is spent, and the child still never answers /health: this
        // is exactly the case that used to be replaced by the next ensure.
        effects.push_elapsed(0);
        effects.push_elapsed(20_001);
        effects.push_probe(false);
        // A second ensure attempt on the same live child is scripted the same
        // way: the retry must still wait and probe, not kill or replace it.
        effects.push_elapsed(0);
        effects.push_elapsed(20_001);
        effects.push_probe(false);

        let spawn = Ok(OwnedBunChildStart::StillStarting);
        let outcome = run_driver_with(&effects, false, false, spawn.clone()).await;

        assert_eq!(
            outcome,
            Ok(BunStartAttempt::StillStarting),
            "waiting on a live child is neither a failed start nor a healthy server"
        );
        assert_eq!(
            effects.snapshot(),
            vec!["listen", "still-starting", "probe", "delay:500"],
            "a live owned child must be waited on: no replacement spawn and no \
             unconfirmed health claim"
        );
        assert!(
            !effects.snapshot().iter().any(|event| event == "spawn"),
            "the owned child must not be replaced by a second spawn"
        );

        // DD-073's retry: a later ensure attempt still waits on the same child
        // and probes it again.
        let retry = run_driver_with(&effects, false, false, spawn).await;
        assert_eq!(
            retry,
            Ok(BunStartAttempt::StillStarting),
            "a later ensure attempt must keep waiting on the same live child"
        );
        assert_eq!(
            effects.snapshot(),
            vec![
                "listen",
                "still-starting",
                "probe",
                "delay:500",
                "listen",
                "still-starting",
                "probe",
                "delay:500"
            ],
            "the retry must probe the same live child again instead of replacing it"
        );
    }

    /// DD-073 must not change the ordinary path: with no live child in the slot
    /// the ensure path still spawns, and health is still required afterwards.
    #[tokio::test]
    async fn a_dead_or_absent_child_still_spawns_as_before() {
        let effects = Effects::default();
        effects.push_elapsed(0);

        let spawn = Ok(OwnedBunChildStart::Spawn);
        let outcome = run_driver_with(&effects, false, false, spawn).await;

        assert_eq!(outcome, Ok(BunStartAttempt::Healthy));
        assert_eq!(
            effects.snapshot(),
            vec!["listen", "spawn", "probe", "healthy"],
            "without a live owned child the ensure path must spawn exactly as before"
        );
    }

    /// DD-073: the decision is a reading of the one existing liveness rule, so
    /// only a live child is left where it is; a dead or absent slot still
    /// spawns.
    #[test]
    fn only_a_live_owned_child_is_left_where_it_is() {
        assert_eq!(
            owned_bun_child_start(true),
            OwnedBunChildStart::StillStarting,
            "a live tracked Bun child must not be replaced"
        );
        assert_eq!(
            owned_bun_child_start(false),
            OwnedBunChildStart::Spawn,
            "a dead or absent Bun child must still be started"
        );
    }
}

/// DS-01 boot-order regressions: Bun (the UI's only data source) must begin its
/// cold startup before the backend's local dependency is polled, and both must
/// converge concurrently. The ordering test runs the production startup gate
/// (`drive_jarvis_server_start`) with every effect injected, so it fails if the
/// boot order reverts to backend-first *or* to awaiting Bun to completion
/// before the backend starts. The wiring test fails if `bootstrap_services`
/// stops using the tested scheduler — the ordering test alone only exercises
/// the helper.
#[cfg(test)]
mod bun_boot_order_tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    #[derive(Default)]
    struct BootTrace {
        events: RefCell<Vec<&'static str>>,
        probe_calls: Cell<u32>,
    }

    impl BootTrace {
        fn note(&self, event: &'static str) {
            self.events.borrow_mut().push(event);
        }

        fn snapshot(&self) -> Vec<&'static str> {
            self.events.borrow().clone()
        }

        /// First health probe misses so the readiness gate awaits; the retry
        /// succeeds. That keeps the gate pending long enough for the backend
        /// dependency to be polled, instead of completing in one poll.
        fn probe(&self) -> bool {
            self.note("bun:probe");
            let calls = self.probe_calls.get() + 1;
            self.probe_calls.set(calls);
            calls > 1
        }
    }

    fn position(events: &[&'static str], event: &str) -> usize {
        events
            .iter()
            .position(|candidate| *candidate == event)
            .unwrap_or_else(|| panic!("{event} missing from boot trace {events:?}"))
    }

    /// The Bun side of the trace, driven through the production startup gate.
    ///
    /// `bun:spawn` is noted when the injected spawn future is first polled,
    /// i.e. when the owned-child startup is *initiated*. In production that
    /// point starts a `spawn_blocking` hop, and the blocking thread may not
    /// have spawned the child yet when the backend dependency is polled.
    async fn drive_traced_bun_start(
        trace: Rc<BootTrace>,
        spawn_succeeds: bool,
    ) -> Result<(), String> {
        drive_jarvis_server_start(
            // Local-only candidates: the closed native listener proves the cold
            // path, so startup must not wait on a pre-spawn HTTP probe.
            false,
            {
                let trace = Rc::clone(&trace);
                move || {
                    let trace = Rc::clone(&trace);
                    async move { trace.probe() }
                }
            },
            {
                let trace = Rc::clone(&trace);
                move |_millis: u64| {
                    let trace = Rc::clone(&trace);
                    async move {
                        // Yields the task, which is where the backend gets its
                        // first poll.
                        trace.note("bun:wait");
                        tokio::task::yield_now().await;
                    }
                }
            },
            || false,
            {
                let trace = Rc::clone(&trace);
                move || {
                    let trace = Rc::clone(&trace);
                    async move {
                        trace.note("bun:spawn");
                        if spawn_succeeds {
                            Ok::<OwnedBunChildStart, String>(OwnedBunChildStart::Spawn)
                        } else {
                            Err("spawn failed".to_string())
                        }
                    }
                }
            },
            || 0u64,
            {
                let trace = Rc::clone(&trace);
                move || trace.note("bun:healthy")
            },
        )
        .await
        // The boot-order trace only cares that the gate finished; DD-079's
        // healthy/still-starting distinction is pinned in `bun_startup_tests`.
        .map(|_attempt| ())
        .map_err(|failure| match failure {
            StartupFailure::Spawn(error) => error,
            StartupFailure::TimedOut => "Bun startup timed out".to_string(),
        })
    }

    #[tokio::test]
    async fn bun_starts_before_the_backend_dependency_and_runs_concurrently() {
        let trace = Rc::new(BootTrace::default());

        let bun = drive_traced_bun_start(Rc::clone(&trace), true);
        let backend = {
            let trace = Rc::clone(&trace);
            async move {
                trace.note("backend:started");
            }
        };

        let outcome = start_bun_and_backend(bun, backend).await;
        assert_eq!(outcome, Ok(()));

        let events = trace.snapshot();
        assert!(
            position(&events, "bun:spawn") < position(&events, "backend:started"),
            "the Bun startup must be initiated before the backend dependency \
             begins: {events:?}"
        );
        assert!(
            position(&events, "backend:started") < position(&events, "bun:healthy"),
            "the backend dependency must run while Bun is still becoming healthy, \
             not after it: {events:?}"
        );
    }

    #[tokio::test]
    async fn bun_start_failure_is_returned_without_cancelling_the_backend_dependency() {
        let trace = Rc::new(BootTrace::default());

        let bun = drive_traced_bun_start(Rc::clone(&trace), false);
        let backend = {
            let trace = Rc::clone(&trace);
            async move {
                trace.note("backend:started");
            }
        };

        let outcome = start_bun_and_backend(bun, backend).await;
        assert_eq!(outcome, Err("spawn failed".to_string()));
        assert_eq!(
            trace.snapshot(),
            vec!["bun:spawn", "backend:started"],
            "a failed Bun spawn must be reported, and the best-effort backend \
             dependency must still be polled"
        );
    }

    /// `bootstrap_services` is the production wiring: it must hand both real
    /// boot steps to `start_bun_and_backend`, with the Bun future first. The
    /// body is read from this file because that function performs the real boot
    /// (SQLite, migrations, child processes, HTTP probes) and cannot be invoked
    /// from a unit test. This fails if the call is replaced by sequential
    /// awaits, by backend-first ordering, or by an inline backend match.
    #[test]
    fn bootstrap_services_boots_through_the_tested_scheduler() {
        const SOURCE: &str = include_str!("lib.rs");
        let start = SOURCE
            .find("async fn bootstrap_services(")
            .expect("bootstrap_services must exist in lib.rs");
        let end = SOURCE[start..]
            .find("\nfn spawn_bootstrap_services(")
            .map(|offset| start + offset)
            .expect("spawn_bootstrap_services must follow bootstrap_services in lib.rs");
        let body = &SOURCE[start..end];

        assert_eq!(
            body.matches("start_bun_and_backend(").count(),
            1,
            "bootstrap_services must call the tested scheduler exactly once:\n{body}"
        );
        let scheduler = body
            .find("start_bun_and_backend(")
            .expect("scheduler call present");
        assert!(
            body[..scheduler].contains("let backend_dependency = start_backend_dependency(&cfg);"),
            "the backend future must be built before the scheduler runs:\n{body}"
        );
        // The first `start_backend_dependency(&cfg)` is that let binding, which
        // sits above the call. Argument order has to be read from the call
        // itself, or the let binding makes Bun look second.
        let call_statement = &body[scheduler..];
        let statement_end = call_statement
            .find(';')
            .expect("the scheduler call must be part of a statement");
        let call = &call_statement[..statement_end];
        let bun = call
            .find("ensure_jarvis_server_started()")
            .expect("the real Bun starter must be handed to the scheduler");
        let backend_arg = call
            .find("backend_dependency")
            .expect("the backend future must be the scheduler's second argument");
        assert!(
            bun < backend_arg,
            "the Bun future must be the scheduler's first argument so `biased;` \
             polls it first:\n{call}"
        );
        // A dropped `start_bun_and_backend(..)` would satisfy the checks above
        // while never booting or polling either step.
        assert!(
            call.contains(".await"),
            "the scheduler must be awaited, not merely constructed:\n{call}"
        );
        assert!(
            !body.contains("ensure_jarvis_server_started().await"),
            "bootstrap_services must not await the Bun starter outside the \
             scheduler:\n{body}"
        );
        assert!(
            !body.contains("start_backend_dependency(&cfg).await"),
            "bootstrap_services must not await the backend dependency on its own:\n{body}"
        );
        assert!(
            !body.contains("JarvisBackend::"),
            "the backend dependency must start through start_backend_dependency, \
             not an inline match in bootstrap_services:\n{body}"
        );
    }
}

/// DD-049 regressions: a native Windows backend (llama.cpp / Ollama launched
/// from a `.exe`) must read a closed local port as closed without spawning
/// `wsl.exe`, while a backend this process really launches through `wsl.exe`
/// keeps its probe. The behavioural tests drive the production decision seam
/// with injected probes, so no port, WSL state or child process is involved; the
/// wiring test reads this file because the two starters perform real boot work
/// and cannot be invoked from a unit test.
#[cfg(test)]
mod local_backend_probe_tests {
    use super::*;
    use std::cell::Cell;

    const NATIVE_COMMAND: &str =
        r"C:\Users\ethan\AppData\Local\Programs\Ollama\ollama.exe";
    const WSL_COMMAND: &str = "/usr/local/bin/ollama";

    /// Slice one function body out of this file between its signature and the
    /// signature of the next item.
    fn body_of<'a>(source: &'a str, signature: &str, next: &str) -> &'a str {
        let start = source
            .find(signature)
            .unwrap_or_else(|| panic!("{signature} must exist in lib.rs"));
        let end = source[start..]
            .find(next)
            .map(|offset| start + offset)
            .unwrap_or_else(|| panic!("{next} must follow {signature} in lib.rs"));
        &source[start..end]
    }

    #[test]
    fn native_backend_closed_port_never_builds_a_wsl_probe() {
        let wsl_probes = Cell::new(0);
        let listening = backend_port_is_listening_with(
            11434,
            false,
            |_| false,
            |_| {
                wsl_probes.set(wsl_probes.get() + 1);
                true
            },
        );

        assert!(
            !listening,
            "a closed locally-launched backend port must read as closed"
        );
        assert_eq!(
            wsl_probes.get(),
            0,
            "the native closed-port path must not spawn wsl.exe; only a backend \
             this process launches through WSL may pay for that probe"
        );
    }

    #[test]
    fn wsl_launched_backend_may_still_probe_wsl() {
        let wsl_probes = Cell::new(0);
        let listening = backend_port_is_listening_with(
            11434,
            true,
            |_| false,
            |_| {
                wsl_probes.set(wsl_probes.get() + 1);
                true
            },
        );

        assert!(
            listening,
            "a WSL-launched backend listening inside WSL must still be detected"
        );
        assert_eq!(wsl_probes.get(), 1, "the WSL probe must still run");
    }

    #[test]
    fn an_open_local_port_short_circuits_before_any_wsl_probe() {
        let wsl_probes = Cell::new(0);
        let listening =
            backend_port_is_listening_with(11434, true, |_| true, |_| {
                wsl_probes.set(wsl_probes.get() + 1);
                false
            });

        assert!(listening);
        assert_eq!(wsl_probes.get(), 0, "an open local port needs no WSL probe");
    }

    #[test]
    fn a_windows_exe_command_is_never_wsl_launched() {
        assert!(
            !command_uses_wsl(Some(NATIVE_COMMAND)),
            "a native .exe command cannot be listening inside WSL"
        );
    }

    #[test]
    fn a_linux_style_command_is_wsl_launched_only_on_windows() {
        assert_eq!(
            command_uses_wsl(Some(WSL_COMMAND)),
            cfg!(target_os = "windows"),
            "only a Windows build launches a non-.exe command through wsl.exe"
        );
    }

    #[test]
    fn a_missing_command_never_implies_wsl() {
        assert!(!command_uses_wsl(None));
        assert!(!command_uses_wsl(Some("   ")));
    }

    #[test]
    fn boot_backends_check_ports_through_the_gated_probe() {
        const SOURCE: &str = include_str!("lib.rs");

        let ollama = body_of(
            SOURCE,
            "pub(crate) async fn start_ollama_and_warm(",
            "pub(crate) async fn start_llama_cpp_server(",
        );
        assert!(
            ollama.contains("let uses_wsl = ollama_uses_wsl();"),
            "the Ollama boot path must derive its launch mode first:\n{ollama}"
        );
        assert!(
            ollama.contains("backend_port_is_listening(OLLAMA_PORT, uses_wsl)"),
            "the Ollama boot path must use the gated port check:\n{ollama}"
        );
        assert!(
            !ollama.contains("is_port_listening(") && !ollama.contains("is_wsl_port_listening("),
            "the Ollama boot path must not use the unconditional probe, which \
             spawns wsl.exe even for a native backend:\n{ollama}"
        );

        let llama = body_of(
            SOURCE,
            "pub(crate) async fn start_llama_cpp_server(",
            "pub fn reconcile_backend_services(",
        );
        assert!(
            llama.contains("command_uses_wsl(Some(config.server_path.as_str()))"),
            "the llama.cpp boot path must derive its launch mode from the \
             configured server command:\n{llama}"
        );
        assert!(
            llama.contains("backend_port_is_listening(config.port, uses_wsl)"),
            "the llama.cpp boot path must use the gated port check:\n{llama}"
        );
        assert!(
            !llama.contains("is_port_listening(") && !llama.contains("is_wsl_port_listening("),
            "the llama.cpp boot path must not use the unconditional probe, which \
             spawns wsl.exe even for a native backend:\n{llama}"
        );
    }
}

/// DD-063 wiring: the stop plan and the supervisor decision are only worth
/// anything if the spawn sites actually record their launch kind and stop
/// replacing a live child. These starters perform real boot work and cannot be
/// invoked from a unit test, so this reads their bodies instead.
#[cfg(test)]
mod owned_slot_wiring_tests {
    const SOURCE: &str = include_str!("lib.rs");

    /// Whitespace-insensitive slice of one function body, so the assertions do
    /// not break when a call is rewrapped but the arguments stay the same.
    fn normalized_body(signature: &str, next: &str) -> String {
        let start = SOURCE
            .find(signature)
            .unwrap_or_else(|| panic!("{signature} must exist in lib.rs"));
        let end = SOURCE[start..]
            .find(next)
            .map(|offset| start + offset)
            .unwrap_or_else(|| panic!("{next} must follow {signature} in lib.rs"));
        SOURCE[start..end].split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn the_ollama_boot_path_never_replaces_a_live_child() {
        // replace=true would kill a server that is still loading a model: the
        // launch reports AlreadyRunning and the wait below gives it time instead.
        let ollama = normalized_body(
            "pub(crate) async fn start_ollama_and_warm(",
            "pub(crate) async fn start_llama_cpp_server(",
        );
        assert!(
            ollama.contains("process_lifecycle::launch( process_lifecycle::ManagedProcess::Ollama, false,"),
            "the Ollama start must not replace a child that is still coming up:\n{ollama}"
        );
    }

    /// DD-073 wiring: the decision above is only real if the ensure path asks
    /// the tracked child's liveness before it reaches the spawn. That path
    /// performs real boot work and cannot be invoked from a unit test, so this
    /// reads its body: it must consult `is_live` for the Bun slot, and the
    /// check must come before `start_jarvis_server`, which reaps the tracked
    /// child before spawning.
    #[test]
    fn the_ensure_path_asks_owned_liveness_before_it_spawns() {
        let ensure = normalized_body(
            "pub async fn ensure_jarvis_server_started(",
            "/// Generic listener probe, used where",
        );
        let live_check = ensure
            .find("process_lifecycle::is_live( process_lifecycle::ManagedProcess::BunServer")
            .unwrap_or_else(|| {
                panic!("the ensure path must consult the tracked Bun child's liveness:\n{ensure}")
            });
        let spawn = ensure
            .find("start_jarvis_server(")
            .expect("the ensure path must still start the server through start_jarvis_server");
        assert!(
            live_check < spawn,
            "owned-child liveness must be consulted before the spawn, since the \
             spawn replaces the tracked child:\n{ensure}"
        );
        assert!(
            ensure.contains("return Ok(OwnedBunChildStart::StillStarting);"),
            "a live owned child must be reported as still starting, not spawned over:\n{ensure}"
        );
        // DD-079: the ensure path must keep that still-starting state visible
        // instead of flattening it into "healthy" on the way out.
        assert!(
            ensure.contains("Ok(BunStartAttempt::StillStarting) => BunServerStart::StillStarting,"),
            "the ensure path must report a still-starting child as still starting, \
             not as healthy:\n{ensure}"
        );
        assert!(
            ensure.contains(
                "BunServerStart::Healthy | BunServerStart::StillStarting => Ok(()),"
            ),
            "callers that only gate on the child being in place must keep the \
             DD-073 success contract:\n{ensure}"
        );
        assert!(
            !ensure.contains("ManagedProcess::Ollama"),
            "the Bun ensure path must ask about the Bun slot, not another service:\n{ensure}"
        );
    }

    #[test]
    fn wsl_launched_children_record_their_guest_port_in_the_slot() {
        // Each site that can spawn `wsl.exe` must pass the matching launch kind,
        // otherwise `stop` only reaps the wrapper and the guest listener survives.
        let bun = normalized_body("fn start_jarvis_server(", "/// Force-restart the Bun server.");
        assert!(
            bun.contains("bun_launches_through_wsl(")
                && bun.contains("process_lifecycle::SlotLaunch::Wsl { port: BUN_SERVER_PORT,")
                && bun.contains(
                    "process_lifecycle::launch_with( process_lifecycle::ManagedProcess::BunServer, replace, slot_launch,"
                ),
            "the Bun starter must record a WSL launch so its stop reaches the guest server:\n{bun}"
        );

        let proxy = normalized_body(
            "pub(crate) fn start_claude_cli_proxy(",
            "pub(crate) fn restart_claude_cli_proxy(",
        );
        assert!(
            proxy.contains(
                "process_lifecycle::launch_with( process_lifecycle::ManagedProcess::ClaudeProxy, false, claude_proxy_slot_launch(),"
            ),
            "the proxy starter must record its launch kind:\n{proxy}"
        );

        let restart = normalized_body(
            "pub(crate) fn restart_claude_cli_proxy(",
            "fn prepare_claude_cli_proxy()",
        );
        assert!(
            restart.contains(
                "process_lifecycle::launch_with( process_lifecycle::ManagedProcess::ClaudeProxy, true, claude_proxy_slot_launch(),"
            ),
            "a proxy restart must record its launch kind too:\n{restart}"
        );

        let slot_launch = normalized_body("fn claude_proxy_slot_launch()", "/// Parse `netstat -ano`");
        assert!(
            slot_launch.contains("process_lifecycle::SlotLaunch::Wsl { port: CLAUDE_PROXY_PORT,")
                && slot_launch.contains("process_lifecycle::SlotLaunch::Direct"),
            "the proxy launch kind must follow the WSL script source:\n{slot_launch}"
        );
    }

    /// DD-082: every Bun start site named in the quit evidence — the ensure
    /// path, `chat_base_url`, and backend reconcile — must reach the managed
    /// spawn that consults DD-077's exit flag at the last instant before the OS
    /// spawn. Reads the production bodies so this test's own text cannot satisfy
    /// the check.
    #[test]
    fn the_named_bun_spawn_paths_reach_the_quit_gated_spawn() {
        let lifecycle = include_str!("process_lifecycle.rs");
        let gate_start = lifecycle
            .find("pub(crate) fn spawn_managed(")
            .expect("the managed spawn must exist");
        let gate_end = lifecycle[gate_start..]
            .find("fn spawn_managed_with_gate(")
            .map(|offset| gate_start + offset)
            .expect("spawn_managed_with_gate must follow spawn_managed");
        assert!(
            lifecycle[gate_start..gate_end].contains("crate::supervisor::is_quitting()"),
            "the managed spawn must refuse once DD-077's flag is set:\n{}",
            &lifecycle[gate_start..gate_end]
        );

        let starter = normalized_body("fn start_jarvis_server(", "/// Force-restart the Bun server.");
        assert!(
            starter.contains("process_lifecycle::launch_with("),
            "the Bun starter must spawn through the managed launcher:\n{starter}"
        );

        // The launcher's spawn closure is `spawn_jarvis_server`, which is the
        // only Bun function that creates the child and therefore names the gate.
        let spawn_bun = normalized_body(
            "fn spawn_jarvis_server(",
            "/// Whether the Bun server is launched inside WSL.",
        );
        assert!(
            spawn_bun.contains("process_lifecycle::spawn_managed("),
            "the Bun spawn must go through the quit-gated managed spawn:\n{spawn_bun}"
        );

        // The ensure path is the spawn evidence for the boot/supervisor callers.
        let ensure = normalized_body(
            "pub async fn ensure_jarvis_server_started(",
            "/// Generic listener probe, used where",
        );
        assert!(
            ensure.contains("start_jarvis_server("),
            "the ensure path must spawn through the gated starter:\n{ensure}"
        );

        // lib.rs:652 in the evidence: backend reconcile starts Bun via ensure.
        let reconcile = normalized_body(
            "pub fn reconcile_backend_services(",
            "pub(crate) fn claude_proxy_enabled(",
        );
        assert!(
            reconcile.contains("ensure_jarvis_server_started()"),
            "backend reconcile must start Bun through the ensure path:\n{reconcile}"
        );

        // jarvis_commands.rs:78-83 in the evidence: a chat send starts Bun via
        // ensure, so it reaches the same gate without a second spawn path.
        let chat = include_str!("commands/jarvis_commands.rs");
        assert!(
            chat.contains("crate::ensure_jarvis_server_started()"),
            "the chat path must start Bun through the ensure path"
        );
    }
}

/// DD-082: teardown must not be limited to `ExitRequested`. A hard or
/// non-window exit reaches `RunEvent::Exit`; that path must tear the same
/// children down. The event set is pure and the wiring is read from the real
/// `.run` callback, so no Tauri app or child process is created here.
#[cfg(test)]
mod quit_teardown_tests {
    use super::TeardownEvent;

    const SOURCE: &str = include_str!("lib.rs");

    /// The production run-loop callback, sliced out so this module's own
    /// assertion text cannot satisfy the wiring checks.
    fn run_callback() -> &'static str {
        let start = SOURCE
            .find(".run(|_app_handle, event| {")
            .expect("the app must still install a run-loop callback");
        let end = SOURCE[start..]
            .find("        });")
            .map(|offset| start + offset)
            .expect("the run-loop callback must have a closing brace");
        &SOURCE[start..end]
    }

    #[test]
    fn exit_tears_down_even_when_exit_requested_never_fired() {
        assert!(
            TeardownEvent::ExitRequested.tears_down(),
            "the normal clean-quit event must still tear children down"
        );
        assert!(
            TeardownEvent::Exit.tears_down(),
            "RunEvent::Exit must also tear children down; it is the path that \
             skips the ExitRequested-only teardown"
        );
        assert!(
            !TeardownEvent::Other.tears_down(),
            "unrelated run-loop events must not run teardown"
        );
    }

    #[test]
    fn the_run_loop_maps_both_exit_events_to_teardown() {
        let callback = run_callback();

        assert!(
            callback.contains("tauri::RunEvent::ExitRequested { .. } => TeardownEvent::ExitRequested"),
            "the run loop must still observe the clean-quit event:\n{callback}"
        );
        assert!(
            callback.contains("tauri::RunEvent::Exit => TeardownEvent::Exit"),
            "the run loop must observe RunEvent::Exit as a teardown path:\n{callback}"
        );
        assert!(
            callback.contains("if teardown.tears_down()"),
            "both mapped events must route through the teardown decision:\n{callback}"
        );

        let gate = callback
            .find("supervisor::mark_quitting();")
            .expect("teardown must close the supervisor gate first");
        let reap = callback
            .find("process_lifecycle::stop_all();")
            .expect("teardown must still reap every owned child");
        assert!(
            gate < reap,
            "the quit gate must close before children are reaped:\n{callback}"
        );
    }
}

/// DD-051 regressions: a packaged install that finds no bundled `index.js` must
/// report a miss instead of silently starting a developer TypeScript source
/// tree. The tests drive the production choice seam with an injected `exists`
/// predicate, so no executable, filesystem, or WSL launch is involved.
#[cfg(test)]
mod jarvis_bundle_lookup_tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// Reads `true` only for the exact paths listed, like a filesystem holding
    /// just those files.
    fn only_files(paths: &[PathBuf]) -> impl Fn(&Path) -> bool + '_ {
        move |candidate: &Path| paths.iter().any(|path| path == candidate)
    }

    /// The developer source-tree locations the bundled lookup used to return.
    /// None of these is a packaged server entry.
    fn developer_source_candidates() -> Vec<PathBuf> {
        vec![
            PathBuf::from(r"C:\Projects\home-base-recovered\server-jarvis\src\index.ts"),
            PathBuf::from(r"C:\Users\ethan\.openclaw\jarvis\server-jarvis\src\index.ts"),
            PathBuf::from(
                "/root/.openclaw/agents/coderclaw/workspace/home-base/server-jarvis/src/index.ts",
            ),
        ]
    }

    #[test]
    fn beside_exe_bundle_wins_over_a_developer_source_tree() {
        let exe_dir = PathBuf::from("install");
        let bundled = exe_dir.join("index.js");
        let mut existing = developer_source_candidates();
        existing.push(bundled.clone());

        let found = find_bundled_server(Some(&exe_dir), only_files(&existing));

        assert_eq!(
            found,
            Some(bundled),
            "a beside-exe index.js must win over any existing source tree"
        );
    }

    #[test]
    fn packaged_install_without_a_bundle_never_returns_a_source_tree() {
        let exe_dir = PathBuf::from("install");
        let existing = developer_source_candidates();

        let found = find_bundled_server(Some(&exe_dir), only_files(&existing));

        assert_eq!(
            found, None,
            "a packaged install must miss instead of starting a developer \
             source tree; found {found:?}"
        );
    }

    #[test]
    fn ancestry_returns_the_dist_bundle_and_never_the_source_sibling() {
        let repo = PathBuf::from("checkout");
        let exe_dir = repo.join("target").join("release");
        let dist = repo.join("server-jarvis").join("dist").join("index.js");
        let source = repo.join("server-jarvis").join("src").join("index.ts");
        let existing = vec![source.clone(), dist.clone()];

        let found = find_bundled_server(Some(&exe_dir), only_files(&existing));

        assert_eq!(found, Some(dist), "ancestry must return the dist bundle");
        assert_ne!(found, Some(source), "a sibling source entry is never a server");
    }

    #[test]
    fn ancestry_source_tree_alone_is_not_a_server() {
        let repo = PathBuf::from("checkout");
        let exe_dir = repo.join("target").join("release");
        let source = repo.join("server-jarvis").join("src").join("index.ts");

        let found = find_bundled_server(Some(&exe_dir), only_files(&[source]));

        assert_eq!(
            found, None,
            "an ancestry walk that only finds src/index.ts must report a miss"
        );
    }

    /// The live lookup must not reintroduce a source-tree candidate or a probe
    /// for one. The behavioural tests above only see the injected predicate, so
    /// this reads the function body for the three paths DD-051 removed.
    #[test]
    fn find_jarvis_server_has_no_developer_source_fallback() {
        const SOURCE: &str = include_str!("lib.rs");
        let start = SOURCE
            .find("fn find_jarvis_server() -> Option<String> {")
            .expect("find_jarvis_server must exist in lib.rs");
        let rest = &SOURCE[start..];
        let end = rest
            .find("/// Async health probe with a local fast path.")
            .expect("probe_jarvis_healthy must follow find_jarvis_server");
        let body = &rest[..end];

        for forbidden in ["index.ts", "home-base-recovered", "USERPROFILE", "wsl.exe"] {
            assert!(
                !body.contains(forbidden),
                "find_jarvis_server must not reference {forbidden}; a packaged \
                 install that finds no bundle must return None:\n{body}"
            );
        }
    }
}

#[cfg(test)]
mod ollama_binary_lookup_tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A Windows-shaped environment: no `HOME`, the per-user install root the
    /// Windows installer uses, and a `PATH` with two directories.
    const LOCAL_APP_DATA: &str = r"C:\Users\ethan\AppData\Local";
    const PATH_VALUE: &str = r"C:\Tools;C:\Program Files\Ollama";

    fn windows_env(explicit: Option<&str>) -> impl Fn(&str) -> Option<String> + '_ {
        move |key| match key {
            "JARVIS_OLLAMA_BIN" => explicit.map(str::to_string),
            "LOCALAPPDATA" => Some(LOCAL_APP_DATA.to_string()),
            "PATH" => Some(PATH_VALUE.to_string()),
            _ => None,
        }
    }

    fn windows_install() -> PathBuf {
        PathBuf::from(LOCAL_APP_DATA)
            .join("Programs")
            .join("Ollama")
            .join("ollama.exe")
    }

    fn on_path(directory: &str) -> PathBuf {
        PathBuf::from(directory).join("ollama.exe")
    }

    /// Reads `true` only for the exact paths listed, like a filesystem holding
    /// just those files.
    fn only_files(paths: &[PathBuf]) -> impl Fn(&Path) -> bool + '_ {
        move |candidate: &Path| paths.iter().any(|path| path == candidate)
    }

    #[test]
    fn candidates_cover_the_windows_install_and_every_path_entry() {
        let candidates = ollama_candidate_paths(windows_env(None), ';', "ollama.exe");

        assert!(
            candidates.contains(&windows_install()),
            "the per-user Windows install location must be searched: {candidates:?}"
        );
        for directory in [r"C:\Tools", r"C:\Program Files\Ollama"] {
            assert!(
                candidates.contains(&on_path(directory)),
                "PATH directory {directory} must be searched for ollama.exe: {candidates:?}"
            );
        }
    }

    #[test]
    fn explicit_override_wins_over_the_install_and_path() {
        let explicit = r"D:\custom\ollama.exe";
        let mut existing = vec![windows_install()];
        existing.push(on_path(r"C:\Tools"));
        existing.push(on_path(r"C:\Program Files\Ollama"));
        existing.push(PathBuf::from(explicit));

        let found = find_ollama_binary_with(
            windows_env(Some(explicit)),
            ';',
            "ollama.exe",
            only_files(&existing),
        );

        assert_eq!(
            found.as_deref(),
            Some(explicit),
            "JARVIS_OLLAMA_BIN must stay the first candidate"
        );
    }

    #[test]
    fn a_native_windows_install_is_found_without_the_binary_being_on_path() {
        let existing = vec![windows_install()];

        let found = find_ollama_binary_with(
            windows_env(None),
            ';',
            "ollama.exe",
            only_files(&existing),
        );

        assert_eq!(
            found,
            Some(windows_install().to_string_lossy().into_owned()),
            "a default Windows install that is not on PATH must still resolve"
        );
    }

    #[test]
    fn a_binary_only_on_path_is_resolved_from_a_path_entry() {
        let existing = vec![on_path(r"C:\Program Files\Ollama")];

        let found = find_ollama_binary_with(
            windows_env(None),
            ';',
            "ollama.exe",
            only_files(&existing),
        );

        assert_eq!(
            found,
            Some(on_path(r"C:\Program Files\Ollama").to_string_lossy().into_owned()),
            "a PATH install must resolve when the default install dir is absent"
        );
    }

    #[test]
    fn a_miss_names_every_searched_location_and_reaches_the_health_counter() {
        let candidates = ollama_candidate_paths(windows_env(None), ';', "ollama.exe");
        let diagnostic = ollama_missing_binary_diagnostic(&candidates);

        assert_eq!(
            find_ollama_binary_with(windows_env(None), ';', "ollama.exe", |_| false),
            None,
            "an empty filesystem must miss"
        );
        for expected in [
            windows_install(),
            on_path(r"C:\Tools"),
            on_path(r"C:\Program Files\Ollama"),
        ] {
            let expected = expected.display().to_string();
            assert!(
                diagnostic.contains(&expected),
                "the miss must name {expected} so the health error is actionable: {diagnostic}"
            );
        }
        assert!(
            diagnostic.contains("JARVIS_OLLAMA_BIN"),
            "the miss must point at the override: {diagnostic}"
        );

        let health_counter = AtomicU32::new(0);
        let failures = record_ollama_startup_failure(&health_counter, &diagnostic);
        assert_eq!(failures, 1);
        assert_eq!(
            health_counter.load(Ordering::Relaxed),
            1,
            "a failed lookup must land on the counter get_system_health reads"
        );
        assert_eq!(record_ollama_startup_failure(&health_counter, &diagnostic), 2);
    }

    /// The pure tests above prove the lookup and the counter; this reads the
    /// boot path to prove the miss is actually routed there instead of dying in
    /// an `eprintln!`.
    #[test]
    fn the_boot_path_reports_ollama_failures_through_the_health_counter() {
        const SOURCE: &str = include_str!("lib.rs");
        let start = SOURCE
            .find("pub(crate) async fn start_ollama_and_warm(")
            .expect("start_ollama_and_warm must exist in lib.rs");
        let rest = &SOURCE[start..];
        let end = rest
            .find("/// Start the configured local llama.cpp server")
            .expect("the llama.cpp starter must follow start_ollama_and_warm");
        let body = &rest[..end];

        assert!(
            body.contains("report_ollama_startup_failure(&error)"),
            "the Ollama start error arm must report to the health counter:\n{body}"
        );
        assert!(
            !body.contains(r#"eprintln!("[Jarvis] Ollama startup failed"#),
            "the health surface must replace the eprintln-only failure:\n{body}"
        );
    }
}

/// DD-065: overlapping warm requests must not stack background threads that
/// each block for up to 180 s, while a warm that has finished must still let
/// the next call warm again. These tests drive the guard directly; no Ollama
/// process, port, or HTTP client is involved.
#[cfg(test)]
mod ollama_warm_guard_tests {
    use super::OllamaWarmGuard;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn an_in_flight_warm_is_not_stacked_and_a_finished_warm_runs_again() {
        let in_flight = Arc::new(AtomicBool::new(false));
        let workers = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel::<()>();

        // First caller: acquire then hand the guard to the worker, exactly as
        // `start_ollama_and_warm` does before `thread::spawn`.
        let first = {
            let guard = OllamaWarmGuard::try_acquire(&in_flight)
                .expect("the first caller must acquire the warm guard");
            let workers = Arc::clone(&workers);
            std::thread::spawn(move || {
                let _guard = guard;
                workers.fetch_add(1, Ordering::SeqCst);
                started_tx.send(()).expect("test receiver must be alive");
                // Stand in for `warm_model` blocking for up to 180 s.
                let _ = finish_rx.recv();
            })
        };
        started_rx.recv().expect("the first worker must start");

        assert!(
            OllamaWarmGuard::try_acquire(&in_flight).is_none(),
            "a second caller must not spawn a second warm worker while one is in flight"
        );
        assert_eq!(
            workers.load(Ordering::SeqCst),
            1,
            "only one warm worker may be started while the warm is in flight"
        );

        finish_tx.send(()).expect("the first worker must be alive");
        first.join().expect("the first warm worker must exit cleanly");

        let later = OllamaWarmGuard::try_acquire(&in_flight)
            .expect("a completed warm must release the guard so a later call can warm again");
        drop(later);
        assert!(
            !in_flight.load(Ordering::Acquire),
            "dropping the guard must clear the in-flight flag"
        );
        assert_eq!(
            workers.load(Ordering::SeqCst),
            1,
            "the later call must acquire the guard without a second worker starting here"
        );
    }
}

#[cfg(test)]
mod first_run_db_failure_tests {
    use super::db_open_failure_diagnostic;
    use std::path::Path;

    /// A first run that cannot open `jarvis.db` must report the database path
    /// and the underlying error — not an empty or opaque message — because the
    /// process exits immediately and this text is the whole explanation.
    #[test]
    fn the_boot_diagnostic_names_the_database_path_and_the_error() {
        let db_path = Path::new(r"C:\Users\ethan\.local\share\com.jarvis.desktop\jarvis.db");
        let error = "Failed to open database: Access is denied. (os error 5)";

        let diagnostic = db_open_failure_diagnostic(db_path, error);

        assert!(
            !diagnostic.trim().is_empty(),
            "a fail-closed boot must explain itself"
        );
        assert!(
            diagnostic.contains(&db_path.display().to_string()),
            "the diagnostic must name the database path it tried to open: {diagnostic}"
        );
        assert!(
            diagnostic.contains("Access is denied. (os error 5)"),
            "the diagnostic must carry the underlying error: {diagnostic}"
        );
    }
}

#[cfg(test)]
mod wsl_server_command_tests {
    use super::wsl_server_command;

    /// The word-splitting rule bash applies before it decides what to `exec`:
    /// whitespace separates words unless it is inside single quotes, and a
    /// backslash outside quotes escapes the next character.
    fn bash_words(command: &str) -> Vec<String> {
        let mut words = Vec::new();
        let mut word = String::new();
        let mut started = false;
        let mut quoted = false;
        let mut escaped = false;
        for ch in command.chars() {
            if escaped {
                word.push(ch);
                escaped = false;
            } else if ch == '\\' && !quoted {
                escaped = true;
                started = true;
            } else if ch == '\'' {
                quoted = !quoted;
                started = true;
            } else if ch.is_whitespace() && !quoted {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            } else {
                word.push(ch);
                started = true;
            }
        }
        if started {
            words.push(word);
        }
        words
    }

    /// A Windows install path is what the WSL fallback is handed on a machine
    /// without the native toolchain (DD-T1). The unquoted `exec {bun} {entry}`
    /// this replaced gave bash `C:Usersethan...` — one token, unopenable.
    #[test]
    fn a_windows_bun_and_entry_reach_bash_as_openable_single_words() {
        let bun = r"C:\Users\ethan\.bun\bin\bun.exe";
        let entry = r"C:\Users\ethan\AppData\Local\Jarvis\resources\server-jarvis\index.js";

        let words = bash_words(&wsl_server_command(bun, entry));

        assert_eq!(
            words,
            vec![
                "exec".to_string(),
                "/mnt/c/Users/ethan/.bun/bin/bun.exe".to_string(),
                "/mnt/c/Users/ethan/AppData/Local/Jarvis/resources/server-jarvis/index.js"
                    .to_string(),
            ],
            "bash must receive two paths it can open, one word each"
        );
    }

    /// An install directory with spaces must not split the entry into several
    /// arguments; bash would then run bun with the wrong script.
    #[test]
    fn a_path_with_spaces_stays_one_argument() {
        let bun = "/mnt/c/Users/Ethan Smith/.bun/bin/bun";
        let entry = r"C:\Program Files\Jarvis\resources\server-jarvis\index.js";

        let words = bash_words(&wsl_server_command(bun, entry));

        assert_eq!(
            words,
            vec![
                "exec".to_string(),
                "/mnt/c/Users/Ethan Smith/.bun/bin/bun".to_string(),
                "/mnt/c/Program Files/Jarvis/resources/server-jarvis/index.js".to_string(),
            ],
            "a space inside a path must stay inside that argument"
        );
    }

    /// `find_bun_executable` returns `$HOME/.bun/bin/bun` on Windows when it
    /// cannot find a native install; the guest shell still has to expand it.
    #[test]
    fn a_wsl_relative_bun_still_expands_in_the_guest_shell() {
        let command = wsl_server_command(
            "$HOME/.bun/bin/bun",
            "$HOME/jarvis/server-jarvis/index.ts",
        );

        assert_eq!(
            command,
            "exec $HOME/.bun/bin/bun $HOME/jarvis/server-jarvis/index.ts"
        );
        assert!(
            !command.contains('\''),
            "quoting $HOME would stop the guest shell expanding it: {command}"
        );
    }
}
