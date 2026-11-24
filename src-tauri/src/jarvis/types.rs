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

// The config schema the Native settings UI persists into SQLite. Each
// "compound" sub-config is serialized as its own JSON blob in the settings
// table; see commands/settings.rs for the loader.
//
// `version` is a schema marker, NOT the app version. The app version comes
// from Cargo.toml (CARGO_PKG_VERSION). The marker tracks the app version so
// a persisted config names the build that wrote it, and nothing branches on
// it - there is no config migration keyed on this value.
//
// The Bun side carries the same marker (server-jarvis/src/config.ts,
// CONFIG_SCHEMA_VERSION). The two used to disagree - 3.1.0 here, 3.0.0
// there, neither matching the 1.0.0 app - so the value a user's config
// file ended up with depended on which side wrote last.
// server-jarvis/src/config-version.test.ts fails if they ever diverge.
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
    #[serde(default)]
    pub vllm: VllmConfig,
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
            // Schema marker, not the app version. See the struct comment.
            version: env!("CARGO_PKG_VERSION").to_string(),
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
            vllm: VllmConfig::default(),
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

#[derive(Debug, Serialize, Deserialize, Clone)]
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

impl Default for OllamaConfig {
    /// Mirrors the Bun server's `defaultConfig().ollama` in
    /// `server-jarvis/src/config.ts` so a Settings save from the native side
    /// cannot replace a working Ollama block with empty/false scalars. The
    /// values (and their source lines) are:
    /// - `base_url: "http://localhost:11434/v1"` (config.ts:667)
    /// - `model: "qwen3.5-9b:latest"` (config.ts:668)
    /// - `auto_pull: true` (config.ts:669)
    /// - `health_check_interval_ms: 30000` (config.ts:670)
    /// - `num_ctx: 8192` (config.ts:672, Bun nests it under `options`)
    /// - `options.num_gpu: 31` (config.ts:673)
    /// - `options.num_thread: 8` (config.ts:674)
    fn default() -> Self {
        Self {
            base_url: "http://localhost:11434/v1".to_string(),
            model: "qwen3.5-9b:latest".to_string(),
            auto_pull: true,
            num_ctx: 8192,
            health_check_interval_ms: 30000,
            options: OllamaOptions {
                num_gpu: 31,
                num_thread: 8,
            },
        }
    }
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
    /// Serving alias (`--alias`). A stored row keeps the alias it saved; a
    /// missing one takes the current default.
    pub model: String,
    pub server_path: String,
    pub model_path: String,
    /// Separate MTP draft head (`-md`). Blank means no separate head. The
    /// shipped Inkling-2-Mini profile disables speculation entirely, so this
    /// stays blank there.
    pub mtp_path: String,
    pub port: u16,
    /// Context window (`-c`).
    pub context_window: u32,
    /// `--reasoning-budget`.
    pub reasoning_budget: u32,
    /// MoE expert layers kept on the CPU (`--n-cpu-moe`). The Inkling-2-Mini
    /// profile keeps this at 0 and places experts with `override_tensor`.
    pub n_cpu_moe: u32,
    /// Logical and physical batch size (`-b` / `-ub`).
    #[serde(default = "legacy_default_batch_size")]
    pub batch_size: u32,
    /// `--spec-type` value, e.g. `draft-mtp,ngram-mod`. Blank disables
    /// speculation, which is the Inkling-2-Mini default (its DSpark draft head
    /// and the n-gram lookup both measured slower than plain decoding).
    #[serde(default = "legacy_default_spec_type")]
    pub spec_type: String,
    /// `--spec-draft-n-max`.
    #[serde(default = "legacy_default_spec_draft_n_max")]
    pub spec_draft_n_max: u32,
    /// KV cache type for both K and V (`-ctk` / `-ctv`). Always emitted.
    /// q5_0/q8_0 take a slow per-token dequant path on Inkling-2-Mini, and the
    /// AgentFast profile's q4_0 cache leaves VRAM for the 6-17 expert
    /// placement, so q4_0 is the shipped default.
    #[serde(default = "legacy_default_cache_type")]
    pub cache_type: String,
    /// `-ot` tensor override, e.g. `blk\.(0|1)\.ffn_.*_exps\.=CPU`. Blank keeps
    /// every tensor on the GPU. The Inkling-2-Mini AgentFast profile keeps the
    /// experts of its looped layers 6-17 on the GPU and offloads the rest.
    #[serde(default)]
    pub override_tensor: String,
    /// Let the launch fit the shipped AgentFast `-ot` expert range to the
    /// measured shared-GPU-memory spill (DD-146). On by default; off leaves
    /// `override_tensor` exactly as stored. An operator's own `-ot` value is
    /// never revised, whether this is on or off.
    #[serde(default = "default_auto_fit")]
    pub auto_fit: bool,
    /// Generation threads (`-t`). 0 omits the flag and lets llama-server decide.
    #[serde(default)]
    pub threads: u32,
    /// Batch threads (`-tb`). 0 omits the flag.
    #[serde(default)]
    pub batch_threads: u32,
    /// `--chat-template-kwargs` `reasoning_effort` value (low / medium / high).
    /// Blank omits the flag and keeps the template's own default (high for
    /// Inkling-2-Mini, which over-thinks).
    #[serde(default)]
    pub reasoning_effort: String,
    /// `--no-host`: keep mmapped weights out of host buffers (16 GB machines).
    #[serde(default)]
    pub no_host: bool,
    /// `--no-repack`: skip weight repacking while the model loads.
    #[serde(default)]
    pub no_repack: bool,
    /// `--cache-prompt`.
    #[serde(default)]
    pub cache_prompt: bool,
    /// `--cache-reuse` value. `None` omits the flag; `Some(0)` is what the
    /// Inkling-2-Mini profile passes explicitly.
    #[serde(default)]
    pub cache_reuse: Option<u32>,
}

