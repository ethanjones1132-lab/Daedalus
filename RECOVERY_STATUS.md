# Home-Base Recovery Status & Handoff

**Last updated:** 2026-06-18 (transcript-recovery pass)
**Tree:** `C:\Projects\home-base-recovered\` — the working source of truth.
**Local git:** this tree is now its own repo (it shadows a stray `C:\.git`). Commits:
- `cf0b489` — tree as found + initial Rust build infra fixes
- `bd1155c` — transcript recovery merged; Rust down to the long-tail

> Every status claim here was produced by running the tool (`cargo check`) and
> reading its output. Don't trust an entry unless it cites the command that proved it.

---

## ★ THE BREAKTHROUGH — the real source survives in AI-tool transcripts

The WSL disk loss gutted the tree (most files are husks/fragments). **None** of the
~6 snapshot trees in `C:\Projects\_recovery\` are complete. BUT the project was built
with Claude Code, Antigravity (Gemini), and Codex, and **their session transcripts
recorded every Write/Edit/Read** — so the real source is reconstructable from them.

**Recovery sources (in priority order):**
1. **Claude Code transcripts** — `~/.claude/projects/--wsl-localhost-ubuntu-mnt-wslg-distro-home-ethan--openclaw-agents-coderclaw-workspace-home-base/` (21 JSONL, 22 MB). Schema: `message.content[].{tool_use,tool_result}`; Write input = full content, Read result = line-numbered, Edit = diff.
2. **Antigravity (Gemini) transcripts** — `~/.gemini/antigravity/brain/*/.system_generated/logs/transcript_full.jsonl`. **This is the "6/14 source"** referenced historically — same workspace, dated 2026-06-14. Schema: entries with `tool_calls[].{name,args}` (`write_to_file`→`CodeContent`, `replace_file_content`→`TargetContent`/`ReplacementContent`) and `type=VIEW_FILE` whose `content` is a line-numbered file dump.
3. **Codex transcripts** — `~/.codex/` (1.2 GB, schema not yet mined; `hermes_spawn`/`seed_skills` DO appear there — useful for the still-truncated hermes files).

**Extractor scripts (committed):**
- `scripts/recover_all.py` — unified Claude + Antigravity extractor. Replays each file's
  event stream in timestamp order (write/view = reset, edit = patch, ranged VIEW_FILE =
  line-stitch). Writes the merged latest-version tree to `C:\Projects\_recovery\from-transcripts-all\` (**216 files recovered**).
- `scripts/recover_from_transcripts.py` — earlier Claude-only version (kept for reference).
- `scripts/scan_antigravity.py` — scans Antigravity logs for writes/views of specific files.

**What the extractor recovered with full real content:** `App.tsx` (34 KB), `server-jarvis/src/index.ts` (111 KB), `skills.rs` (21 KB), `lib.rs` (27 KB), the full 23 KB `db/migrations.rs`, all of `server-jarvis` (75 files), the `jarvis/memory/` subsystem, and partial `hermes/*`.

---

## Current build state (2026-06-18)

| Subsystem | Status | Evidence |
|-----------|--------|----------|
| Python (`claude_cli_proxy` + `workspace/action-registry`) | ✅ GREEN | `py_compile` passes |
| Rust (`src-tauri`) | 🟡 **CASCADE CLEARED — long-tail of truncated command files remains** | `cargo check` → from 345 errors down to **55 undefined commands** concentrated in a few truncated files |
| Bun server (`server-jarvis`) | 🟡 real `index.ts` (111 KB) + 75 files recovered; **not yet typechecked** | — |
| React UI (`src-ui`) | 🟡 real `App.tsx` (34 KB) recovered; **node_modules not installed, not typechecked** | — |

### What got fixed this pass (Rust 345 → long-tail)
The original "383/345 errors" were almost all cascade. Root causes fixed:
- Added `src-tauri/build.rs` (`tauri_build::build()`) — fixed the `OUT_DIR` error and ~340 `__cmd__` macro errors.
- Added `cron = "0.12"` to `Cargo.toml`; generated placeholder `icons/` (via `cargo tauri icon`) + placeholder `server-jarvis/dist/index.js` (build-script resources).
- Restored lost `use serde::{...}` headers in `types/mod.rs` + `types/extra.rs`.
- Overlaid the 216 recovered real files onto the tree (0 EROFS husks remain in `src*`).
- Merged `commands/mod.rs` (recovered module decls + `action_registry` + `legacy`), `jarvis/mod.rs` (+`hermes`,+`learning`), created `jarvis/hermes/mod.rs`.
- Pulled full `db/migrations.rs` (565-line real schema).
- Reconstructed truncated files: `settings.rs`, `sessions.rs`, `skills.rs` (`list_skills` + `enable/disable/invoke_skill`, `skill_revisions_list`), `agents.rs` (all 8 commands).

---

## ⏭️ NEXT STEPS (precise — this is the handoff)

### 1. Finish the Rust long-tail — 55 undefined `#[tauri::command]`s
These are referenced in `lib.rs`'s `generate_handler![]` but their definitions were
truncated. They live in a few files that the transcript stitcher cut short:

- **`commands/system.rs`** — TRUNCATED at line 37 (only structs survive). Needs ~23 cmds:
  `get_system_health, get_doctor_report, get_gateway_status, check_updates,
  optimize_claude_settings, restart_bridge, get_devices, add_device, remove_device,
  add_node, remove_node, get_hooks, register_hook, unregister_hook, get_commitments,
  add_commitment, complete_commitment, delete_commitment, get_approvals,
  approve_request, reject_request, enable_plugin, disable_plugin`.
- **`commands/jarvis_commands.rs`** — only the EARLY 9-cmd version recovered. Missing ~17:
  `jarvis_get_skills, jarvis_get_tools, jarvis_ping, jarvis_discover_models,
  jarvis_test_connection, jarvis_switch_backend, jarvis_get_companion,
  jarvis_save_companion, jarvis_tool_decision, jarvis_review_session,
  jarvis_commit_session_end, jarvis_get_tier_stats, jarvis_list_memories_by_tier,
  jarvis_recall_cold_memory, jarvis_restart_ollama, jarvis_restart_server,
  jarvis_invoke_skill`, plus `cancel_chat_stream`.
- **`commands/sessions.rs`** — needs `list_sessions, create_session, delete_session,
  export_session, append_message, update_token_count` (only `compact_session_db` present).
- **`commands/memory.rs`** — verify `list_workspace_files`, `read_workspace_file` (may be missing).
- **`jarvis/hermes/commands.rs`** (43 lines, truncated — only `hermes_status`) + **`process.rs`** (41 lines, truncated). Needs `hermes_spawn/shutdown/restart/interrupt/invoke` + the `HermesProcess` body. **Check Codex transcripts** (`~/.codex/`) — `hermes_spawn` appears there.

**Two ways to do this (recommended: try A first per file, fall back to B):**
- **(A) Recover the real bodies** — re-mine transcripts for each file. The stitcher in
  `recover_all.py` falls back to "contiguous from line 1" when a file was never fully
  viewed; improving stitching or pulling a specific late VIEW_FILE/write often yields the
  whole file. Grep the transcripts for the function name to find the session that has it.
- **(B) Stub to get the window up fast** — for any command still missing, add
  `#[tauri::command] pub async fn NAME(...) -> Result<serde_json::Value, String> { Err("not yet recovered".into()) }`.
  The Tauri window renders regardless; only that feature errors at runtime. The reconstructed
  `agents.rs`/`skills.rs` in this pass are good templates for real CRUD.

Re-verify after each file: `cargo check --manifest-path src-tauri/Cargo.toml` then
`grep -oE "__cmd__[a-z_]+" output | sort -u` to see what's still undefined. **Expect a
second wave of real type/borrow errors** once the macro cascade fully clears (previously
seen: `JarvisState` init missing `queue` field at `lib.rs:456`; a `chrono` DateTime
subtraction; a couple of `does not live long enough`). Fix those normally.

### 2. UI build
`cd src-ui && bun install` then `bunx tsc -b` / `bun run build`. `App.tsx` (34 KB) is real;
components in `src-ui/src/components/jarvis/` mostly survived. Fix any remaining truncations
the same way (compare against `from-transcripts-all/src-ui`).

### 3. Make `tauri dev` launch (the "app on screen" goal)
`tauri.conf.json` `beforeDevCommand` is `wsl bash .../scripts/dev-ui.sh` — **dead** (the
Ubuntu WSL distro is gone; only `docker-desktop` remains). Replace with a native command,
e.g. `beforeDevCommand: "bun --cwd src-ui run dev"` and confirm `devUrl`/`frontendDist`.
Then `cargo tauri dev` from the repo root. The window renders the React UI even if the Bun
server / backend commands aren't all wired yet.

### 4. Bun server (separate process; lowest priority for "window on screen")
`server-jarvis/src/index.ts` (111 KB real) + 75 files recovered. Typecheck with
`cd server-jarvis && bun install && bunx tsc --noEmit`. Some imported modules may still be
missing (`agent-schema`, `projection-store`, `activation-boundary`, `orchestration/*`,
`self-tuning/mod`) — check `from-transcripts-all/server-jarvis` first; mine Codex if absent.

---

## Key locations
- Recovered merged tree: `C:\Projects\_recovery\from-transcripts-all\` (216 files — pull from here first when a file is truncated).
- Other snapshots (older/partial): `C:\Projects\_recovery\{claude-recovered-v4, grok-recovered-v*, merged-home-base}\`.
- Transcripts: see "Recovery sources" above.
- Extractors: `scripts/recover_all.py`, `scripts/scan_antigravity.py`.

## How to re-verify
```bash
cargo check --manifest-path src-tauri/Cargo.toml      # Rust
cd src-ui && bun install && bunx tsc -b               # UI
cd server-jarvis && bun install && bunx tsc --noEmit  # Bun server
python -m py_compile scripts/claude_cli_proxy.py      # Python (green)
```
