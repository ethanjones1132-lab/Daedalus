//! Single owner for the native process handles that live with the Tauri app.
//!
//! Start/restart callers provide the service-specific spawn function, while
//! this module serializes starts, stores the resulting `Child`, and is the only
//! place that terminates a tracked process. A listener on a configured port is
//! not proof of ownership and is never killed here.

use std::process::Child;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagedProcess {
    BunServer,
    ClaudeProxy,
    Ollama,
    LlamaCpp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StartOutcome {
    Started(u32),
    AlreadyRunning(u32),
    AlreadyListening,
}

#[derive(Default)]
struct Children {
    bun_server: Option<Child>,
    claude_proxy: Option<Child>,
    ollama: Option<Child>,
    llama_cpp: Option<Child>,
}

impl Children {
    fn slot(&mut self, process: ManagedProcess) -> &mut Option<Child> {
        match process {
            ManagedProcess::BunServer => &mut self.bun_server,
            ManagedProcess::ClaudeProxy => &mut self.claude_proxy,
            ManagedProcess::Ollama => &mut self.ollama,
            ManagedProcess::LlamaCpp => &mut self.llama_cpp,
        }
    }
}

static BUN_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PROXY_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static OLLAMA_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static LLAMA_CPP_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CHILDREN: OnceLock<Mutex<Children>> = OnceLock::new();

fn process_lock(process: ManagedProcess) -> std::sync::MutexGuard<'static, ()> {
    let lock = match process {
        ManagedProcess::BunServer => &BUN_START_LOCK,
        ManagedProcess::ClaudeProxy => &PROXY_START_LOCK,
        ManagedProcess::Ollama => &OLLAMA_START_LOCK,
        ManagedProcess::LlamaCpp => &LLAMA_CPP_START_LOCK,
    };
    lock.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn children() -> std::sync::MutexGuard<'static, Children> {
    CHILDREN
        .get_or_init(|| Mutex::new(Children::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn stop_slot(slot: &mut Option<Child>) {
    if let Some(mut child) = slot.take() {
        // `kill` is best effort because a process can exit between try_wait and
        // kill. Always wait afterwards so the owned handle is reaped.
        if !matches!(child.try_wait(), Ok(Some(_))) {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

/// Whether the tracked Bun child started by this Tauri process is currently
/// alive. This is the only ownership evidence a mutation gate accepts; a TCP
/// listener on the server port is never treated as ownership.
pub(crate) fn bun_server_is_alive() -> bool {
    let mut children = children();
    match children.slot(ManagedProcess::BunServer) {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

/// Start a managed child, or replace the child this process already owns.
/// The caller must check its service port before spawning; this module does not
/// infer ownership from a TCP listener and never terminates an unknown PID.
pub(crate) fn launch(
    process: ManagedProcess,
    replace: bool,
    spawn: impl FnOnce() -> Result<Child, String>,
) -> Result<StartOutcome, String> {
    let _serial = process_lock(process);
    let should_clear;
    {
        let mut children = children();
        let slot = children.slot(process);

        should_clear = match slot.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) if !replace => return Ok(StartOutcome::AlreadyRunning(child.id())),
                Ok(None) => true,
                Ok(Some(_)) => true,
                Err(error) if !replace => {
                    return Err(format!("could not inspect the tracked child: {error}"));
                }
                Err(_) => true,
            },
            None => false,
        };
        if should_clear {
            stop_slot(slot);
        }
    }
    // Drop the CHILDREN guard before touching transport state: the mutation
    // gate acquires transport state and then probes child liveness, so the
    // global order must be transport-state -> CHILDREN, never the reverse.
    if should_clear && matches!(process, ManagedProcess::BunServer) {
        crate::jarvis::memory::transport::native_memory_transport().note_owned_stop();
    }

    let child = spawn()?;
    let pid = child.id();
    *children().slot(process) = Some(child);
    if matches!(process, ManagedProcess::BunServer) {
        crate::jarvis::memory::transport::native_memory_transport().note_owned_spawn();
    }
    Ok(StartOutcome::Started(pid))
}

/// Stop and reap a child started by this Tauri process.
pub(crate) fn stop(process: ManagedProcess) {
    let _serial = process_lock(process);
    stop_slot(children().slot(process));
    if matches!(process, ManagedProcess::BunServer) {
        crate::jarvis::memory::transport::native_memory_transport().note_owned_stop();
    }
}

/// Stop and reap every child owned by this Tauri process during app shutdown.
pub(crate) fn stop_all() {
    let _bun = process_lock(ManagedProcess::BunServer);
    let _proxy = process_lock(ManagedProcess::ClaudeProxy);
    let _ollama = process_lock(ManagedProcess::Ollama);
    let _llama_cpp = process_lock(ManagedProcess::LlamaCpp);
    let mut children = children();
    stop_slot(&mut children.bun_server);
    stop_slot(&mut children.claude_proxy);
    stop_slot(&mut children.ollama);
    stop_slot(&mut children.llama_cpp);
    drop(children);
    crate::jarvis::memory::transport::native_memory_transport().note_owned_stop();
}
