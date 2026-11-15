//! Inference-backend readiness derived from the canonical config (DD-060).
//!
//! Daedalus ships no model and no llama-server binary: on a fresh install
//! `llama_cpp.server_path` and `llama_cpp.model_path` are blank, so
//! `start_llama_cpp_server` returns an error that boot can only
//! `eprintln!`, and the shell renders as if a backend existed. This module
//! turns the same condition into serializable state the UI can render:
//! either `ready`, or `missing_config` naming the exact blank settings.
//!
//! Derivation is config-only on purpose: whether a configured backend is
//! *running* is `jarvis_check_status`/health state. The one liveness fact that
//! belongs here is the already-listening server boot itself accepts (see
//! [`with_backend_reachable`]), because it changes whether a turn is
//! attemptable at all.

use serde::Serialize;

use super::types::{JarvisBackend, JarvisConfig, LLAMA_MODEL_PATH_ENV, LLAMA_SERVER_PATH_ENV};

/// One blank setting that leaves the active backend unable to answer a turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MissingSetting {
    /// Canonical settings key, e.g. `llama_cpp.server_path`.
    pub key: &'static str,
    /// How Settings labels the same field, so the UI can name it.
    pub label: &'static str,
    /// Environment variable that also satisfies the field, when one exists.
    pub env_var: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendReadinessState {
    Ready,
    MissingConfig,
}

/// What the shell needs to decide between normal chat and a first-run setup
/// state. `missing` is empty exactly when `state` is `Ready`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BackendReadiness {
    pub state: BackendReadinessState,
    pub backend: JarvisBackend,
    pub missing: Vec<MissingSetting>,
}

impl BackendReadiness {
    pub fn is_ready(&self) -> bool {
        self.state == BackendReadinessState::Ready
    }
}

/// Derive readiness for the active backend.
///
/// Only conditions that boot itself treats as fatal are reported, so the UI
/// never claims a setup problem that a working install does not have:
/// - llama.cpp: `start_llama_cpp_server` refuses to launch without both
///   `server_path` and `model_path`.
/// - OpenRouter: boot logs that chats will fail until `openrouter.api_key` is
///   set.
/// - Ollama and Claude CLI resolve their own executable/model, so a blank
///   field is not fatal there.
///
/// llama.cpp artifact paths must already have env fallbacks applied (see
/// `LlamaCppConfig::with_env_fallbacks`), which is what the IPC command does.
pub fn derive_backend_readiness(config: &JarvisConfig) -> BackendReadiness {
    let missing = match &config.active_backend {
        JarvisBackend::LlamaCpp => {
            let mut missing = Vec::new();
            if config.llama_cpp.server_path.trim().is_empty() {
                missing.push(MissingSetting {
                    key: "llama_cpp.server_path",
                    label: "llama.cpp server_path",
                    env_var: Some(LLAMA_SERVER_PATH_ENV),
                });
            }
            if config.llama_cpp.model_path.trim().is_empty() {
                missing.push(MissingSetting {
                    key: "llama_cpp.model_path",
                    label: "llama.cpp model_path",
                    env_var: Some(LLAMA_MODEL_PATH_ENV),
                });
            }
            missing
        }
        JarvisBackend::OpenRouter => {
            if config.openrouter.api_key.trim().is_empty() {
                vec![MissingSetting {
                    key: "openrouter.api_key",
                    label: "OpenRouter API key",
                    env_var: None,
                }]
            } else {
                Vec::new()
            }
        }
        JarvisBackend::Ollama | JarvisBackend::ClaudeCli => Vec::new(),
    };

    let state = if missing.is_empty() {
        BackendReadinessState::Ready
    } else {
        BackendReadinessState::MissingConfig
    };

    BackendReadiness {
        state,
        backend: config.active_backend.clone(),
        missing,
    }
}

