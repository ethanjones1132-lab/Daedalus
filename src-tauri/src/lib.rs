pub mod commands;
pub mod cron_scheduler;
pub mod db;
pub mod jarvis;
pub mod parsers;
pub mod supervisor;
pub mod types;
pub mod wsl;

pub use commands::*;
pub use jarvis::types as jarvis_types;

use crate::jarvis::hermes::commands::{
    hermes_interrupt, hermes_invoke, hermes_restart, hermes_shutdown, hermes_spawn, hermes_status,
};
use crate::jarvis::hermes::state::HermesAppState;
use jarvis::types::JarvisState;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

// ─── Jarvis Bun Server Auto-Start ────────────────────────────────────────────

pub(crate) static SERVER_PROCESS: std::sync::OnceLock<
    std::sync::Mutex<Option<std::process::Child>>,
> = std::sync::OnceLock::new();

#[allow(dead_code)]
pub(crate) static SERVER_SPAWNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

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

pub(crate) static OLLAMA_PROCESS: std::sync::OnceLock<
    std::sync::Mutex<Option<std::process::Child>>,
> = std::sync::OnceLock::new();
pub(crate) static PROXY_PROCESS: std::sync::OnceLock<
    std::sync::Mutex<Option<std::process::Child>>,
> = std::sync::OnceLock::new();

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
struct PythonInvocation {
    program: std::path::PathBuf,
    prefix_args: Vec<String>,
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

fn find_jarvis_python() -> Option<PythonInvocation> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from);
    find_jarvis_python_with(home.as_deref(), |candidate| {
        let mut command = std::process::Command::new(&candidate.program);
        command
            .args(&candidate.prefix_args)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        crate::wsl::hide_windows_console(&mut command);
        command
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    })
}

