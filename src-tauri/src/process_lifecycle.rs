//! Single owner for the native process handles that live with the Tauri app.
//!
//! Start/restart callers provide the service-specific spawn function, while
//! this module serializes starts, stores the resulting `Child`, and is the only
//! place that terminates a tracked process. A listener on a configured port is
//! not proof of ownership and is never killed here — with one deliberate
//! exception: a slot launched through `wsl.exe` also records its guest port, and
//! stopping that slot terminates the guest process holding it, because the
//! wrapper handle cannot (DD-063).
//!
//! Hermes is the one async child: it is spawned through tokio so its stdio
//! pipes stay non-blocking, so it cannot use `spawn_managed`'s
//! `std::process::Child`. It still joins the same ownership registry through
//! `spawn_managed_tokio`, gets assigned to the same kill-on-close job object,
//! and is stopped by the same `stop_all` routine the exit hook calls.

use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Upper bound for one guest-side stop. A cold or wedged distro must not hold
/// the stop path open; the timeout child is killed by the helper.
const GUEST_STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// Upper bound for one tracked-child reap (DD-075). App quit must complete even
/// when a managed child refuses to die, so a kill request is followed by a
/// bounded wait: still alive at the deadline means `Reap::Unconfirmed`, never an
/// open-ended wait on the handle. The async Hermes twin polls the same bound.
const CHILD_REAP_TIMEOUT: Duration = Duration::from_secs(5);

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

/// Ownership of the tracked Bun child, derived from the actual `Child` handle.
/// `Unknown` means the handle could not report its status; callers must fail
/// closed rather than assume the old registry is gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BunOwnership {
    None,
    Live,
    Exited,
    Unknown,
}

/// Shared handle to the async Hermes child. `HermesProcess` and this registry
/// observe the same `Option`, so exactly one `tokio::process::Child` is owned
/// and either side can confirm its exit.
pub(crate) type AsyncChildSlot = Arc<Mutex<Option<tokio::process::Child>>>;

#[derive(Default)]
struct Children {
    bun_server: Option<Slot>,
    claude_proxy: Option<Slot>,
    ollama: Option<Slot>,
    llama_cpp: Option<Slot>,
    hermes: Option<AsyncChildSlot>,
}

/// How a slot was launched. A WSL-hosted backend tracks the `wsl.exe` client,
/// which is only a wrapper: killing it leaves the guest server running with its
/// listener still bound, so the stop path must also terminate the guest side
/// (DD-063).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SlotLaunch {
    /// The tracked `Child` is the server itself.
    Direct,
    /// The tracked `Child` is `wsl.exe`; `port` is the guest port it serves.
    Wsl { port: u16 },
}

struct Slot {
    child: Child,
    launch: SlotLaunch,
}

impl Children {
    fn slot(&mut self, process: ManagedProcess) -> &mut Option<Slot> {
        match process {
            ManagedProcess::BunServer => &mut self.bun_server,
            ManagedProcess::ClaudeProxy => &mut self.claude_proxy,
            ManagedProcess::Ollama => &mut self.ollama,
            ManagedProcess::LlamaCpp => &mut self.llama_cpp,
        }
    }
}

/// One command in a slot's kill set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StopCommand {
    pub program: &'static str,
    pub args: Vec<String>,
}

/// Everything that has to die before a slot counts as stopped. The tracked child
/// is always killed and reaped; a WSL-launched slot additionally needs the guest
/// listener stopped, because `wsl.exe` does not own it on this side.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SlotStopPlan {
    pub kill_tracked_child: bool,
    pub guest: Option<StopCommand>,
}

/// Guest-side stop for a server launched through `wsl.exe`. `ss` (iproute2) is
/// available in any distro this app drives through WSL — the host-IP resolver
/// already runs `ip route` — and reports the pid that owns the listening socket
/// even though the Windows-side wrapper cannot see it. The listener is what
/// blocks the next launch, so the pid that holds it is the kill target; a guest
/// process that no longer holds the port cannot block anything.
fn guest_stop_script(port: u16) -> String {
    format!(
        "for p in $(ss -ltnp 2>/dev/null | grep -F ':{port} ' | grep -o 'pid=[0-9]*' \
         | cut -d= -f2 | sort -u); do kill $p 2>/dev/null; sleep 0.2; kill -9 $p 2>/dev/null; done; true"
    )
}

/// The kill set for a slot. Pure so the WSL branch can be asserted without
/// spawning a real `wsl.exe` or touching a guest distro.
fn stop_plan(launch: SlotLaunch) -> SlotStopPlan {
    let guest = match launch {
        SlotLaunch::Direct => None,
        SlotLaunch::Wsl { port } => Some(StopCommand {
            program: "wsl.exe",
            args: vec![
                "--".to_string(),
                "bash".to_string(),
                "-lc".to_string(),
                guest_stop_script(port),
            ],
        }),
    };
    SlotStopPlan {
        kill_tracked_child: true,
        guest,
    }
}

/// Run the guest side of a stop plan. Returns `false` when the stop could not be
/// run to completion, so callers keep reporting termination as unconfirmed.
fn run_guest_stop(command: &StopCommand) -> bool {
    let mut process = Command::new(command.program);
    process.args(&command.args);
    crate::wsl::command_output_timeout(process, GUEST_STOP_TIMEOUT)
        .map(|output| output.status.success())
        .unwrap_or(false)
}

static BUN_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PROXY_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static OLLAMA_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static LLAMA_CPP_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CHILDREN: OnceLock<Mutex<Children>> = OnceLock::new();

#[cfg(windows)]
struct JobObject(usize);

