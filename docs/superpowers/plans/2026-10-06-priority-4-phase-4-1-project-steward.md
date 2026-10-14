# Priority 4.1 — Project Steward Implementation Plan

> **For agentic workers:** Implement this plan sequentially through the assigned OpenCode `opencode-go/deepseek-v4.1-flash` executor. Luna reviews each bounded source slice before the next. Do not execute a real project task as part of source implementation.

**Goal:** Let a user start a project-scoped Goal from a persisted Session, explicitly send its task through the existing Jarvis chat path, and inspect the exact run plus a read-only, source-revision-bound workspace diff.

**Architecture:** Reuse native SQLite Session, Agent, workspace, Goal, and run authorities; the UI may select their IDs but never supplies authority. A task handoff pre-fills the existing chat composer and selects its Goal/Session, while the user explicitly presses Send. After a terminal run, native readback validates the exact Session/Goal/run tuple before it returns Git revision and diff evidence; completion and acceptance remain governed by the existing trusted acceptance path.

**Tech Stack:** Tauri/Rust commands and SQLite, existing `jarvis_list_sessions`, `memory_bind_session_workspace`, Goal/run commands, React/Tauri UI, and fixed-argument read-only Git subprocess calls.

**Spec:** `docs/superpowers/plans/2026-10-05-roadmap-priority-4-workflows.md` §“Phase 4.1 — Project Steward local workflow”; `docs/CURRENT_ROADMAP.md` §4.

## Global Constraints

- The native persisted Session supplies the Agent ID and canonical project root; a UI selection is only a selector.
- A Goal is created with the exact user-authored task and acceptance criteria, and native `goal_create` validates the Agent and canonical workspace.
- A chat handoff only selects the matching Session and Goal and places the user-authored task in the composer. It never sends automatically.
- The existing native `jarvis_send_message`/Goal run binding revalidates Goal, Session, saved user message, Agent, and workspace before the run is linked.
- All file-changing work stays inside the exact selected Session workspace and uses the existing Jarvis ToolRuntime and current Permission/approval policy. Do not add a permission grant or a parallel executor.
- Do not auto-commit, merge, publish, or deploy. The workspace snapshot command is read-only and invokes Git with fixed argument arrays, never a shell string.
- A run, tool success, model text, or successful request is not Goal acceptance. Show completion only after the existing trusted native acceptance evidence and readback contract succeeds.
- Failures and unreadable data are `blocked`, `partial`, `stale`, or `unavailable`, never an authoritative empty list or successful result.
- No tests, installations, runtime calls, model calls, campaign work, or real-project edits are part of this source phase. Use only the five permitted exact-SHA source checks listed below.

## Review Focus

- Session or Goal identity changes while requests are in flight: drop stale responses and keep the handoff bound to its captured IDs.
- Missing project binding or disabled/invalid Agent projection: block task creation/dispatch with the exact recovery action; never default to Jarvis or an unrelated root.
- Goal/Session Agent or root mismatch at send time: preserve the draft and report the native rejection; never retry as a Goal-less turn.
- Git unavailable, non-repository root, changed workspace binding, timeout, oversized diff, binary file, or untracked file that cannot be represented: show partial/unavailable with the affected paths; never call the snapshot complete.
- Failed, interrupted, cancelled, or ambiguous runs: show their durable run status and any safely bound diff as pending review; never infer delivery or acceptance.

## Bounded Source Map