// Serde defaults for a *missing* field in a stored `llama_cpp` row. Only the
// fields a row can genuinely predate get them: `batch_size`, `spec_type` and
// `spec_draft_n_max` were added after the first installs, so a row saved then
// must keep the values the launcher used for it (1024, `draft-mtp,ngram-mod`,
// 2) instead of silently picking up the Inkling-2-Mini AgentFast defaults.
// `Default::default()` (a fresh install) uses the AgentFast profile, and a
// missing `model`/`context_window`/`reasoning_budget` takes that profile too,
// because every saved row has always written those.
fn legacy_default_batch_size() -> u32 {
    1024
}

fn legacy_default_spec_type() -> String {
    "draft-mtp,ngram-mod".to_string()
}

fn legacy_default_spec_draft_n_max() -> u32 {
    2
}

fn legacy_default_cache_type() -> String {
    "q8_0".to_string()
}

/// `auto_fit` for a stored row that predates DD-146. Fitting stays on for those
/// rows too, but it can only ever revise the shipped AgentFast `-ot` value, so
/// a legacy placement or an operator's own override still launches untouched.
fn default_auto_fit() -> bool {
    true
}

impl Default for LlamaCppConfig {
    /// Inkling-2-Mini (UD-IQ3_XXS) with its measured "AgentFast" profile:
    /// 57344 tokens of context, q4_0 KV cache (q5_0/q8_0 take a slow dequant
    /// fallback on this model, and q4_0 leaves VRAM for the expert placement),
    /// every layer offloaded with the experts of the looped layers 6-17 kept on
    /// the GPU through an `-ot` override and the rest on the CPU
    /// (`--n-cpu-moe 0`), batch 512, eight generation and six batch threads,
    /// thinking capped by `reasoning_effort = medium` (the template defaults to
    /// high, which over-thinks), and no speculation at all (its DSpark draft
    /// head and n-gram lookup both measured slower). Sampling is the conductor's
    /// business: temperature 1.0 / top_p 1.0 / top_k 0 / min_p 0, because the
    /// keep96 sampling made Inkling loop.
    ///
    /// Inkling-2-Mini only loads in Unsloth's llama.cpp fork (b12651, engine
    /// directory `llama-unsloth-b12651`), so `server_path` has to point at that
    /// build; mainline llama-server cannot load it. That build's portable zip
    /// ships without the `cudart`/`cublas` DLLs, so the installer has to bundle
    /// them alongside it; this profile does not address packaging. Artifact
    /// locations are machine-specific, so source ships them blank: each install
    /// sets them in Settings (persisted as the `llama_cpp` row of the app
    /// settings table) or through the JARVIS_LLAMA_* environment variables; see
    /// `with_env_fallbacks`.
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:8080/v1".to_string(),
            model: "Inkling-2-Mini-UD-IQ3_XXS.gguf".to_string(),
            server_path: String::new(),
            model_path: String::new(),
            mtp_path: String::new(),
            port: 8080,
            context_window: 57344,
            reasoning_budget: 2048,
            n_cpu_moe: 0,
            batch_size: 512,
            spec_type: String::new(),
            spec_draft_n_max: 0,
            cache_type: "q4_0".to_string(),
            override_tensor: r"blk\.(0|1|2|3|4|5|18|19|20|21|22|23)\.ffn_.*_exps\.=CPU"
                .to_string(),
            auto_fit: true,
            threads: 8,
            batch_threads: 6,
            reasoning_effort: "medium".to_string(),
            no_host: true,
            no_repack: true,
            cache_prompt: true,
            cache_reuse: Some(0),
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