/// Fold in the one liveness fact boot already acts on.
///
/// `start_llama_cpp_server` returns `AlreadyListening` before it looks at
/// `server_path`/`model_path`, so a server the user started by hand is usable
/// with blank artifact paths. Reporting `missing_config` there would block a
/// chat that works, so the caller passes the port-probe result in.
pub fn with_backend_reachable(
    readiness: BackendReadiness,
    backend_reachable: bool,
) -> BackendReadiness {
    if backend_reachable && !readiness.is_ready() {
        BackendReadiness {
            state: BackendReadinessState::Ready,
            missing: Vec::new(),
            ..readiness
        }
    } else {
        readiness
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jarvis::types::{LlamaCppConfig, OpenRouterConfig};

    fn llama_cpp_config(server_path: &str, model_path: &str) -> JarvisConfig {
        JarvisConfig {
            active_backend: JarvisBackend::LlamaCpp,
            llama_cpp: LlamaCppConfig {
                server_path: server_path.to_string(),
                model_path: model_path.to_string(),
                ..LlamaCppConfig::default()
            },
            ..JarvisConfig::default()
        }
    }

    fn missing_keys(readiness: &BackendReadiness) -> Vec<&'static str> {
        readiness.missing.iter().map(|setting| setting.key).collect()
    }

    #[test]
    fn blank_llama_cpp_paths_are_missing_config_naming_both_fields() {
        // The shipped default config: no machine-specific paths committed.
        let readiness = derive_backend_readiness(&llama_cpp_config("", ""));

        assert_eq!(readiness.state, BackendReadinessState::MissingConfig);
        assert!(!readiness.is_ready());
        assert_eq!(readiness.backend, JarvisBackend::LlamaCpp);
        assert_eq!(
            missing_keys(&readiness),
            vec!["llama_cpp.server_path", "llama_cpp.model_path"]
        );
        assert_eq!(
            readiness.missing[0].env_var,
            Some(LLAMA_SERVER_PATH_ENV),
            "the setup state names where else the field can be set"
        );
        assert_eq!(readiness.missing[1].env_var, Some(LLAMA_MODEL_PATH_ENV));
        assert_eq!(readiness.missing[0].label, "llama.cpp server_path");
        assert_eq!(readiness.missing[1].label, "llama.cpp model_path");
    }

    #[test]
    fn filled_llama_cpp_paths_are_ready() {
        let readiness = derive_backend_readiness(&llama_cpp_config(
            "C:/llama.cpp/build/bin/llama-server.exe",
            "D:/models/qwen3.6-keep96.gguf",
        ));

        assert_eq!(readiness.state, BackendReadinessState::Ready);
        assert!(readiness.is_ready());
        assert!(readiness.missing.is_empty());
    }

    #[test]
    fn whitespace_only_paths_still_count_as_blank() {
        // `start_llama_cpp_server` trims before its checks, so the setup state
        // must agree: spaces are not a configured path.
        let readiness = derive_backend_readiness(&llama_cpp_config("   ", "\t"));

        assert_eq!(
            missing_keys(&readiness),
            vec!["llama_cpp.server_path", "llama_cpp.model_path"]
        );
    }

    #[test]
    fn a_partly_configured_install_names_only_the_blank_field() {
        let readiness = derive_backend_readiness(&llama_cpp_config(
            "C:/llama.cpp/build/bin/llama-server.exe",
            "",
        ));

        assert_eq!(readiness.state, BackendReadinessState::MissingConfig);
        assert_eq!(missing_keys(&readiness), vec!["llama_cpp.model_path"]);
    }

    #[test]
    fn readiness_follows_the_active_backend() {
        // Filled llama.cpp artifacts do not make an OpenRouter turn attemptable.
        let mut config = llama_cpp_config("server", "model");
        config.active_backend = JarvisBackend::OpenRouter;
        config.openrouter = OpenRouterConfig::default();
        config.openrouter.api_key = String::new();

        let readiness = derive_backend_readiness(&config);
        assert_eq!(readiness.state, BackendReadinessState::MissingConfig);
        assert_eq!(readiness.backend, JarvisBackend::OpenRouter);
        assert_eq!(missing_keys(&readiness), vec!["openrouter.api_key"]);

        // A non-blank placeholder, not a credential: the derivation only checks
        // that the key is set, and a key-shaped literal trips the secret scanner.
        config.openrouter.api_key = "test".to_string();
        assert!(derive_backend_readiness(&config).is_ready());
    }

    #[test]
    fn backends_that_resolve_their_own_runtime_are_ready() {
        // Boot starts neither as a hard requirement: Ollama pulls/serves its own
        // model and the Claude CLI resolves from PATH.
        let ollama = JarvisConfig {
            active_backend: JarvisBackend::Ollama,
            ..JarvisConfig::default()
        };
        assert!(derive_backend_readiness(&ollama).is_ready());

        let claude = JarvisConfig {
            active_backend: JarvisBackend::ClaudeCli,
            ..JarvisConfig::default()
        };
        assert!(derive_backend_readiness(&claude).is_ready());
    }

    #[test]
    fn an_already_serving_backend_is_not_reported_as_unconfigured() {
        // Boot returns AlreadyListening before it reads the artifact paths; the
        // gate must agree or it blocks a chat that already works.
        let serving =
            with_backend_reachable(derive_backend_readiness(&llama_cpp_config("", "")), true);
        assert!(serving.is_ready());
        assert!(serving.missing.is_empty());

        let not_serving =
            with_backend_reachable(derive_backend_readiness(&llama_cpp_config("", "")), false);
        assert_eq!(not_serving.state, BackendReadinessState::MissingConfig);
        assert_eq!(missing_keys(&not_serving).len(), 2);
    }

    #[test]
    fn serializes_the_state_the_shell_reads() {
        let readiness = derive_backend_readiness(&llama_cpp_config("", ""));

        let value = serde_json::to_value(&readiness).unwrap();
        assert_eq!(value["state"], "missing_config");
        assert_eq!(value["backend"], "llama_cpp");
        assert_eq!(value["missing"][0]["key"], "llama_cpp.server_path");
        assert_eq!(value["missing"][1]["key"], "llama_cpp.model_path");
        assert!(!value["missing"][0]["label"].as_str().unwrap().is_empty());
        assert_eq!(value["missing"][0]["env_var"], "JARVIS_LLAMA_SERVER_PATH");

        let ready =
            serde_json::to_value(derive_backend_readiness(&llama_cpp_config("s", "m"))).unwrap();
        assert_eq!(ready["state"], "ready");
        assert!(ready["missing"].as_array().unwrap().is_empty());
    }
}