- `src-tauri/src/commands/sessions.rs` — canonical `SessionSummary`, including `agent_id` and optional persisted `project_root`; existing terminal `SessionRunRecord` persistence/readback.
- `src-tauri/src/jarvis/memory/scope.rs` and `src-tauri/src/commands/memory.rs` — `normalize_project_root` and `memory_bind_session_workspace`; the native path normalizer validates and canonicalizes a user-selected workspace.
- `src-tauri/src/commands/agents.rs` — persisted enabled Agent and projection readback. Existing enabled/active projection rules remain authoritative for dispatch.
- `src-tauri/src/commands/goals.rs` — `goal_create(objective, criteria, agent_id, project_root)`, `goal_get`, and `goal_run_progress`; `resolve_goal_run_binding` already rejects cross-Agent, cross-root, missing-source, and terminal-Goal bindings.
- `src-tauri/src/commands/jarvis_commands.rs` — `jarvis_list_sessions` and native chat dispatch/Goal-binding preparation.
- `src-tauri/src/commands/mod.rs` and `src-tauri/src/lib.rs` — command module and Tauri command registration for the new read-only workspace snapshot.
- `src-ui/src/components/jarvis/GoalsView.tsx` — existing user-owned Goal, criteria, and run-progress surface; reuse for authoritative Goal/run status rather than copying lifecycle state.
- `src-ui/src/components/jarvis/JarvisView.tsx` — existing Session selection, Agent/workspace controls, Goal selector, chat draft, explicit Send, and native turn readback.
- `src-ui/src/components/jarvis/types.ts` — typed one-shot Project Steward handoff carrying only Session ID, Goal ID, and user-authored task text.
- `src-ui/src/types.ts` — top-level `ViewId` union used by App navigation.
- `src-ui/src/App.tsx` and new `src-ui/src/components/jarvis/ProjectStewardView.tsx` — route and compose the task setup, handoff, and review flow.
- `server-jarvis/src/git-metadata-bundle.ts` — existing `git_metadata` reports only HEAD/branch/dirty metadata. It does not provide a user-visible complete diff, so the planned bounded diff readback belongs to the native command and must not replace ToolRuntime permission enforcement for writes.

## Task 1: Add exact, read-only workspace review snapshot

**Files:**

- Create `src-tauri/src/commands/project_steward.rs`.
- Modify `src-tauri/src/commands/mod.rs` and `src-tauri/src/lib.rs` only to declare and register the command.
- Reuse, without changing, the Session, Goal, Agent/projection, and workspace helpers named in the source map.

**Interface:**

- Tauri command `project_steward_workspace_snapshot(session_id: String, goal_id: String, run_id: String) -> Result<ProjectStewardWorkspaceSnapshot, String>`.
- `ProjectStewardWorkspaceSnapshot` returns the exact `session_id`, `goal_id`, `run_id`, persisted `agent_id`, canonical `project_root`, persisted run outcome/time, Git HEAD and branch, changed paths, `changed_paths_exhaustive`, diff text, diff SHA-256, capture time, and a typed `complete | partial | stale | unavailable` state with bounded reason/path details.
- IDs are selectors only. The command derives all scope from SQLite and rejects a missing or ambiguous binding.

