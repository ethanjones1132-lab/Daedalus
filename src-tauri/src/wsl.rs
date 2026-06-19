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
    let mut guard = CACHED_BUN_URL.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|p| p.into_inner());
    *guard = Some(url);
}

/// Clear the cached Bun URL.
pub fn clear_cached_bun_url() {
    let mut guard = CACHED_BUN_URL.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|p| p.into_inner());
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

// ─── WSL Path Resolution ─────────────────────────────────────────────────

/// Get the WSL home directory path (e.g., `/home/ethan`).
pub fn wsl_home() -> String {
    let output = Command::new("wsl.exe")
        .arg("--")
        .arg("bash")
        .arg("-lc")
        .arg("echo $HOME")
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        "/home/ethan".to_string()
    } else {
        path
    }
}

/// Run a command inside WSL and return stdout as a String.
pub fn wsl_openclaw(args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("wsl.exe");
    cmd.arg("--").arg("bash").arg("-lc");
    let full_cmd = format!("openclaw {}", args.join(" "));
    cmd.arg(&full_cmd);
    let output = cmd.output().map_err(|e| format!("wsl_openclaw failed: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("wsl_openclaw error: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Read a file from the WSL filesystem.
pub fn wsl_read_file(path: &str) -> Result<String, String> {
    let output = Command::new("wsl.exe")
        .arg("--")
        .arg("bash")
        .arg("-lc")
        .arg(format!("cat \"{}\"", path))
        .output()
        .map_err(|e| format!("wsl_read_file failed: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("wsl_read_file error: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}