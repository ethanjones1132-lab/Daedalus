# Priority 4.3 — Recurring Operator Implementation Plan

> **For agentic workers:** Implement the bounded source tasks sequentially through the assigned OpenCode `opencode-go/deepseek-v4.1-flash` executor. Luna reviews each task before the next. This plan covers local source and UI workflow only; it does not authorize a live recurring task, an external action, or real-task acceptance.

**Goal:** Let a user explicitly associate an existing supported Cron action with a Goal (and its related commitment), inspect exact durable activation/run evidence, and navigate an in-app Goal notification to the corresponding freshly-read record. Pause, run, and cancellation controls remain native-authoritative and never imply Goal acceptance.

**Architecture:** Native SQLite Goal/Cron/Commitment rows, activation claims, run records, cancellation, and notification dedupe remain authoritative. The UI uses the existing validated `goal_link_add`/`goal_link_remove`, `add_cron_job`, `list_cron_jobs`, `get_cron_runs`, `get_cron_activations`, and Goal/Commitment readers. Explicit IDs are selectors only. Every write is followed by exact native readback. Existing Cron scheduler and ToolRuntime permissions govern execution; this phase adds no executor, Permission, external integration, or completion authority.

**Tech Stack:** Rust/Tauri commands and SQLite; existing Bun ToolRuntime and Cron scheduler; React/Tauri `GoalsView`, `CronView`, and App in-app toast routing.

**Spec:** `docs/superpowers/plans/2026-10-05-roadmap-priority-4-workflows.md` §“Phase 4.3 — Recurring Operator”; `docs/CURRENT_ROADMAP.md` §4; existing Goal/Cron contracts in `src-tauri/src/commands/goals.rs`, `src-tauri/src/commands/cron.rs`, `src-tauri/src/cron_scheduler.rs`, and `src-tauri/src/notifications.rs`.

## Sequence and Evidence Boundary

- Priority #4 source work is authorized after Priority #3 source/evaluation work even if the empirical Priority #3 gate fails. This sequence ruling does not complete Priority #3 or alter its open acceptance state.
- Phase 4.2 source is reviewed and frozen. Priority #2 runtime acceptance and Priority #3 empirical campaign/acceptance remain open; this phase must not claim either.
- No concrete recurring user task or commitment was provided. A real recurring-operator success remains open until the user selects and authorizes a specific Goal/commitment and supported action, then observes the scheduled operation and any required recovery interval.
- Source/UI implementation and source checks are not a live schedule, a successful activation, a recovery observation, or user acceptance.

## Global Invariants

- Native persisted Goal, Cron job, Commitment, Session, Agent, workspace, activation, run, and notification rows remain the only authority. Text, labels, model output, toast payload, or caller-supplied IDs cannot establish a binding or outcome.
- A schedule association is explicit and validated by native Goal/Cron/Commitment commands. Re-read the owning Goal and target row after mutation; only show the association after exact native rows agree. An unavailable read is not an empty list or an unlinked state.
- The selected scheduled action is the existing saved Cron job action/prompt. Do not derive a tool call, command, arguments, Permission, or authorization from Goal/commitment text or from the UI. At each scheduled execution, the existing ToolRuntime policy remains authoritative: allow executes through the existing runtime; ask/wait remains waiting; deny remains blocked. Do not add permissions, grants, approval bypasses, direct command execution, or alternate dispatch paths.
- The native scheduler remains responsible for deterministic occurrence identity, durable claim/dedupe, cancellation, ambiguous recovery, terminal settlement, and notification persistence. UI retries of reads are reconciliation only. Never replay an ambiguous activation. A new “Run now” is a new explicit user action and is unavailable while the prior operation remains unresolved.
- “Run accepted” or tool success is not Goal acceptance. Display schedule enabled/paused state, activation claim state, run state, and trusted execution-evidence fields as separate facts. Goal completion continues to require the existing trusted Goal acceptance path and its exact receipt/readback.
- Progress/terminal notices stay in-app and are surfaced only from the existing persisted/deduped native notification event. No email, chat, calendar, browser, cloud, or other external notice or write is in scope.
- Preserve `loading`, `empty`, `unavailable`, `stale`, `waiting`, `blocked`, `cancelled`, `ambiguous`, `failed`, and confirmed states distinctly. No failed native read may be rendered as a successful empty state.
- No source task may auto-commit, merge, publish, deploy, create a live schedule, run an app, call a model, execute a real recurring task, or send an external message. No tests are added or run for this source phase.

## Bounded Source Map