- [x] Load the exact Session and Goal rows. Require identical persisted Agent ID and canonical project root, a non-archived Session, and an existing terminal `session_runs` row whose `session_id`, `goal_id`, and `run_id` equal the request and whose `finished_at` is a valid RFC3339 timestamp. Confirm exactly one native Goal-run binding was consumed by that same run, and require its persisted `agent_id`, canonical `project_root`, nonempty `task_run_id`, and nonempty `bun_instance_id` to agree with the Session/Goal authority. Include the validated binding identity in the final reread comparison. Return an error/readback-unavailable result on missing, duplicate, unreadable, or conflicting rows.
- [x] Re-canonicalize the persisted root with `normalize_project_root` and require it still equals both rows. Require Git's fixed-argument `rev-parse --show-toplevel` to resolve to that exact root; no caller path or model-provided path is passed to Git.
- [x] Use `std::process::Command` with executable `git`, fixed argument arrays, a bounded timeout enforced by polling and killing the child, no shell, no external diff driver, and no write flags. Pass the fixed `-c core.fsmonitor=false` override on every Git invocation so `git status` cannot invoke an external FSMonitor hook. Capture HEAD, branch, status, and staged/unstaged tracked diffs. For untracked entries, list exact NUL-terminated paths only; never read their contents. Any snapshot with an untracked path is `partial`, with its known paths listed and content omission explained. Label the result as the workspace snapshot at capture time; it may include pre-existing edits and is not causal proof that the selected run created every change.
- [x] Use fixed limits of 10 seconds for the entire capture and 512 KiB of diff output. Repeat the same bounded Git read set under the same deadline and compare the exact HEAD, branch, status, untracked-list, staged-diff, and unstaged-diff observations. Any reread error or changed observation returns `stale` with all workspace diff/path evidence cleared. Invalid UTF-8 in tracked diff output is shown with replacement characters only in `partial` state. Parse raw `-z` path bytes injectively (percent-escape `%` and non-unreserved bytes); invalid-UTF-8 path names use this escaped representation and make the snapshot `partial`. Accept only NUL-terminated path fields and drop/report an incomplete trailing fragment. Return `partial` for binary/unsupported changes, output limits, or path caps; `changed_paths_exhaustive` is false whenever status/list truncation, an incomplete path fragment, or the path cap means coverage is unknown. Git errors, timeout, unavailable workspace, or non-repository roots return `unavailable`; a clean repository is a valid `complete` result with an empty diff.
- [x] Hash the exact returned diff bytes with SHA-256. Re-read the Session/Goal/run/binding identity immediately before success; if the scope changed, return `stale` and discard the diff and changed paths.
- [x] Keep the command read-only. It must not stage files, write files, run project checks, create commits, or mutate Goal state.

**Task 1 review checkpoint:** Luna's read-only review is complete. Task 1 source checks are recorded under **Final source review and checks** below; source checks do not establish real-task acceptance.

## Task 2: Add the explicit Project Steward task flow and chat handoff

**Files:**

- Create `src-ui/src/components/jarvis/ProjectStewardView.tsx`.
- Modify `src-ui/src/App.tsx` to add the Project Steward route and one-shot handoff state.
- Modify `src-ui/src/types.ts` to add the route ID to `ViewId`.
- Modify `src-ui/src/components/jarvis/types.ts` for the typed selector-only handoff.
- Modify `src-ui/src/components/jarvis/JarvisView.tsx` to consume and clear the handoff.
- Modify `src-tauri/src/commands/jarvis_commands.rs` so an explicitly selected Goal cannot fall back to a Goal-less turn if exact native-to-Bun binding registration is unavailable.

**Interfaces:**

- `ProjectStewardHandoff = { session_id: string; goal_id: string; task_draft: string }`; it contains no workspace path, Agent identity, tool call, permission, or completion authority.
- The setup view uses `jarvis_list_sessions`, `list_agents`, `list_agent_projections`, and existing `goal_create`; the native Goal response is decoded and compared to the exact submitted objective, criteria, Agent, and project root before enabling handoff.

- [x] Load Sessions, enabled Agent rows, and Agent projections with explicit loading/error states. Allow a user to select only an existing, non-archived Session whose native readback has a nonempty canonical root and an enabled Agent. For custom Agents, require the existing valid/active/non-stale projection; preserve only the existing built-in Jarvis no-row exception. Show the Session ID, Agent, and canonical root from the returned rows. Do not turn a failed read into an empty selection.
- [x] If no eligible bound Session exists, show the recovery path through the existing Chat Agent/workspace controls and native `memory_bind_session_workspace`; do not allow a raw path string in this view to become authority.
- [x] Collect the user's concrete task/objective and at least one user-authored acceptance criterion. Create a Goal with `goal_create` and exact selected Session `agent_id`/`project_root`. Preserve the draft on rejection or ambiguous response; reload `goal_get` and require exact identity/content readback before showing the Goal as created.
- [x] Offer an explicit “Open in Chat” action only after exact Goal readback. App carries the three-field handoff to `JarvisView`; a new selection or route generation invalidates old responses.
- [x] In `JarvisView`, re-read the selected Session and Goal before consuming the handoff. Require Session ID, Agent, and project root to match the Goal. Select that Session and Goal and prefill the exact user task; do not call the send function. Show the ordinary composer and require the user to press Send.
- [x] In `jarvis_commands.rs`, if the request contains a nonempty selected `goal_id`, return a visible error before Bun dispatch when `register_goal_run_binding` does not return both `registered == true` and a nonempty native binding ID. Preserve ordinary Goal-less chat only when the user selected no Goal. Do not downgrade a Project Steward request to an unlinked turn.
- [x] If the native Goal-run binding rejects because the Goal, Session, workspace, Agent, or source message changed, retain the user's draft, show the native blocked reason, and do not resend goal-less. The existing `jarvis_send_message`/`resolve_goal_run_binding` gate remains authoritative and current ToolRuntime Permission/approval behavior is unchanged.