fn build_hermes_config() -> crate::jarvis::hermes::process::HermesConfig {
    use std::path::PathBuf;
    let mut config = crate::jarvis::hermes::process::HermesConfig::default();
    if let Some(py) = find_jarvis_python() {
        config.python = py.program;
    }
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        config.hermes_home = PathBuf::from(home)
            .join(".openclaw")
            .join("jarvis")
            .join("hermes");
    }
    config
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
    let child = command.spawn().ok()?;
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
    let model = if model.is_empty() {
        "qwen3:8b".to_string()
    } else {
        model
    };
    if is_port_listening(11434) {
        println!("[Jarvis] Ollama already running on port 11434");
    } else if let Some(child) = spawn_ollama() {
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
        if let Some(m) = OLLAMA_PROCESS.get() {
            if let Ok(mut g) = m.lock() {
                *g = Some(child);
            }
        }
    }
    // Warm the model off the async runtime so we don't block the boot task.
    std::thread::spawn(move || warm_model(model));
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
) {
    tauri::async_runtime::spawn(async move {
        if matches!(backend, crate::jarvis::types::JarvisBackend::Ollama) {
            start_ollama_and_warm(ollama_model).await;
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
        let mut forwarded = std::env::var("WSLENV")
            .unwrap_or_default()
            .split(':')
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if !forwarded.iter().any(|name| name == KEY) {
            forwarded.push(KEY.to_string());
        }
        command.env("WSLENV", forwarded.join(":"));
    }
}

pub(crate) fn spawn_claude_cli_proxy(
    ollama_model: String,
    openrouter_api_key: String,
) -> Option<std::process::Child> {
    use std::process::Command;
    let script = find_claude_cli_proxy()?;
    let py = match script.kind {
        ProxyScriptKind::Native => find_jarvis_python()?,
        ProxyScriptKind::Wsl => PythonInvocation {
            program: "wsl.exe".into(),
            prefix_args: vec!["--".to_string(), "python3".to_string()],
        },
    };
    let model = if ollama_model.is_empty() {
        "qwen3:8b".to_string()
    } else {
        ollama_model
    };
    let mut command = Command::new(&py.program);
    command
        .args(&py.prefix_args)
        .arg(&script.path)
        .env("JARVIS_CLAUDE_PROXY_PORT", "19878")
        .env("JARVIS_OLLAMA_URL", "http://127.0.0.1:11434")
        .env("JARVIS_DEFAULT_MODEL", &model)
        .stdout(jarvis_server_log_stdio("claude-proxy.log"))
        .stderr(jarvis_server_log_stdio("claude-proxy.err.log"));
    configure_proxy_credential(
        &mut command,
        &openrouter_api_key,
        matches!(script.kind, ProxyScriptKind::Wsl),
    );
    crate::wsl::hide_windows_console(&mut command);
    let child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "[Jarvis] claude_cli_proxy spawn failed: {e} (interpreter={:?} {:?}, script={}, source={:?}, model={model})",
                py.program,
                py.prefix_args,
                script.path.display(),
                script.kind,
            );
            return None;
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
    Some(child)
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

/// Async health probe across candidate URLs. Uses a 2s per-probe timeout because
/// WSL2 localhost-forwarded first-connects routinely exceed sub-second latency —
/// the old 300ms blocking probe made the app wrongly conclude the server was down
/// even when it was reachable. Candidate generation (which may spawn `wsl.exe`)
/// runs on the blocking pool so it never stalls async workers. Caches the first
/// reachable URL.
async fn probe_jarvis_healthy() -> bool {
    let candidates = tokio::task::spawn_blocking(crate::wsl::jarvis_api_candidates)
        .await
        .unwrap_or_default();
    let client = reqwest::Client::new();
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
        return format!("{}/.bun/bin/bun", wsl_home());
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

fn spawn_jarvis_server(entry: &str) -> Option<std::process::Child> {
    let bun = find_bun_executable();
    let is_windows = cfg!(target_os = "windows");
    let looks_like_local_bun =
        is_windows && bun.to_lowercase().ends_with(".exe") && !bun.contains("wsl");

    let spawn_result = if is_windows && !looks_like_local_bun {
        // Original WSL path for dev / full WSL setups.
        let cmd = format!("exec {} {}", bun, entry);
        let mut command = std::process::Command::new("wsl.exe");
        command
            .args(["--", "bash", "-lc", &cmd])
            .stdout(jarvis_server_log_stdio("server-jarvis.log"))
            .stderr(jarvis_server_log_stdio("server-jarvis.err.log"));
        crate::wsl::hide_windows_console(&mut command);
        command.spawn()
    } else if looks_like_local_bun {
        // NEW: Native Windows execution using bundled/portable bun.exe + bundled server .js .
        // This path is taken for installers on new hardware (no WSL checkout needed).
        // The entry should be a .js (the one we added via tauri resources or placed next to exe).
        let mut command = std::process::Command::new(&bun);
        command
            .arg(entry)
            .stdout(jarvis_server_log_stdio("server-jarvis.log"))
            .stderr(jarvis_server_log_stdio("server-jarvis.err.log"));
        if should_hide_jarvis_server_console(is_windows, looks_like_local_bun) {
            crate::wsl::hide_windows_console(&mut command);
        }
        command.spawn()
    } else {
        let bun = find_bun_executable();
        std::process::Command::new(&bun)
            .arg(entry)
            .env("JARVIS_HOME", wsl_home())
            .stdout(jarvis_server_log_stdio("server-jarvis.log"))
            .stderr(jarvis_server_log_stdio("server-jarvis.err.log"))
            .spawn()
    };
    let child = match spawn_result {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Jarvis] Bun spawn failed: {e} (bun={bun}, entry={entry})");
            return None;
        }
    };
    println!("[Jarvis] Bun server spawned (PID {})", child.id());
    Some(child)
}

/// Force-restart the Bun server. Bypasses the HEALTHY_TTL fast-path in
/// `ensure_jarvis_server_started` (the symptom of "clicked restart, nothing
/// happened" when the server is actually down) and clears the supervisor's
/// consecutive-failure counter so the auto-restart loop stays healthy after
/// a user-driven restart. Returns a specific error string on failure so the
/// UI can show why (missing server bundle, spawn error, health timeout).
pub async fn force_restart_jarvis_server() -> Result<(), String> {
    // 1. Re-arm the supervisor so a subsequent auto-restart is allowed even
    //    if previous ticks drove the counter to the give-up cap.
    crate::supervisor::reset_failures(crate::supervisor::SupervisedService::Bun);

    // 2. Locate the server entry (the cheap part; surfaces a real error if
    //    the bundle is genuinely missing on this machine).
    let server_entry = find_jarvis_server().ok_or_else(|| {
        "server bundle not found (no index.js / index.ts beside the app or in the repo)".to_string()
    })?;

    // 3. Kill the tracked child (if any) and re-spawn off the runtime.
    let spawn_result: Result<(), String> = spawn_blocking_on_current_runtime(move || {
        if SERVER_PROCESS.get().is_none() {
            let _ = SERVER_PROCESS.set(std::sync::Mutex::new(None));
        }
        let m = SERVER_PROCESS
            .get()
            .ok_or("SERVER_PROCESS not initialized")?;
        let mut guard = m.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
        let child = spawn_jarvis_server(&server_entry).ok_or_else(|| {
            "Failed to spawn Bun server (see [Jarvis] logs above for the OS error)".to_string()
        })?;
        *guard = Some(child);
        Ok(())
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
    Err("Bun server did not become healthy within 20s of restart".to_string())
}

pub async fn ensure_jarvis_server_started() -> Result<(), String> {
    use std::sync::atomic::{AtomicI64, Ordering};
    // Last time the server was confirmed healthy (epoch ms). A short TTL lets the
    // many callers (boot + every frontend status poll) skip all probing/spawning.
    static LAST_HEALTHY_MS: AtomicI64 = AtomicI64::new(0);
    // Serializes the probe/spawn sequence so concurrent callers can't pile up
    // overlapping `wsl.exe` spawns and reqwest threads (the cause of the UI hang).
    static ENSURE_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
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
    let lock = ENSURE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;
    if fresh() {
        return Ok(());
    }

    // Already reachable? (2s timeout tolerates WSL2 localhost-forward latency.)
    if probe_jarvis_healthy().await {
        LAST_HEALTHY_MS.store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
        return Ok(());
    }

    // Not reachable — spawn the server once.
    log::info!(target: "jarvis::startup", "Bun health probe failed; locating server entry");
    if SERVER_PROCESS.get().is_none() {
        SERVER_PROCESS.set(std::sync::Mutex::new(None)).ok();
    }
    let server_entry = find_jarvis_server().ok_or("server-jarvis index.ts not found")?;
    log::info!(target: "jarvis::startup", "Bun server entry resolved: {server_entry}");
    spawn_blocking_on_current_runtime(move || -> Result<(), String> {
        let m = SERVER_PROCESS
            .get()
            .ok_or("SERVER_PROCESS not initialized")?;
        let mut guard = m.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
        let child = spawn_jarvis_server(&server_entry).ok_or("Failed to spawn Bun server")?;
        *guard = Some(child);
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;
    log::info!(target: "jarvis::startup", "Bun child spawn returned");

    // Wait (off the main thread) for the freshly spawned server to come up.
    let start = std::time::Instant::now();
    while start.elapsed() < std::time::Duration::from_secs(20) {
        if probe_jarvis_healthy().await {
            LAST_HEALTHY_MS.store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Err("Bun server did not become healthy within timeout".to_string())
}

pub fn is_port_listening(port: u16) -> bool {
    if let Ok(addrs) = std::net::ToSocketAddrs::to_socket_addrs(&format!("127.0.0.1:{}", port)) {
        for addr in addrs {
            if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(200))
                .is_ok()
            {
                return true;
            }
        }
    }
    is_wsl_port_listening(port)
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
    let cfg = crate::commands::load_jarvis_config(&db_state).unwrap_or_default();
    log::info!(target: "jarvis::startup", "bootstrap config load complete");
    {
        let state = handle.state::<crate::jarvis::types::JarvisState>();
        *state.config.lock().await = cfg.clone();
    }
    let backend = cfg.active_backend.clone();
    println!("[Jarvis] Boot backend = {}", backend);

    // Backend-specific local dependency: only start Ollama when it's active.
    match backend {
        crate::jarvis::types::JarvisBackend::Ollama => {
            crate::start_ollama_and_warm(cfg.ollama.model.clone()).await;
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

    // Bun is required by every backend and must become healthy before optional
    // Claude-proxy discovery touches WSL. A cold/misconfigured WSL install must
    // not prevent the desktop's core HTTP runtime from starting.
    if let Err(e) = crate::ensure_jarvis_server_started().await {
        log::error!(target: "jarvis::startup", "Bun server startup failed at boot: {e}");
    } else {
        log::info!(target: "jarvis::startup", "Bun server healthy at boot");
    }

    // Proxy auth requires the compatibility listener. Subscription auth uses
    // the stock Claude CLI directly and must never require or spawn port 19878.
    if crate::claude_proxy_enabled(&cfg) {
        let proxy_model = cfg.ollama.model.clone();
        let openrouter_api_key = cfg.openrouter.api_key.clone();
        let proxy_result = spawn_blocking_on_current_runtime(move || {
            crate::spawn_claude_cli_proxy(proxy_model, openrouter_api_key)
        })
        .await;
        match proxy_result {
            Ok(Some(child)) => {
                if let Some(m) = crate::PROXY_PROCESS.get() {
                    if let Ok(mut g) = m.lock() {
                        println!(
                            "[Jarvis] Claude CLI proxy registered at startup (PID {})",
                            child.id()
                        );
                        *g = Some(child);
                    }
                }
            }
            _ => eprintln!("[Jarvis] Claude CLI proxy not started (not found or spawn failed)"),
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
    let db_path = std::path::PathBuf::from(&home).join(".local/share/com.jarvis.desktop/jarvis.db");

    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let db = match rusqlite::Connection::open(&db_path) {
        Ok(conn) => {
            conn.execute_batch(
                "PRAGMA journal_mode = WAL; \
                 PRAGMA foreign_keys = ON; \
                 PRAGMA synchronous = NORMAL; \
                 PRAGMA temp_store = MEMORY; \
                 PRAGMA mmap_size = 30000000000; \
                 PRAGMA cache_size = -20000;",
            )
            .ok();
            // Wait up to 5s on lock contention instead of erroring instantly with
            // "database is locked" (the manual open path skipped AppDb::new's setup).
            let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));
            crate::db::run_migrations(&conn).ok();
            let db = crate::db::AppDb {
                conn: std::sync::Mutex::new(conn),
                db_path: db_path.clone(),
            };
            let _ = crate::commands::skills::seed_skills(&db);
            db
        }
        Err(e) => {
            eprintln!("[Jarvis] Failed to open DB at {:?}: {}", db_path, e);
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .manage(jarvis_state)
        .manage(db)
        .manage(HermesAppState::with_config(build_hermes_config()))
        .setup(|app| {
            // Ensure the OnceLocks are initialized
            crate::PROXY_PROCESS.get_or_init(|| std::sync::Mutex::new(None));
            crate::OLLAMA_PROCESS.get_or_init(|| std::sync::Mutex::new(None));
            crate::SERVER_PROCESS.get_or_init(|| std::sync::Mutex::new(None));

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
            record_terminal_run,
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
            list_skills,
            get_skill,
            enable_skill,
            disable_skill,
            invoke_skill,
            skill_revisions_list,
            skill_restore_revision,
            sync_distilled_skill_candidates,
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
            delete_cron_job,
            run_cron_job,
            get_cron_runs,
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
            complete_commitment,
            delete_commitment,
            get_action_registry_summary,
            get_action_registry_bucket,
            get_action_registry_alerts,
            sync_action_registry,
            update_action_approval,
            dispatch_action,
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
                for (slot, _name) in [
                    (SERVER_PROCESS.get(), "Bun server"),
                    (PROXY_PROCESS.get(), "claude_cli_proxy"),
                    (OLLAMA_PROCESS.get(), "Ollama"),
                ] {
                    if let Some(m) = slot {
                        if let Ok(mut g) = m.lock() {
                            if let Some(mut child) = g.take() {
                                let _ = child.kill();
                            }
                        }
                    }
                }
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
        configure_proxy_credential(&mut wsl, "secret-key", true);
        let wsl_env: std::collections::HashMap<_, _> = wsl.get_envs().collect();
        let wslenv = wsl_env
            .get(std::ffi::OsStr::new("WSLENV"))
            .and_then(|value| *value)
            .expect("WSL launch should opt the credential into environment forwarding");
        assert!(wslenv
            .to_string_lossy()
            .split(':')
            .any(|name| name == "JARVIS_OPENROUTER_API_KEY"));
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
