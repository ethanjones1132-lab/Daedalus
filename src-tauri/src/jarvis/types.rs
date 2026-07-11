use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ═══════════════════════════════════════════════════════════════
// ── Jarvis Config ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
pub enum JarvisBackend {
    #[serde(rename = "ollama")]
    #[default]
    Ollama,
    #[serde(rename = "openrouter")]
    OpenRouter,
    #[serde(rename = "claude_cli")]
    ClaudeCli,
}

impl std::fmt::Display for JarvisBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JarvisBackend::Ollama => f.write_str("ollama"),
            JarvisBackend::OpenRouter => f.write_str("openrouter"),
            JarvisBackend::ClaudeCli => f.write_str("claude_cli"),
        }
    }
}

// The full v3.1 config schema that the Native settings UI persists into
// SQLite. Each "compound" sub-config is serialized as its own JSON blob
// in the settings table; see commands/settings.rs for the loader.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JarvisConfig {
    pub version: String,
    pub active_backend: JarvisBackend,
    pub ollama: OllamaConfig,
    pub openrouter: OpenRouterConfig,
    #[serde(default)]
    pub opencode_zen: OpenCodeProviderConfig,
    #[serde(default)]
    pub opencode_go: OpenCodeProviderConfig,
    pub claude_cli: ClaudeCliConfig,
    pub tools: ToolConfig,
    pub reasoning: ReasoningConfig,
    pub companion: CompanionConfig,
    pub system_prompt: String,
    pub mode: String,
    pub prizepicks_prompt: String,
    pub temperature: f64,
    pub max_tokens: u32,
    pub top_p: f64,
    pub bridge_port: u16,
    pub bridge_enabled: bool,
    pub jarvis_path: String,
    pub compaction: CompactionConfigV2,
    pub profiles: HashMap<String, ModelProfile>,
    pub active_profile: String,
    pub api_sports_key: String,
    pub agents_root: String,
}

impl Default for JarvisConfig {
    fn default() -> Self {
        JarvisConfig {
            version: "3.1.0".to_string(),
            active_backend: JarvisBackend::Ollama,
            ollama: OllamaConfig::default(),
            openrouter: OpenRouterConfig::default(),
            opencode_zen: OpenCodeProviderConfig {
                base_url: "https://opencode.ai/zen/v1".to_string(),
                api_key: String::new(),
                first_token_timeout_ms: default_opencode_first_token_timeout_ms(),
            },
            opencode_go: OpenCodeProviderConfig {
                base_url: "https://opencode.ai/zen/go/v1".to_string(),
                api_key: String::new(),
                first_token_timeout_ms: default_opencode_first_token_timeout_ms(),
            },
            claude_cli: ClaudeCliConfig::default(),
            tools: ToolConfig::default(),
            reasoning: ReasoningConfig::default(),
            companion: CompanionConfig::default(),
            system_prompt: "You are Jarvis, a local AI assistant. Be concise and helpful."
                .to_string(),
            mode: "general".to_string(),
            prizepicks_prompt: String::new(),
            temperature: 0.7,
            max_tokens: 2048,
            top_p: 0.95,
            bridge_port: 19876,
            bridge_enabled: true,
            jarvis_path: String::new(),
            compaction: CompactionConfigV2::default(),
            profiles: HashMap::new(),
            active_profile: "default".to_string(),
            api_sports_key: String::new(),
            agents_root: String::new(),
        }
    }
}

impl JarvisConfig {
    /// Get the effective base URL for the active backend.
    pub fn effective_base_url(&self) -> String {
        match self.active_backend {
            JarvisBackend::Ollama => self.ollama.base_url.clone(),
            JarvisBackend::OpenRouter => self.openrouter.base_url.clone(),
            JarvisBackend::ClaudeCli => self.claude_cli.path.clone(),
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// ── Sub-configs (recovered from callsite inspection) ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct OllamaConfig {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub auto_pull: bool,
    #[serde(default)]
    pub num_ctx: u32,
    #[serde(default)]
    pub health_check_interval_ms: u64,
    #[serde(default)]
    pub options: OllamaOptions,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct OllamaOptions {
    #[serde(default)]
    pub num_gpu: u32,
    #[serde(default)]
    pub num_thread: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct OpenRouterConfig {
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub site_url: String,
    #[serde(default)]
    pub site_name: String,
    #[serde(default)]
    pub fallbacks: Vec<String>,
    #[serde(default)]
    pub enable_fallbacks: bool,
    #[serde(default)]
    pub enable_paid_fallbacks: bool,
    #[serde(default)]
    pub max_retries: u32,
    #[serde(default)]
    pub timeout_ms: u64,
}

/// OpenAI-compatible credentials used by the Bun provider cascade for
/// OpenCode Zen and OpenCode Go. These are fallback providers, not a new
/// primary Native surface backend.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct OpenCodeProviderConfig {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    /// Provider-wide first-byte budget used before the fallback cascade moves
    /// to the next model. Individual pool-agent overrides still take priority.
    #[serde(default = "default_opencode_first_token_timeout_ms")]
    pub first_token_timeout_ms: u64,
}

fn default_opencode_first_token_timeout_ms() -> u64 {
    45_000
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ClaudeCliConfig {
    #[serde(default)]
    pub enabled: bool,
    pub path: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub timeout_ms: u64,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ToolConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub require_approval: Vec<String>,
    #[serde(default = "default_sandbox")]
    pub sandbox_mode: String,
    #[serde(default)]
    pub allowlist: Vec<String>,
    #[serde(default)]
    pub denylist: Vec<String>,
}

fn default_sandbox() -> String {
    "permissive".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ReasoningConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub show_trace_by_default: bool,
    #[serde(default)]
    pub max_tokens: u32,
    #[serde(default)]
    pub backend: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct CompanionConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_companion_name")]
    pub name: String,
    #[serde(default = "default_companion_species")]
    pub species: String,
    #[serde(default = "default_companion_rarity")]
    pub rarity: String,
}

fn default_companion_name() -> String {
    "Sprout".to_string()
}
fn default_companion_species() -> String {
    "spriggan".to_string()
}
fn default_companion_rarity() -> String {
    "common".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct CompactionConfigV2 {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub threshold_messages: u32,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub keep_system_prompt: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ModelProfile {
    #[serde(default)]
    pub backend: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub options: serde_json::Value,
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
    // Ollama backend
    pub ollama_running: bool,
    pub model_available: bool,
    // Bun server (needed by all backends)
    pub bun_server_running: bool,
    pub bun_server_url: String,
    // Claude CLI proxy
    pub claude_proxy_running: bool,
    // Bridge
    pub bridge_active: bool,
    pub bridge_port: u16,
    // General availability indicator
    pub bun_available: bool,
    // Active backend + model (for the status chip row)
    pub active_backend: String,
    pub model: String,
    pub openrouter_key_set: bool,
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

fn default_timeout() -> u64 {
    30
}

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