## Task 3: Show durable run state and the exact reviewable diff

**Files:**

- Modify `src-ui/src/App.tsx` to retain only the exact Project Steward Session/Goal selector across the route change to Chat and back.
- Modify `src-ui/src/components/jarvis/ProjectStewardView.tsx` to re-read and validate that selector before restoring the Goal/run review.
- Reuse native `goal_get`, `goal_run_progress`, and `project_steward_workspace_snapshot` readbacks.

**Interface:**

- App-level review selection is exactly `{ session_id: string; goal_id: string }`. It carries no task text, Agent, root, criteria, outcome, diff, or evidence. The existing one-shot `ProjectStewardHandoff` remains the separate Chat prefill; do not retain its `task_draft` in the review selector.
- On return to Project Steward, `ProjectStewardView` re-reads `goal_get(goal_id)` and canonical `list_sessions`, then requires exact Goal and Session IDs, a non-archived Session, and matching persisted Agent ID and canonical project root before reconstructing the Goal review. All displayed Goal/criteria/run fields come from fresh native readbacks, never cached selector fields.

- [x] Show the selected Goal's criteria and native run rows (`session_id`, `run_id`, outcome, `finished_at`, resumable/interrupted flags, evidence references). Require explicit run selection; do not automatically choose a latest/first row as the proof context.
- [x] Preserve only the exact `{session_id, goal_id}` review selector in App memory across Open in Chat navigation. When Project Steward remounts, re-read native Goal and canonical Session authority before restoring review. Require exact ID, non-archived state, matching Agent, and matching canonical project root; missing, malformed, or conflicting readback is explicitly unavailable and does not restore the review. Do not persist task contents or treat cached Goal/Session fields as authority.
- [x] Disable snapshot review until the user explicitly selects a concrete terminal run with a nonempty, valid RFC3339 `finished_at`. Validate calendar and component ranges strictly so impossible dates (for example February 30) are rejected consistently with native parsing; a permissive `Date.parse` normalization alone is insufficient. Require matching `session_id` and selected Goal identity. Request the snapshot with that exact Session/Goal/run tuple; strictly decode every identity/status field and require snapshot `run_finished_at` to equal the selected persisted row's `finished_at` string exactly. Drop results when the selected Goal/run changes or any identity/timestamp differs.
- [x] Render HEAD/branch, capture time, changed paths, exact diff, and diff hash. Before labeling or rendering `diff_sha256` as SHA-256, require exactly 64 hexadecimal characters. Keep clean, partial, stale, and unavailable states distinct. Label it as the workspace snapshot at capture time (which may include pre-existing edits), not as proof that the selected run caused every change. A failed or interrupted run may still show a complete read-only diff, labeled “changes pending review”; it is never displayed as delivered or accepted.
- [x] Show check evidence only when it comes from the exact persisted terminal run/ToolRuntime result. If this source chain does not persist a check result, show “check evidence unavailable”; do not add a test runner or claim checks passed. The five source checks below validate Jarvis source only and are not task-level acceptance evidence.
- [x] Provide read-only Refresh/Reconcile. Do not add commit, merge, publish, deploy, direct write, generic shell, or model-triggered acceptance controls. Goal completion remains available only through the existing trusted native acceptance receipt and exact readback path.

## Failure, Permission, and Recovery Contract

