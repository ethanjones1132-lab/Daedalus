---
name: jarvis-bun-sqlite-cross-boundary-ioerr
description: why Bun/server-side SQLite must use WSL-native DBs, never the shared Windows jarvis.db (concurrent WAL over /mnt/c 9p → SQLITE_IOERR)
metadata:
  type: project
---

The native Rust process opens `jarvis.db` (`C:\Users\ethan\.local\share\com.jarvis.desktop\jarvis.db`) in **WAL** mode. The Bun server runs in WSL and can only reach that file via `/mnt/c` (9p). **Concurrent WAL access across the Win/WSL boundary** fails: the `-shm` shared-memory file can't be coordinated across native-Windows + 9p, so Bun gets `SQLiteError: disk I/O error` (SQLITE_IOERR) on every operation while Rust holds the DB. Verified nuance: a *single-opener* WAL write over `/mnt/c` actually works — it's specifically the **concurrent cross-boundary** case that breaks, which is why it only showed up in the running app (logs were the reliable repro).

Rule: **any Bun/server-side SQLite store must live on the WSL-native fs** — `~/.openclaw/jarvis/*.db` (e.g. `self-tuning.db`, and the pre-existing `agent_projections.db`, `inference_performance.db`) — never the shared `jarvis.db`. `locateJarvisDb()` in `server-jarvis/src/self-tuning/store.ts` resolves to the `/mnt/c` path; fine for the occasional readonly query but **never for writes**.

Fixed 2026-06-17: `SelfTuningStore` now defaults to `selfTuningDbPath()` (`~/.openclaw/jarvis/self-tuning.db`) and creates its own schema (mirrors `src-tauri/src/db/migrations.rs::create_self_tuning_tables`), instead of writing to the shared DB. Rust still creates the self-tuning tables in `jarvis.db` (migrations) but never reads them, so they're now just unused there. Related: [[windows-hang-root-cause]], [[jarvis-blank-screen-on-launch]].