#[cfg(windows)]
impl JobObject {
    fn handle(&self) -> windows_sys::Win32::Foundation::HANDLE {
        self.0 as windows_sys::Win32::Foundation::HANDLE
    }
}

#[cfg(windows)]
impl Drop for JobObject {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle());
        }
    }
}

#[cfg(windows)]
static PROCESS_JOB: OnceLock<Result<JobObject, u32>> = OnceLock::new();

/// Monotonic owned-Bun generation. Bumped on every successful spawn and every
/// tracked stop so a mutation coordinator can detect replacement across an
/// HTTP request without holding any lock across the network.
static BUN_GENERATION: AtomicU64 = AtomicU64::new(0);
/// Set when the owned Bun child could not be confirmed dead. While set,
/// `bun_ownership` reports `Unknown` so no mutation may bypass invalidation.
static BUN_TERMINATION_UNCONFIRMED: AtomicBool = AtomicBool::new(false);
/// Reaps that could not confirm the child is gone (DD-082). A silent `false`
/// used to read exactly like a clean stop; this count is what the give-up/status
/// path can report as "a child of this app may still be running".
static REAP_FAILURES: AtomicU32 = AtomicU32::new(0);

/// How many reap attempts have ended unconfirmed in this process's lifetime.
/// Read by `stop_all`'s summary and, since DD-084, by
/// `SupervisorStatus::reap_failures` so a survivor is reported in the app's own
/// status instead of being mistaken for a clean quit.
pub(crate) fn reap_failure_count() -> u32 {
    REAP_FAILURES.load(Ordering::SeqCst)
}

#[cfg(windows)]
fn create_kill_on_close_job() -> Result<JobObject, u32> {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{GetLastError, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err(unsafe { GetLastError() });
    }

    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        let error = unsafe { GetLastError() };
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
        return Err(error);
    }

    Ok(JobObject(handle as HANDLE as usize))
}

#[cfg(windows)]
fn process_job() -> std::io::Result<&'static JobObject> {
    let job = PROCESS_JOB.get_or_init(create_kill_on_close_job);
    match job {
        Ok(job) => Ok(job),
        Err(error) => Err(std::io::Error::from_raw_os_error(*error as i32)),
    }
}

/// The error a managed spawn returns once the app has begun quitting (DD-082).
/// The std and async managed spawns share it so both refusals name the same
/// reason.
fn quit_spawn_error() -> std::io::Error {
    std::io::Error::other("the app is quitting; refusing to start a managed child")
}

/// DD-082: one gate for every managed spawn. Pure so a test can drive the
/// refused branch without setting the process-wide flag, which would leak into
/// every other test in this binary. The live value is DD-077's flag, read at the
/// last instant before the OS spawn.
fn refuse_spawn_when_quitting(quitting: bool) -> std::io::Result<()> {
    if quitting {
        Err(quit_spawn_error())
    } else {
        Ok(())
    }
}

/// Spawn a managed child and assign it to its Windows Job Object immediately.
/// The non-Windows path preserves the existing child-spawn behavior.
pub(crate) fn spawn_managed(command: &mut std::process::Command) -> std::io::Result<Child> {
    spawn_managed_with_gate(command, crate::supervisor::is_quitting())
}

/// [`spawn_managed`] with the quit gate injected. The gate is the last check
/// before the OS spawn, so a start path that passed its own gate before a slow
/// probe still cannot create a child after the app begins quitting. A test can
/// pass `true` without poisoning the process-wide flag for every other test.
fn spawn_managed_with_gate(
    command: &mut std::process::Command,
    quitting: bool,
) -> std::io::Result<Child> {
    refuse_spawn_when_quitting(quitting)?;

    #[cfg(windows)]
    {
        return spawn_assigned(command, process_job()?);
    }

    #[cfg(not(windows))]
    {
        command.spawn()
    }
}

#[cfg(windows)]
fn spawn_assigned(command: &mut std::process::Command, job: &JobObject) -> std::io::Result<Child> {
    use std::os::windows::io::AsRawHandle;

    let mut child = command.spawn()?;
    if let Err(error) = assign_handle_to_job(child.as_raw_handle(), job) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    Ok(child)
}

/// Assign an already-spawned process handle to the kill-on-close job object.
/// Both the std `Child` path and the async Hermes path funnel through here, so
/// one job object carries every child this app owns.
#[cfg(windows)]
fn assign_handle_to_job(
    handle: std::os::windows::io::RawHandle,
    job: &JobObject,
) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::{GetLastError, HANDLE};
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

    let assigned = unsafe { AssignProcessToJobObject(job.handle(), handle as HANDLE) };
    if assigned == 0 {
        let error = unsafe { GetLastError() };
        return Err(std::io::Error::from_raw_os_error(error as i32));
    }

    Ok(())
}

/// Spawn a managed async child (Hermes), assign it to the same kill-on-close
/// job object as the std children, and register its handle with the ownership
/// registry so `stop_all` — the routine the app's exit hook runs — terminates
/// it. The `slot` is shared with `HermesProcess`, which keeps the pipes and may
/// confirm the exit; the registry holds the other half of that one handle.
pub(crate) async fn spawn_managed_tokio(
    slot: &AsyncChildSlot,
    command: &mut tokio::process::Command,
) -> std::io::Result<()> {
    // A previous child that could not be confirmed dead must not be silently
    // replaced: fail closed instead of leaking an untracked process.
    {
        let mut tracked = lock_async_child(slot);
        if !stop_async_child(&mut tracked) {
            return Err(std::io::Error::other(
                "the previously tracked async child could not be confirmed dead",
            ));
        }
    }

    #[cfg(windows)]
    let mut child = command.spawn()?;
    #[cfg(not(windows))]
    let child = command.spawn()?;

    #[cfg(windows)]
    {
        let assigned = match process_job() {
            Ok(job) => match child.raw_handle() {
                Some(handle) => assign_handle_to_job(handle, job),
                None => Err(std::io::Error::other(
                    "the spawned async child did not expose a process handle",
                )),
            },
            Err(error) => Err(error),
        };
        if let Err(error) = assigned {
            let _ = child.kill().await;
            return Err(error);
        }
    }

    {
        let mut tracked = lock_async_child(slot);
        *tracked = Some(child);
    }
    track_async_child(Arc::clone(slot));
    Ok(())
}