- `src-ui/src/components/jarvis/GoalsView.tsx` owns Goal details, linked Commitments/Cron jobs, current schedule controls, and activation/run history. It already calls native Goal/Cron/Commitment readers and uses operation readback before clearing a pending schedule mutation.
- `src-ui/src/components/jarvis/CronView.tsx` owns the existing explicit Cron-job creation form and run history. Its current create request omits `goal_id`, although the native `add_cron_job` command accepts it. Its run-history model already includes native `execution_evidence` fields.
- `src-ui/src/App.tsx` receives the `goal://notifications` event and currently offers only “Open Goals”; it does not carry the event’s Goal/activation/job/run selector into the Goal view.
- `src-tauri/src/commands/cron.rs` owns validated `add_cron_job`, `edit_cron_job`, `get_cron_runs`, `get_cron_activations`, enable/disable/cancel, and manual run commands. `CronRun` includes `execution_evidence`, activation ID, occurrence, Goal ID, and terminal reason. `CronActivation` includes Goal/Cron/Agent/Session/root, occurrence, state, run IDs, reason, and lifecycle timestamps.
- `src-tauri/src/commands/goals.rs` owns `goal_link_add`/`goal_link_remove`, `goal_links_list`, compatibility validation, and Goal lifecycle. Cron association updates `cron_jobs.goal_id` and `goal_links` transactionally; Commitment association routes through Commitment authority. Existing validators reject incompatible Agent/workspace/Session bindings.
- `src-tauri/src/commands/system.rs` owns Commitment add/update/Goal binding and rejects incompatible workspace associations. `src-tauri/src/notifications.rs` owns persisted preference, dedupe, and in-app event emission after state persistence/readback. `src-ui/src/components/jarvis/SettingsView.tsx` already has the in-app Goal-notification preference.
- `src-tauri/src/cron_scheduler.rs` owns activation claims, ToolRuntime dispatch, cancellation/ambiguous recovery, terminal settlement, and post-readback notification requests. No source changes are planned there unless Luna review identifies a specific missing durable contract and approves a separately bounded correction.

## Task 1: Make Goal-linked schedule setup explicit and readback-confirmed

**Allowed files:**

- Modify `src-ui/src/components/jarvis/CronView.tsx` to optionally select an existing Goal when creating a Cron job.
- Modify `src-ui/src/components/jarvis/GoalsView.tsx` to link or unlink existing compatible Cron jobs and Commitments from the selected Goal.
- Do not change native command semantics. Reuse `add_cron_job`, `goal_link_add`, `goal_link_remove`, `goal_get`, `goal_links_list`, `list_cron_jobs`, and `get_commitments`.

**Implementation contract:**

- Cron creation exposes a Goal selector only from a successful native Goal-list read. A genuinely empty list is distinct from a read failure. Selection remains a selector and is passed to the existing native `add_cron_job` as `goal_id`; selected Agent and Goal binding are validated by native code. No typed/raw Goal text creates authority.
- After `add_cron_job`, refresh `list_cron_jobs` and require exactly one row matching the returned Cron ID plus the submitted name/schedule/Agent and selected `goal_id`. If the command response or readback is ambiguous, retain a visible unresolved state and do not retry creation automatically.
- In Goal details, offer explicit association of an existing Cron job or Commitment. Candidate lists come from the owning native authorities and are tagged to the current Goal/request generation. The user selects one exact candidate and confirms Link/Unlink; no automatic association is inferred from matching text or Agent names.
- Link only through `goal_link_add`; unlink only through `goal_link_remove`. After the command, re-read the exact Goal, `goal_links_list`, `list_cron_jobs`, or `get_commitments` rows. Confirm only when both Goal-side link and authoritative target-side `goal_id` agree; unlink confirmation requires the link absent and target unbound. Preserve a failed/ambiguous state when one side is unavailable or disagrees.
- A project-scoped Goal may link only a Cron job whose persisted Agent, Session, and workspace pass the current native compatibility validator. The existing `add_cron_job` create interface has no Session selector, so do not create an enabled unbound job and then attach it in a second step for a project-scoped Goal. For that case, offer only a compatible existing session-bound job and show a concrete blocked/unavailable explanation if none exists. Do not add a new native API in this task.
- Commitments may be linked only where current native validation accepts the binding. If project/workspace compatibility is not supported by the existing Commitment schema, preserve the native rejection and explain that the Commitment cannot be bound under the current contract; do not weaken validation or silently fall back to an unscoped Goal.
- Linking or creating a schedule does not grant action permissions or immediately trigger it. The existing enable/pause state is read from the native Cron row. A schedule may execute only through the existing scheduler and current ToolRuntime policy.

**Acceptance criteria:**

