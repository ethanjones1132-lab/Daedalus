# Jarvis Architectural Debt Cleanup Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate dead code, unify duplicate systems, fix version mismatches, and clean up the Jarvis v3.0.0 codebase so there is one clear path for each feature.

**Architecture:** The root cause of most debt is the migration from an OpenClaw-dependent architecture to a standalone Tauri app. Root-level .rs files are the old architecture. The new architecture lives entirely in `src-tauri/src/`. We delete the dead code, unify the dual session/config/memory systems, and align all version strings.

**Tech Stack:** Rust 2024, Tauri 2, SQLite (rusqlite), TypeScript, Bun

---

## File Map

### Files to DELETE (dead code — old architecture)
| File | Reason |
|------|--------|
| `lib.rs` (root) | Old entry point, duplicates `src-tauri/src/lib.rs` |
| `bridge.rs` (root) | Old TCP bridge, replaced by `src-tauri/src/wsl.rs` + Bun bridge |
| `jarvis_commands.rs` (root) | Old commands, replaced by `src-tauri/src/commands/` |
| `queue.rs` (root) | Old message queue, replaced by SQLite sessions |
| `runner.rs` (root) | Old CLI runner, replaced by Bun server |
| `mod.rs` (root) | Old module root, dead code |
| `wsl.rs` (root) | Superseded by `src-tauri/src/wsl.rs` |

### Files to MODIFY
| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Bump version to 3.0.0 |
| `tauri.conf.json` | Bump version to 3.0.0 |
| `src-tauri/src/lib.rs` | Remove file-based session commands, keep SQLite ones |
| `src-tauri/src/jarvis/mod.rs` | Remove file-based session CRUD (keep config load/save only) |
| `src-ui/src/App.tsx` | Fix sidebar version to 3.0.0 |
| `src-ui/src/components/jarvis/JarvisView.tsx` | Remove polling of stub commands |
| `server-jarvis/src/index.ts` | Remove duplicate session/companion persistence (Rust handles it) |

### Files to KEEP (current architecture)
| File | Purpose |
|------|---------|
| `src-tauri/src/lib.rs` | Tauri app entry, command registration |
| `src-tauri/src/wsl.rs` | WSL utilities |
| `src-tauri/src/db/` | SQLite persistence layer |
| `src-tauri/src/commands/` | All Tauri command handlers |
| `src-tauri/src/jarvis/types.rs` | Config types |
| `src-tauri/src/jarvis/compaction.rs` | Context compaction |
| `src-tauri/src/jarvis/hermes/` | Hermes bridge |
| `src-tauri/src/jarvis/memory/` | File-based memory (legacy, keep for now) |
| `server-jarvis/src/index.ts` | Bun HTTP server (LLM API, SSE streaming) |
| `server-jarvis/src/bridge.ts` | TCP bridge |
| `server-jarvis/src/config.ts` | Config loading (Bun side) |

---

## Task 1: Remove Root-Level Dead Code

**Files:**
- Delete: `lib.rs`, `bridge.rs`, `jarvis_commands.rs`, `queue.rs`, `runner.rs`, `mod.rs`, `wsl.rs` (all at repo root)

- [ ] **Step 1: Verify root .rs files are NOT referenced by Cargo.toml**

Run: `grep -r "lib\.rs\|bridge\.rs\|jarvis_commands\|queue\.rs\|runner\.rs\|mod\.rs\|wsl\.rs" Cargo.toml src-tauri/Cargo.toml`
Expected: No references found

- [ ] **Step 2: Delete the 7 dead root .rs files**

```bash
cd /home/ethan/.openclaw/agents/coderclaw/workspace/home-base
rm lib.rs bridge.rs jarvis_commands.rs queue.rs runner.rs mod.rs wsl.rs
```

- [ ] **Step 3: Verify the project still builds**

Run: `cd src-tauri && cargo check`
Expected: PASS (no errors)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove root-level dead code from old architecture