pub(crate) fn bun_generation() -> u64 {
    BUN_GENERATION.load(Ordering::SeqCst)
}

fn bump_bun_generation() {
    BUN_GENERATION.fetch_add(1, Ordering::SeqCst);
}

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

/// What reaping a slot left behind. A WSL-launched server is two processes from
/// this side — the `wsl.exe` wrapper we hold a handle to, and the guest process
/// that owns the listener — so the guest stop is returned instead of being run
/// under the CHILDREN lock.
#[derive(Debug, PartialEq, Eq)]
enum Reap {
    /// Nothing left to do.
    Clean,
    /// The wrapper is gone; this guest stop is still owed.
    Guest(StopCommand),
    /// The tracked wrapper could not be confirmed dead.
    Unconfirmed,
}

/// Wait for a child to report an exit, polling `try_wait` until `deadline`.
/// Returns `true` only when the exit was observed; a child still alive at the
/// deadline, or a handle that cannot be inspected, ends the wait unconfirmed.
/// The std reap and the async Hermes stop share this so both are bounded alike.
fn wait_for_exit(
    deadline: Instant,
    mut poll: impl FnMut() -> std::io::Result<Option<std::process::ExitStatus>>,
) -> bool {
    loop {
        match poll() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return false,
        }
    }
}

/// Stop and reap a slot's tracked child. The guest side a WSL wrapper started is
/// *not* run here: it is an external command and must not hold the CHILDREN lock.
fn reap_slot(slot: &mut Option<Slot>) -> Reap {
    reap_slot_with(slot, CHILD_REAP_TIMEOUT, |child| {
        let _ = child.kill();
    })
}

/// [`reap_slot`] with the reap bound and the kill step in hand. The bound is
/// what keeps quit finite: a child whose kill does not take is still alive at
/// the deadline, and `Reap::Unconfirmed` says exactly that instead of waiting on
/// the handle forever. `kill` is a parameter so a test can drive the "the kill
/// does not take" case against a real child without needing an unkillable one.
fn reap_slot_with(
    slot: &mut Option<Slot>,
    timeout: Duration,
    kill: impl FnOnce(&mut Child),
) -> Reap {
    let Some(tracked) = slot.as_mut() else {
        return Reap::Clean;
    };
    let plan = stop_plan(tracked.launch);
    if plan.kill_tracked_child && !matches!(tracked.child.try_wait(), Ok(Some(_))) {
        // Start the clock before the kill request so the whole reap — not just
        // the polling after it — is bounded.
        let deadline = Instant::now() + timeout;
        kill(&mut tracked.child);
        if !wait_for_exit(deadline, || tracked.child.try_wait()) {
            // The slot is deliberately kept: an unconfirmed kill stays owned
            // instead of being forgotten as if the child had died.
            return Reap::Unconfirmed;
        }
    }
    slot.take();
    match plan.guest {
        Some(command) => Reap::Guest(command),
        None => Reap::Clean,
    }
}

/// Run one guest side of a stop plan. A guest stop that could not run leaves the
/// termination unconfirmed: the listener may still hold the port.
fn stop_guest(command: StopCommand) -> bool {
    run_guest_stop(&command)
}

/// The line logged for a service whose child did not confirm as gone. Kept pure
/// so a test can assert the PID and the service are in the text the log
/// receives, without installing a logger or starting a process.
fn reap_failure_message(service: &str, pid: Option<u32>, reason: &str) -> String {
    match pid {
        Some(pid) => format!("{service} child PID {pid} survived teardown: {reason}"),
        None => format!("{service} child survived teardown: {reason}"),
    }
}

/// Record a reap that could not confirm the child is gone: log it with the PID
/// and count it. Both halves are the DD-082 contract — a failed reap must never
/// be silent, and the give-up/status path must be able to say a child survived.
fn record_service_reap_failure(service: &str, pid: Option<u32>, reason: &str) {
    REAP_FAILURES.fetch_add(1, Ordering::SeqCst);
    log::warn!(
        target: "jarvis::lifecycle",
        "{}",
        reap_failure_message(service, pid, reason)
    );
}

fn record_reap_failure(process: ManagedProcess, pid: Option<u32>, reason: &str) {
    record_service_reap_failure(&format!("{process:?}"), pid, reason);
}

/// Whether a reap confirms that the whole slot — wrapper and any guest server it
/// started — is gone. A failure is recorded with the tracked child's PID before
/// this returns `false`, so no caller can reduce it to a discarded boolean.
fn confirm_reap(process: ManagedProcess, pid: Option<u32>, reap: Reap) -> bool {
    match reap {
        Reap::Clean => true,
        Reap::Guest(command) => {
            if stop_guest(command) {
                true
            } else {
                record_reap_failure(
                    process,
                    pid,
                    "the guest stop did not complete; its listener may still hold the port",
                );
                false
            }
        }
        Reap::Unconfirmed => {
            record_reap_failure(
                process,
                pid,
                "the tracked child did not exit before the reap deadline",
            );
            false
        }
    }
}

