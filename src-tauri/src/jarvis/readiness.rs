//! Inference-backend readiness derived from the canonical config (DD-060).
//!
//! Daedalus ships no model and no llama-server binary: on a fresh install
//! `llama_cpp.server_path` and `llama_cpp.model_path` are blank, so
//! `start_llama_cpp_server` returns an error that boot can only
//! `eprintln!`, and the shell renders as if a backend existed. This module
//! turns the same condition into serializable state the UI can render:
//! `ready`, `missing_config` naming the exact blank setting or the program
//! that could not be found/run, `missing_file` when a configured artifact path
//! is not a file (DD-111), or `not_listening` when the settings are complete
//! but nothing answers the backend's port — or when the port is held by a
//! listener that does not answer as llama.cpp (DD-162).
//!
//! Derivation is config-only on purpose: which process is running is
//! `jarvis_check_status`/health state. The one liveness fact that belongs here
//! is the identified-server probe boot itself uses (see
//! [`with_backend_reachable`]), because it changes whether a turn is attemptable
//! at all — in both directions: a server already answering makes an unconfigured
//! install usable, and a configured backend with a closed port cannot answer a
//! turn.

use serde::Serialize;

use super::types::{JarvisBackend, JarvisConfig, LLAMA_MODEL_PATH_ENV, LLAMA_SERVER_PATH_ENV};

/// One setting (or program) that leaves the active backend unable to answer a
/// turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MissingSetting {
    /// Canonical settings key, e.g. `llama_cpp.server_path`.
    pub key: &'static str,
    /// How Settings labels the same field, so the UI can name it.
    pub label: &'static str,
    /// Environment variable that also satisfies the field, when one exists.
    pub env_var: Option<&'static str>,
    /// DD-115: the item's own sentence when the field is not merely blank —
    /// a program the backend resolves itself is absent or cannot run. It names
    /// the program, so the shell can print it verbatim instead of reading
    /// "missing ollama executable". Omitted from the wire for blank settings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// DD-111: the configured artifact path that is not a file. A blank field
    /// has no path; an unusable one names the exact path the operator should
    /// correct, so the composer and the health band can print the same one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// What the spawn path found for the executable a backend resolves itself.
