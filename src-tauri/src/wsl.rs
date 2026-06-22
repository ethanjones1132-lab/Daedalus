use std::process::{Command, Output, Stdio};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub(crate) fn hide_windows_console(_cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Run a command with a wall-clock timeout. Returns `None` on spawn failure or
/// timeout (the child is killed on timeout). Used to bound `wsl.exe` invocations,
/// which can otherwise block indefinitely when the WSL VM is cold or busy —
/// blocking the caller's thread and, on hot paths, starving the UI.
pub(crate) fn command_output_timeout(mut cmd: Command, timeout: Duration) -> Option<Output> {
    hide_windows_console(&mut cmd);
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
}

static WINDOWS_HOST_IP: OnceLock<String> = OnceLock::new();
static WSL_IPS_CACHE: OnceLock<Mutex<Option<(Vec<String>, Instant)>>> = OnceLock::new();
static CACHED_BUN_URL: OnceLock<Mutex<Option<String>>> = OnceLock::new();

const WSL_IPS_TTL: Duration = Duration::from_secs(60);
/// Resolve the Windows host IP from WSL2.
/// Prefer the WSL default gateway. On this setup, /etc/resolv.conf points at a
/// DNS proxy that does not expose Windows-host services like Ollama.
pub fn wsl_windows_host_ip() -> String {
    WINDOWS_HOST_IP
        .get_or_init(|| {
            let mut route_cmd = Command::new("wsl.exe");
            route_cmd
                .arg("--")
                .arg("bash")
                .arg("-lc")
                .arg("ip route show default | awk '/default/ {print $3; exit}'");
            if let Some(output) = command_output_timeout(route_cmd, Duration::from_secs(15)) {
                let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !ip.is_empty() && ip.split('.').count() == 4 {
                    return ip;
                }
            }

            let mut cmd = Command::new("wsl.exe");
            cmd.arg("--")
                .arg("bash")
                .arg("-c")
                .arg("grep -oP 'nameserver \\K\\S+' /etc/resolv.conf | head -1");
            if let Some(output) = command_output_timeout(cmd, Duration::from_secs(15)) {
                let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !ip.is_empty() && ip.split('.').count() == 4 {
                    return ip;
                }
            }
            if let Ok(content) = std::fs::read_to_string("/etc/resolv.conf") {
                for line in content.lines() {
                    let line = line.trim();
                    if let Some(stripped) = line.strip_prefix("nameserver ") {
                        let ip = stripped.trim().to_string();
                        if !ip.is_empty() {
                            return ip;
                        }
                    }
                }
            }
            "172.17.0.1".to_string()
        })
        .clone()
}

/// Retrieve the WSL hostname IPs, cached with a 60-second TTL to avoid spawning wsl.exe repeatedly.
pub fn wsl_hostname_ips() -> Vec<String> {
    let cache_mutex = WSL_IPS_CACHE.get_or_init(|| Mutex::new(None));
    let guard = cache_mutex.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((ips, last_updated)) = &*guard {
        if last_updated.elapsed() < WSL_IPS_TTL {
            return ips.clone();
        }
    }

    #[allow(unused_mut)]
    let mut ips = Vec::new();
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["hostname", "-I"]);
        if let Some(output) = command_output_timeout(cmd, Duration::from_secs(15)) {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                for ip in text.split_whitespace() {
                    ips.push(ip.to_string());
                }
            }
        }
    }

    let mut guard = cache_mutex.lock().unwrap_or_else(|p| p.into_inner());
    *guard = Some((ips.clone(), Instant::now()));

    ips
}

/// Get the cached Bun URL if available.
pub fn get_cached_bun_url() -> Option<String> {
    CACHED_BUN_URL
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

/// Set the cached Bun URL.
pub fn set_cached_bun_url(url: String) {
    let mut guard = CACHED_BUN_URL
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    *guard = Some(url);
}

/// Clear the cached Bun URL.
pub fn clear_cached_bun_url() {
    let mut guard = CACHED_BUN_URL
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    *guard = None;
}

/// Helper to generate candidate API URLs for the Bun server.
pub fn jarvis_api_candidates() -> Vec<String> {
    let mut candidates = vec![
        std::env::var("JARVIS_API").unwrap_or_default(),
        "http://127.0.0.1:19877".to_string(),
        "http://localhost:19877".to_string(),
    ];

    for ip in wsl_hostname_ips() {
        candidates.push(format!("http://{}:19877", ip));
    }

    candidates.retain(|value| !value.trim().is_empty());
    candidates.dedup();
    candidates
}

// ── Helper functions added in recovery (2026-06-19) ──────────────
//
// These three helpers are referenced by jarvis/mod.rs, jarvis/runner.rs,
// commands/system.rs, and commands/legacy.rs. The recovered tree
// referenced them but their definitions were lost in the snapshot.
// The bodies are deliberately conservative: they only call `wsl.exe` on
// Windows and fall back to plain `Command` on Linux/macOS.

/// Resolve the WSL home directory (`/home/<user>`). On non-Windows targets
/// this returns the value of `$HOME` directly. Used everywhere the app
/// needs to construct paths under JARVIS_HOME.
pub fn wsl_home() -> String {
    #[cfg(target_os = "windows")]
    {
        // `wsl.exe -- bash -lc 'echo $HOME'` is the most reliable source
        // because the user's actual Linux home may differ from the Windows
        // `%USERPROFILE%`.
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["--", "bash", "-lc", "echo -n $HOME"]);
        hide_windows_console(&mut cmd);
        if let Some(out) = command_output_timeout(cmd, Duration::from_secs(5)) {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return s;
                }
            }
        }
        // Fallback to USERPROFILE/HOME
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| r"C:\Users\ethan".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").unwrap_or_else(|_| "/home/ethan".to_string())
    }
}

/// Run an openclaw CLI subcommand and return its stdout. On Windows, this
/// shells out via `wsl.exe -- bash -lc '<args joined>'`. On non-Windows
/// platforms it executes the binary directly. Returns Err if the process
/// fails to start or exits non-zero.
pub fn wsl_openclaw(args: &[&str]) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let joined = shlex_join(args);
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["--", "bash", "-lc", &format!("openclaw {joined}")]);
        hide_windows_console(&mut cmd);
        let out = command_output_timeout(cmd, Duration::from_secs(30))
            .ok_or_else(|| "openclaw invocation timed out or failed to spawn".to_string())?;
        if !out.status.success() {
            return Err(format!(
                "openclaw failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("openclaw");
        cmd.args(args);
        let out = cmd
            .output()
            .map_err(|e| format!("Failed to spawn openclaw: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "openclaw failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

/// Read a file under the WSL filesystem and return its contents. The path
/// is interpreted as a WSL path on Windows; on non-Windows it is read
/// directly via `std::fs`.
pub fn wsl_read_file(path: &str) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["--", "cat", path]);
        hide_windows_console(&mut cmd);
        let out = command_output_timeout(cmd, Duration::from_secs(10))
            .ok_or_else(|| "wsl cat timed out or failed to spawn".to_string())?;
        if !out.status.success() {
            return Err(format!(
                "wsl cat failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {}", path, e))
    }
}

/// Tiny shlex join for the WSL passthrough. Quoting is deliberately
/// minimal — the WSL openclaw invocation only ever receives safe args.
fn shlex_join(args: &[&str]) -> String {
    args.iter()
        .map(|a| {
            if a.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_./:".contains(c))
            {
                a.to_string()
            } else {
                format!("'{}'", a.replace('\'', "'\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
