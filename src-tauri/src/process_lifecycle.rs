//! Single owner for the native process handles that live with the Tauri app.
//!
//! Start/restart callers provide the service-specific spawn function, while
//! this module serializes starts, stores the resulting `Child`, and is the only
//! place that terminates a tracked process. A listener on a configured port is
//! not proof of ownership and is never killed here.
//!
//! Hermes is the one async child: it is spawned through tokio so its stdio
//! pipes stay non-blocking, so it cannot use `spawn_managed`'s
//! `std::process::Child`. It still joins the same ownership registry through
//! `spawn_managed_tokio`, gets assigned to the same kill-on-close job object,
//! and is stopped by the same `stop_all` routine the exit hook calls.

use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

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
    bun_server: Option<Child>,
    claude_proxy: Option<Child>,
    ollama: Option<Child>,
    llama_cpp: Option<Child>,
    hermes: Option<AsyncChildSlot>,
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

/// Spawn a managed child and assign it to its Windows Job Object immediately.
/// The non-Windows path preserves the existing child-spawn behavior.
pub(crate) fn spawn_managed(command: &mut std::process::Command) -> std::io::Result<Child> {
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

/// Stop and reap a tracked child. Returns `true` only when exit is confirmed
/// (the process was observed exited, or kill+wait succeeded). An unconfirmed
/// termination leaves the handle in place so ownership stays tracked.
fn stop_slot(slot: &mut Option<Child>) -> bool {
    let Some(child) = slot.as_mut() else {
        return true;
    };
    if matches!(child.try_wait(), Ok(Some(_))) {
        slot.take();
        return true;
    }
    let _ = child.kill();
    match child.wait() {
        Ok(_) => {
            slot.take();
            true
        }
        Err(_) => false,
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
/// and polls for the exit the same way `stop_slot` waits for a std child.
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
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                slot.take();
                return true;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(_) => return false,
        }
    }
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
/// An unconfirmed exit puts the slot back so ownership stays tracked.
fn stop_registered_hermes() -> bool {
    let tracked = { children().hermes.take() };
    let Some(slot) = tracked else {
        return true;
    };
    let confirmed = {
        let mut child = lock_async_child(&slot);
        stop_async_child(&mut child)
    };
    if !confirmed {
        // Only put the slot back if no newer child registered meanwhile.
        let mut children = children();
        if children.hermes.is_none() {
            children.hermes = Some(slot);
        }
    }
    confirmed
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
        match children.bun_server.as_mut().map(|child| child.try_wait()) {
            Some(Ok(Some(_))) => {
                BUN_TERMINATION_UNCONFIRMED.store(false, Ordering::SeqCst);
                return BunOwnership::Exited;
            }
            _ => return BunOwnership::Unknown,
        }
    }
    match children.bun_server.as_mut() {
        None => BunOwnership::None,
        Some(child) => match child.try_wait() {
            Ok(None) => BunOwnership::Live,
            Ok(Some(_)) => BunOwnership::Exited,
            Err(_) => BunOwnership::Unknown,
        },
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
    let mut bun_unconfirmed = false;
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
            let confirmed = stop_slot(slot);
            if matches!(process, ManagedProcess::BunServer) && !confirmed {
                bun_unconfirmed = true;
            }
        }
    }
    // Generation bookkeeping is atomic; the CHILDREN guard has already been
    // dropped, so no lock held across HTTP is acquired while CHILDREN is held.
    // An unconfirmed termination must NOT bump the generation: ownership stays
    // Unknown and invalidation cannot be bypassed.
    if should_clear && matches!(process, ManagedProcess::BunServer) {
        if bun_unconfirmed {
            BUN_TERMINATION_UNCONFIRMED.store(true, Ordering::SeqCst);
        } else {
            bump_bun_generation();
        }
    }

    let child = spawn()?;
    let pid = child.id();
    *children().slot(process) = Some(child);
    if matches!(process, ManagedProcess::BunServer) {
        BUN_TERMINATION_UNCONFIRMED.store(false, Ordering::SeqCst);
        bump_bun_generation();
    }
    Ok(StartOutcome::Started(pid))
}

/// Stop and reap a child started by this Tauri process.
pub(crate) fn stop(process: ManagedProcess) {
    let _serial = process_lock(process);
    let confirmed = {
        let mut children = children();
        stop_slot(children.slot(process))
    };
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
    stop_registered_hermes();
    let bun_confirmed = {
        let mut children = children();
        let confirmed = stop_slot(&mut children.bun_server);
        stop_slot(&mut children.claude_proxy);
        stop_slot(&mut children.ollama);
        stop_slot(&mut children.llama_cpp);
        confirmed
    };
    if bun_confirmed {
        BUN_TERMINATION_UNCONFIRMED.store(false, Ordering::SeqCst);
        bump_bun_generation();
    } else {
        BUN_TERMINATION_UNCONFIRMED.store(true, Ordering::SeqCst);
    }
}

#[cfg(all(test, windows))]
mod windows_job_tests {
    use super::{
        create_kill_on_close_job, hermes_tracked, spawn_assigned, spawn_managed_tokio, stop_all,
        AsyncChildSlot, JobObject,
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
}