///
/// DD-115: Ollama and the Claude CLI are selectable but their programs are not
/// shipped. Selecting one whose executable is absent used to report `ready`,
/// so Send stayed live and the first turn failed in the child process with
/// nothing to read. This is only the presence judgement — where to look stays
/// the spawn path's lookup (`find_ollama_binary`, `resolveClaudePath`), never a
/// second `PATH` parser in this module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendExecutable {
    /// The lookup resolved a program the OS can start.
    Present,
    /// No candidate exists in the locations the spawn path searches.
    Absent,
    /// A candidate exists, but starting it would fail: the OS refuses the file
    /// (not executable) or it is not a file at all.
    NotRunnable(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendReadinessState {
    /// The active backend can answer a turn as far as this process can tell.
    Ready,
    /// The active backend cannot start: at least one required setting is blank,
    /// or (DD-115) the program it resolves itself is absent or cannot run.
    MissingConfig,
    /// A required setting is configured, but the path it names is not a file:
    /// a missing GGUF, or a `server_path` that points at a directory. Nothing
    /// is blank, so this is not `missing_config`, and the backend can never
    /// bind its port, so it must not read as a backend that may still be
    /// starting (DD-111).
    MissingFile,
    /// The settings are complete, but nothing llama.cpp answers the backend's
    /// port: the local server may still be starting, may have exited, or the
    /// port may be held by a listener that does not answer as llama.cpp (DD-162,
    /// named in `missing`). A turn sent now would fail at the first request.
    NotListening,
}

/// What the shell needs to decide between normal chat and a first-run setup
/// state. `missing` names the setting or program that is unavailable, so it is
/// empty for every state except `MissingConfig`, `MissingFile`, and (DD-162)
/// `NotListening` when the port is held by a listener that is not llama.cpp.
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
///   `server_path` and `model_path`, and refuses again when either path is not
///   a file (DD-111). A blank field is `missing_config`; a configured path that
///   is a directory or does not exist is `missing_file`, named with the path.
/// - OpenRouter: boot logs that chats will fail until `openrouter.api_key` is
///   set.
/// - Ollama and Claude CLI resolve their own executable/model, so a blank
///   field is not fatal there — but an executable that cannot be found or run
///   is (DD-115): the turn would die in the child process.
///
/// The artifact check runs before the port probe (`with_backend_reachable`):
/// a hopeless install must never be reported as a server that may still be
/// starting, while an already-answering port still wins because boot returns
/// `AlreadyListening` before it looks at these files.
///
/// llama.cpp artifact paths must already have env fallbacks applied (see
/// `LlamaCppConfig::with_env_fallbacks`), which is what the IPC command does.
pub fn derive_backend_readiness(config: &JarvisConfig) -> BackendReadiness {
    derive_backend_readiness_with(config, crate::backend_executable_state)
}

/// [`derive_backend_readiness`] with the executable lookup injected.
///
/// The production lookup touches the filesystem, so tests pin both answers of
/// a program's presence without depending on what this machine has installed.
pub fn derive_backend_readiness_with(
    config: &JarvisConfig,
    executable: impl Fn(&JarvisConfig) -> BackendExecutable,
) -> BackendReadiness {
    let missing = match &config.active_backend {
        JarvisBackend::LlamaCpp => {
            let mut missing = Vec::new();
            if config.llama_cpp.server_path.trim().is_empty() {
                missing.push(MissingSetting {
                    key: "llama_cpp.server_path",
                    label: "llama.cpp server_path",
                    env_var: Some(LLAMA_SERVER_PATH_ENV),
                    reason: None,
                    path: None,
                });
            }
            if config.llama_cpp.model_path.trim().is_empty() {
                missing.push(MissingSetting {
                    key: "llama_cpp.model_path",
                    label: "llama.cpp model_path",
                    env_var: Some(LLAMA_MODEL_PATH_ENV),
                    reason: None,
                    path: None,
                });
            }
            // DD-111: a configured path that is not a file makes the launch
            // hopeless, so it is its own fault rather than a port that might
            // still come up. Blank fields keep the `missing_config` verdict
            // above, and an already-answering port never reaches this check
            // (`with_backend_reachable`).
            if missing.is_empty() {
                let artifacts: [(&'static str, &'static str, &'static str, &str); 2] = [
                    (
                        "llama_cpp.server_path",
                        "llama.cpp server_path",
                        LLAMA_SERVER_PATH_ENV,
                        config.llama_cpp.server_path.as_str(),
                    ),
                    (
                        "llama_cpp.model_path",
                        "llama.cpp model_path",
                        LLAMA_MODEL_PATH_ENV,
                        config.llama_cpp.model_path.as_str(),
                    ),
                ];
                for (key, label, env_var, value) in artifacts {
                    let path = std::path::Path::new(value.trim());
                    if !path.is_file() {
                        missing.push(MissingSetting {
                            key,
                            label,
                            env_var: Some(env_var),
                            reason: None,
                            path: Some(path.display().to_string()),
                        });
                    }
                }
            }
            missing
        }
        JarvisBackend::OpenRouter => {
            if config.openrouter.api_key.trim().is_empty() {
                vec![MissingSetting {
                    key: "openrouter.api_key",
                    label: "OpenRouter API key",
                    env_var: None,
                    reason: None,
                    path: None,
                }]
            } else {
                Vec::new()
            }
        }
        JarvisBackend::Ollama => missing_executable(
            executable(config),
            "ollama.executable",
            "ollama executable",
            Some("JARVIS_OLLAMA_BIN"),
            "ollama",
            "install Ollama, add it to PATH, or set JARVIS_OLLAMA_BIN",
        ),
        JarvisBackend::ClaudeCli => missing_executable(
            executable(config),
            "claude_cli.executable",
            "claude executable",
            None,
            "claude",
            "install the Claude CLI or add it to PATH",
        ),
    };

    let state = if missing.is_empty() {
        BackendReadinessState::Ready
    } else if missing.iter().all(|setting| setting.path.is_some()) {
        // Only unusable artifacts: every blank field was filled, but a path
        // that should name a file names something else (DD-111).
        BackendReadinessState::MissingFile
    } else {
        BackendReadinessState::MissingConfig
    };

    BackendReadiness {
        state,
        backend: config.active_backend.clone(),
        missing,
    }
}

/// The readiness item for a backend whose own executable cannot be spawned.
///
/// `program` is the executable name in the same lower-case form the item labels
/// use, so the item reads as a sentence ("ollama was not found …") rather than
/// as a field name. A present program contributes no item, which keeps the
/// installed case exactly as it was before DD-115.
fn missing_executable(
    found: BackendExecutable,
    key: &'static str,
    label: &'static str,
    env_var: Option<&'static str>,
    program: &str,
    install_hint: &str,
) -> Vec<MissingSetting> {
    let reason = match found {
        BackendExecutable::Present => return Vec::new(),
        BackendExecutable::Absent => format!("{program} was not found — {install_hint}"),
        // A file that exists but cannot be started is its own failure: telling
        // the operator to install again would send them after the wrong thing.
        BackendExecutable::NotRunnable(path) => {
            format!("{program} was found at {path} but could not be run — {install_hint}")
        }
    };
    vec![MissingSetting {
        key,
        label,
        env_var,
        reason: Some(reason),
        path: None,
    }]
}

/// Fold in the one liveness fact boot already acts on.
///
/// `backend_reachable` means *identified*, not merely "the port is open": boot
/// adopts a listener only when `crate::llama_cpp_server_is_serving` passes, so
/// the caller must pass that same answer. The probe is not a one-way lift into
/// `Ready`:
/// - `true` means an identified llama.cpp server is already answering.
///   `start_llama_cpp_server` returns `AlreadyListening` before it looks at
///   `server_path`/`model_path`, so a server the user started by hand is usable
///   with blank artifact paths. Reporting `missing_config` there would block a
///   chat that works.
/// - `false` on a configured install means nothing is answering the port yet,
///   so the value must stop claiming `Ready`: the turn would fail at the first
///   request. A backend that is still `missing_config` or `missing_file` keeps
///   that more specific verdict, because the blank field or the unusable path
///   is the thing to fix — a hopeless install must not read as "starting".
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
    } else if matches!(
        readiness.state,
        BackendReadinessState::MissingConfig | BackendReadinessState::MissingFile
    ) {
        readiness
    } else {
        BackendReadiness {
            state: BackendReadinessState::NotListening,
            missing: Vec::new(),
            ..readiness
        }
    }
}

