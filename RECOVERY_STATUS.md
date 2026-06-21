# Home-Base Recovery Status & Handoff

**Last updated:** 2026-06-21 (full typecheck green pass)
**Tree:** `C:\Projects\home-base-recovered\` — the working source of truth.
**Local git:** this tree is now its own repo (it shadows a stray `C:\.git`). Commits:
- `cf0b489` — tree as found + initial Rust build infra fixes
- `bd1155c` — transcript recovery merged; Rust down to the long-tail
- `9a0cf63` — recovery handoff written with exact long-tail steps
- *(prior sessions, uncommitted)* — Rust long-tail fixed with stubs + 89-file overhaul
- *(this run)* — server-jarvis typecheck green; all 3 subsystems verified clean

> Every status claim here was produced by running the actual commands and reading output.
> Don't trust an entry unless it cites the command that proved it.

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

---

## ✅ Current build state (2026-06-21)

| Subsystem | Status | Verification command | Result |
|-----------|--------|----------------------|--------|
| Rust (`src-tauri`) | ✅ **CLEAN** | `cargo check --manifest-path src-tauri/Cargo.toml` | exit 0, "Finished" |
| React UI (`src-ui`) | ✅ **CLEAN** | `cd src-ui && bunx tsc -b` | exit 0, no output |
| Bun server (`server-jarvis`) | ✅ **CLEAN** | `cd server-jarvis && bunx tsc --noEmit` | exit 0, 0 errors |
| Python (`claude_cli_proxy`) | ✅ **GREEN** | `py_compile` passes | — |

### What got fixed this pass
Prior sessions (uncommitted, 89 files modified):
- Fixed all 55 undefined Rust commands via stubs in `commands/recovery_stubs.rs`, 
  recovered real bodies in `sessions.rs`, `jarvis_commands.rs`, `system.rs`, `hermes/process.rs`, etc.
- Installed node_modules for both `src-ui` and `server-jarvis`
- Overlaid recovered UI components

This session (2026-06-21):
- **Created `server-jarvis/tsconfig.json`** — first ever; enables `bunx tsc --noEmit` typecheck
- **Installed `@types/bun@1.3.14` and `typescript@6.0.3`** in server-jarvis
- **Re-authored `server-jarvis/src/football.ts`** — was completely missing; now has NFL_2025_PLAYERS (28 players), NFL_2025_DEFENSES (all 32 teams), NFL_2025_TRENDS, NFL_2025_LEAGUE_CONTEXT
- **Re-authored `server-jarvis/src/cron-prompts.ts`** — was truncated at line 27; now complete with LEARNING_SUBTOPICS (10 subtopics) + 4 exported functions (buildLearningPrompt, buildReviewPrompt, buildCodebaseAuditPrompt, buildFootballAuditPrompt)
- **Re-authored `server-jarvis/src/prizepicks.ts`** — was truncated at line 23; now complete with PRIZEPICKS_SYSTEM_PROMPT + 5 exported functions (buildPrizePicksContext, buildFullDatabaseContext, normalizeStatType, findPlayerName, generateWeeklyPicks)
- **Created `server-jarvis/src/bun-compat.d.ts`** — global type shims for Response.json<T>() and ReadableStreamReadResult<T>
- **Fixed 22 TypeScript errors** in production code:
  - `agent-lifecycle.ts`: `agents_root` typo → `agents_root: agentsRoot`
  - `agent-schema.ts`: `string | string[]` push → spread correctly
  - `bridge.ts`: `socket.on/off` → `@ts-expect-error` (Bun Socket compat)
  - `claude-cli.ts`: Added `result?: string` and `content?: string | Array<...>` to ClaudeCliMessage
  - `config.ts`: Added missing `health_check_interval_ms: 30000` to defaultConfig()
  - `index.ts`: Fixed 6 reasoning event `else` branches → `else if (re.type === "content")`; fixed `compactProfile` scope (hoisted before try block); fixed bare `return;` → `return { content: "", tool_calls: undefined }`
  - `mcp-tools.ts`: 3 fixes (as McpServers cast, servers: {} in error return, server.command!)
  - `orchestration/pipeline.ts`: Added `PipelineMessage` type alias; annotated message arrays
  - `tools.ts`: Extended `ToolParameter.items` to include `properties` and `required`

---

## ⏭️ NEXT STEPS

### 1. Run bun tests (now that typecheck is green)
```bash
cd server-jarvis && bun test
```
Expect some failures in tests that mock the server or require real Ollama. Fix any
structural test failures (wrong imports, missing stubs) but leave integration failures.

### 2. Make `tauri dev` launch (the "app on screen" goal)
`tauri.conf.json` `beforeDevCommand` is `wsl bash .../scripts/dev-ui.sh` — **dead**
(the Ubuntu WSL distro is gone; only `docker-desktop` remains). Replace with a native
command: `beforeDevCommand: "bun --cwd src-ui run dev"` and confirm `devUrl`/`frontendDist`.
Then `cargo tauri dev` from the repo root. The window renders the React UI even if the Bun
server / backend commands aren't all wired yet.

### 3. Investigate Tauri config for native Windows build
`src-tauri/tauri.conf.json` likely still references WSL paths. Update for native Windows:
- `beforeDevCommand`: `bun --cwd ../src-ui run dev`
- `devUrl`: `http://localhost:5173` (Vite default)
- `beforeBuildCommand`: `bun --cwd ../src-ui run build`

### 4. Run server in real-use mode
```bash
cd server-jarvis && bun run dev
```
Verify it starts on port 19877, check `/health`, `/models`, `/config` endpoints.

### 5. Forward improvements (architecture priority from AGENTS.md)
- Build provenance / stale-binary prevention
- Eval / regression harness
- Bridge and runtime reliability
- The still-stubbed commands in `recovery_stubs.rs` — wire to real implementations

---

## Key locations
- Recovered merged tree: `C:\Projects\_recovery\from-transcripts-all\` (216 files — pull from here first when a file is truncated).
- Other snapshots (older/partial): `C:\Projects\_recovery\{claude-recovered-v4, grok-recovered-v*, merged-home-base}\`.
- Transcripts: see "Recovery sources" above.
- Extractors: `scripts/recover_all.py`, `scripts/scan_antigravity.py`.

## How to re-verify
```bash
cargo check --manifest-path src-tauri/Cargo.toml      # Rust ✅ GREEN
cd src-ui && bunx tsc -b                               # UI ✅ GREEN  
cd server-jarvis && bunx tsc --noEmit                  # Server ✅ GREEN
python -m py_compile scripts/claude_cli_proxy.py       # Python ✅ GREEN
cd server-jarvis && bun test                           # Tests (not yet verified)
```