fn lock_async_child(
    slot: &AsyncChildSlot,
) -> std::sync::MutexGuard<'_, Option<tokio::process::Child>> {
    slot.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Stop and reap an async child handle (Hermes). Returns `true` only when exit
/// is confirmed; an unconfirmed stop leaves the handle in place so ownership
/// stays tracked. Tokio's `kill` is async-only, so this sends the kill request
/// and polls for the exit through the same bounded wait `reap_slot` uses for a
/// std child.
fn stop_async_child(slot: &mut Option<tokio::process::Child>) -> bool {
    let Some(child) = slot.as_mut() else {
        return true;
    };
    if matches!(child.try_wait(), Ok(Some(_))) {
        slot.take();
        return true;
    }
    // The kill request itself may race an exit that already happened; only a
    // confirmed exit clears the handle.
    let _ = child.start_kill();
    // Bounded like the std reap, so a Hermes child that will not die cannot hold
    // app quit open either.
    let deadline = Instant::now() + CHILD_REAP_TIMEOUT;
    let exited = wait_for_exit(deadline, || child.try_wait());
    if exited {
        slot.take();
        return true;
    }
    false
}

/// Register the async child slot so the exit hook stops it. Any previously
/// tracked slot is replaced, matching the single-Hermes-per-app lifecycle.
fn track_async_child(slot: AsyncChildSlot) {
    children().hermes = Some(slot);
}

/// Stop the async child owned by `slot` on behalf of `HermesProcess`. When the
/// slot is still the registered one this goes through the ownership entry, so
/// the exit hook and an explicit Hermes shutdown terminate the same handle.
/// Returns `true` only when exit is confirmed; ownership stays registered when
/// it is not.
pub(crate) fn stop_hermes(slot: &AsyncChildSlot) -> bool {
    let registered = {
        children()
            .hermes
            .as_ref()
            .is_some_and(|tracked| Arc::ptr_eq(tracked, slot))
    };
    if registered {
        return stop_registered_hermes();
    }
    let mut child = lock_async_child(slot);
    stop_async_child(&mut child)
}

/// Take the registered async child out of the ownership set and stop it.
/// An unconfirmed exit puts the slot back so ownership stays tracked. The
/// tracked PID is returned alongside the result so a survivor can be named.
fn stop_registered_hermes_with_pid() -> (bool, Option<u32>) {
    let tracked = { children().hermes.take() };
    let Some(slot) = tracked else {
        return (true, None);
    };
    let (confirmed, pid) = {
        let mut child = lock_async_child(&slot);
        let pid = child.as_ref().and_then(|child| child.id());
        (stop_async_child(&mut child), pid)
    };
    if !confirmed {
        // Only put the slot back if no newer child registered meanwhile.
        let mut children = children();
        if children.hermes.is_none() {
            children.hermes = Some(slot);
        }
    }
    (confirmed, pid)
}

/// [`stop_registered_hermes_with_pid`] for callers that only need the outcome.
fn stop_registered_hermes() -> bool {
    stop_registered_hermes_with_pid().0
}

/// Whether the async Hermes child is currently in the ownership registry.
#[cfg(test)]
pub(crate) fn hermes_tracked() -> bool {
    children().hermes.is_some()
}

/// Whether the tracked Bun child is alive, exited, or could not be inspected.
/// This is the only ownership evidence a mutation gate accepts; a TCP listener
/// on the server port is never treated as ownership.
pub(crate) fn bun_ownership() -> BunOwnership {
    let mut children = children();
    if children.bun_server.is_none() {
        return BunOwnership::None;
    }
    if BUN_TERMINATION_UNCONFIRMED.load(Ordering::SeqCst) {
        // A stop could not confirm exit. Re-check the handle: a confirmed exit
        // clears the uncertainty; otherwise stay Unknown and fail closed.
        match children.bun_server.as_mut().map(|slot| slot.child.try_wait()) {
            Some(Ok(Some(_))) => {
                BUN_TERMINATION_UNCONFIRMED.store(false, Ordering::SeqCst);
                return BunOwnership::Exited;
            }
            _ => return BunOwnership::Unknown,
        }
    }
    match children.bun_server.as_mut() {
        None => BunOwnership::None,
        Some(slot) => match slot.child.try_wait() {
            Ok(None) => BunOwnership::Live,
            Ok(Some(_)) => BunOwnership::Exited,
            Err(_) => BunOwnership::Unknown,
        },
    }
}

/// How the tracked Bun child stands for a caller that is waiting on it
/// (DD-083): `Ok(None)` while it has not exited, `Ok(Some(status))` once it has,
/// and `Err` when the handle cannot be inspected. A caller waiting for the child
/// to answer `/health` needs the exit itself — the exit code is the reason the
/// start died — which [`bun_ownership`] deliberately does not preserve.
pub(crate) fn bun_exit_status() -> Result<Option<std::process::ExitStatus>, String> {
    let mut children = children();
    match children.bun_server.as_mut() {
        None => Ok(None),
        Some(slot) => inspect_exit_status(&mut slot.child),
    }
}

/// One `try_wait` reading of a tracked child, keeping "has not exited" apart
/// from "could not be inspected". Separate from the registry so the reading can
/// be driven from a test without a global slot.
fn inspect_exit_status(child: &mut Child) -> Result<Option<std::process::ExitStatus>, String> {
    child.try_wait().map_err(|error| error.to_string())
}