Removed 7 dead .rs files (lib.rs, bridge.rs, jarvis_commands.rs,
queue.rs, runner.rs, mod.rs, wsl.rs) that were remnants of the
pre-Tauri architecture. All functionality has been replaced by
src-tauri/src/."
```

---

## Task 2: Unify Version Strings

**Files:**
- Modify: `src-tauri/Cargo.toml:3` — version = "3.0.0"
- Modify: `tauri.conf.json:4` — version = "3.0.0"
- Modify: `src-ui/src/App.tsx:152` — v3.0.0

- [ ] **Step 1: Bump src-tauri/Cargo.toml version**

Change `version = "2.0.0"` to `version = "3.0.0"` in `src-tauri/Cargo.toml`

- [ ] **Step 2: Bump tauri.conf.json version**

Change `"version": "0.1.0"` to `"version": "3.0.0"` in `tauri.conf.json`

- [ ] **Step 3: Fix sidebar version in App.tsx**

Change `v0.5.0` to `v3.0.0` in `src-ui/src/App.tsx` line 152

- [ ] **Step 4: Verify build**

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml tauri.conf.json src-ui/src/App.tsx
git commit -m "chore: unify version strings to 3.0.0

Bumped src-tauri/Cargo.toml (2.0.0 -> 3.0.0),
tauri.conf.json (0.1.0 -> 3.0.0),
and sidebar display (v0.5.0 -> v3.0.0)."
```

---

## Task 3: Remove Duplicate File-Based Session System

**Files:**
- Modify: `src-tauri/src/jarvis/mod.rs` — Remove file-based session CRUD functions
- Modify: `src-tauri/src/lib.rs` — Remove file-based session command registrations

The file-based session system in `jarvis/mod.rs` (lines ~118-325) creates JSON files in `~/.openclaw/jarvis/sessions/`. The SQLite system in `commands/sessions.rs` does the same thing properly. We remove the file-based one.

- [ ] **Step 1: Identify file-based session commands in lib.rs**

Run: `grep -n "jarvis_new_session\|jarvis_list_sessions\|jarvis_delete_session\|jarvis_load_session_messages\|jarvis_save_message\|jarvis_get_companion\|jarvis_save_companion" src-tauri/src/lib.rs`
Expected: Lines showing these commands registered in invoke_handler

- [ ] **Step 2: Remove file-based session command registrations from lib.rs**

In `src-tauri/src/lib.rs`, remove these lines from the `invoke_handler![]` macro:
```
jarvis_new_session,
jarvis_list_sessions,
jarvis_delete_session,
jarvis_load_session_messages,
jarvis_save_message,
jarvis_get_companion,
jarvis_save_companion,
```

- [ ] **Step 3: Remove file-based session functions from jarvis/mod.rs**

In `src-tauri/src/jarvis/mod.rs`, delete these functions (keep `load_jarvis_config`, `save_jarvis_config`, `get_config_path`):
- `list_jarvis_sessions()`
- `delete_jarvis_session()`
- `create_jarvis_session()`
- `append_session_message()`
- `load_session_messages()`
- `load_companion_state()`
- `save_companion_state()`
- `get_sessions_dir()`
- `ensure_sessions_dir()`
- `get_companion_path()`

Also remove the test module at the bottom of the file (lines 76-139).

- [ ] **Step 4: Remove unused imports from jarvis/mod.rs**

Remove imports that are no longer needed after deleting the above functions. Keep only what `load_jarvis_config` and `save_jarvis_config` need.

- [ ] **Step 5: Verify build**

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/jarvis/mod.rs
git commit -m "chore: remove duplicate file-based session system

