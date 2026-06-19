use serde::{Deserialize, Serialize};

// ═══════════════════════════════════════════════════════════════
// ── Jarvis Config ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum JarvisBackend {
    #[serde(rename = "ollama")]
    Ollama,
    #[serde(rename = "openrouter")]
    OpenRouter,
}

impl Default for JarvisBackend {
    fn default() -> Self { JarvisBackend::Ollama }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JarvisConfig {
    pub backend: JarvisBackend,
    pub ollama_base_url: String,
    pub openrouter_base_url: String,
    pub model: String,
    pub api_key: String,
    pub system_prompt: String,
    pub bridge_port: u16,
    pub bridge_enabled: bool,
    pub jarvis_path: String,
}

impl Default for JarvisConfig {
    fn default() -> Self {
        JarvisConfig {
            backend: JarvisBackend::Ollama,
            ollama_base_url: "http://localhost:11434/v1".to_string(),
            openrouter_base_url: "https://openrouter.ai/api/v1".to_string(),
            model: "qwen2.5-coder:7b".to_string(),
            api_key: "ollama".to_string(),
            system_prompt: "You are Jarvis, a local AI assistant running via Ollama. Be concise and helpful.".to_string(),
            bridge_port: 19876,
            bridge_enabled: true,
            jarvis_path: String::new(),
        }
    }
}

impl JarvisConfig {
    /// Get the effective base URL based on the selected backend
    pub fn effective_base_url(&self) -> String {
        match self.backend {
            JarvisBackend::Ollama => {
                // Resolve Windows host IP at runtime for WSL2
                let host_ip = crate::wsl::wsl_windows_host_ip();
                self.ollama_base_url.replace("localhost", &host_ip).replace("127.0.0.1", &host_ip)
            }
            JarvisBackend::OpenRouter => self.openrouter_base_url.clone(),
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// ── Jarvis Session ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JarvisSession {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub model: String,
    pub message_count: u32,
}

// ═══════════════════════════════════════════════════════════════
// ── Jarvis Message ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JarvisMessage {
    pub role: String,
    pub content: String,
    pub timestamp: Option<String>,
    pub source: Option<String>, // "user" or agent id
}

// ═══════════════════════════════════════════════════════════════
// ── Stream Event ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StreamEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub session_id: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Value,
}

// ═══════════════════════════════════════════════════════════════
// ── Jarvis Status ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JarvisStatus {
    pub ollama_running: bool,
    pub model_available: bool,
    pub bridge_active: bool,
    pub bridge_port: u16,
    pub bun_available: bool,
}

// ═══════════════════════════════════════════════════════════════
// ── Agent Bridge Request / Response ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Deserialize)]
pub struct BridgeRequest {
    pub from: String,
    pub message: String,
    pub session: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}

fn default_timeout() -> u64 { 30 }

#[derive(Debug, Serialize)]
pub struct BridgeResponse {
    pub response: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_used: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ═══════════════════════════════════════════════════════════════
// ── Jarvis State (managed by Tauri) ──
// ═══════════════════════════════════════════════════════════════

use std::sync::Arc;
use tokio::sync::Mutex;

pub struct JarvisState {
    pub config: Arc<Mutex<JarvisConfig>>,
    pub queue: Arc<crate::jarvis::queue::MessageQueue>,
    pub http_client: reqwest::Client,
}