/// Whether this process currently owns a live child in the slot. The supervisor
/// uses this to tell "still coming up" (a child it spawned that has not opened
/// its port yet, e.g. Ollama loading a model) from "down", so a tick does not
/// replace a warm-in-progress backend (DD-063).
pub(crate) fn is_live(process: ManagedProcess) -> bool {
    let mut children = children();
    children
        .slot(process)
        .as_mut()
        .map(|slot| matches!(slot.child.try_wait(), Ok(None)))
        .unwrap_or(false)
}

/// Start a managed child, or replace the child this process already owns.
/// The caller must check its service port before spawning; this module does not
/// infer ownership from a TCP listener and never terminates an unknown PID.
pub(crate) fn launch(
    process: ManagedProcess,
    replace: bool,
    spawn: impl FnOnce() -> Result<Child, String>,
) -> Result<StartOutcome, String> {
    launch_with(process, replace, SlotLaunch::Direct, spawn)
}

/// [`launch`] with the slot's launch kind. A slot launched through `wsl.exe`
/// must record that so its stop reaches the guest server, not just the wrapper.
pub(crate) fn launch_with(
    process: ManagedProcess,
    replace: bool,
    launch: SlotLaunch,
    spawn: impl FnOnce() -> Result<Child, String>,
) -> Result<StartOutcome, String> {
    let _serial = process_lock(process);
    let should_clear;
    let reap;
    let tracked_pid;
    {
        let mut children = children();
        let slot = children.slot(process);

        should_clear = match slot.as_mut() {
            Some(tracked) => match tracked.child.try_wait() {
                Ok(None) if !replace => return Ok(StartOutcome::AlreadyRunning(tracked.child.id())),
                Ok(None) => true,
                Ok(Some(_)) => true,
                Err(error) if !replace => {
                    return Err(format!("could not inspect the tracked child: {error}"));
                }
                Err(_) => true,
            },
            None => false,
        };
        // Capture the PID before the reap: an unconfirmed or failed guest stop
        // must still name the process that may have survived (DD-082).
        tracked_pid = slot.as_ref().map(|tracked| tracked.child.id());
        reap = if should_clear {
            reap_slot(slot)
        } else {
            Reap::Clean
        };
    }
    // The guest stop is an external command; run it after the CHILDREN guard is
    // dropped, before the replacement spawn needs the port it should have freed.
    let confirmed = confirm_reap(process, tracked_pid, reap);
    // Generation bookkeeping is atomic; the CHILDREN guard has already been
    // dropped, so no lock held across HTTP is acquired while CHILDREN is held.
    // An unconfirmed termination must NOT bump the generation: ownership stays
    // Unknown and invalidation cannot be bypassed.
    if should_clear && matches!(process, ManagedProcess::BunServer) {
        if confirmed {
            bump_bun_generation();
        } else {
            BUN_TERMINATION_UNCONFIRMED.store(true, Ordering::SeqCst);
        }
    }

    let child = spawn()?;
    let pid = child.id();
    *children().slot(process) = Some(Slot { child, launch });
    if matches!(process, ManagedProcess::BunServer) {
        BUN_TERMINATION_UNCONFIRMED.store(false, Ordering::SeqCst);
        bump_bun_generation();
    }
    Ok(StartOutcome::Started(pid))
}

/// Stop and reap a child started by this Tauri process.
pub(crate) fn stop(process: ManagedProcess) {
    let _serial = process_lock(process);
    let (reap, tracked_pid) = {
        let mut children = children();
        let slot = children.slot(process);
        let pid = slot.as_ref().map(|tracked| tracked.child.id());
        (reap_slot(slot), pid)
    };
    let confirmed = confirm_reap(process, tracked_pid, reap);
    if matches!(process, ManagedProcess::BunServer) {
        if confirmed {
            BUN_TERMINATION_UNCONFIRMED.store(false, Ordering::SeqCst);
            bump_bun_generation();
        } else {
            BUN_TERMINATION_UNCONFIRMED.store(true, Ordering::SeqCst);
        }
    }
}

/// Stop and reap every child owned by this Tauri process during app shutdown.
pub(crate) fn stop_all() {
    let _bun = process_lock(ManagedProcess::BunServer);
    let _proxy = process_lock(ManagedProcess::ClaudeProxy);
    let _ollama = process_lock(ManagedProcess::Ollama);
    let _llama_cpp = process_lock(ManagedProcess::LlamaCpp);
    // The async Hermes child is tracked in the same ownership set, so the exit
    // hook stops it here too instead of leaving it running after the app quits.
    let failures_before = reap_failure_count();
    let (hermes_confirmed, hermes_pid) = stop_registered_hermes_with_pid();
    if !hermes_confirmed {
        record_service_reap_failure(
            "Hermes",
            hermes_pid,
            "the async child did not exit before the reap deadline",
        );
    }
    let (bun_reap, bun_pid, other_reaps) = {
        let mut children = children();
        let bun_pid = children
            .bun_server
            .as_ref()
            .map(|tracked| tracked.child.id());
        let bun = reap_slot(&mut children.bun_server);
        let proxy_pid = children
            .claude_proxy
            .as_ref()
            .map(|tracked| tracked.child.id());
        let proxy = reap_slot(&mut children.claude_proxy);
        let ollama_pid = children.ollama.as_ref().map(|tracked| tracked.child.id());
        let ollama = reap_slot(&mut children.ollama);
        let llama_cpp_pid = children
            .llama_cpp
            .as_ref()
            .map(|tracked| tracked.child.id());
        let llama_cpp = reap_slot(&mut children.llama_cpp);
        (
            bun,
            bun_pid,
            [
                (ManagedProcess::ClaudeProxy, proxy_pid, proxy),
                (ManagedProcess::Ollama, ollama_pid, ollama),
                (ManagedProcess::LlamaCpp, llama_cpp_pid, llama_cpp),
            ],
        )
    };
    let bun_confirmed = confirm_reap(ManagedProcess::BunServer, bun_pid, bun_reap);
    for (process, pid, reap) in other_reaps {
        // Recorded and logged with its PID inside `confirm_reap`; these services
        // have no generation bookkeeping, but a survivor must still be counted.
        let _confirmed = confirm_reap(process, pid, reap);
    }
    if bun_confirmed {
        BUN_TERMINATION_UNCONFIRMED.store(false, Ordering::SeqCst);
        bump_bun_generation();
    } else {
        BUN_TERMINATION_UNCONFIRMED.store(true, Ordering::SeqCst);
    }
    let failures = reap_failure_count() - failures_before;
    if failures > 0 {
        log::warn!(
            target: "jarvis::lifecycle",
            "{failures} child reap(s) were unconfirmed during teardown; a child of this app may still be running"
        );
    }
}