Removed file-based session CRUD (JSON files in ~/.openclaw/jarvis/sessions/)
that duplicated the SQLite-backed session system in commands/sessions.rs.
Kept config load/save functions in jarvis/mod.rs."
```

---

## Task 4: Remove Duplicate Compaction Code

**Files:**
- Modify: `src-tauri/src/jarvis/compaction.rs` — Delete or mark as deprecated

There are two compaction implementations:
1. `jarvis/compaction.rs` — standalone function using Ollama API directly
2. `commands/sessions.rs:compact_session_db()` — DB-backed compaction with proper transaction handling

The `commands/sessions.rs` version is more complete (reads/writes DB, handles transactions). The `compaction.rs` version is simpler but redundant.

- [ ] **Step 1: Check if compaction.rs is referenced anywhere**

Run: `grep -rn "compaction" src-tauri/src/ --include="*.rs" | grep -v "compaction\.rs" | grep -v "CompactionConfig"`
Expected: Only references should be the type definition in types.rs and the module declaration

- [ ] **Step 2: Remove the compaction module declaration**

In `src-tauri/src/jarvis/mod.rs`, remove the line `pub mod compaction;`

- [ ] **Step 3: Delete compaction.rs**

```bash
rm src-tauri/src/jarvis/compaction.rs
```

- [ ] **Step 4: Verify build**

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/jarvis/mod.rs src-tauri/src/jarvis/compaction.rs
git commit -m "chore: remove duplicate compaction implementation

Removed jarvis/compaction.rs (standalone Ollama compaction) in favor
of the more complete DB-backed compact_session_db() in commands/sessions.rs
which handles transactions and proper message management."
```

---

## Task 5: Clean Up Stub Commands

**Files:**
- Modify: `src-tauri/src/commands/mod.rs` — Remove or document stub commands

The `commands/mod.rs` file has ~20 stub commands that return empty/default values because they depended on OpenClaw which is no longer installed. These pollute the frontend with non-functional UI.

- [ ] **Step 1: Identify all stub commands**

Run: `grep -n "pub async fn get_" src-tauri/src/commands/mod.rs`
Expected: List of all stub command functions

- [ ] **Step 2: Remove stub command registrations from lib.rs**

In `src-tauri/src/lib.rs` `invoke_handler![]`, remove these commands that are pure stubs:
```
get_agents,
get_cron_jobs,
get_skills,
get_nodes,
get_channels,
get_models,
get_plugins,
get_memory_status,
get_tasks,
get_health,
get_logs,
get_config,
get_sessions,
get_status,
get_session_history,
get_hooks,
get_commitments,
get_devices,
get_approvals,
get_gateway_status,
get_doctor,
```

- [ ] **Step 3: Remove stub function implementations from commands/mod.rs**

Delete all the stub function bodies from `commands/mod.rs`. Keep the module declarations for the real command modules (sessions, memory, skills, models, cron, agents, channels, settings, jarvis_commands).

- [ ] **Step 4: Verify build**

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands/mod.rs
git commit -m "chore: remove OpenClaw-dependent stub commands

Removed ~20 stub commands that returned empty/default values
because they depended on OpenClaw which is no longer installed.
The frontend views for these are also non-functional."
```

---

## Task 6: Fix Mutex Poison Handling

**Files:**
- Modify: All files in `src-tauri/src/commands/` — Replace `.map_err()` with proper poison recovery

Currently every command uses:
```rust
db.conn.lock().map_err(|e| format!("Mutex poison: {}", e))?
```
This means a single panicking thread permanently kills DB access. The correct approach is to use `into_inner()` to recover the poisoned mutex.

- [ ] **Step 1: Create a helper function in commands/mod.rs**

Add to `commands/mod.rs`:
```rust
/// Lock the DB mutex, recovering from poison.
fn db_lock(db: &crate::db::AppDb) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, String> {
    db.conn.lock().or_else(|poisoned| {
        // Recover the inner data even if the mutex was poisoned
        Ok(poisoned.into_inner())
    })
}
```

- [ ] **Step 2: Replace all `.conn.lock().map_err(|e| format!("Mutex poison: {}", e))?` with `db_lock(&db)?`**

Files to update:
- `commands/sessions.rs` — ~8 occurrences
- `commands/memory.rs` — ~5 occurrences
- `commands/skills.rs` — ~5 occurrences
- `commands/models.rs` — ~6 occurrences
- `commands/cron.rs` — ~10 occurrences
- `commands/agents.rs` — ~8 occurrences
- `commands/channels.rs` — ~6 occurrences
- `commands/settings.rs` — ~3 occurrences
- `commands/jarvis_commands.rs` — ~2 occurrences

- [ ] **Step 3: Verify build**

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/
git commit -m "fix: recover from mutex poison instead of failing permanently

Replaced all .conn.lock().map_err(|e| format!('Mutex poison: {}', e))?
with a db_lock() helper that uses poisoned.into_inner() to recover
the inner connection. Previously, a single panicking thread would
permanently lock out all subsequent DB access."
```