/// Readiness for a llama.cpp port held by a listener that does not answer as
/// llama.cpp.
///
/// An unidentified listener is not adoptable (`start_llama_cpp_server` refuses
/// it by name), so the install must not read as `Ready`. The state becomes
/// `NotListening` — or keeps a more specific `missing_config`/`missing_file`
/// verdict that the operator still has to fix — and the `missing` list gains an
/// item naming the port conflict, so the setup band and the composer can say
/// what is actually in the way.
pub fn with_backend_port_conflict(
    readiness: BackendReadiness,
    port: u16,
) -> BackendReadiness {
    let state = if matches!(
        readiness.state,
        BackendReadinessState::MissingConfig | BackendReadinessState::MissingFile
    ) {
        readiness.state
    } else {
        BackendReadinessState::NotListening
    };
    let mut missing = readiness.missing;
    missing.push(MissingSetting {
        key: "llama_cpp.port",
        label: "llama.cpp port",
        env_var: None,
        reason: Some(format!(
            "port {port} is held by a process that does not answer as llama.cpp; refusing to use it"
        )),
        path: None,
    });
    BackendReadiness {
        state,
        backend: readiness.backend,
        missing,
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

    /// A scratch directory for one test. The artifact check is a real
    /// `Path::is_file()`, so ready and missing-file verdicts are proven against
    /// paths that exist rather than against whatever this machine has.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("dd111-readiness-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_artifact(dir: &std::path::Path, name: &str) -> String {
        let path = dir.join(name);
        std::fs::write(&path, b"artifact").unwrap();
        path.display().to_string()
    }

    /// Both llama.cpp artifacts exist, so only the port can make this unready.
    fn ready_llama_cpp_config(dir: &std::path::Path) -> JarvisConfig {
        llama_cpp_config(
            &write_artifact(dir, "llama-server.exe"),
            &write_artifact(dir, "model.gguf"),
        )
    }

    fn ollama_config() -> JarvisConfig {
        JarvisConfig {
            active_backend: JarvisBackend::Ollama,
            ..JarvisConfig::default()
        }
    }

    fn claude_config() -> JarvisConfig {
        JarvisConfig {
            active_backend: JarvisBackend::ClaudeCli,
            ..JarvisConfig::default()
        }
    }

    fn present(_config: &JarvisConfig) -> BackendExecutable {
        BackendExecutable::Present
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
        let dir = scratch("ready");
        let readiness = derive_backend_readiness(&ready_llama_cpp_config(&dir));

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
    fn a_configured_directory_is_missing_file_naming_the_setting_and_path() {
        // DD-111: a server_path that names a directory can never be spawned, so
        // it is its own fault — not a blank field and not a port still coming up.
        let dir = scratch("server-is-a-directory");
        let model = write_artifact(&dir, "model.gguf");
        let readiness =
            derive_backend_readiness(&llama_cpp_config(&dir.display().to_string(), &model));

        assert_eq!(readiness.state, BackendReadinessState::MissingFile);
        assert!(!readiness.is_ready());
        assert_eq!(readiness.backend, JarvisBackend::LlamaCpp);
        assert_eq!(missing_keys(&readiness), vec!["llama_cpp.server_path"]);
        assert_eq!(readiness.missing[0].label, "llama.cpp server_path");
        assert_eq!(
            readiness.missing[0].env_var,
            Some(LLAMA_SERVER_PATH_ENV),
            "the item still names where else the field can be set"
        );
        assert_eq!(
            readiness.missing[0].path.as_deref(),
            Some(dir.display().to_string().as_str()),
            "the item carries the exact path the operator must correct"
        );
    }

    #[test]
    fn an_absent_gguf_is_missing_file_naming_the_model_path() {
        let dir = scratch("model-absent");
        let server = write_artifact(&dir, "llama-server.exe");
        let absent = dir.join("not-installed.gguf").display().to_string();

        let readiness = derive_backend_readiness(&llama_cpp_config(&server, &absent));

        assert_eq!(readiness.state, BackendReadinessState::MissingFile);
        assert_eq!(missing_keys(&readiness), vec!["llama_cpp.model_path"]);
        assert_eq!(readiness.missing[0].label, "llama.cpp model_path");
        assert_eq!(readiness.missing[0].path.as_deref(), Some(absent.as_str()));
    }

    #[test]
    fn a_missing_artifact_keeps_its_verdict_while_nothing_answers_the_port() {
        // Reverting the artifact check makes this NotListening ("it may still be
        // starting"), which sends a first run after a backend that cannot bind.
        let dir = scratch("silent-port");
        let model = write_artifact(&dir, "model.gguf");
        let configured =
            derive_backend_readiness(&llama_cpp_config(&dir.display().to_string(), &model));
        assert_eq!(configured.state, BackendReadinessState::MissingFile);

        let silent = with_backend_reachable(configured, false);
        assert_eq!(silent.state, BackendReadinessState::MissingFile);
        assert_eq!(silent.missing[0].key, "llama_cpp.server_path");
        assert_eq!(
            silent.missing[0].path.as_deref(),
            Some(dir.display().to_string().as_str())
        );

        // An already-answering port still wins: boot returns AlreadyListening
        // before it looks at the artifact files.
        let serving = with_backend_reachable(silent, true);
        assert!(serving.is_ready());
        assert!(serving.missing.is_empty());
    }

    #[test]
    fn an_unidentified_listener_never_reads_as_ready_and_names_the_port() {
        // DD-162: boot refuses a stranger on the port instead of returning
        // AlreadyListening, so readiness must not lift it to Ready.
        let dir = scratch("foreign-listener");
        let configured = derive_backend_readiness(&ready_llama_cpp_config(&dir));
        assert!(configured.is_ready());

        let readiness = with_backend_port_conflict(configured, 8080);

        assert_eq!(readiness.state, BackendReadinessState::NotListening);
        assert!(!readiness.is_ready());
        assert_eq!(missing_keys(&readiness), vec!["llama_cpp.port"]);
        assert_eq!(readiness.missing[0].label, "llama.cpp port");
        assert_eq!(
            readiness.missing[0].reason.as_deref(),
            Some(
                "port 8080 is held by a process that does not answer as llama.cpp; refusing to use it"
            )
        );
    }

    #[test]
    fn a_port_conflict_keeps_a_more_specific_missing_config_verdict() {
        // The operator still has blank fields to fix, so that verdict wins; the
        // port conflict is added rather than replacing what is already wrong.
        let readiness =
            with_backend_port_conflict(derive_backend_readiness(&llama_cpp_config("", "")), 8080);

        assert_eq!(readiness.state, BackendReadinessState::MissingConfig);
        assert_eq!(
            missing_keys(&readiness),
            vec![
                "llama_cpp.server_path",
                "llama_cpp.model_path",
                "llama_cpp.port"
            ]
        );
        assert!(readiness.missing[2]
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("port 8080")));
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
    fn backends_that_resolve_their_own_runtime_are_ready_when_their_program_is_present() {
        // Boot starts neither as a hard requirement, and a resolvable program
        // keeps today's behaviour: nothing to fix, Send stays live.
        assert!(derive_backend_readiness_with(&ollama_config(), present).is_ready());
        assert!(derive_backend_readiness_with(&claude_config(), present).is_ready());
    }

    #[test]
    fn a_missing_ollama_executable_is_a_readiness_item_naming_ollama() {
        // DD-115: selecting Ollama without the program installed used to report
        // ready, so the first turn died in the child with nothing to read.
        let readiness =
            derive_backend_readiness_with(&ollama_config(), |_| BackendExecutable::Absent);

        assert_eq!(readiness.state, BackendReadinessState::MissingConfig);
        assert!(!readiness.is_ready());
        assert_eq!(readiness.backend, JarvisBackend::Ollama);
        assert_eq!(missing_keys(&readiness), vec!["ollama.executable"]);
        assert_eq!(readiness.missing[0].label, "ollama executable");
        assert_eq!(
            readiness.missing[0].env_var,
            Some("JARVIS_OLLAMA_BIN"),
            "the item still names where else the program can come from"
        );
        let reason = readiness.missing[0]
            .reason
            .as_deref()
            .expect("a program item carries its own sentence");
        assert!(
            reason.starts_with("ollama was not found"),
            "lower-case-prefixed, like the existing items: {reason}"
        );
    }

    #[test]
    fn a_missing_claude_executable_is_a_readiness_item_naming_claude() {
        let readiness =
            derive_backend_readiness_with(&claude_config(), |_| BackendExecutable::Absent);

        assert_eq!(readiness.state, BackendReadinessState::MissingConfig);
        assert_eq!(readiness.backend, JarvisBackend::ClaudeCli);
        assert_eq!(missing_keys(&readiness), vec!["claude_cli.executable"]);
        assert_eq!(readiness.missing[0].label, "claude executable");
        let reason = readiness.missing[0]
            .reason
            .as_deref()
            .expect("a program item carries its own sentence");
        assert!(
            reason.starts_with("claude was not found"),
            "the item must name the program, not the backend id: {reason}"
        );
    }

    #[test]
    fn a_program_that_exists_but_cannot_run_gets_its_own_sentence() {
        // Present but unstartable is not "not installed": an install hint would
        // send the operator after the wrong fix.
        for config in [ollama_config(), claude_config()] {
            let readiness = derive_backend_readiness_with(&config, |_| {
                BackendExecutable::NotRunnable("C:/tools/backend".to_string())
            });

            assert_eq!(readiness.state, BackendReadinessState::MissingConfig);
            let reason = readiness.missing[0]
                .reason
                .as_deref()
                .expect("a program item carries its own sentence");
            assert!(
                reason.contains("was found at C:/tools/backend but could not be run"),
                "the sentence must name the path that failed to start: {reason}"
            );
            assert!(
                !reason.contains("was not found"),
                "a present-but-unrunnable program is not reported as absent: {reason}"
            );
        }
    }

    #[test]
    fn a_present_program_adds_no_readiness_item() {
        for config in [ollama_config(), claude_config()] {
            let readiness = derive_backend_readiness_with(&config, present);
            assert_eq!(readiness.state, BackendReadinessState::Ready);
            assert!(readiness.missing.is_empty());
        }
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
        let dir = scratch("not-listening");
        let configured = derive_backend_readiness(&ready_llama_cpp_config(&dir));
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
        assert!(
            value["missing"][0].get("reason").is_none(),
            "a blank setting has no program sentence to carry"
        );
        assert!(
            value["missing"][0].get("path").is_none(),
            "a blank setting has no unusable path to carry"
        );

        let ready_dir = scratch("serialize-ready");
        let ready_readiness = derive_backend_readiness(&ready_llama_cpp_config(&ready_dir));
        let ready = serde_json::to_value(&ready_readiness).unwrap();
        assert_eq!(ready["state"], "ready");
        assert!(ready["missing"].as_array().unwrap().is_empty());

        let silent_dir = scratch("serialize-silent");
        let silent = serde_json::to_value(with_backend_reachable(
            derive_backend_readiness(&ready_llama_cpp_config(&silent_dir)),
            false,
        ))
        .unwrap();
        assert_eq!(silent["state"], "not_listening");
        assert_eq!(silent["backend"], "llama_cpp");
        assert!(silent["missing"].as_array().unwrap().is_empty());

        // DD-111: an unusable artifact reaches the shell as its own state
        // carrying the setting and the exact path.
        let file_dir = scratch("serialize-missing-file");
        let file_model = write_artifact(&file_dir, "model.gguf");
        let artifact = serde_json::to_value(derive_backend_readiness(&llama_cpp_config(
            &file_dir.display().to_string(),
            &file_model,
        )))
        .unwrap();
        assert_eq!(artifact["state"], "missing_file");
        assert_eq!(artifact["backend"], "llama_cpp");
        assert_eq!(artifact["missing"][0]["key"], "llama_cpp.server_path");
        assert_eq!(
            artifact["missing"][0]["path"],
            file_dir.display().to_string()
        );
        assert!(artifact["missing"][0].get("reason").is_none());

        // DD-115: a missing program reaches the shell as its own sentence.
        let program = serde_json::to_value(derive_backend_readiness_with(
            &claude_config(),
            |_| BackendExecutable::Absent,
        ))
        .unwrap();
        assert_eq!(program["state"], "missing_config");
        assert_eq!(program["backend"], "claude_cli");
        assert_eq!(program["missing"][0]["key"], "claude_cli.executable");
        assert!(program["missing"][0]["reason"]
            .as_str()
            .unwrap()
            .starts_with("claude was not found"));
    }
}
