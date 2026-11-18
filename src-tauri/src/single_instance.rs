//! Windows single-instance ownership and best-effort window handoff.
//!
//! The named mutex handle is held for the entire Tauri run. A second process
//! observes the existing kernel object, raises the primary Jarvis window, and
//! returns before constructing app state or starting bootstrap services.
//! Non-Windows builds intentionally use the documented owner-only fallback:
//! no cross-platform single-instance guarantee is made there.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InstanceRole {
    Owner,
    Secondary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LaunchPlan {
    pub(crate) focus_existing_window: bool,
    pub(crate) start_bootstrap_services: bool,
    pub(crate) stop_owned_children: bool,
}

pub(crate) fn launch_plan(role: InstanceRole) -> LaunchPlan {
    match role {
        InstanceRole::Owner => LaunchPlan {
            focus_existing_window: false,
            start_bootstrap_services: true,
            stop_owned_children: true,
        },
        InstanceRole::Secondary => LaunchPlan {
            focus_existing_window: true,
            start_bootstrap_services: false,
            stop_owned_children: false,
        },
    }
}

/// Invoke the real window handoff only for a secondary process. `None` means
/// the caller is the owner and should continue normal app construction.
pub(crate) fn focus_handoff(
    role: InstanceRole,
    request_focus: impl FnOnce() -> bool,
) -> Option<bool> {
    match role {
        InstanceRole::Owner => None,
        InstanceRole::Secondary => Some(request_focus()),
    }
}

pub(crate) struct InstanceGuard {
    role: InstanceRole,
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}

impl InstanceGuard {
    pub(crate) fn role(&self) -> InstanceRole {
        self.role
    }

    #[cfg(windows)]
    pub(crate) fn focus_existing_window(&self) -> bool {
        use std::time::{Duration, Instant};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            BringWindowToTop, FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE,
        };

        let title = wide("Jarvis");
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            // SAFETY: title is a live NUL-terminated UTF-16 string; passing a
            // null class name asks Windows to match by the stable Jarvis title.
            let window = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
            if !window.is_null() {
                // SAFETY: `window` was returned by FindWindowW and each call
                // accepts an HWND without retaining the pointer.
                unsafe {
                    ShowWindow(window, SW_RESTORE);
                    BringWindowToTop(window);
                    return SetForegroundWindow(window) != 0;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    #[cfg(not(windows))]
    pub(crate) fn focus_existing_window(&self) -> bool {
        false
    }
}

#[cfg(windows)]
impl Drop for InstanceGuard {
    fn drop(&mut self) {
        // SAFETY: this guard uniquely owns the handle returned by CreateMutexW.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

pub(crate) fn acquire() -> Result<InstanceGuard, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{
            GetLastError, SetLastError, ERROR_ALREADY_EXISTS, HANDLE,
        };
        use windows_sys::Win32::System::Threading::CreateMutexW;

        let name = wide(r"Local\Jarvis.Desktop.SingleInstance");
        // Make the CreateMutexW last-error result unambiguous for a newly
        // created mutex as well as for ERROR_ALREADY_EXISTS.
        unsafe { SetLastError(0) };
        // SAFETY: name is NUL-terminated and CreateMutexW copies the name.
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(format!(
                "could not create the Jarvis single-instance mutex (Windows error {})",
                unsafe { GetLastError() }
            ));
        }
        let role = if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            InstanceRole::Secondary
        } else {
            InstanceRole::Owner
        };
        return Ok(InstanceGuard {
            role,
            handle: handle as HANDLE,
        });
    }

    #[cfg(not(windows))]
    {
        Ok(InstanceGuard {
            role: InstanceRole::Owner,
        })
    }
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::{focus_handoff, launch_plan, InstanceRole};
    use std::cell::Cell;

    #[test]
    fn secondary_launch_only_hands_off_and_never_owns_startup_or_shutdown() {
        let plan = launch_plan(InstanceRole::Secondary);
        assert!(plan.focus_existing_window);
        assert!(!plan.start_bootstrap_services);
        assert!(!plan.stop_owned_children);
    }

    #[test]
    fn secondary_requests_focus_while_owner_does_not() {
        let focus_requested = Cell::new(false);
        let secondary = focus_handoff(InstanceRole::Secondary, || {
            focus_requested.set(true);
            true
        });
        assert_eq!(secondary, Some(true));
        assert!(focus_requested.get());

        focus_requested.set(false);
        let owner = focus_handoff(InstanceRole::Owner, || {
            focus_requested.set(true);
            true
        });
        assert_eq!(owner, None);
        assert!(!focus_requested.get());
    }

    #[test]
    fn only_the_instance_owner_starts_and_stops_managed_services() {
        let plan = launch_plan(InstanceRole::Owner);
        assert!(!plan.focus_existing_window);
        assert!(plan.start_bootstrap_services);
        assert!(plan.stop_owned_children);
    }

    #[test]
    fn launch_plan_can_be_captured_by_both_tauri_callbacks() {
        let plan = launch_plan(InstanceRole::Owner);
        let setup_starts_services = move || plan.start_bootstrap_services;
        let exit_stops_children = move || plan.stop_owned_children;

        assert!(setup_starts_services());
        assert!(exit_stops_children());
    }
}