---

## Task 7: Remove Duplicate Config Loading

**Files:**
- Modify: `src-tauri/src/jarvis/mod.rs` — Simplify config to use only SQLite settings
- Modify: `src-tauri/src/commands/settings.rs` — Make SQLite the single source of truth

Currently config is loaded from both `config.json` (file) and SQLite settings table. The Rust backend reads from the file, while also having a full settings CRUD in SQLite. We should pick one.

**Decision:** Keep `config.json` as the Bun server's config (it runs in WSL and reads it directly). Make the Rust backend read/write ONLY through SQLite settings table. The `get_jarvis_config` / `save_jarvis_config` commands in `settings.rs` already do this correctly — they serialize the full config into SQLite.

- [ ] **Step 1: Remove file-based config load/save from jarvis/mod.rs**

In `src-tauri/src/jarvis/mod.rs`, delete:
- `load_jarvis_config()` function
- `save_jarvis_config()` function
- `get_config_path()` function
- `encrypt_api_key()` function
- `decrypt_api_key()` function
- `get_encryption_salt()` function
- The `CONFIG_DIR`, `CONFIG_FILE`, `SESSIONS_DIR`, `COMPANION_FILE` constants
- The `get_test_config_dir()` test helper
- The entire `#[cfg(test)] mod tests` block

Keep only: `pub use types::JarvisState;` and the module declarations.

- [ ] **Step 2: Update lib.rs to use settings commands for config**

In `src-tauri/src/lib.rs`, the `jarvis_get_config` and `jarvis_save_config` commands should call `get_jarvis_config` and `save_jarvis_config` from `commands/settings.rs` instead of from `jarvis/mod.rs`.

Update `jarvis_commands.rs` to use `commands::settings::get_jarvis_config` and `commands::settings::save_jarvis_config`.

- [ ] **Step 3: Verify build**

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/jarvis/mod.rs src-tauri/src/lib.rs src-tauri/src/commands/jarvis_commands.rs
git commit -m "chore: unify config loading to SQLite settings table

Removed file-based config load/save from jarvis/mod.rs (encrypt_api_key,
decrypt_api_key, load_jarvis_config, save_jarvis_config, get_config_path).
Config is now managed exclusively through the SQLite settings table
via commands/settings.rs get_jarvis_config/save_jarvis_config.
Bun server continues to read config.json directly in WSL."
```

---

## Task 8: Clean Up Bun Server Duplication

**Files:**
- Modify: `server-jarvis/src/index.ts` — Remove session/companion persistence no-ops

The Bun server has session helper and companion persistence sections that are commented as "delegated to Rust/SQLite" but still contain no-op code and unused imports.

- [ ] **Step 1: Remove unused imports from index.ts**

In `server-jarvis/src/index.ts`, remove:
- `writeFileSync`, `mkdirSync`, `readdirSync`, `existsSync`, `rmSync`, `renameSync` from fs imports (if only used in no-ops)
- `join` from path (if unused after cleanup)
- `homedir` from os (if unused after cleanup)
- `spawn` from child_process (if unused)

- [ ] **Step 2: Remove no-op session/companion sections**

Remove the commented-out session helper sections (lines ~231-243) and companion persistence sections (lines ~238-240) that are marked as "delegated to Rust/SQLite".

- [ ] **Step 3: Remove duplicate config defaults**

The Bun server's `loadConfig()` has hardcoded defaults that differ from Rust's `JarvisConfig::default()`. Align them or add a comment noting the divergence.

- [ ] **Step 4: Commit**

```bash
git add server-jarvis/src/index.ts
git commit -m "chore: clean up Bun server no-op code

