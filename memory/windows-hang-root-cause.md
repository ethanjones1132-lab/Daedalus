---
name: windows-hang-root-cause
description: Why the Jarvis Tauri app spawn-stall-crashes on Windows, and how it was hardened
metadata:
  type: project
---

The Jarvis desktop app (Tauri) "spawns, stalls, then crashes" on Windows = a UI-thread **AppHang** (Windows force-close) followed by a native `ntdll.dll` access violation (`0xc0000005`), NOT a Rust panic. Nothing shows on stderr or in the Tauri log (`%LOCALAPPDATA%\com.jarvis.desktop\logs\Jarvis.log`); diagnose via the **Windows Application event log** (`Application Error` / `Application Hang` for `home-base.exe`) and by running the exe under `Start-Process` while polling `Process.Responding` for ~4 min (the hang appears ~25-30s in).

**Root cause:** boot-time backend startup in `lib.rs` `.setup()` eagerly runs `ensure_jarvis_server_started()`, which fires a cascade of **untimed `wsl.exe` subprocess spawns** (`wsl_home`, `find_jarvis_server`'s `test -f`, `spawn_jarvis_server`'s `bash -lc exec bun`) plus blocking `is_jarvis_running()` (blocking reqwest) on a tokio worker, plus a 15s health-wait. When the Bun server is unreachable this storm starves the WebView UI thread.

**Hardening applied (verified: responding=True for 240s, 0 crash events):** added `crate::wsl::command_output_timeout()` to bound every `wsl.exe` spawn (3s); wrapped `is_jarvis_running()` in `tokio::task::spawn_blocking`; added `busy_timeout(5000ms)` to the live DB connection in `lib.rs::run()` (it's opened manually and skips `AppDb::new`'s setup) and to the ephemeral connections in `commands/sessions.rs`.

Key gotchas: the Bun server is **unreachable from Windows on `127.0.0.1:19877` even when running inside WSL** (so the app can never reach its backend without fixing networking). The live DB is at `C:\home\ethan\.local\share\com.jarvis.desktop\jarvis.db` (HOME unset on Windows → `/home/ethan` fallback). Residual non-fatal `[cron] database is locked` persists on a clean DB — see [[jarvis-db-locked-followup]]. The Windows build compiles the **working tree** (`cargo tauri build` / `cargo build --release` with `CARGO_TARGET_DIR=%USERPROFILE%\.cargo-target\home-base`), which carries uncommitted concurrent edits beyond what's committed.
