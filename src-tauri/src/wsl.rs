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
#[allow(clippy::type_complexity)]
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
fn cached_hostname_ips<F>(
    cache_mutex: &Mutex<Option<(Vec<String>, Instant)>>,
    refresh: F,
) -> Vec<String>
where
    F: FnOnce() -> Vec<String>,
{
    {
        let guard = cache_mutex.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((ips, last_updated)) = &*guard {
            if last_updated.elapsed() < WSL_IPS_TTL {
                return ips.clone();
            }
        }
    }

    // Do not hold the cache mutex while invoking wsl.exe. Apart from blocking
    // callers, holding it here deadlocks the publication lock below whenever
    // the cache is cold.
    let ips = refresh();
    let mut guard = cache_mutex.lock().unwrap_or_else(|p| p.into_inner());
    *guard = Some((ips.clone(), Instant::now()));
    ips
}

pub fn wsl_hostname_ips() -> Vec<String> {
    let cache_mutex = WSL_IPS_CACHE.get_or_init(|| Mutex::new(None));
    cached_hostname_ips(cache_mutex, || {
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
        ips
    })
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

/// Candidate URLs that can be checked without starting WSL.
pub fn local_jarvis_api_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(cached) = get_cached_bun_url() {
        candidates.push(cached);
    }
    if let Ok(configured) = std::env::var("JARVIS_API") {
        candidates.push(configured);
    }
    candidates.extend([
        "http://127.0.0.1:19877".to_string(),
        "http://localhost:19877".to_string(),
    ]);

    let mut unique = Vec::new();
    for candidate in candidates {
        if !candidate.trim().is_empty() && !unique.contains(&candidate) {
            unique.push(candidate);
        }
    }
    unique
}

