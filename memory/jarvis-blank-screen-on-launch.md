---
name: jarvis-blank-screen-on-launch
description: why the Jarvis Tauri app white-screens on every launch (persisted view + unwrapped ErrorBoundary) and the fix
metadata:
  type: project
---

Jarvis showing a **blank/frozen (white) window on every launch** is almost always a frontend render crash, not a server/WSL problem. The WebView loads `index.html` (you'll see `tauri::manager Asset favicon.ico ... fallback to index.html` in `Jarvis.log`), but React throws during render and unmounts the whole tree.

Root cause pattern: `src-ui/src/App.tsx` persists the active view to `localStorage('jarvis-current-view')` and restores it on boot. Historically **only the `jarvis` and `control` views were wrapped in `ErrorBoundary`** in `renderView()`; every other view (`overview`, `sessions`, `cron`, `action-registry`, `skills`, `agents`, `channels`, `memory`, `chat-feeds`) rendered bare. So any uncaught render throw in a non-jarvis view — e.g. `OverviewView` doing `health.memory.used_percent.toFixed()` on a partial `get_system_health` payload, or `ActionRegistryView` doing `activeData.actions` when `.actions` is absent → `active.length` throws — blanks the entire app, and it **recurs every launch** because localStorage keeps pointing at the broken view.

Fix (2026-06-17): wrapped `renderView()` in a single `ErrorBoundary` in `<main>` (the keyed `<div key={currentView}>` auto-resets it on navigation), validated the persisted view against `NAV_SECTIONS`, and guarded `ActionRegistryView` data with `?? []`. Now a view crash shows the error message + a working sidebar instead of a white screen.

Launch is `cargo tauri dev` (via `scripts/launch.sh` → `tauri-dev.bat`); frontend served by Vite from source / `src-ui/dist`. A frontend-only fix needs **only a relaunch** (no cargo rebuild). To verify a white-screen hypothesis without the GUI: serve `src-ui/dist` over http and load it headless — `invoke()` rejects there so data-dependent throws need a mocked `window.__TAURI_INTERNALS__.invoke`. Related: [[windows-hang-root-cause]].