- A user can explicitly create a Goal-associated Cron job where the current native validator supports the binding, and can link/unlink an existing compatible Cron job or Commitment from Goal detail.
- No UI success is shown until exact fresh native Goal/link/target rows agree. Failure, stale request, malformed collection, and read error are not shown as “unlinked” or successful.
- Incompatible Agent/Session/root, terminal Goal, unsupported project-bound creation, or Commitment scope is rejected with an actionable explanation and no fallback.
- No association or new schedule is created on mount/load. Every write follows an explicit user action; no user text becomes a tool call or Permission.
- **Luna checkpoint:** review candidate-generation invalidation, native API arguments, project/Session compatibility constraints, create-once ambiguity behavior, exact row readbacks, and no auto-trigger/permission changes before Task 2.

## Task 2: Expose exact durable activation and execution evidence in Goal detail

**Allowed files:**

- Modify `src-ui/src/components/jarvis/GoalsView.tsx` only.
- Reuse native `get_cron_activations`, `get_cron_runs`, `list_cron_jobs`, and current schedule mutation/readback commands. No backend change is allowed unless a concrete missing native field is confirmed and Luna approves a separate bounded correction.

**Implementation contract:**

- Strictly decode the native activation/run rows needed for display rather than casting arbitrary arrays. A malformed collection/row or a read failure is unavailable; a valid empty array is “none recorded.” Preserve the current stale/error distinction and disable mutation controls whenever native schedule state is unavailable/stale.
- Display each activation’s exact activation ID, Cron ID, Goal ID, Agent ID, optional Session/root, occurrence, trigger kind, claim state, run/bun-run IDs, terminal reason, and claim/dispatch/settle times. Display each run’s native run/Cron/Goal/activation/occurrence IDs, status, finish/start time, terminal reason, and optional `CronExecutionEvidence` identity/status/result/error fields.
- Join a run to an activation only when exact Cron ID, Goal ID, activation ID, and occurrence agree; where present, run IDs must agree too. If the records conflict or are missing, show separate/unavailable evidence and do not render a synthesized successful relationship.
- Keep schedule enabled state and next/last run timestamps from the current `CronJob` read separate from activation claim and run terminal state. Distinguish waiting, blocked, ambiguous, cancelled, failed, running, and successful run outcomes. Do not reduce a pending activation to “failed” because no `cron_runs` row exists yet.
- Show execution evidence as a bounded “runtime receipt/evidence” read from the authoritative run DTO, visibly scoped to that run. A receipt’s execution status is not Goal acceptance. Never label `acceptance_result` or successful tool execution as the Goal being accepted/completed; continue to use the separate existing trusted Goal acceptance readback for that state.
- Pause/resume/cancel/run-now remain explicit controls only when the exact native schedule is readable and compatible with this Goal. For a write response, require exact operation-specific readback before clearing its pending state. Ambiguous results retain the original operation context; Refresh is read-only reconciliation. Do not add blind replay. “Run now” is a new explicitly clicked occurrence and is disabled while a prior run/cancel remains unresolved.
- Keep progress/terminal state truthful to the native persisted read. “Next run,” “last run,” history, and receipt are unavailable if their own source read fails; do not substitute `never`, empty history, or success in that case.

**Acceptance criteria:**

- Goal detail lets the user inspect exact native activation, run, and available execution-evidence rows for each associated Cron job.
- Identity mismatch, malformed/missing receipt, or inaccessible activation/run history is visibly unavailable/ambiguous and is never represented as a successful linked run.
- No client response, submitted request, tool result, output text, or model text is treated as Goal completion or acceptance evidence.
- Existing cancellation/idempotency/ToolRuntime policy behavior is preserved; no additional permission, retry executor, or native state mutation is added.
- **Luna checkpoint:** review exact activation↔run tuple matching, evidence provenance, status distinctions, unavailable versus empty rendering, and operation/readback/retry behavior before Task 3.

## Task 3: Make durable in-app Goal notifications open the exact actionable record

**Allowed files:**

- Modify `src-ui/src/App.tsx` to retain only a notification selector when opening Goals.
- Modify `src-ui/src/components/jarvis/GoalsView.tsx` to consume that selector and restore details from fresh native reads.
- Modify `src-ui/src/components/jarvis/types.ts` only if a shared selector DTO is needed. Do not change native notification generation, scheduler state, or notification settings.

**Selector contract:**

