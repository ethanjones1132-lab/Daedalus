pub mod commands;
pub mod cron_scheduler;
pub mod db;
pub mod jarvis;
pub mod notifications;
pub mod parsers;
mod process_lifecycle;
mod bun_startup_policy;
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
// the native HOME env var on Linux/macOS.  Result is cached for the process lifetime.

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
                "/home/ethan".to_string()
            } else {
                std::env::var("HOME").unwrap_or_else(|_| "/home/ethan".to_string())
            }
        })
        .clone()
}

// ─── Ollama + Claude-CLI Proxy Auto-Start ────────────────────────────────────
// Two extra child processes that must outlive setup() but die on app exit:
//   • Ollama serve  (port 11434) — runs the local model
//   • claude_cli_proxy.py (port 19878) — Anthropic /v1/messages -> claude CLI
// Both are spawned lazily off the main thread so the window paints fast.

fn find_ollama_binary() -> Option<String> {
    [
        std::env::var("JARVIS_OLLAMA_BIN").ok(),
        Some(format!(
            "{}/.local/bin/ollama",
            std::env::var("HOME").unwrap_or_default()
        )),
        Some("/usr/local/bin/ollama".into()),
        Some("/usr/bin/ollama".into()),
    ]
    .into_iter()
    .flatten()
    .find(|p| std::path::Path::new(p).exists())
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
fn probe_python_command(
    command: &mut std::process::Command,
    timeout: std::time::Duration,
) -> bool {
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

fn spawn_ollama() -> Option<std::process::Child> {
    use std::process::{Command, Stdio};
    let bin = find_ollama_binary()?;
    let mut command = Command::new(&bin);
    command
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::wsl::hide_windows_console(&mut command);
    let child = process_lifecycle::spawn_managed(&mut command).ok()?;
    println!("[Jarvis] Ollama started (PID {}, bin {})", child.id(), bin);
    Some(child)
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
    if is_port_listening(11434) {
        println!("[Jarvis] Ollama already running on port 11434");
    } else {
        let launch = process_lifecycle::launch(
            process_lifecycle::ManagedProcess::Ollama,
            true,
            || {
                if is_port_listening(11434) {
                    return Err(
                        "Ollama port 11434 is occupied by a process this app does not own; leaving it untouched".into(),
                    );
                }
                spawn_ollama().ok_or_else(|| "could not spawn Ollama".to_string())
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
                eprintln!("[Jarvis] Ollama startup failed: {error}");
                return;
            }
        }
        let mut ready = false;
        for _ in 0..30 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if is_port_listening(11434) {
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
    std::thread::spawn(move || warm_model(model));
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
    if is_port_listening(config.port) {
        return Ok(process_lifecycle::StartOutcome::AlreadyListening);
    }

    let config = config.with_env_fallbacks();
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
        return Err(format!("llama-server executable not found: {}", server_path.display()));
    }
    if !model_path.is_file() {
        return Err(format!("llama.cpp model GGUF not found: {}", model_path.display()));
    }
    let mtp_head_exists = mtp_path.is_file();
    if mtp_path.as_os_str().is_empty() {
        println!("[Daedalus] no separate MTP head configured; draft-mtp uses the model's embedded MTP layer");
    } else if !mtp_head_exists {
        eprintln!("[Daedalus] MTP head not found at {}; starting without draft-mtp", mtp_path.display());
    }
    let server_args = config.server_args(mtp_head_exists);

    let outcome = process_lifecycle::launch(
        process_lifecycle::ManagedProcess::LlamaCpp,
        false,
        || {
            if is_port_listening(config.port) {
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
                format!("failed to spawn llama-server {}: {error}", server_path.display())
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
        let normalized = if required.contains(&base) { base } else { entry };
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

fn configure_proxy_runtime(
    command: &mut std::process::Command,
    model: &str,
    through_wsl: bool,
) {
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
static PROXY_USES_WSL: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub(crate) fn claude_proxy_is_listening() -> bool {
    local_port_is_listening(CLAUDE_PROXY_PORT)
        || (PROXY_USES_WSL.load(std::sync::atomic::Ordering::Relaxed)
            && is_wsl_port_listening(CLAUDE_PROXY_PORT))
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
        let Some(local_addr) = cols.get(1) else { continue };
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
    let Ok(output) = std::process::Command::new("netstat").args(["-ano"]).output() else {
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
        assert!(!NETSTAT_FIXTURE.lines().any(|l| l.contains("53872") && l.contains("LISTENING")));
    }

    #[test]
    fn empty_output_yields_no_pids() {
        assert_eq!(parse_listening_pids("", 19878), Vec::<u32>::new());
    }

    #[test]
    fn a_port_with_nothing_listening_yields_no_pids() {
        assert_eq!(parse_listening_pids(NETSTAT_FIXTURE, 60000), Vec::<u32>::new());
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

    process_lifecycle::launch(
        process_lifecycle::ManagedProcess::ClaudeProxy,
        false,
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
    process_lifecycle::launch(process_lifecycle::ManagedProcess::ClaudeProxy, true, || {
        if claude_proxy_is_listening() {
            return Err(format!(
                    "Claude proxy port {CLAUDE_PROXY_PORT} remains occupied by a listener this app does not own; leaving it untouched"
                ));
        }
        spawn_claude_cli_proxy_child(script, py, ollama_model, openrouter_api_key)
    })
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
    configure_proxy_credential(
        &mut command,
        &openrouter_api_key,
        through_wsl,
    );
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
    fixed_windows_path: std::path::PathBuf,
    user_profile: Option<std::path::PathBuf>,
    wsl_candidates: Vec<std::path::PathBuf>,
}

fn ancestry_proxy_script(start: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut cursor = if start.is_dir() {
        Some(start.to_path_buf())
    } else {
        start.parent().map(std::path::Path::to_path_buf)
    };
    for _ in 0..8 {
        let Some(dir) = cursor.as_ref() else { break };
        let candidate = dir.join("scripts").join("claude_cli_proxy.py");
        if candidate.exists() {
            return Some(candidate);
        }
        cursor = dir.parent().map(std::path::Path::to_path_buf);
    }
    None
}

fn find_claude_cli_proxy_with(
    context: &ProxyDiscoveryContext,
    mut wsl_exists: impl FnMut(&std::path::Path) -> bool,
) -> Option<ProxyScript> {
    if let Some(path) = context.override_path.as_ref().filter(|path| path.exists()) {
        return Some(ProxyScript {
            path: path.clone(),
            kind: ProxyScriptKind::Native,
        });
    }
    if let Some(exe_dir) = context
        .exe_path
        .as_deref()
        .and_then(std::path::Path::parent)
    {
        let path = exe_dir.join("resources").join("claude_cli_proxy.py");
        if path.exists() {
            return Some(ProxyScript {
                path,
                kind: ProxyScriptKind::Native,
            });
        }
    }
    for start in [context.exe_path.as_deref(), context.cwd.as_deref()]
        .into_iter()
        .flatten()
    {
        if let Some(path) = ancestry_proxy_script(start) {
            return Some(ProxyScript {
                path,
                kind: ProxyScriptKind::Native,
            });
        }
    }
    if context.fixed_windows_path.exists() {
        return Some(ProxyScript {
            path: context.fixed_windows_path.clone(),
            kind: ProxyScriptKind::Native,
        });
    }
    if let Some(profile) = &context.user_profile {
        let path = profile
            .join(".openclaw")
            .join("jarvis")
            .join("hermes")
            .join("claude_cli_proxy.py");
        if path.exists() {
            return Some(ProxyScript {
                path,
                kind: ProxyScriptKind::Native,
            });
        }
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
    let native = ProxyDiscoveryContext {
        override_path: std::env::var_os("JARVIS_CLAUDE_PROXY_PATH").map(Into::into),
        exe_path: std::env::current_exe().ok(),
        cwd: std::env::current_dir().ok(),
        fixed_windows_path: r"C:\Projects\home-base-recovered\scripts\claude_cli_proxy.py".into(),
        user_profile: std::env::var_os("USERPROFILE").map(Into::into),
        wsl_candidates: Vec::new(),
    };
    if let Some(script) = find_claude_cli_proxy_with(&native, |_| false) {
        return Some(script);
    }

    let home = wsl_home();
    let wsl = ProxyDiscoveryContext {
        override_path: None,
        exe_path: None,
        cwd: None,
        fixed_windows_path: std::path::PathBuf::new(),
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

fn find_jarvis_server() -> Option<String> {
    // Explicit override — useful for dev without WSL.
    if let Ok(path) = std::env::var("JARVIS_SERVER_PATH") {
        if std::path::Path::new(&path).exists() {
            println!("[Jarvis] Using JARVIS_SERVER_PATH override: {}", path);
            return Some(path);
        }
    }

    // Bundled server next to the EXE (production installer / cargo tauri build).
    #[cfg(target_os = "windows")]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for cand in [
                    dir.join("index.js"),
                    dir.join("resources").join("index.js"),
                    dir.join("server-jarvis").join("dist").join("index.js"),
                    dir.join("server.js"),
                ] {
                    if cand.exists() {
                        return Some(cand.to_string_lossy().into_owned());
                    }
                }
            }
        }

        // Walk up the current_exe ancestry looking for a repo-rooted
        // server-jarvis. This catches `cargo tauri build` outputs that
        // ended up under target/.../home-base.exe and dev runs that point
        // at a sibling checkout, without hardcoding the home path.
        if let Ok(exe) = std::env::current_exe() {
            let mut cursor = exe.parent().map(|p| p.to_path_buf());
            for _ in 0..8 {
                let Some(dir) = cursor.as_ref() else { break };
                for rel in ["server-jarvis/dist/index.js", "server-jarvis/src/index.ts"] {
                    let cand = dir.join(rel);
                    if cand.exists() {
                        return Some(cand.to_string_lossy().into_owned());
                    }
                }
                match dir.parent() {
                    Some(p) => cursor = Some(p.to_path_buf()),
                    None => break,
                }
            }
        }

        // Same check relative to CWD — useful when the binary is launched
        // from a sibling of the repo (e.g. `target\release\home-base.exe`
        // run from the repo root, or from a CI workspace).
        if let Ok(cwd) = std::env::current_dir() {
            let mut cursor = Some(cwd);
            for _ in 0..8 {
                let Some(dir) = cursor.as_ref() else { break };
                for rel in ["server-jarvis/dist/index.js", "server-jarvis/src/index.ts"] {
                    let cand = dir.join(rel);
                    if cand.exists() {
                        return Some(cand.to_string_lossy().into_owned());
                    }
                }
                match dir.parent() {
                    Some(p) => cursor = Some(p.to_path_buf()),
                    None => break,
                }
            }
        }

        // Windows-native dev tree locations (no WSL required).
        // Checked in order; first existing path wins.
        let dev_candidates: &[&str] =
            &[r"C:\Projects\home-base-recovered\server-jarvis\src\index.ts"];
        for cand in dev_candidates {
            if std::path::Path::new(cand).exists() {
                println!("[Jarvis] Found server at native dev path: {}", cand);
                return Some(cand.to_string());
            }
        }

        // Standard user-level openclaw install (Windows without WSL).
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            let user_server = std::path::PathBuf::from(profile)
                .join(".openclaw")
                .join("jarvis")
                .join("server-jarvis")
                .join("src")
                .join("index.ts");
            if user_server.exists() {
                return Some(user_server.to_string_lossy().into_owned());
            }
        }
    }

    let home = wsl_home();
    let base = format!(
        "{}/.openclaw/agents/coderclaw/workspace/home-base/server-jarvis/src/index.ts",
        home
    );
    let exists = if cfg!(target_os = "windows") {
        let mut cmd = std::process::Command::new("wsl.exe");
        cmd.args(["--", "test", "-f", &base]);
        crate::wsl::command_output_timeout(cmd, std::time::Duration::from_secs(15))
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        std::path::Path::new(&base).exists()
    };
    if exists {
        Some(base)
    } else {
        None
    }
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
        if let Ok(Ok(resp)) =
            tokio::time::timeout(std::time::Duration::from_secs(2), client.get(&probe).send()).await
        {
            if resp.status().is_success() {
                crate::wsl::set_cached_bun_url(trimmed);
                return true;
            }
        }
    }
    false
}

fn find_bun_executable() -> String {
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

fn spawn_jarvis_server(entry: &str) -> Result<std::process::Child, String> {
    let bun = find_bun_executable();
    let is_windows = cfg!(target_os = "windows");
    let looks_like_local_bun =
        is_windows && bun.to_lowercase().ends_with(".exe") && !bun.contains("wsl");

    // Owned-process authority: only this spawned child receives the private
    // capability and app instance id. Never logged, never persisted to config.
    let (cap_name, cap_value, app_name, app_value) =
        crate::jarvis::memory::transport::owned_memory_env();

    let spawn_result = if is_windows && !looks_like_local_bun {
        // Original WSL path for dev / full WSL setups.
        let cmd = format!("exec {} {}", bun, entry);
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

fn bun_uses_wsl() -> bool {
    cfg!(target_os = "windows") && !find_bun_executable().to_ascii_lowercase().ends_with(".exe")
}

/// Port-only check used by the supervisor. Native desktop launches do not
/// start `wsl.exe` just to learn that the local Bun listener is absent.
pub(crate) fn bun_server_is_listening() -> bool {
    if local_port_is_listening(BUN_SERVER_PORT) {
        return true;
    }
    bun_uses_wsl() && is_wsl_port_listening(BUN_SERVER_PORT)
}

fn start_jarvis_server(
    entry: &str,
    replace: bool,
) -> Result<process_lifecycle::StartOutcome, String> {
    let entry = entry.to_string();
    process_lifecycle::launch(
        process_lifecycle::ManagedProcess::BunServer,
        replace,
        || {
            if bun_server_is_listening() {
                return Err(format!(
                    "Bun port {BUN_SERVER_PORT} is occupied by a listener this app does not own; leaving it untouched"
                ));
            }
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

    // 3. Replace only the child owned by this app. An unrelated listener on
    //    :19877 is reported and left untouched.
    let spawn_result =
        spawn_blocking_on_current_runtime(move || start_jarvis_server(&server_entry, true))
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
    Err("Bun server did not become healthy within 20s of restart".to_string())
}

/// Why a startup attempt failed. `TimedOut` is kept distinct so the caller can
/// attach host-specific diagnostics (Windows ghost sockets) without the driver
/// knowing about ports or processes.
#[derive(Debug, PartialEq, Eq)]
enum StartupFailure {
    Spawn(String),
    TimedOut,
}

/// The owned-child startup sequence with every out-of-process effect injected.
///
/// Ordering is the point: when the native listener is closed and no configured
/// endpoint can live outside it, an HTTP probe cannot succeed, so the owned
/// child is spawned before any probe budget is spent. An open listener, a
/// configured remote/WSL endpoint, or a WSL-launched Bun keeps the probe-first
/// path and the open-listener second chance. The child is always verified
/// healthy afterwards; spawning alone is not success.
async fn drive_jarvis_server_start<P, PF, D, DF, L, S, SF, E, M>(
    remote_endpoint_requires_probe: bool,
    probe_healthy: P,
    delay: D,
    listener_present: L,
    spawn_owned_child: S,
    elapsed_since_spawn: E,
    mark_healthy: M,
) -> Result<(), StartupFailure>
where
    P: Fn() -> PF,
    PF: std::future::Future<Output = bool>,
    D: Fn(u64) -> DF,
    DF: std::future::Future<Output = ()>,
    L: Fn() -> bool,
    S: Fn() -> SF,
    SF: std::future::Future<Output = Result<(), String>>,
    E: Fn() -> u64,
    M: Fn(),
{
    const SPAWN_HEALTH_BUDGET_MS: u64 = 20_000;

    // Remote/WSL endpoints keep their probe-first order: a closed native
    // listener says nothing about them, and a reachable remote endpoint must
    // not even pay a native/WSL listener probe.
    if remote_endpoint_requires_probe && probe_healthy().await {
        mark_healthy();
        return Ok(());
    }

    let listener_open = listener_present();
    if !remote_endpoint_requires_probe && listener_open && probe_healthy().await {
        mark_healthy();
        return Ok(());
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
            return Ok(());
        }
        log::warn!(
            target: "jarvis::startup",
            "Bun port open but /health still failing — replacing the tracked child"
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
    // handle are never terminated by startup recovery.
    spawn_owned_child()
        .await
        .map_err(StartupFailure::Spawn)?;
    log::info!(target: "jarvis::startup", "Bun child spawn returned");

    // Wait (off the main thread) for the freshly spawned server to come up.
    while elapsed_since_spawn() < SPAWN_HEALTH_BUDGET_MS {
        if probe_healthy().await {
            mark_healthy();
            return Ok(());
        }
        delay(500).await;
    }
    Err(StartupFailure::TimedOut)
}

pub async fn ensure_jarvis_server_started() -> Result<(), String> {
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
        return Ok(());
    }

    // Only one probe/spawn sequence at a time; queued callers fall through to the
    // re-check below and return immediately once the first call succeeds.
    let lock = BUN_ENSURE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;
    if fresh() {
        return Ok(());
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
        bun_server_is_listening,
        move || {
            let spawn_clock = Arc::clone(&spawn_clock);
            async move {
                let server_entry = find_jarvis_server()
                    .ok_or_else(|| "server-jarvis index.ts not found".to_string())?;
                log::info!(target: "jarvis::startup", "Bun server entry resolved: {server_entry}");
                spawn_blocking_on_current_runtime(move || {
                    start_jarvis_server(&server_entry, true)
                })
                .await
                .map_err(|e| format!("Task join error: {}", e))??;
                *spawn_clock
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = std::time::Instant::now();
                Ok::<(), String>(())
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
        Ok(()) => Ok(()),
        Err(StartupFailure::Spawn(error)) => Err(error),
        Err(StartupFailure::TimedOut) => {
            // Surface the ghost-socket case explicitly — a generic timeout leaves the
            // operator hunting EADDRINUSE in err logs with no recovery path.
            let ghosts = ghost_pids_holding_port(BUN_SERVER_PORT);
            if !ghosts.is_empty() {
                let diagnostic = bun_port_ghost_diagnostic(BUN_SERVER_PORT, &ghosts);
                log::error!(target: "jarvis::startup", "{diagnostic}");
                return Err(diagnostic);
            }
            Err("Bun server did not become healthy within timeout".to_string())
        }
    }
}

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

pub fn get_home_dir() -> String {
    if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| "C:\\Users\\ethan".to_string())
    } else {
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| "/home/ethan".to_string())
    }
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
    let app_data_dir =
        std::path::PathBuf::from(&home).join(".local/share/com.jarvis.desktop");

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
            eprintln!(
                "[Jarvis] Failed to open DB at {:?}: {}",
                app_data_dir.join("jarvis.db"),
                e
            );
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
            if let tauri::RunEvent::ExitRequested { .. } = event {
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
            fixed_windows_path: root.join("missing/claude_cli_proxy.py"),
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
        let destination = root.join("release").join("resources").join("claude_cli_proxy.py");
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
        assert!(build.contains(
            "Deploy-File $proxyModelsJson 'resources\\opencode_go_openai_models.json'"
        ));
        assert!(build.contains("claude_proxy_sha256 ="));
        assert!(build.contains("opencode_go_models_sha256 ="));

        let verify = include_str!("../../scripts/verify-deploy.ps1");
        assert!(verify.contains("'resources\\claude_cli_proxy.py'"));
        assert!(verify.contains("$manifest.claude_proxy_sha256"));
        assert!(verify.contains("'resources\\opencode_go_openai_models.json'"));

        let build_helper = include_str!("../build.rs").replace("\r\n", "\n");
        assert!(build_helper.contains("cargo:rerun-if-changed=../scripts/claude_cli_proxy.py"));
        assert!(build_helper.contains("cargo:rerun-if-changed=../scripts/opencode_go_openai_models.json"));
        assert!(build_helper.contains(
            "let proxy_dest = release_dir.join(\"resources\").join(\"claude_cli_proxy.py\")"
        ));
        assert!(build_helper.contains(
            "release_resource_staging::copy_if_different(&proxy_src, &proxy_dest)"
        ));
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

    async fn run_driver(
        effects: &Effects,
        remote_endpoint_requires_probe: bool,
        listener_open: bool,
        spawn_succeeds: bool,
    ) -> Result<(), StartupFailure> {
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
                    async move {
                        effects.note("spawn");
                        if spawn_succeeds {
                            effects.set_healthy(true);
                            Ok(())
                        } else {
                            Err("spawn failed".to_string())
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

    #[tokio::test]
    async fn closed_native_listener_spawns_before_any_pre_spawn_http_probe() {
        let effects = Effects::default();
        effects.push_elapsed(0);
        let outcome = run_driver(&effects, false, false, true).await;

        assert_eq!(outcome, Ok(()));
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

        assert_eq!(outcome, Ok(()));
        assert_eq!(effects.snapshot(), vec!["listen", "probe", "healthy"]);
    }

    #[tokio::test]
    async fn open_but_unhealthy_listener_gets_a_second_health_chance() {
        let effects = Effects::default();
        effects.push_probe(false);
        effects.push_probe(true);
        let outcome = run_driver(&effects, false, true, true).await;

        assert_eq!(outcome, Ok(()));
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

        assert_eq!(outcome, Ok(()));
        assert_eq!(
            effects.snapshot(),
            vec![
                "listen", "probe", "delay:750", "probe", "spawn", "probe", "healthy"
            ]
        );
    }

    #[tokio::test]
    async fn closed_port_with_a_healthy_remote_endpoint_never_spawns() {
        let effects = Effects::default();
        effects.push_probe(true);
        let outcome = run_driver(&effects, true, false, true).await;

        assert_eq!(outcome, Ok(()));
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

        assert_eq!(outcome, Ok(()));
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
                            Ok::<(), String>(())
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