/// DD-063: a slot launched through `wsl.exe` must stop the guest server as well
/// as the wrapper it tracks. The plan is asserted directly — no `wsl.exe`, distro
/// or real child process is involved.
#[cfg(test)]
mod stop_plan_tests {
    use super::{stop_plan, SlotLaunch};

    fn args_of(command: &super::StopCommand) -> Vec<&str> {
        command.args.iter().map(String::as_str).collect()
    }

    #[test]
    fn a_wsl_launched_slot_stops_its_guest_listener_not_just_the_wrapper() {
        let wsl = stop_plan(SlotLaunch::Wsl { port: 19877 });

        assert!(
            wsl.kill_tracked_child,
            "the tracked wsl.exe wrapper must still be killed and reaped"
        );
        let guest = wsl.guest.expect(
            "a WSL-launched slot must also stop the guest server it started; \
             reaping only wsl.exe leaves the listener bound and blocks the next launch",
        );
        assert_eq!(
            guest.program, "wsl.exe",
            "the guest stop has to run inside WSL, not on the Windows host"
        );
        let args = args_of(&guest);
        assert_eq!(
            args.iter().take(3).copied().collect::<Vec<_>>(),
            vec!["--", "bash", "-lc"],
            "the guest stop must be a WSL bash invocation: {args:?}"
        );
        let script = args[3];
        assert!(
            script.contains(":19877"),
            "the guest stop must target the slot's listener port: {script}"
        );
        assert!(
            script.contains("pid=[0-9]*") && script.contains("kill"),
            "the guest stop must kill the guest pid that owns the port: {script}"
        );

        // The other half of the regression: a directly launched slot is one
        // process, so no guest step may be invented for it.
        let direct = stop_plan(SlotLaunch::Direct);
        assert!(direct.kill_tracked_child);
        assert!(
            direct.guest.is_none(),
            "a directly launched slot must not run a guest stop"
        );
    }
}

/// DD-082: a reap that cannot confirm the child is gone must be observed, not
/// reduced to a discarded `false`. These drive the recording seam directly and
/// start no process, so nothing outside this app can be affected.
#[cfg(test)]
mod reap_failure_tests {
    use super::{
        confirm_reap, reap_failure_count, reap_failure_message, refuse_spawn_when_quitting,
        spawn_managed_with_gate, ManagedProcess, Reap,
    };

    /// The reap ledger is process-wide, so every test that moves it holds this
    /// lock: a status read and the count it must mirror are never separated by a
    /// sibling test's increment.
    static LEDGER_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_ledger() -> std::sync::MutexGuard<'static, ()> {
        LEDGER_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn an_unconfirmed_reap_is_counted_and_names_the_pid() {
        let _ledger = lock_ledger();
        let before = reap_failure_count();
        let pid = 4242;
        let confirmed = confirm_reap(ManagedProcess::BunServer, Some(pid), Reap::Unconfirmed);

        assert!(
            !confirmed,
            "an unconfirmed reap must not report success"
        );
        let after = reap_failure_count();
        assert!(
            after > before,
            "a failed reap must be counted, not silently discarded ({before} -> {after})"
        );

        let message = reap_failure_message(
            "BunServer",
            Some(pid),
            "the tracked child did not exit",
        );
        assert!(
            message.contains("4242"),
            "the failure log must name the surviving PID: {message}"
        );
        assert!(
            message.contains("BunServer"),
            "the failure log must name the service that survived: {message}"
        );
    }

    /// DD-084: the app's own status must be able to say that a reap failed. The
    /// status is a read of the DD-082 ledger, so a recorded failure shows up as a
    /// non-zero count and a clean run reports the ledger as-is (zero in a process
    /// where nothing has failed).
    #[test]
    fn a_recorded_reap_failure_is_reported_by_the_supervisor_status() {
        let _ledger = lock_ledger();

        // Clean half: a clean reap records nothing, and the status mirrors the
        // ledger exactly instead of inventing a failure.
        let clean_ledger = reap_failure_count();
        assert!(
            confirm_reap(ManagedProcess::Ollama, None, Reap::Clean),
            "a clean reap confirms without recording a failure"
        );
        assert_eq!(
            reap_failure_count(),
            clean_ledger,
            "a clean reap must not be counted as a failure"
        );
        assert_eq!(
            crate::supervisor::give_up_status().reap_failures,
            clean_ledger,
            "a clean run must report the ledger's count, not a failure"
        );

        // Failure half: the same recorded failure DD-082 counts is what the
        // status must report — one ledger, read in both places.
        let pid = 4343;
        assert!(
            !confirm_reap(ManagedProcess::BunServer, Some(pid), Reap::Unconfirmed),
            "an unconfirmed reap must not report success"
        );
        let recorded = reap_failure_count();
        assert!(
            recorded > clean_ledger,
            "the recorded failure must move the ledger ({clean_ledger} -> {recorded})"
        );
        assert_eq!(
            crate::supervisor::give_up_status().reap_failures,
            recorded,
            "a recorded reap failure must make the status report a non-zero count"
        );
    }