- Session, Goal, Agent projection, run history, or snapshot read failure is explicitly unavailable; it never becomes “no project,” “no changes,” or “no runs.” Retry is read-only until the authority is readable.
- Missing/invalid workspace, disabled Agent, stale Agent projection, changed Session binding, Goal/Session scope mismatch, or native registration denial is blocked before dispatch. The UI points to the existing Agent activation or Session workspace-binding control and preserves user text.
- Current ToolRuntime Permission and approval policy controls every file-changing operation. Waiting/approval-required outcomes remain waiting; denial, cancellation, timeout, and partial results remain distinct. This phase adds no permissions or fallback executor.
- Ambiguous send/run outcomes are reconciled from exact native `goal_run_progress`/Session readback. The UI does not start a second operation or assert success from a submitted request, tool return, or assistant text.
- Scope mismatch or snapshot failure after a run blocks diff display. Truncated, binary, or unsupported changes remain partial and cannot be labeled fully reviewed. No run result transitions a Goal to accepted/completed; trusted acceptance remains a separate explicit native operation.

**Task 3 Luna review checkpoint:** Complete and clean. Luna reviewed selector-only App state, fresh Goal/Session revalidation on return, strict RFC3339 calendar/component validation, exact finish-time equality, run/snapshot tuple binding, strict 64-hex `diff_sha256` validation, changed-path coverage, status distinction, evidence provenance, and the absence of acceptance or completion claims.

## Exact-Source Review and Permitted Checks

- Luna reviews the native tuple validation, no-write Git invocation, diff completeness/truncation semantics, one-shot handoff, explicit Send boundary, current Permission preservation, and exact run/readback binding before acceptance.
- Run only these five source checks against the final exact source SHA: `(cd src-tauri && /Users/charlottehughes/.cargo/bin/cargo check)`; `(cd server-jarvis && bun run typecheck)`; `(cd server-jarvis && bun run build)`; `(cd src-ui && bun run build)`; and `git diff --check`. Record each command, exit code, and source SHA. Do not run tests, fixtures, UI runtime, app runtime, model calls, or project commands.
- Source checks establish source buildability only. No real project task has been supplied for this plan, so real-task acceptance remains **OPEN** and must not be claimed from source checks or synthetic artifacts.

## Final source review and checks

- Final Luna source review: **clean** after the Task 1, Task 2, and Task 3 corrections.
- Exact source fingerprint: SHA-256 `9c1d5f7dcc32a7023b7086cab6ed4eb3490176ddd00443f649c989df6159e561`, computed over the nine changed source files in sorted-path order as `path + NUL + file bytes + NUL`.
- Fingerprinted source files: `src-tauri/src/commands/project_steward.rs`; `src-tauri/src/commands/mod.rs`; `src-tauri/src/lib.rs`; `src-tauri/src/commands/jarvis_commands.rs`; `src-ui/src/App.tsx`; `src-ui/src/components/jarvis/JarvisView.tsx`; `src-ui/src/components/jarvis/types.ts`; `src-ui/src/types.ts`; `src-ui/src/components/jarvis/ProjectStewardView.tsx`.
- `(cd src-tauri && /Users/charlottehughes/.cargo/bin/cargo check)` — **PASS**, exit 0; six warnings are in existing files.
- `(cd server-jarvis && bun run typecheck)` — **PASS**, exit 0.
- `(cd server-jarvis && bun run build)` — **PASS**, exit 0.
- `(cd src-ui && bun run build)` — **PASS**, exit 0; Vite reported its chunk-size warning.
- `git diff --check` — **ran, exit 2; not fully green**. Its only reported issue was unrelated pre-existing dirty `docs/implementation/roadmap-priority-3-status.md:3` trailing whitespace (`**As of:** 2026-10-06  `). That unrelated file was not modified for this checkpoint.
- The four Cargo/Bun source build/type checks passed. The diff check result is recorded separately and is not represented as passing. These checks are not real-task evidence; real-task acceptance remains **OPEN**.