Removed commented-out session/companion persistence sections that
were marked as 'delegated to Rust/SQLite'. Cleaned up unused imports."
```

---

## Task 9: Fix Hardcoded Paths

**Files:**
- Modify: Multiple files — Replace hardcoded `/home/ethan` with `std::env::var("HOME")`

- [ ] **Step 1: Find all hardcoded home paths**

Run: `grep -rn "/home/ethan" src-tauri/src/ --include="*.rs"`
Expected: List of files with hardcoded paths

- [ ] **Step 2: Replace with env var fallback**

Replace all instances of:
```rust
"/home/ethan".to_string()
```
with:
```rust
std::env::var("HOME").unwrap_or_else(|_| "/home/ethan".to_string())
```

- [ ] **Step 3: Verify build**

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/
git commit -m "fix: replace hardcoded /home/ethan with HOME env var

Replaced all hardcoded '/home/ethan' paths with
std::env::var('HOME').unwrap_or_else(|_| '/home/ethan'.to_string())
for portability across different user environments."
```

---

## Task 10: Add Cron Job Patch Validation

**Files:**
- Modify: `src-tauri/src/commands/cron.rs:156-190` — Add whitelist validation for dynamic SQL

The `edit_cron_job` function builds dynamic SQL from JSON patch keys without validation, which is a potential SQL injection vector.

- [ **Step 1: Add allowed fields whitelist**

In `commands/cron.rs`, add at the top of the file:
```rust
const ALLOWED_CRON_PATCH_FIELDS: &[&str] = &[
    "name", "schedule", "prompt", "agent_id", "session_id", "next_run",
];
```

- [ ] **Step 2: Add validation in edit_cron_job**

Before the dynamic SQL build (around line 156), add:
```rust
for key in obj.keys() {
    if !ALLOWED_CRON_PATCH_FIELDS.contains(&key.as_str()) {
        return Err(format!("Invalid patch field: '{}'. Allowed: {:?}", key, ALLOWED_CRON_PATCH_FIELDS));
    }
}
```

- [ ] **Step 3: Verify build**

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/cron.rs
git commit -m "fix: add whitelist validation for cron job patch fields

Added ALLOWED_CRON_PATCH_FIELDS whitelist to prevent SQL injection
via the dynamic SQL builder in edit_cron_job. Only name, schedule,
prompt, agent_id, session_id, and next_run can be patched."
```

---

## Summary of Changes

| Task | Files Changed | Impact |
|------|---------------|--------|
| 1. Remove dead code | 7 files deleted | -1,657 LOC, cleaner structure |
| 2. Unify versions | 3 files modified | Consistent versioning |
| 3. Remove file-based sessions | 2 files modified | Single session store (SQLite) |
| 4. Remove duplicate compaction | 1 file deleted | Single compaction path |
| 5. Remove stub commands | 2 files modified | -~400 LOC, cleaner frontend |
| 6. Fix mutex poison | 9 files modified | Resilient DB access |
| 7. Unify config loading | 3 files modified | Single config source (SQLite) |
| 8. Clean Bun server | 1 file modified | Remove no-op code |
| 9. Fix hardcoded paths | Multiple files | Portability |
| 10. Cron patch validation | 1 file modified | Security |

**Estimated total: ~2,000+ lines removed, ~50 lines added for fixes**