- Carry only exact optional IDs from the event: `{ goal_id, activation_id?, cron_job_id?, run_id? }`. These values are navigation selectors, never authority, status, reason, or trusted evidence. Do not retain toast message/title or schedule prompt.
- Selecting “Open Goal” navigates to Goals and preserves the selector through the component mount. GoalsView must read `goal_get(goal_id)`, `goal_links_list`, `list_cron_jobs`, and the relevant activation/run histories from native before selecting/expanding the detail. Reconcile against persisted Goal↔Cron association and exact activation/Cron/Goal/run tuple.
- If only `goal_id` is present, open that Goal after exact `goal_get` readback; do not invent an activation or choose a “latest” one. If an activation/job/run selector is present, expand/focus only the exact matching native record. Missing, deleted, malformed, or conflicting identity shows a stale/unavailable state and leaves the user able to refresh or select the Goal manually.
- Event payload text is display-only. A “verified scheduled run” toast is not re-verification and must not set any Goal state. The fresh detail remains authoritative and must show run progress separately from Goal acceptance.
- Ensure route changes/read responses are generation-bound. A delayed event or old GoalsView response cannot replace a newer user selection. Keep the selector in App memory only until consumed/cleared; do not persist it as task content or durable authority.

**Acceptance criteria:**

- Clicking an in-app Goal notification opens the exact freshly-read Goal and, when exact IDs are supplied, its exact Cron activation/run history.
- Stale selectors never display a different/latest record or claim the toast proves completion. The user can navigate to the Goal and inspect its current native state.
- Notifications remain in the current in-app surface with existing persisted preference/dedupe. No external notifications or dispatches are added.
- **Luna checkpoint:** review selector-only App state, fresh Goal/link/activation/run readback, invalidation on route/selection changes, and no toast-derived status claims before final source freeze.

## Failure, Authorization, and Recovery Contract

- Goal, Cron job, Commitment, link, activation, run, in-flight, and notification reads preserve `loading`, true-empty, malformed, unavailable, and stale outcomes. No read error is a successful empty result.
- Native Goal binding rejection is respected. The UI does not retry without the Goal, swap Agent/Session, clear project scope, or alter native validation.
- Existing ToolRuntime Permission handling stays unchanged. Approval-required/ask remains waiting; deny remains blocked. No model-authored tool arguments, shell commands, or external destination can be introduced through schedule text or Goal text.
- A native write that errors or lacks exact readback remains unresolved; the UI retains its exact target/operation selector for read-only reconciliation and never blindly repeats a create/run/cancel. A new manual run is allowed only as a fresh user action after the previous operation is durably resolved.
- Scheduler cancellation and ambiguous activation recovery remain native-owned. The UI reports only the durable native states; it cannot cancel by hiding a row or deleting a Goal link.
- A successful Cron run, acceptance-result string, notification toast, source build, or synthetic activation is not Goal acceptance or real recurring-workflow evidence. The existing trusted acceptance manifest/receipt path remains the only Goal completion boundary.
- External notices and real task execution remain outside this plan. Do not run a schedule to demonstrate behavior. Record them as open acceptance requirements until the user authorizes a concrete task and observation interval.

## Exact-Source Review and Permitted Checks

- DeepSeek implements Tasks 1–3 sequentially. Luna reviews each exact source diff before proceeding. Review native API wire names/arguments, exact association/readback tuples, ambiguous operation behavior, ToolRuntime/Permission preservation, notification selector validation, and no completion claims.
- After all source tasks are reviewed and frozen, run only these five source checks at the same exact final source SHA: `(cd src-tauri && /Users/charlottehughes/.cargo/bin/cargo check)`; `(cd server-jarvis && bun run typecheck)`; `(cd server-jarvis && bun run build)`; `(cd src-ui && bun run build)`; and `git diff --check`. Record each command and unmasked exit code against the exact source SHA. No tests, UI/app runtime, model calls, live scheduler execution, external notices, or real-task acceptance are part of this plan.
- Source checks establish source buildability only. Priority 4.3 real-task acceptance remains **OPEN** until the user explicitly selects and authorizes a concrete Goal/commitment/action, observes a complete recurring interval and any required recovery path, and accepts the exact persisted readback.

## Plan Self-Review

- The current native layer already supplies validated Goal/Cron/Commitment links, deterministic activation identities, ToolRuntime dispatch, cancellation/ambiguous recovery, execution-evidence DTOs, and post-readback in-app notices. The plan keeps those authorities intact and targets the missing UI association, Goal-detail receipt projection, and exact notification navigation.
- New project-scoped Cron creation is intentionally excluded because the existing `add_cron_job` UI/API path does not bind a Session during create. A user may link an already Session-bound compatible job through the validated Goal link API; no unsafe create-then-link window is introduced.
- Commitment/Goal compatibility remains whatever native validation supports. The UI must show native refusal rather than inventing workspace authority or weakening it.
- External delivery, a live schedule, real task completion, and recovery observation are explicitly outside source implementation and remain open evidence requirements.
