use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ═══════════════════════════════════════════════════════════════
// ── Jarvis Config ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
pub enum JarvisBackend {
    #[serde(rename = "ollama")]
    Ollama,
    #[serde(rename = "openrouter")]
    OpenRouter,
    #[serde(rename = "llama_cpp")]
    #[default]
    LlamaCpp,
    #[serde(rename = "claude_cli")]
    ClaudeCli,
}

impl std::fmt::Display for JarvisBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JarvisBackend::Ollama => f.write_str("ollama"),
            JarvisBackend::OpenRouter => f.write_str("openrouter"),
            JarvisBackend::LlamaCpp => f.write_str("llama_cpp"),
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
    pub llama_cpp: LlamaCppConfig,
    #[serde(default)]
    pub opencode_zen: OpenCodeProviderConfig,
    #[serde(default)]
    pub opencode_go: OpenCodeProviderConfig,
    pub claude_cli: ClaudeCliConfig,
    pub tools: ToolConfig,
    pub reasoning: ReasoningConfig,
    #[serde(default)]
    pub web_search: WebSearchConfig,
    pub companion: CompanionConfig,
    #[serde(default)]
    pub orchestrator: OrchestratorConfig,
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
            active_backend: JarvisBackend::LlamaCpp,
            ollama: OllamaConfig::default(),
            openrouter: OpenRouterConfig::default(),
            llama_cpp: LlamaCppConfig::default(),
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
            web_search: WebSearchConfig::default(),
            companion: CompanionConfig::default(),
            orchestrator: OrchestratorConfig::default(),
            system_prompt: "You are Jarvis, a local AI assistant. Be concise and helpful."
                .to_string(),
            mode: "general".to_string(),
            prizepicks_prompt: String::new(),
            temperature: 0.7,
            max_tokens: 4096,
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
            JarvisBackend::LlamaCpp => self.llama_cpp.base_url.clone(),
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

/// Local llama.cpp OpenAI-compatible server configuration. Daedalus owns the
/// server process when this backend is active; model artifacts remain in their
/// existing local locations and are never copied into the app bundle.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct LlamaCppConfig {
    pub base_url: String,
    pub model: String,
    pub server_path: String,
    pub model_path: String,
    pub mtp_path: String,
    pub port: u16,
    pub context_window: u32,
    pub reasoning_budget: u32,
}

impl Default for LlamaCppConfig {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:8080/v1".to_string(),
            model: "gemma-4-26B-A4B-it-IQ2_M.gguf".to_string(),
            // Artifact locations are machine-specific, so source ships them
            // blank. Each install sets them in Settings (persisted as the
            // `llama_cpp` row of the app settings table) or through the
            // JARVIS_LLAMA_* environment variables; see `with_env_fallbacks`.
            server_path: String::new(),
            model_path: String::new(),
            mtp_path: String::new(),
            port: 8080,
            context_window: 16384,
            reasoning_budget: 1536,
        }
    }
}

/// Supplies `llama_cpp.server_path` (the llama-server executable) when Settings leaves it blank.
pub const LLAMA_SERVER_PATH_ENV: &str = "JARVIS_LLAMA_SERVER_PATH";
/// Supplies `llama_cpp.model_path` (the GGUF model file) when Settings leaves it blank.
pub const LLAMA_MODEL_PATH_ENV: &str = "JARVIS_LLAMA_MODEL_PATH";
/// Supplies `llama_cpp.mtp_path` (optional MTP draft head) when Settings leaves it blank.
pub const LLAMA_MTP_PATH_ENV: &str = "JARVIS_LLAMA_MTP_PATH";

impl LlamaCppConfig {
    /// Fill blank artifact paths from the `JARVIS_LLAMA_*` environment
    /// variables. A path set in Settings always wins over the environment.
    pub fn with_env_fallbacks(self) -> Self {
        self.with_path_fallbacks(|key| std::env::var(key).ok())
    }

    fn with_path_fallbacks(mut self, lookup: impl Fn(&str) -> Option<String>) -> Self {
        for (field, key) in [
            (&mut self.server_path, LLAMA_SERVER_PATH_ENV),
            (&mut self.model_path, LLAMA_MODEL_PATH_ENV),
            (&mut self.mtp_path, LLAMA_MTP_PATH_ENV),
        ] {
            if field.trim().is_empty() {
                if let Some(value) = lookup(key)
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                {
                    *field = value;
                }
            }
        }
        self
    }
}

#[cfg(test)]
mod llama_cpp_config_tests {
    use super::*;

    #[test]
    fn default_ships_no_machine_specific_paths() {
        let config = LlamaCppConfig::default();
        assert!(config.server_path.is_empty());
        assert!(config.model_path.is_empty());
        assert!(config.mtp_path.is_empty());
    }

