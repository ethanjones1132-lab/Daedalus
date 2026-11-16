//! Inference-backend readiness derived from the canonical config (DD-060).
//!
//! Daedalus ships no model and no llama-server binary: on a fresh install
//! `llama_cpp.server_path` and `llama_cpp.model_path` are blank, so
//! `start_llama_cpp_server` returns an error that boot can only
//! `eprintln!`, and the shell renders as if a backend existed. This module
//! turns the same condition into serializable state the UI can render:
//! `ready`, `missing_config` naming the exact blank settings, or
//! `not_listening` when the settings are complete but nothing answers the
//! backend's port.
//!
//! Derivation is config-only on purpose: which process is running is
//! `jarvis_check_status`/health state. The one liveness fact that belongs here
//! is the port probe boot itself uses (see [`with_backend_reachable`]), because
//! it changes whether a turn is attemptable at all — in both directions: a
//! server already answering makes an unconfigured install usable, and a
//! configured backend with a closed port cannot answer a turn.

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
    /// The active backend can answer a turn as far as this process can tell.
    Ready,
    /// At least one required setting is blank, so the backend cannot start.
    MissingConfig,
    /// The settings are complete, but nothing is listening on the backend's
    /// port: the local server may still be starting, may have exited, or may
    /// be bound elsewhere. A turn sent now would fail at the first request.
    NotListening,
}

/// What the shell needs to decide between normal chat and a first-run setup
/// state. `missing` names the blank settings, so it is empty for every state
/// except `MissingConfig`.
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
/// The probe is not a one-way lift into `Ready`:
/// - `true` means a server is already answering. `start_llama_cpp_server`
///   returns `AlreadyListening` before it looks at `server_path`/`model_path`,
///   so a server the user started by hand is usable with blank artifact paths.
///   Reporting `missing_config` there would block a chat that works.
/// - `false` on a configured install means nothing is answering the port yet,
///   so the value must stop claiming `Ready`: the turn would fail at the first
///   request. A backend that is still `missing_config` keeps that more specific
///   verdict, because the blank setting is the thing to fix.
pub fn with_backend_reachable(
    readiness: BackendReadiness,
    backend_reachable: bool,
) -> BackendReadiness {
    if backend_reachable {
        if readiness.is_ready() {
            readiness
        } else {
            BackendReadiness {
                state: BackendReadinessState::Ready,
                missing: Vec::new(),
                ..readiness
            }
        }
    } else if readiness.state == BackendReadinessState::MissingConfig {
        readiness
    } else {
        BackendReadiness {
            state: BackendReadinessState::NotListening,
            missing: Vec::new(),
            ..readiness
        }
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
    fn a_configured_backend_that_is_not_listening_is_not_ready() {
        // DD-067: complete settings are not the same as an answering backend.
        // Boot spawns llama.cpp fire-and-forget, so the port probe is the only
        // fact that says whether a turn sent right now can reach it.
        let configured = derive_backend_readiness(&llama_cpp_config(
            "C:/llama.cpp/build/bin/llama-server.exe",
            "D:/models/qwen3.6-keep96.gguf",
        ));
        assert!(configured.is_ready());

        let silent = with_backend_reachable(configured.clone(), false);
        assert_eq!(silent.state, BackendReadinessState::NotListening);
        assert!(!silent.is_ready());
        assert!(silent.missing.is_empty(), "nothing is blank, so nothing is named");
        assert_eq!(silent.backend, JarvisBackend::LlamaCpp);

        // Not a one-way ratchet: once the server answers, the same install is
        // ready again, and a second `true` probe changes nothing.
        let serving = with_backend_reachable(silent.clone(), true);
        assert_eq!(serving, configured);
        assert!(serving.is_ready());
        assert_eq!(with_backend_reachable(serving, true), configured);
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

        let silent = serde_json::to_value(with_backend_reachable(
            derive_backend_readiness(&llama_cpp_config("s", "m")),
            false,
        ))
        .unwrap();
        assert_eq!(silent["state"], "not_listening");
        assert_eq!(silent["backend"], "llama_cpp");
        assert!(silent["missing"].as_array().unwrap().is_empty());
    }
}
