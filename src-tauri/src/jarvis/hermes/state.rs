//! Tauri-managed wrapper around HermesProcess. Owns the singleton instance per
//! window. Re-emits HermesEvents as typed Tauri events under name "hermes-event".
//!
//! Interpreter discovery is deferred: constructing this state (which happens
//! before the window exists) only stores a resolver. The first Hermes process
//! start runs that resolver, so a slow or hung Python candidate cannot block
//! first paint.

use crate::jarvis::hermes::process::{HermesConfig, HermesProcess, HermesState};
use crate::PythonInvocation;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

/// Deferred interpreter lookup, run on the first Hermes start. The error is
/// surfaced to the caller as-is so it can be actionable.
pub(crate) type InterpreterResolver =
    Arc<dyn Fn() -> Result<PythonInvocation, String> + Send + Sync>;

/// One-shot interpreter lookup plus its successful result. Failures are never
/// stored, so a broken lookup is retried on the next start.
#[derive(Clone)]
struct DeferredInterpreter {
    resolver: InterpreterResolver,
    resolved: Arc<std::sync::Mutex<Option<PythonInvocation>>>,
}

impl DeferredInterpreter {
    fn new(resolver: InterpreterResolver) -> Self {
        Self {
            resolver,
            resolved: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    #[cfg(test)]
    fn is_resolved(&self) -> bool {
        self.resolved
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
    }

    /// Resolve once. A failed lookup returns the resolver's error and is not
    /// cached, so the next start probes again instead of claiming an
    /// interpreter that was never proven to work.
    fn resolve(&self) -> Result<PythonInvocation, String> {
        let mut cached = self
            .resolved
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(invocation) = cached.as_ref() {
            return Ok(invocation.clone());
        }
        let invocation = (self.resolver)()?;
        *cached = Some(invocation.clone());
        Ok(invocation)
    }
}

pub struct HermesAppState {
    pub process: Mutex<Option<Arc<HermesProcess>>>,
    pub config: HermesConfig,
    /// `None` when the caller supplied a fully-resolved config. Callers that
    /// need discovery use `with_lazy_interpreter`.
    interpreter: Option<DeferredInterpreter>,
}

impl HermesAppState {
    pub fn new() -> Self {
        Self::with_config(HermesConfig::default())
    }

    /// State for callers that already chose an interpreter (including custom
    /// `HermesConfig` callers). Construction never probes.
    pub fn with_config(config: HermesConfig) -> Self {
        Self {
            process: Mutex::new(None),
            config,
            interpreter: None,
        }
    }

    /// State whose interpreter is resolved on the first Hermes process start.
    /// Construction only stores the resolver; it must not spawn a probe.
    pub(crate) fn with_lazy_interpreter(
        config: HermesConfig,
        resolver: InterpreterResolver,
    ) -> Self {
        Self {
            process: Mutex::new(None),
            config,
            interpreter: Some(DeferredInterpreter::new(resolver)),
        }
    }

    /// Test hook: the production wiring must leave discovery pending until the
    /// first spawn.
    #[cfg(test)]
    pub(crate) fn has_pending_interpreter(&self) -> bool {
        self.interpreter
            .as_ref()
            .is_some_and(|deferred| !deferred.is_resolved())
    }

    fn config_with_interpreter(&self, invocation: &PythonInvocation) -> HermesConfig {
        let mut config = self.config.clone();
        crate::apply_python_invocation_to_hermes(&mut config, invocation.clone());
        config
    }

    /// Config for a process start. Resolves the interpreter off the async
    /// runtime only when discovery is still pending.
    async fn config_for_spawn(&self) -> Result<HermesConfig, String> {
        let Some(deferred) = self.interpreter.clone() else {
            return Ok(self.config.clone());
        };
        let invocation = tokio::task::spawn_blocking(move || deferred.resolve())
            .await
            .map_err(|e| format!("Hermes interpreter discovery task failed: {e}"))??;
        Ok(self.config_with_interpreter(&invocation))
    }

    /// Get the running process or return None.
    pub async fn get(&self) -> Option<Arc<HermesProcess>> {
        self.process.lock().await.clone()
    }

    /// Spawn a new HermesProcess and start it. Stores the Arc on success. Bridges
    /// events to Tauri's emit system.
    pub async fn spawn_and_attach(&self, app: AppHandle) -> Result<(), String> {
        let mut guard = self.process.lock().await;
        if let Some(proc) = guard.as_ref() {
            match proc.state().await {
                HermesState::Crashed { .. } => {
                    *guard = None;
                }
                _ => return Ok(()), // already running — idempotent
            }
        }
        let config = self.config_for_spawn().await?;
        let proc = HermesProcess::new(config);
        // Subscribe before start so we don't miss early events.
        let mut sub = proc.subscribe_events();
        let app_clone = app.clone();
        let proc = std::sync::Arc::new(proc);
        tokio::spawn(async move {
            while let Ok(ev) = sub.recv().await {
                let payload = serde_json::json!({
                    "type": ev.event_type,
                    "session_id": ev.session_id,
                    "params": ev.payload,
                });
                let _ = app_clone.emit("hermes-event", payload);
            }
        });
        proc.start().await.map_err(|e| e.to_string())?;
        *guard = Some(proc);
        Ok(())
    }

    pub async fn detach_and_shutdown(&self) -> Result<(), String> {
        let proc = self.process.lock().await.take();
        if let Some(p) = proc {
            p.shutdown().await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

impl Default for HermesAppState {
    fn default() -> Self {
        Self::new()
    }
}

/// Helper used by commands: get the running process or surface a clean error.
pub async fn require_process(app: &AppHandle) -> Result<Arc<HermesProcess>, String> {
    let state = app.state::<HermesAppState>();
    state
        .get()
        .await
        .ok_or_else(|| "hermes process is not running".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn invocation() -> PythonInvocation {
        PythonInvocation {
            program: PathBuf::from("py"),
            prefix_args: vec!["-3".to_string()],
        }
    }

    #[test]
    fn state_construction_defers_discovery_until_it_is_needed() {
        let calls = Arc::new(AtomicUsize::new(0));
        let resolver_calls = Arc::clone(&calls);
        let resolver: InterpreterResolver = Arc::new(move || {
            resolver_calls.fetch_add(1, Ordering::SeqCst);
            Ok(invocation())
        });

        let state = HermesAppState::with_lazy_interpreter(HermesConfig::default(), resolver);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "constructing HermesAppState must not discover an interpreter"
        );
        assert!(state.has_pending_interpreter());

        let deferred = state.interpreter.as_ref().expect("deferred interpreter");
        let resolved = deferred.resolve().expect("discovery succeeds");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(resolved.program, PathBuf::from("py"));
        assert_eq!(resolved.prefix_args, vec!["-3".to_string()]);
        assert!(!state.has_pending_interpreter());
    }

    #[test]
    fn successful_discovery_is_reused_by_later_spawns() {
        let calls = Arc::new(AtomicUsize::new(0));
        let resolver_calls = Arc::clone(&calls);
        let resolver: InterpreterResolver = Arc::new(move || {
            resolver_calls.fetch_add(1, Ordering::SeqCst);
            Ok(invocation())
        });
        let deferred = DeferredInterpreter::new(resolver);

        assert_eq!(
            deferred.resolve().expect("first lookup").program,
            PathBuf::from("py")
        );
        assert_eq!(
            deferred.resolve().expect("second lookup").program,
            PathBuf::from("py")
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "a proven interpreter must not be re-probed on every start"
        );
    }

    #[test]
    fn failed_discovery_is_not_cached_permanently() {
        let calls = Arc::new(AtomicUsize::new(0));
        let resolver_calls = Arc::clone(&calls);
        let resolver: InterpreterResolver = Arc::new(move || {
            let attempt = resolver_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if attempt == 1 {
                Err("no interpreter answered --version".to_string())
            } else {
                Ok(invocation())
            }
        });
        let deferred = DeferredInterpreter::new(resolver);

        assert!(deferred.resolve().is_err());
        assert!(!deferred.is_resolved());
        let retried = deferred.resolve().expect("second lookup retries");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(retried.program, PathBuf::from("py"));
    }

    #[test]
    fn first_spawn_resolves_the_interpreter_and_preserves_launcher_args() {
        let calls = Arc::new(AtomicUsize::new(0));
        let resolver_calls = Arc::clone(&calls);
        let resolver: InterpreterResolver = Arc::new(move || {
            resolver_calls.fetch_add(1, Ordering::SeqCst);
            Ok(invocation())
        });
        let state = HermesAppState::with_lazy_interpreter(HermesConfig::default(), resolver);
        assert!(state.has_pending_interpreter());

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime should build");
        let config = runtime
            .block_on(state.config_for_spawn())
            .expect("first spawn resolves the interpreter");

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(config.python, PathBuf::from("py"));
        assert_eq!(config.python_prefix_args, vec!["-3".to_string()]);
        assert!(!state.has_pending_interpreter());
    }

    #[test]
    fn custom_config_callers_keep_their_explicit_interpreter() {
        let config = HermesConfig {
            python: PathBuf::from("custom-python"),
            ..HermesConfig::default()
        };

        let state = HermesAppState::with_config(config);
        assert!(state.interpreter.is_none());
        assert_eq!(state.config.python, PathBuf::from("custom-python"));
    }

    #[test]
    fn resolved_config_preserves_python_launcher_prefix_args() {
        let resolver: InterpreterResolver = Arc::new(|| Ok(invocation()));
        let state = HermesAppState::with_lazy_interpreter(HermesConfig::default(), resolver);
        let deferred = state.interpreter.as_ref().expect("deferred interpreter");
        let resolved = deferred.resolve().expect("discovery succeeds");

        let config = state.config_with_interpreter(&resolved);
        assert_eq!(config.python, PathBuf::from("py"));
        assert_eq!(config.python_prefix_args, vec!["-3".to_string()]);
    }
}
