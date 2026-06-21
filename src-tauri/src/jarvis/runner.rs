use crate::jarvis::types::*;
use crate::wsl::wsl_openclaw;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

/// Spawn a Jarvis subprocess and stream output via Tauri events.
/// This runs bun run main.tsx from the Jarvis workspace directory.
pub fn run_jarvis_message(
    app: AppHandle,
    config: JarvisConfig,
    session_id: String,
    message: String,
) -> Result<(), String> {
    let jarvis_path = config.jarvis_path.clone();
    let effective_url = config.effective_base_url();
    // Map legacy flat fields onto the v3.1 sub-config shape.
    let (model, api_key) = match config.active_backend {
        crate::jarvis::types::JarvisBackend::Ollama => (
            config.ollama.model.clone(),
            "ollama".to_string(),
        ),
        crate::jarvis::types::JarvisBackend::OpenRouter => (
            config.openrouter.model.clone(),
            config.openrouter.api_key.clone(),
        ),
        crate::jarvis::types::JarvisBackend::ClaudeCli => (
            config.claude_cli.model.clone().unwrap_or_default(),
            String::new(),
        ),
    };

    // Build the Jarvis invocation
    let message_escaped = message.replace('\\', "\\\\").replace('"', "\\\"");

    // Handle session: if empty, generate new UUID; otherwise resume
    let effective_session_id = if session_id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        session_id.clone()
    };
    let resume_flag = format!("--session-id {}", effective_session_id);

    // Build env vars for the Jarvis process
    let mut env_vars = format!(
        "ANTHROPIC_BASE_URL='{}' ANTHROPIC_API_KEY='{}' ANTHROPIC_MODEL='{}'",
        effective_url, api_key, model
    );

    // Add system prompt if non-empty
    if !config.system_prompt.is_empty() {
        let prompt_escaped = config.system_prompt.replace('\\', "\\\\").replace('\'', "'\\''");
        env_vars.push_str(&format!(" ANTHROPIC_SYSTEM_PROMPT='{}'", prompt_escaped));
    }

    // Use WSL to run bun from inside the WSL filesystem
    let wsl_cmd = format!(
        "cd '{}' && {} bun run main.tsx -p --output-format stream-json --verbose {} \"{}\"",
        jarvis_path, env_vars, resume_flag, message_escaped
    );

    let mut cmd = Command::new("wsl.exe");
    cmd.arg("--")
        .arg("bash")
        .arg("-c")
        .arg(&wsl_cmd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn Jarvis: {}", e))?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let app_clone = app.clone();
    let session_id_clone = effective_session_id.clone();

    // Read stdout line-by-line (NDJSON streaming)
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            // Try to parse as JSON stream event
            if let Ok(event) = serde_json::from_str::<StreamEvent>(trimmed) {
                match event.event_type.as_str() {
                    "stream_event" => {
                        // Extract text delta from the event
                        if let Some(text) = event.extra.get("delta").and_then(|d| d.get("text")).and_then(|t| t.as_str()) {
                            let _ = app_clone.emit("jarvis://token", serde_json::json!({
                                "text": text,
                                "session_id": session_id_clone,
                            }));
                        }
                    }
                    "message_stop" => {
                        let _ = app_clone.emit("jarvis://done", serde_json::json!({
                            "session_id": session_id_clone,
                        }));
                        break;
                    }
                    "error" => {
                        let err_text = event.extra.get("error").and_then(|e| e.as_str()).unwrap_or("Unknown error");
                        let _ = app_clone.emit("jarvis://error", serde_json::json!({
                            "error": err_text,
                            "session_id": session_id_clone,
                        }));
                        break;
                    }
                    _ => {} // Ignore other event types (init, result, etc.)
                }
            }
            // Non-JSON lines (init noise) are silently skipped
        }
    });

    // Read stderr in a separate thread
    let app_err = app.clone();
    let session_id_err = effective_session_id.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if !line.trim().is_empty() {
                let _ = app_err.emit("jarvis://error", serde_json::json!({
                    "error": line,
                    "session_id": session_id_err,
                }));
            }
        }
    });

    Ok(())
}

/// Check Jarvis status: Ollama, model, bun availability
/// Uses spawning blocking tasks to avoid tokio runtime issues.
pub fn check_jarvis_status(config: &JarvisConfig) -> JarvisStatus {
    let effective_url = config.effective_base_url();

    // Check if Ollama is reachable (non-blocking TCP connect)
    let ollama_running = if matches!(config.active_backend, JarvisBackend::Ollama) {
        let host = effective_url
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .split('/')
            .next()
            .unwrap_or("localhost:11434");
        let host = host.split(':').next().unwrap_or("localhost");
        let port: u16 = effective_url
            .split(':')
            .nth(2)
            .and_then(|p| p.split('/').next())
            .and_then(|p| p.parse().ok())
            .unwrap_or(11434);
        std::net::TcpStream::connect((host, port)).is_ok()
    } else {
        true // OpenRouter doesn't need local Ollama
    };

    // For a proper Ollama check, we use a lightweight blocking call in a separate thread
    let model_available = if matches!(config.active_backend, JarvisBackend::Ollama) {
        let url = effective_url.clone();
        let model = config.ollama.model.clone();
        // Use a scoped thread for the blocking HTTP call
        std::thread::spawn(move || {
            let client = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build();
            match client {
                Ok(c) => {
                    if let Ok(resp) = c.get(format!("{}/api/tags", url)).send() {
                        if let Ok(json) = resp.json::<serde_json::Value>() {
                            return json.get("models")
                                .and_then(|m| m.as_array())
                                .map(|models| models.iter().any(|m| m.get("name").and_then(|n| n.as_str()).map_or(false, |n| n.contains(&model))))
                                .unwrap_or(false);
                        }
                    }
                    false
                }
                Err(_) => false,
            }
        })
        .join()
        .unwrap_or(false)
    } else {
        !config.openrouter.api_key.is_empty()
    };

    // Check if bun is available in WSL
    let bun_available = wsl_openclaw(&["which", "bun"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    // Check if bridge TCP port is listening
    let bridge_active =
        std::net::TcpStream::connect(format!("127.0.0.1:{}", config.bridge_port)).is_ok();

    JarvisStatus {
        ollama_running,
        model_available: if matches!(config.active_backend, JarvisBackend::Ollama) {
            model_available
        } else {
            true
        },
        bridge_active,
        bridge_port: config.bridge_port,
        bun_available,
    }
}