    #[test]
    fn a_spawn_after_the_exit_flag_is_refused_without_starting_a_child() {
        let mut command = std::process::Command::new("definitely-not-a-managed-child-binary");
        let error = spawn_managed_with_gate(&mut command, true)
            .expect_err("a spawn attempted after the exit flag must be refused");

        assert!(
            error.to_string().contains("quitting"),
            "the refusal must say the app is quitting: {error}"
        );
    }

    #[test]
    fn the_spawn_gate_only_refuses_after_the_exit_flag_is_set() {
        assert!(
            refuse_spawn_when_quitting(false).is_ok(),
            "a running app must keep its existing spawn path"
        );
        let error = refuse_spawn_when_quitting(true)
            .expect_err("the gate must close once the app is quitting");
        assert!(
            error.to_string().contains("quitting"),
            "the refusal must say the app is quitting: {error}"
        );
    }

    /// Every named Bun path (ensure, chat, reconcile) reaches `spawn_managed`
    /// through the managed launcher, so the last-instant gate there covers all
    /// of them. Reads the two production bodies rather than the whole file so
    /// this module's own assertion text cannot satisfy the check.
    #[test]
    fn the_managed_spawn_reads_the_live_exit_flag_before_spawning() {
        let source = include_str!("process_lifecycle.rs");

        let start = source
            .find("pub(crate) fn spawn_managed(")
            .expect("spawn_managed must still exist");
        let end = source[start..]
            .find("fn spawn_managed_with_gate(")
            .map(|offset| start + offset)
            .expect("spawn_managed_with_gate must follow spawn_managed");
        let spawn_managed = &source[start..end];
        assert!(
            spawn_managed.contains("crate::supervisor::is_quitting()"),
            "the managed spawn must read DD-077's live flag:\n{spawn_managed}"
        );
        assert!(
            spawn_managed.contains("spawn_managed_with_gate("),
            "the managed spawn must route through the quit gate:\n{spawn_managed}"
        );

        let gate_start = source
            .find("fn spawn_managed_with_gate(")
            .expect("spawn_managed_with_gate must still exist");
        let gate_end = source[gate_start..]
            .find("fn spawn_assigned(command")
            .map(|offset| gate_start + offset)
            .expect("spawn_assigned must follow the gated spawn");
        let gated_spawn = &source[gate_start..gate_end];
        assert!(
            gated_spawn.contains("refuse_spawn_when_quitting(quitting)?;"),
            "the gate must run immediately before the OS spawn:\n{gated_spawn}"
        );
    }
}

#[cfg(all(test, windows))]
mod windows_job_tests {
    use super::{
        create_kill_on_close_job, hermes_tracked, inspect_exit_status, reap_slot, reap_slot_with,
        spawn_assigned, spawn_managed_tokio, stop_all, AsyncChildSlot, JobObject, Reap, Slot,
        SlotLaunch,
    };
    use std::process::{Child, Command, Stdio};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{GetLastError, BOOL, HANDLE};
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;

