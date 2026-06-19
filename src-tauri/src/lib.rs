pub mod commands;
pub mod cron_scheduler;
pub mod db;
pub mod jarvis;
pub mod parsers;
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
use tokio::sync::Mutex;

// ─── Jarvis Bun Server Auto-Start ────────────────────────────────────────────

pub(crate) static SERVER_PROCESS: std::sync::OnceLock<
    std::sync::Mutex<Option<std::process::Child>>,
> = std::sync::OnceLock::new();

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

static OLLAMA_PROCESS: std::sync::OnceLock<std::sync::Mutex<Option<std::process::Child>>> =
    std::sync::OnceLock::new();
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

fn find_jarvis_python() -> Option<String> {
    if let Ok(home) = std::env::var("HOME") {
        for rel in [
            ".openclaw/jarvis/hermes/.venv/bin/python",
            ".openclaw/jarvis/hermes/venv/bin/python",
        ] {
            let p = format!("{home}/{rel}");
            if std::path::Path::new(&p).exists() {
                return Some(p);
            }
        }
    }
    Some("python3".into())
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

fn warm_qwen_model() {
    // Best-effort: send a 1-token generate request so the model is hot when
    // the user fires their first chat. Failures are non-fatal.
    let _ = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .and_then(|c| {
            c.post("http://127.0.0.1:11434/api/generate")
                .json(&serde_json::json!({
                    "model": "qwen3:8b",
                    "prompt": "ok",
                    "stream": false,
                    "options": {"num_predict": 1}
                }))
                .send()
        });
}

pub(crate) fn spawn_claude_cli_proxy() -> Option<std::process::Child> {
    use std::process::{Command, Stdio};
    let script = find_claude_cli_proxy()?;
    let py = find_jarvis_python()?;
    let mut command = Command::new(&py);
    command
        .arg(&script)
        .env("JARVIS_CLAUDE_PROXY_PORT", "19878")
        .env("JARVIS_OLLAMA_URL", "http://127.0.0.1:11434")
        .env("JARVIS_DEFAULT_MODEL", "qwen3:8b")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::wsl::hide_windows_console(&mut command);
    let child = command.spawn().ok()?;
    println!(
        "[Jarvis] claude_cli_proxy started (PID {}, py {}, script {})",
        child.id(),
        py,
        script
    );
    Some(child)
}

fn find_claude_cli_proxy() -> Option<String> {
    let home = wsl_home();
    // Prefer the version-controlled copy in the repo; fall back to the legacy
    // deployed copy under ~/.openclaw/jarvis/hermes for older installs.
    let candidates = [
        format!(
            "{}/.openclaw/agents/coderclaw/workspace/home-base/scripts/claude_cli_proxy.py",
            home
        ),
        format!("{}/.openclaw/jarvis/hermes/claude_cli_proxy.py", home),
    ];
    for path in candidates {
        let exists = if cfg!(target_os = "windows") {
            let mut cmd = std::process::Command::new("wsl.exe");
            cmd.args(["--", "test", "-f", &path]);
            crate::wsl::command_output_timeout(cmd, std::time::Duration::from_secs(15))
                .map(|o| o.status.success())
                .unwrap_or(false)
        } else {
            std::path::Path::new(&path).exists()
        };
        if exists {
            return Some(path);
        }
    }
    None
}

fn find_jarvis_server() -> Option<String> {
    // NEW: On Windows, if we have a local (bundled) bun.exe, prefer the bundled server .js
    // (included via tauri "resources" in the installer / from build). This lets a fresh
    // NSIS installer launch a full successful application on new hardware (no WSL dev tree required).
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
    if exists { Some(base) } else { None }
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
        // On Windows, bun lives inside WSL.  Return the WSL path; callers that
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

fn spawn_jarvis_server(entry: &str) -> Option<std::process::Child> {
    let bun = find_bun_executable();
    let is_windows = cfg!(target_os = "windows");
    let looks_like_local_bun = is_windows && bun.to_lowercase().ends_with(".exe") && !bun.contains("wsl");

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
        std::process::Command::new(&bun)
            .arg(entry)
            .stdout(jarvis_server_log_stdio("server-jarvis.log"))
            .stderr(jarvis_server_log_stdio("server-jarvis.err.log"))
            .spawn()
    } else {
        let bun = find_bun_executable();
        std::process::Command::new(&bun)
            .arg(entry)
            .env("JARVIS_HOME", wsl_home())
            .stdout(jarvis_server_log_stdio("server-jarvis.log"))
            .stderr(jarvis_server_log_stdio("server-jarvis.err.log"))
            .spawn()
    };
    let child = spawn_result.ok()?;
    println!("[Jarvis] Bun server spawned (PID {})", child.id());
    Some(child)
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
    if SERVER_PROCESS.get().is_none() {
        SERVER_PROCESS.set(std::sync::Mutex::new(None)).ok();
    }
    let server_entry = find_jarvis_server().ok_or("server-jarvis index.ts not found")?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let jarvis_config = Arc::new(Mutex::new(crate::jarvis::types::JarvisConfig::default()));

    let jarvis_state = JarvisState {
        config: jarvis_config.clone(),
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
        .manage(HermesAppState::new())
        .setup(|app| {
            // Ensure the OnceLocks are initialized
            crate::PROXY_PROCESS.get_or_init(|| std::sync::Mutex::new(None));
            crate::OLLAMA_PROCESS.get_or_init(|| std::sync::Mutex::new(None));
            crate::SERVER_PROCESS.get_or_init(|| std::sync::Mutex::new(None));

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Start Ollama
                if crate::is_port_listening(11434) {
                    println!("[Jarvis] Ollama already running on port 11434");
                } else if let Some(child) = crate::spawn_ollama() {
                    let mut ready = false;
                    for _ in 0..30 {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        if crate::is_port_listening(11434) {
                            ready = true;
                            break;
                        }
                    }
                    if !ready {
                        eprintln!("[Jarvis] Ollama did not become ready within 15s");
                    } else {
                        println!("[Jarvis] Ollama ready on 11434");
                    }
                    if let Some(m) = crate::OLLAMA_PROCESS.get() {
                        if let Ok(mut g) = m.lock() {
                            *g = Some(child);
                        }
                    }
                }

                // Warm qwen model
                std::thread::spawn(crate::warm_qwen_model);

                // Start Claude CLI proxy
                let proxy_result =
                    tauri::async_runtime::spawn_blocking(crate::spawn_claude_cli_proxy).await;
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
                    _ => eprintln!(
                        "[Jarvis] Claude CLI proxy not started (not found or spawn failed)"
                    ),
                }

                // Start the Bun server eagerly so the UI is ready on first load.
                if let Err(e) = crate::ensure_jarvis_server_started().await {
                    eprintln!("[Jarvis] Bun server startup failed at boot: {}", e);
                }

                // Start cron scheduler.
                crate::cron_scheduler::start_cron_scheduler(handle).await;
            });
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