    /// llama-server arguments after the executable. `mtp_head_exists` says
    /// whether `mtp_path` names an existing file; a configured head that is
    /// missing drops `draft-mtp` so the server still starts with the rest of
    /// the speculation stack.
    ///
    /// Every optional flag is emitted only when its field is set, so a row saved
    /// before those fields existed produces the same argument vector it always
    /// did. `cache_type` is the exception: it always emits `-ctk`/`-ctv` (a
    /// blank value falls back to the legacy `q8_0`).
    pub fn server_args(&self, mtp_head_exists: bool) -> Vec<String> {
        let port = self.port.to_string();
        let n_cpu_moe = self.n_cpu_moe.to_string();
        let context = self.context_window.to_string();
        let batch = self.batch_size.to_string();
        let budget = self.reasoning_budget.to_string();
        let cache_type = match self.cache_type.trim() {
            "" => "q8_0",
            value => value,
        };
        let mut args: Vec<String> = [
            "-m",
            self.model_path.trim(),
            "--alias",
            self.model.as_str(),
            "--host",
            "127.0.0.1",
            "--port",
            port.as_str(),
            "-ngl",
            "99",
            "--n-cpu-moe",
            n_cpu_moe.as_str(),
        ]
        .iter()
        .map(|arg| arg.to_string())
        .collect();

        let override_tensor = self.override_tensor.trim();
        if !override_tensor.is_empty() {
            args.extend(["-ot".to_string(), override_tensor.to_string()]);
        }

        args.extend(
            [
                "-c",
                context.as_str(),
                "-ctk",
                cache_type,
                "-ctv",
                cache_type,
                "--flash-attn",
                "on",
            ]
            .iter()
            .map(|arg| arg.to_string()),
        );

        if self.threads > 0 {
            args.extend(["-t".to_string(), self.threads.to_string()]);
        }
        if self.batch_threads > 0 {
            args.extend(["-tb".to_string(), self.batch_threads.to_string()]);
        }

        args.extend(
            [
                // -np > 1 is not supported with MTP
                "-b",
                batch.as_str(),
                "-ub",
                batch.as_str(),
                "-np",
                "1",
                "--jinja",
                "--reasoning-budget",
                budget.as_str(),
            ]
            .iter()
            .map(|arg| arg.to_string()),
        );

        let reasoning_effort = self.reasoning_effort.trim();
        if !reasoning_effort.is_empty() {
            args.extend([
                "--chat-template-kwargs".to_string(),
                format!("{{\"reasoning_effort\":\"{reasoning_effort}\"}}"),
            ]);
        }

        args.extend(
            [
                "--no-webui",
                // The default 8 GiB host prompt cache starves a 16 GB machine.
                "--cache-ram",
                "0",
            ]
            .iter()
            .map(|arg| arg.to_string()),
        );

        if self.no_host {
            args.push("--no-host".to_string());
        }
        if self.no_repack {
            args.push("--no-repack".to_string());
        }
        if self.cache_prompt {
            args.push("--cache-prompt".to_string());
        }
        if let Some(cache_reuse) = self.cache_reuse {
            args.extend(["--cache-reuse".to_string(), cache_reuse.to_string()]);
        }

        let mtp_configured = !self.mtp_path.trim().is_empty();
        let spec: Vec<&str> = self
            .spec_type
            .split(',')
            .map(str::trim)
            .filter(|kind| !kind.is_empty())
            .filter(|kind| !(*kind == "draft-mtp" && mtp_configured && !mtp_head_exists))
            .collect();
        if !spec.is_empty() {
            args.extend([
                "--spec-type".to_string(),
                spec.join(","),
                "--spec-draft-n-max".to_string(),
                self.spec_draft_n_max.to_string(),
            ]);
            if mtp_configured && mtp_head_exists && spec.contains(&"draft-mtp") {
                args.extend(["-md".to_string(), self.mtp_path.trim().to_string()]);
            }
        }
        args
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

    fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|index| args.get(index + 1))
            .map(String::as_str)
    }

    /// The measured "AgentFast" placement: the q4_0 KV cache leaves room for
    /// the experts of looped layers 6-17 to stay on the GPU, while layers 0-5
    /// and 18-23 keep theirs on the CPU.
    const AGENT_FAST_OVERRIDE_TENSOR: &str =
        r"blk\.(0|1|2|3|4|5|18|19|20|21|22|23)\.ffn_.*_exps\.=CPU";

    /// The DD-144 "Agent" placement the shipped default used before DD-145.
    const AGENT_OVERRIDE_TENSOR: &str =
        r"blk\.(0|1|2|3|4|5|15|16|17|18|19|20|21|22|23)\.ffn_.*_exps\.=CPU";

    #[test]
    fn default_launches_the_inkling_agent_fast_profile() {
        let config = LlamaCppConfig {
            model_path: "inkling.gguf".to_string(),
            ..LlamaCppConfig::default()
        };
        let args = config.server_args(false);
        assert_eq!(flag(&args, "-m"), Some("inkling.gguf"));
        assert_eq!(flag(&args, "--alias"), Some("Inkling-2-Mini-UD-IQ3_XXS.gguf"));
        assert_eq!(flag(&args, "-ngl"), Some("99"));
        assert_eq!(flag(&args, "--n-cpu-moe"), Some("0"));
        assert_eq!(flag(&args, "-ot"), Some(AGENT_FAST_OVERRIDE_TENSOR));
        // The pre-DD-145 6-14 placement must not survive as the default.
        assert!(
            !args.iter().any(|arg| arg == AGENT_OVERRIDE_TENSOR),
            "default server_args still carries the DD-144 6-14 expert placement: {args:?}"
        );
        assert_eq!(flag(&args, "-c"), Some("57344"));
        assert_eq!(flag(&args, "-ctk"), Some("q4_0"));
        assert_eq!(flag(&args, "-ctv"), Some("q4_0"));
        // llama-server's long form of `-fa`; the short form would change the
        // argument vector legacy rows already launch with.
        assert_eq!(flag(&args, "--flash-attn"), Some("on"));
        assert_eq!(flag(&args, "-b"), Some("512"));
        assert_eq!(flag(&args, "-ub"), Some("512"));
        assert_eq!(flag(&args, "-t"), Some("8"));
        assert_eq!(flag(&args, "-tb"), Some("6"));
        assert_eq!(flag(&args, "-np"), Some("1"));
        assert!(args.iter().any(|arg| arg == "--jinja"));
        assert_eq!(flag(&args, "--reasoning-budget"), Some("2048"));
        assert_eq!(
            flag(&args, "--chat-template-kwargs"),
            Some(r#"{"reasoning_effort":"medium"}"#)
        );
        assert!(args.iter().any(|arg| arg == "--no-host"));
        assert!(args.iter().any(|arg| arg == "--no-repack"));
        assert!(args.iter().any(|arg| arg == "--cache-prompt"));
        assert_eq!(flag(&args, "--cache-ram"), Some("0"));
        assert_eq!(flag(&args, "--cache-reuse"), Some("0"));
        // No speculation: Inkling's DSpark draft head and n-gram lookup both
        // measured slower than plain decoding.
        assert!(!args
            .iter()
            .any(|arg| arg == "--spec-type" || arg == "-md" || arg == "--spec-draft-n-max"));
    }

    #[test]
    fn separate_mtp_head_is_passed_when_present_and_dropped_when_missing() {
        let config = LlamaCppConfig {
            model_path: "gemma.gguf".to_string(),
            mtp_path: "mtp-gemma.gguf".to_string(),
            n_cpu_moe: 16,
            spec_type: "draft-mtp,ngram-mod".to_string(),
            spec_draft_n_max: 2,
            ..LlamaCppConfig::default()
        };
        let present = config.server_args(true);
        assert_eq!(flag(&present, "--spec-type"), Some("draft-mtp,ngram-mod"));
        assert_eq!(flag(&present, "-md"), Some("mtp-gemma.gguf"));
        assert_eq!(flag(&present, "--n-cpu-moe"), Some("16"));

        let missing = config.server_args(false);
        assert_eq!(flag(&missing, "--spec-type"), Some("ngram-mod"));
        assert!(!missing.iter().any(|arg| arg == "-md"));
    }

    #[test]
    fn blank_spec_type_disables_speculation() {
        let config = LlamaCppConfig {
            spec_type: " ".to_string(),
            ..LlamaCppConfig::default()
        };
        let args = config.server_args(false);
        assert!(!args.iter().any(|arg| arg == "--spec-type" || arg == "-md"));
    }

    /// Pre-change row, verbatim from an install that saved llama.cpp settings
    /// before the Inkling-2-Mini default. Every field it does not carry has to
    /// deserialize to the value it had before, not to the new default.
    const STORED_PRE_CHANGE_ROW: &str = r#"{"base_url":"http://127.0.0.1:8080/v1","model":"m","server_path":"s","model_path":"p","mtp_path":"","port":8080,"context_window":16384,"reasoning_budget":0}"#;

    #[test]
    fn stored_row_without_placement_fields_keeps_the_legacy_values() {
        let config: LlamaCppConfig = serde_json::from_str(STORED_PRE_CHANGE_ROW).unwrap();
        assert_eq!(config.n_cpu_moe, 0);
        assert_eq!(config.batch_size, 1024);
        assert_eq!(config.spec_type, "draft-mtp,ngram-mod");
        assert_eq!(config.spec_draft_n_max, 2);
        // Fields the row predates are the legacy no-ops, not the Inkling profile.
        assert_eq!(config.cache_type, "q8_0");
        assert_eq!(config.override_tensor, "");
        assert_eq!(config.threads, 0);
        assert_eq!(config.batch_threads, 0);
        assert_eq!(config.reasoning_effort, "");
        assert!(!config.no_host);
        assert!(!config.no_repack);
        assert!(!config.cache_prompt);
        assert_eq!(config.cache_reuse, None);
    }

    #[test]
    fn block_without_model_or_window_takes_the_current_defaults() {
        // A fresh block (paths only) is not a pre-change row: the fields every
        // saved row has always written fall back to the Inkling-2-Mini default.
        let stored = r#"{"server_path":"s","model_path":"p"}"#;
        let config: LlamaCppConfig = serde_json::from_str(stored).unwrap();
        assert_eq!(config.model, "Inkling-2-Mini-UD-IQ3_XXS.gguf");
        assert_eq!(config.context_window, 57344);
        assert_eq!(config.reasoning_budget, 2048);
        assert_eq!(config.threads, 0);
        assert!(!config.no_host);
    }

    #[test]
    fn stored_pre_change_row_launches_byte_identical_args() {
        // Exactly what the launcher emitted for this row before DD-144: q8_0
        // KV, no `-ot`, no thread flags, no chat-template-kwargs, no new flags.
        let config: LlamaCppConfig = serde_json::from_str(STORED_PRE_CHANGE_ROW).unwrap();
        let expected: Vec<String> = [
            "-m",
            "p",
            "--alias",
            "m",
            "--host",
            "127.0.0.1",
            "--port",
            "8080",
            "-ngl",
            "99",
            "--n-cpu-moe",
            "0",
            "-c",
            "16384",
            "-ctk",
            "q8_0",
            "-ctv",
            "q8_0",
            "--flash-attn",
            "on",
            "-b",
            "1024",
            "-ub",
            "1024",
            "-np",
            "1",
            "--jinja",
            "--reasoning-budget",
            "0",
            "--no-webui",
            "--cache-ram",
            "0",
            "--spec-type",
            "draft-mtp,ngram-mod",
            "--spec-draft-n-max",
            "2",
        ]
        .iter()
        .map(|arg| arg.to_string())
        .collect();
        assert_eq!(config.server_args(false), expected);
    }

    /// A row saved after DD-144 but before DD-145 names the DD-144 "Agent"
    /// values (f16 KV, experts of layers 6-14 on the GPU, six threads). Only
    /// `Default::default()` moves to AgentFast; a stored row keeps its own
    /// launch vector.
    #[test]
    fn stored_agent_profile_row_keeps_its_own_launch_values() {
        let stored = concat!(
            r#"{"base_url":"http://127.0.0.1:8080/v1","model":"m","server_path":"s","model_path":"p","mtp_path":"","port":8080,"context_window":57344,"reasoning_budget":2048,"n_cpu_moe":0,"batch_size":512,"spec_type":"","spec_draft_n_max":0,"cache_type":"f16","#,
            r#""override_tensor":"blk\\.(0|1|2|3|4|5|15|16|17|18|19|20|21|22|23)\\.ffn_.*_exps\\.=CPU","threads":6,"batch_threads":6,"reasoning_effort":"medium","no_host":true,"no_repack":true,"cache_prompt":true,"cache_reuse":0}"#,
        );
        let config: LlamaCppConfig = serde_json::from_str(stored).unwrap();
        let args = config.server_args(false);
        assert_eq!(flag(&args, "-ctk"), Some("f16"));
        assert_eq!(flag(&args, "-ctv"), Some("f16"));
        assert_eq!(flag(&args, "-ot"), Some(AGENT_OVERRIDE_TENSOR));
        assert_eq!(flag(&args, "-t"), Some("6"));
        assert_eq!(flag(&args, "-tb"), Some("6"));
        assert!(!args.iter().any(|arg| arg == AGENT_FAST_OVERRIDE_TENSOR));
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

/// Pins the native `OllamaConfig::default()` to the Bun server's
/// `defaultConfig().ollama` (`server-jarvis/src/config.ts:666-677`). If the Bun
/// defaults move, or these values drift back to empty/zero, the first Settings
/// save in a fresh install blanks a working Ollama block again.
#[cfg(test)]
mod ollama_config_default_tests {
    use super::*;

    #[test]
    fn default_matches_bun_ollama_defaults() {
        let config = OllamaConfig::default();
        // config.ts:667
        assert_eq!(config.base_url, "http://localhost:11434/v1");
        // config.ts:668
        assert_eq!(config.model, "qwen3.5-9b:latest");
        // config.ts:669
        assert!(config.auto_pull);
        // config.ts:670
        assert_eq!(config.health_check_interval_ms, 30000);
        // config.ts:672 (Bun keeps num_ctx under `options`, the native struct
        // carries it as a top-level field; the value is the same)
        assert_eq!(config.num_ctx, 8192);
        // config.ts:673
        assert_eq!(config.options.num_gpu, 31);
        // config.ts:674
        assert_eq!(config.options.num_thread, 8);
    }

    #[test]
    fn default_ollama_block_is_not_blank() {
        let config = OllamaConfig::default();
        assert!(
            !config.base_url.trim().is_empty(),
            "a blank base_url is what DD-058 reported getting written on first save"
        );
        assert!(!config.model.trim().is_empty());
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

/// Optional self-hosted vLLM route. The API key remains in the named process
/// environment variable; this config stores only its name.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct VllmConfig {
    pub enabled: bool,
    pub base_url: String,
    pub model: String,
    pub api_key_env: String,
    pub first_token_timeout_ms: u64,
}

impl Default for VllmConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: String::new(),
            model: String::new(),
            api_key_env: String::new(),
            first_token_timeout_ms: 120_000,
        }
    }
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

pub(crate) fn default_true() -> bool {
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
    /// The operator's Enable Bridge setting. Health surfaces must treat a
    /// stopped-but-disabled bridge as a settings state, not a fault.
    #[serde(default = "default_true")]
    pub bridge_enabled: bool,
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