    fn spawn_ping(job: &JobObject) -> Child {
        let mut command = Command::new("cmd");
        command
            .args(["/c", "ping -n 30 127.0.0.1 > NUL"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        spawn_assigned(&mut command, job).expect("spawn and assign dummy child")
    }

    /// A dummy child shaped like the Hermes spawn: tokio pipes, long enough to
    /// outlive the assertions. It is the only process in the tree, so stopping
    /// it leaves no orphan.
    fn spawn_ping_tokio() -> tokio::process::Command {
        let mut command = tokio::process::Command::new("ping");
        command
            .args(["-n", "30", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command
    }

    fn is_process_in_job(child: &Child, job: &JobObject) -> bool {
        use std::os::windows::io::AsRawHandle;

        let mut in_job: BOOL = 0;
        let succeeded =
            unsafe { IsProcessInJob(child.as_raw_handle() as HANDLE, job.handle(), &mut in_job) };
        assert_ne!(
            succeeded,
            0,
            "IsProcessInJob failed with Win32 error {}",
            unsafe { GetLastError() }
        );
        in_job != 0
    }

    #[test]
    fn managed_child_is_assigned_to_its_job() {
        let job = create_kill_on_close_job()
            .unwrap_or_else(|error| panic!("create job failed with Win32 error {error}"));
        let mut child = spawn_ping(&job);
        let assigned = is_process_in_job(&child, &job);

        drop(job);
        let _ = child.kill();
        let _ = child.wait();

        assert!(assigned, "managed child was not assigned to its job");
    }

    /// DD-083: startup's health loop asks this reading whether the child it is
    /// waiting on is gone, so "it exited" must never be mistaken for "it is
    /// slow". A live child reports no exit; a child that exited reports the real
    /// exit code, which is the reason startup puts in front of the operator.
    #[test]
    fn the_tracked_child_exit_status_names_the_exit_code() {
        let mut live = Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1 > NUL"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a live child");
        let running = inspect_exit_status(&mut live);
        let _ = live.kill();
        let _ = live.wait();
        assert_eq!(
            running,
            Ok(None),
            "a running child must not be reported as exited"
        );

        let mut dead = Command::new("cmd")
            .args(["/c", "exit 3"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a short-lived child");
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            match inspect_exit_status(&mut dead) {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                other => panic!("the short-lived child never reported an exit: {other:?}"),
            }
        };
        assert_eq!(
            status.code(),
            Some(3),
            "the reading must carry the child's real exit code"
        );
    }

    /// DD-062: a Hermes child spawned through the managed path must join the
    /// ownership set and must be stopped by the shutdown routine the app's exit
    /// hook (`RunEvent::ExitRequested`) calls. Before the registry tracked the
    /// async child, nothing stopped it on exit.
    #[test]
    fn hermes_child_is_owned_and_stopped_by_the_exit_hook() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime should build");

        let slot: AsyncChildSlot = Arc::new(Mutex::new(None));
        let mut stdout = runtime.block_on(async {
            let mut command = spawn_ping_tokio();
            spawn_managed_tokio(&slot, &mut command)
                .await
                .expect("managed async spawn");
            let mut tracked = slot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            tracked
                .as_mut()
                .and_then(|child| child.stdout.take())
                .expect("the managed child exposes its stdout pipe")
        });

        assert!(
            hermes_tracked(),
            "a Hermes child spawned through the managed path must join the ownership set"
        );

        // The dummy child must still be running here, otherwise the stop
        // assertion below could pass without the exit hook doing anything.
        let still_running = runtime.block_on(async {
            use tokio::io::AsyncReadExt;

            let mut sink = Vec::new();
            tokio::time::timeout(Duration::from_millis(250), stdout.read_to_end(&mut sink))
                .await
                .is_err()
        });
        assert!(
            still_running,
            "the dummy Hermes child exited before the exit hook ran"
        );

        stop_all();

        assert!(
            !hermes_tracked(),
            "the exit hook must clear ownership after stopping the Hermes child"
        );

        // EOF on the child's stdout pipe is positive evidence that the OS
        // process exited; returning from `stop_all` is not.
        let exited = runtime.block_on(async {
            use tokio::io::AsyncReadExt;

            let mut sink = Vec::new();
            tokio::time::timeout(Duration::from_secs(10), stdout.read_to_end(&mut sink))
                .await
                .is_ok()
        });
        assert!(
            exited,
            "the exit hook must stop the Hermes child, not merely forget its handle"
        );
    }

    #[test]
    fn closing_job_terminates_managed_child() {
        let job = create_kill_on_close_job()
            .unwrap_or_else(|error| panic!("create job failed with Win32 error {error}"));
        let mut child = spawn_ping(&job);
        drop(job);

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut exited = false;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => {
                    exited = true;
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(_) => break,
            }
        }

        if !exited {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert!(
            exited,
            "closing the job did not terminate the managed child"
        );
    }

    /// DD-075: quit must complete even when a managed child refuses to die. The
    /// dummy child here is a real, running `cmd`/`ping` (the same double the job
    /// test uses) whose kill deliberately does not take, standing in for a
    /// process that survives `Child::kill`. What must hold is that the reap is
    /// bounded: it reports `Reap::Unconfirmed` at the deadline, keeps the handle
    /// owned, and returns in well under the child's own lifetime. If the
    /// open-ended `Child::wait` comes back to `reap_slot`, this test blocks for
    /// the rest of that lifetime and then reports `Clean`, so it fails either
    /// way instead of passing on a stale code path.
    #[test]
    fn a_child_that_never_exits_is_reaped_unconfirmed_at_the_deadline() {
        let job = create_kill_on_close_job()
            .unwrap_or_else(|error| panic!("create job failed with Win32 error {error}"));
        let child = spawn_ping(&job);
        let mut slot = Some(Slot {
            child,
            launch: SlotLaunch::Direct,
        });

        let timeout = Duration::from_millis(200);
        let started = Instant::now();
        // The kill does not take: the double keeps running, like a managed child
        // that refuses to die.
        let reap = reap_slot_with(&mut slot, timeout, |_child| {});
        let elapsed = started.elapsed();

        assert_eq!(
            reap,
            Reap::Unconfirmed,
            "a child still alive at the deadline must be reported as unconfirmed, \
             not waited on until it dies"
        );
        assert!(
            elapsed >= timeout,
            "the reap gave up after {elapsed:?}, before its {timeout:?} deadline"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "the reap took {elapsed:?}: the deadline did not bound the wait, so a \
             child that never dies would hold quit open"
        );
        assert!(
            slot.is_some(),
            "an unconfirmed reap must keep the child owned instead of forgetting it"
        );

        // Stop the double for real; the job drop is the backstop if this panics.
        if let Some(tracked) = slot.as_mut() {
            let _ = tracked.child.kill();
            let _ = tracked.child.wait();
        }
        drop(job);
    }

    /// The other half of DD-075: bounding the reap must not turn a kill that
    /// does take into a false negative. This drives the production `reap_slot`
    /// entry point — real kill, real deadline — and expects a confirmed, clean
    /// reap that also clears the slot.
    #[test]
    fn a_well_behaved_child_still_reaps_clean() {
        let job = create_kill_on_close_job()
            .unwrap_or_else(|error| panic!("create job failed with Win32 error {error}"));
        let child = spawn_ping(&job);
        let mut slot = Some(Slot {
            child,
            launch: SlotLaunch::Direct,
        });

        let reap = reap_slot(&mut slot);

        assert_eq!(
            reap,
            Reap::Clean,
            "a child that does exit when killed must still reap clean, not unconfirmed"
        );
        assert!(
            slot.is_none(),
            "a confirmed reap must clear the tracked slot"
        );
        drop(job);
    }
}