/// Helper to generate candidate API URLs for the Bun server. WSL hostname
/// discovery is intentionally lazy; callers on local Bun deployments should
/// use `local_jarvis_api_candidates()` first and avoid waking a cold distro.
pub fn jarvis_api_candidates() -> Vec<String> {
    let mut candidates = local_jarvis_api_candidates();
    for ip in wsl_hostname_ips() {
        let candidate = format!("http://{}:19877", ip);
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

// ── Helper functions added in recovery (2026-06-19) ──────────────
//
// These three helpers are referenced by jarvis/mod.rs, jarvis/runner.rs,
// commands/system.rs, and commands/legacy.rs. The recovered tree
// referenced them but their definitions were lost in the snapshot.
// The bodies are deliberately conservative: they only call `wsl.exe` on
// Windows and fall back to plain `Command` on Linux/macOS.

/// Resolve this machine's home directory from an injected environment, in the
/// order each platform publishes it: `USERPROFILE` then `HOME` on Windows and
/// the reverse elsewhere, then the `HOMEDRIVE` + `HOMEPATH` pair older Windows
/// shells set. `None` means the environment names no home, so callers report a
/// miss instead of reusing a directory from another PC.
pub(crate) fn home_dir_from_env(env: impl Fn(&str) -> Option<String>) -> Option<String> {
    fn read(env: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
        env(name)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    let ordered: &[&str] = if cfg!(target_os = "windows") {
        &["USERPROFILE", "HOME"]
    } else {
        &["HOME", "USERPROFILE"]
    };
    if let Some(home) = ordered.iter().find_map(|name| read(&env, name)) {
        return Some(home);
    }
    match (read(&env, "HOMEDRIVE"), read(&env, "HOMEPATH")) {
        (Some(drive), Some(path)) => Some(format!("{drive}{path}")),
        _ => None,
    }
}

/// Ask `wsl.exe` for the Linux home directory. `None` when the probe did not
/// answer with a usable path.
#[cfg(target_os = "windows")]
fn probe_wsl_home() -> Option<String> {
    // `wsl.exe -- bash -lc 'echo $HOME'` is the most reliable source because
    // the user's actual Linux home may differ from the Windows `%USERPROFILE%`.
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["--", "bash", "-lc", "echo -n $HOME"]);
    hide_windows_console(&mut cmd);
    let out = command_output_timeout(cmd, Duration::from_secs(5))?;
    if !out.status.success() {
        return None;
    }
    let home = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!home.is_empty()).then_some(home)
}

/// There is no WSL probe off Windows; the environment names the home directly.
#[cfg(not(target_os = "windows"))]
fn probe_wsl_home() -> Option<String> {
    None
}

/// Pure decision seam: the `wsl.exe` probe's answer, else this machine's home
/// from the environment, else an error the caller can report. A failed probe
/// never turns into a literal `/home/<name>` or `C:\Users\<name>` guess.
fn resolve_wsl_home(
    probe: impl FnOnce() -> Option<String>,
    env: impl Fn(&str) -> Option<String>,
) -> Result<String, String> {
    if let Some(home) = probe()
        .map(|home| home.trim().to_string())
        .filter(|home| !home.is_empty())
    {
        return Ok(home);
    }
    home_dir_from_env(env).ok_or_else(|| {
        "WSL home could not be resolved: `wsl.exe` reported none and the \
         environment names no home (USERPROFILE, HOME, HOMEDRIVE + HOMEPATH)"
            .to_string()
    })
}

/// [`wsl_home`]'s value for one probe/environment pair: the resolver's answer,
/// or an empty string (with the miss logged) when there is nothing to derive.
/// Empty is deliberate — a caller that joins it into a path gets an obviously
/// rootless path rather than a user directory from another PC.
fn wsl_home_value(
    probe: impl FnOnce() -> Option<String>,
    env: impl Fn(&str) -> Option<String>,
) -> String {
    match resolve_wsl_home(probe, env) {
        Ok(home) => home,
        Err(error) => {
            eprintln!("[Jarvis] {error}");
            String::new()
        }
    }
}

/// Resolve the WSL home directory (`/home/<user>`). On non-Windows targets
/// this returns the value of `$HOME` directly. Used everywhere the app
/// needs to construct paths under JARVIS_HOME.
///
/// Cached for the process lifetime: the answer cannot change while the app
/// runs, and an uncached `wsl.exe` launch can block for the full 5s timeout
/// when the distro is cold (DD-023, DS-06).
///
/// When neither the probe nor the environment names a home, the miss from
/// [`resolve_wsl_home`] is logged and [`wsl_home_value`] returns an empty
/// string rather than a user directory that only exists on one machine.
pub fn wsl_home() -> String {
    static WSL_HOME: OnceLock<String> = OnceLock::new();
    WSL_HOME
        .get_or_init(|| wsl_home_value(probe_wsl_home, |name| std::env::var(name).ok()))
        .clone()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostname_cache_refresh_does_not_hold_the_mutex_during_refresh() {
        let cache = Mutex::new(None);
        let refreshed = cached_hostname_ips(&cache, || {
            // This re-entrant lock is the regression seam: the refresh closure
            // must be able to publish/inspect state without deadlocking.
            let guard = cache.lock().unwrap();
            drop(guard);
            vec!["127.0.0.1".to_string()]
        });

        assert_eq!(refreshed, vec!["127.0.0.1"]);
        assert_eq!(cache.lock().unwrap().as_ref().unwrap().0, vec!["127.0.0.1"]);
    }

    /// A machine that is not the owner's has no `/home/ethan` and no
    /// `C:\Users\ethan`. When `wsl.exe` cannot answer, the resolver must use
    /// this machine's own home from the environment — and must report an error
    /// rather than return the literal owner path when even that is absent.
    #[test]
    fn wsl_home_fallback_is_environment_derived_or_reports_a_miss() {
        let buyer_home = r"C:\Users\buyer";
        let derived = resolve_wsl_home(|| None, |name| match name {
            "USERPROFILE" => Some(buyer_home.to_string()),
            _ => None,
        })
        .expect("an environment-derived home is a usable fallback");
        assert_eq!(derived, buyer_home);

        let error = resolve_wsl_home(|| None, |_: &str| None).expect_err(
            "with no `wsl.exe` answer and no home in the environment the \
             resolver must report a miss, not return a path from another PC",
        );
        for forbidden in [r"C:\Users\ethan", "/home/ethan"] {
            assert!(
                !error.contains(forbidden),
                "the reported miss must not name a literal user path: {error}"
            );
        }

        assert_eq!(
            home_dir_from_env(|_: &str| None),
            None,
            "the environment fallback must not invent a home when no variable names one"
        );
        assert_eq!(
            home_dir_from_env(|name| (name == "USERPROFILE").then(|| buyer_home.to_string())),
            Some(buyer_home.to_string()),
            "the environment fallback must use the home the environment names"
        );

        // The cached production value comes from this seam: a miss must stay
        // empty, never fall back to a hardcoded user path.
        assert_eq!(
            wsl_home_value(|| None, |_: &str| None),
            "",
            "an unresolvable WSL home must not resolve to a literal user directory"
        );
        assert_eq!(
            wsl_home_value(|| None, |name| {
                (name == "USERPROFILE").then(|| buyer_home.to_string())
            }),
            buyer_home,
            "the cached value must come from the environment when the probe is silent"
        );
    }
}