    #[test]
    fn environment_fills_only_blank_paths() {
        let config = LlamaCppConfig {
            server_path: "configured-llama-server".to_string(),
            ..LlamaCppConfig::default()
        };
        let resolved = config.with_path_fallbacks(|key| match key {
            LLAMA_SERVER_PATH_ENV => Some("env-llama-server".to_string()),
            LLAMA_MODEL_PATH_ENV => Some("  env-model.gguf  ".to_string()),
            _ => Some("   ".to_string()),
        });
        assert_eq!(resolved.server_path, "configured-llama-server");
        assert_eq!(resolved.model_path, "env-model.gguf");
        assert_eq!(resolved.mtp_path, "");
    }
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

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
pub enum ClaudeCliAuthMode {
    #[serde(rename = "proxy")]
    #[default]
    Proxy,
    #[serde(rename = "subscription")]
    Subscription,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClaudeCliConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub auth_mode: ClaudeCliAuthMode,
    pub path: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub timeout_ms: u64,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub delegate: ClaudeDelegateConfig,
}

impl Default for ClaudeCliConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            auth_mode: ClaudeCliAuthMode::default(),
            path: String::new(),
            args: Vec::new(),
            timeout_ms: 0,
            cwd: String::new(),
            model: None,
            delegate: ClaudeDelegateConfig::default(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
pub enum ClaudeDelegatePolicy {
    #[serde(rename = "delegate_first")]
    #[default]
    DelegateFirst,
    #[serde(rename = "escalation")]
    Escalation,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
pub enum ClaudeDelegatePermissionMode {
    #[serde(rename = "acceptEdits")]
    #[default]
    AcceptEdits,
    #[serde(rename = "bypassPermissions")]
    BypassPermissions,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClaudeDelegateConfig {
    #[serde(default = "default_delegate_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub policy: ClaudeDelegatePolicy,
    #[serde(default)]
    pub permission_mode: ClaudeDelegatePermissionMode,
    #[serde(default = "default_delegate_allowed_tools")]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_delegate_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_delegate_enabled() -> bool {
    true
}

fn default_delegate_allowed_tools() -> Vec<String> {
    vec![
        "Read".to_string(),
        "Edit".to_string(),
        "Write".to_string(),
        "MultiEdit".to_string(),
        "Grep".to_string(),
        "Glob".to_string(),
        "WebSearch".to_string(),
        "WebFetch".to_string(),
        "TodoWrite".to_string(),
    ]
}

fn default_delegate_timeout_ms() -> u64 {
    420_000
}

impl Default for ClaudeDelegateConfig {
    fn default() -> Self {
        Self {
            enabled: default_delegate_enabled(),
            policy: ClaudeDelegatePolicy::DelegateFirst,
            permission_mode: ClaudeDelegatePermissionMode::AcceptEdits,
            allowed_tools: default_delegate_allowed_tools(),
            model: String::new(),
            timeout_ms: default_delegate_timeout_ms(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
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
    #[serde(default)]
    pub allowed_roots: Vec<String>,
    #[serde(default = "default_true")]
    pub grant_session_roots: bool,
    #[serde(default)]
    pub bash_path: String,
    #[serde(default = "default_shell_timeout_max_ms")]
    pub shell_timeout_max_ms: u64,
}

fn default_shell_timeout_max_ms() -> u64 {
    120_000
}

impl Default for ToolConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            require_approval: Vec::new(),
            sandbox_mode: String::new(),
            allowlist: Vec::new(),
            denylist: Vec::new(),
            allowed_roots: Vec::new(),
            grant_session_roots: true,
            bash_path: String::new(),
            shell_timeout_max_ms: default_shell_timeout_max_ms(),
        }
    }
}

fn default_sandbox() -> String {
    "permissive".to_string()
}

fn default_true() -> bool {
    true
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WebSearchConfig {
    #[serde(default = "default_web_search_provider")]
    pub provider: String,
    #[serde(default)]
    pub brave_api_key: String,
    #[serde(default)]
    pub tavily_api_key: String,
}

fn default_web_search_provider() -> String {
    "duckduckgo".to_string()
}

impl Default for WebSearchConfig {
    fn default() -> Self {
        Self {
            provider: default_web_search_provider(),
            brave_api_key: String::new(),
            tavily_api_key: String::new(),
        }
    }
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OrchestratorConfig {
    #[serde(default = "default_orchestrator_enabled")]
    pub enabled: bool,
    /// The Bun server owns the detailed pipeline policy. Preserve those fields
    /// while the native surface only exposes the user-facing runtime switch.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            extra: HashMap::new(),
        }
    }
}

fn default_orchestrator_enabled() -> bool {
    true
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
    /// Canonical persisted Agent identity from the Session row. This is scope
    /// input only; it never becomes a filesystem grant or memory authority.
    #[serde(default)]
    pub agent_id: String,
    /// Explicit validated project binding, if any. `None` is Agent scope.
    #[serde(default)]
    pub project_root: Option<String>,
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
    // llama.cpp backend
    pub llama_cpp_running: bool,
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
