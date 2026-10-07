Implement roadmap Priority #2 Part 2, **Goal-linked execution and recovery**, in this repository. The full source-scope plan is `docs/superpowers/plans/2026-10-05-roadmap-priority-2-part-2-execution-recovery.md`; treat it as authoritative. Part 1 is committed at `7bf50fa` and current HEAD is docs commit `8d59e17`.

Architecture already inspected:
- Goal authority is native SQLite/Tauri in `src-tauri/src/commands/goals.rs`; Part 1 added nullable `goal_id` to native `session_runs`.
- Native Tauri `jarvis_send_message` prepares and registers an authenticated one-shot TurnMemory envelope; Bun resolves/consumes it in `server-jarvis/src/index.ts` around the 1531–1633 region, then calls `sessionMemory.beginTaskRun` around 1750. Existing public `/chat/stream` fields are untrusted and MUST NOT provide Goal authority.
- `TaskRun` persists in the Bun per-session runtime JSON through `server-jarvis/src/orchestration/session-memory.ts`.
- Native terminal run persistence is in `src-tauri/src/commands/sessions.rs`; SSE relay accumulation/persistence is in `src-tauri/src/jarvis/runner.rs`. Current terminal insert/list DTO drops the new nullable `session_runs.goal_id`.
- The Part 2 plan governs target scope. Do not expand into Part 3 commitments/cron scheduling or Part 4 trusted action dispatch/acceptance delivery.

Implement the plan's contracts end to end within this slice: securely bind Goal identity only through a native-authenticated association that validates the current canonical Goal/session/Agent/project binding; carry Goal linkage into persisted TaskRun and native `session_runs`; add durable structured checkpoint/interruption/resume semantics with stable run/effect identity and no blind replay of ambiguous side effects; preserve distinct actionable blocked/waiting/paused/failed/cancelled/completed status and existing permission/resource/cancellation boundaries; expose enough Goal-linked progress and native run correlation for later parts to extend. Preserve existing Goal-less TaskRun/chat behavior and compatibility with legacy persisted records. Never persist recalled memory text, full transcripts, or client-provided Goal identity as authority.

Important safety constraints: a status field or TaskRun completion alone MUST NOT mark a Goal completed; only Part 4 trusted acceptance can do that. Do not claim restart acceptance is proven without running it. An effect with ambiguous prior outcome must surface blocked/needs-review state and retain its original exact identity rather than silently duplicate it.

Luna/root source review found/affirmed Part 1 binding requirements already implemented: `goal_link_add` must validate authoritative target existence/scope and canonical Agent/project identity; Goal detail reads must use a generation guard. Do not revert those safeguards.

Workflow constraints:
- You are the sole production-source executor, running as exact OpenCode CLI model `opencode-go/deepseek-v4.1-flash`.
- Do not add/run tests, fixtures, test declarations, provider scripts, live inference/runtime/restart demonstrations, installers, or acceptance checks. Allowed: inspect source, compile/type/build, `git diff --check` only.
- Do not edit unrelated dirty baseline or broaden package manifests/dependencies/permissions/credentials/settings. Do not commit.
- Make bounded source edits. When finished, report concise files changed, architecture/invariant decisions, commands/checks actually run (should be none beyond allowed compile/type/build/diff), unresolved source gaps, and exact `git diff --stat`/status. Do not claim runtime/test evidence.
