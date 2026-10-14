# Priority 4.4 — Cross-Workflow Readiness and Evidence Handoff Implementation Plan

> **For agentic workers:** Implement the bounded source tasks sequentially through the assigned OpenCode `opencode-go/deepseek-v4.1-flash` executor. Luna reviews each task's exact diff before the next. This plan covers local UI and documentation only; it does not authorize a real user task, live research, scheduled execution, external integration, or acceptance.

**Goal:** Give users a consistent, selector-only way to move among Project Steward, Attributable Researcher, and Recurring Operator; show the actual readiness and recovery state of each workflow; and preserve source/check and real-task evidence without treating source work as accepted delivery.

**Architecture:** Reuse each workflow's existing native Goal, Session, run, research receipt, Cron activation, and output readbacks. App navigation may carry only exact identifiers as temporary selectors; the destination must re-read its owning authority and validate the tuple before restoring a selection. A shared readiness panel is presentational and receives state already decoded by the workflow view; it creates no parallel authority, performs no probes, and never claims a tool, Permission, source, credential, or runtime is ready without current evidence. Per-workflow evidence records live in repository documentation and distinguish source checks from real-task observations.

**Tech Stack:** Existing React/Tauri navigation and workflow views; existing native Rust/Tauri Goal, Session, research receipt, memory, Cron, run, and notification APIs; existing Bun ToolRuntime and current Permission policy; Markdown evidence/status records.

**Spec:** `docs/superpowers/plans/2026-10-05-roadmap-priority-4-workflows.md` §“Phase 4.4 — Cross-workflow readiness and evidence handoff”; `docs/CURRENT_ROADMAP.md` §4; `docs/superpowers/plans/2026-10-06-priority-4-phase-4-1-project-steward.md`; `docs/superpowers/plans/2026-10-06-priority-4-phase-4-2-attributable-researcher.md`; and `docs/superpowers/plans/2026-10-06-priority-4-phase-4-3-recurring-operator.md`.

## Sequence and Starting State

- Priority #4 source implementation was explicitly authorized to proceed after Priority #3 source/evaluation work even if its empirical gate fails. This sequencing does not complete Priority #3 or change the open acceptance state of Priorities #1–#3.
- P4.1–P4.3 source work is the basis for this plan. Reuse the existing views and native APIs; do not re-implement or weaken their binding, ToolRuntime, cancellation, evidence, or acceptance contracts.
- The latest P4.3 Task 3 checkpoint was source-reviewed clean. Its final check attempt held the same before/after worktree fingerprint `164660dda7eed52a436a14069f146dfca7d88e20661ce22753cde985f363cd52`: `cargo check`, server typecheck, server build, and UI build exited 0; `git diff --check` exited 2 solely for existing trailing whitespace in `docs/implementation/roadmap-priority-3-status.md:3` (`**As of:** 2026-10-06  `). The fingerprint is a worktree fingerprint, not a commit SHA. No tests or runtime evidence were produced. Preserve this exact distinction in the eventual P4 status/evidence record; do not repair or stage that unrelated P3 file as part of this plan.
- There is no user-selected real task for any of the three workflows. Their real-task acceptance remains **OPEN**. No live task, schedule, research request, external connector, or consequential action may be run as part of implementation.

## Global Invariants

- Persisted native rows remain the authority. Handoff IDs are selectors only; every destination performs fresh readback and exact identity/scope validation before selection or evidence display.
- Never carry task text, prompts, source excerpts, research synthesis, output contents, permission decisions, acceptance claims, backend credentials, or copied status in a cross-workflow selector.
- Do not infer that `session_run_id`, research `agent_run_id`/research receipt ID, Cron `run_id`, activation ID, or Goal ID are interchangeable. Preserve their exact namespaces and only hand off an identifier when its producing native DTO supplies it.
- A navigation action is never a dispatch. Do not auto-send chat, auto-run research, create a Goal, save memory, run a Cron action, or submit an external write after a route change.
- Keep current ToolRuntime Permission and approval policy unchanged. `ask`/approval-required stays waiting, `deny` stays blocked, and neither missing configuration nor a source/build check is permission to add a grant or alternate executor.
- Onboarding/recovery copy must follow observed state. A failed or malformed read is unavailable, not empty; a submitted request is not accepted; a successful tool/run is not accepted output; a completed Cron run is not Goal acceptance; a saved memory remains user-authored manual memory with cited research.
- Do not probe credentials, external connectors, APIs, or runtimes merely to populate readiness. Use only existing native readbacks and user-visible settings/status already available. If a required diagnostic has no authoritative existing source, say “not observed” and point to the existing setup surface without claiming a cause.
- Evidence records describe what was actually observed. Use explicit `NOT RUN`, `not available`, or `not applicable` values; never fill a missing backend/version/budget/output/readback/acceptance field from inference.
- Do not add source-writing, commit, merge, publish, deploy, email/chat/calendar, browser automation, MCP, or connector behavior. Such actions need their own concrete task and authorization.
- No tests, fixtures, test declarations, installs, runtime calls, model calls, live research, schedule executions, or external actions are part of this phase. After exact-source review, run only the five permitted checks in the final section.

## Review Focus

- A selector becomes stale between the source click and destination mount: destination must reject it and preserve manual navigation.
- A selected Session, Goal, run, receipt, activation, or Cron row changes after the first read: later responses must be dropped unless the exact tuple remains current.
- One workflow lacks an identifier required by another: do not guess a mapping or choose a latest/first row; open the destination without preselection or show the exact stale/unavailable state.
- A missing permission, workspace, source, credential, connector, or runtime is not currently observable: do not present an inferred “ready” or falsely diagnose the missing capability.
- Source checks or an in-app status card are mistaken for accepted real-work output: keep source evidence and user-task acceptance records visibly separate.

## Bounded Source Map

- `src-ui/src/App.tsx` owns the existing routes for `project-steward`, `learning`, and `goals`, the Project Steward App-memory review selector, and the in-app Goal-notification selector. Reuse route state; do not persist selectors.
- `src-ui/src/components/jarvis/types.ts` owns existing typed Project Steward and Goal notification selectors. Add only the narrow discriminated navigation selector contract needed by this phase.
- `src-ui/src/components/jarvis/ProjectStewardView.tsx` owns the persisted Session/Goal/run selection, workspace snapshot result, review state, and explicit Open-in-Chat handoff.
- `src-ui/src/components/jarvis/LearningView.tsx` owns persisted Session/Agent-run source choices, bounded request inputs, native research receipt/readback, evidence findings, user synthesis, and explicit memory save/readback.
- `src-ui/src/components/jarvis/GoalsView.tsx` owns Goal details, Goal-linked Cron/Commitment state, activation/run evidence, notification selector reconciliation, and the separate trusted Goal acceptance path.
- New `src-ui/src/components/jarvis/WorkflowReadinessPanel.tsx` is a presentation-only panel. It receives already-decoded per-workflow states and recovery destinations as props; it does not invoke native commands, inspect settings, or become a state authority.
- Create `docs/implementation/roadmap-priority-4-status.md` and three per-workflow evidence records under `docs/implementation/priority-4-evidence/`. Update `docs/CURRENT_ROADMAP.md` and `work/opencode-memory/priority4-coordination.md` only in the final documentation task.
- No native Rust or Bun source change is planned. If a missing native field or binding blocks exact handoff, stop for a separate Luna-reviewed scope amendment rather than adding an unreviewed authority path.

## Task 1: Add exact selector-only navigation between workflow entry points

**Allowed files:**

- Modify `src-ui/src/components/jarvis/types.ts` with a discriminated `WorkflowNavigationSelector` union. Keep only native identifiers: Project Steward `{ session_id, goal_id, session_run_id? }`; Researcher `{ session_id, agent_run_id }`; Recurring Operator `{ goal_id, cron_job_id?, activation_id?, cron_run_id? }`. Keep the run identifiers explicitly distinct. Optional IDs are omitted when the source view has no exact native value.
- Modify `src-ui/src/App.tsx` to hold at most one selector in memory, switch to the existing destination route, and clear only the selector instance consumed by that destination.
- Modify `ProjectStewardView.tsx`, `LearningView.tsx`, and `GoalsView.tsx` only to add explicit navigation affordances from currently displayed, successfully decoded native records and consume their target selector after fresh exact readback.
- Do not add a new route, native command, storage, status cache, or cross-workflow content field.

**Contract:**

- The source view may create a selector only from a record it currently displays from successful native readback. If it cannot supply the exact destination's required identifiers, offer navigation without preselection; never coerce or copy an ID across namespaces.
- On the destination, re-read the target workflow's owner rows using its existing commands. Match exact Session/Agent/root, Goal, Session run, research run/receipt, or Cron/activation/run identity as required by the destination. A selector is consumed only after fresh readback resolves or explicitly rejects it.
- Missing, malformed, stale, duplicate, or conflicting identity shows an unavailable/stale message and leaves the destination available for manual selection. Do not choose a latest or first candidate and do not dispatch the destination workflow.
- Every request captures a route/request generation and exact selector object. A route change, newer selector, or manual selection invalidates delayed responses. Same-ID reselection must still increment the generation.
- Handoffs carry no objective/task text, source content, research findings/synthesis, permission, outcome, status, accepted flag, or backend configuration.

**Luna checkpoint:** inspect each source of selector IDs, the exact destination reread function, namespace distinctions, one-shot consume/clear semantics, and same-ID generation invalidation. Reject any inferred binding or handoff that could auto-run a workflow.

## Task 2: Present one consistent readiness and recovery surface

**Allowed files:**

- Create `src-ui/src/components/jarvis/WorkflowReadinessPanel.tsx`.
- Modify `ProjectStewardView.tsx`, `LearningView.tsx`, and `GoalsView.tsx` to pass their existing decoded loading/readback/permission/run/receipt states and existing navigation callbacks into the panel.
- Modify `src-ui/src/components/jarvis/types.ts` only if the component's display-only props need a shared type. No App/native/API changes.

**Interface and behavior:**

- Define a closed presentation state such as `ready_for_explicit_action | needs_user_input | waiting | blocked | partial | stale | unavailable`. This is a display vocabulary, not a persisted lifecycle or permission decision. Unknown/missing input defaults to unavailable.
- Each view supplies a `workflow` kind, a short current state derived from its already-decoded authoritative reads, and one actionable next step pointing to an existing control/settings surface. The shared component performs no command, network, credential, or ToolRuntime check.
- Project Steward recovery covers no eligible persisted Session/workspace/Agent projection, blocked or waiting ToolRuntime outcome, unavailable run/snapshot, partial/untracked diff, and the separate trusted Goal acceptance boundary. It must not claim task delivery from the diff alone.
- Research recovery covers absent eligible Session/successful Agent run, source-choice/readback failure, partial/blocked/unavailable source coverage, current ToolRuntime `ask`/`deny`, and explicit manual-memory save/readback state. It must not expose credentials or imply web sources are globally available.
- Recurring Operator recovery covers no compatible Goal/Cron link, waiting/blocked/ambiguous/cancelled/failed activation, unavailable or stale history, and trusted Goal acceptance separately from run evidence. It must not create, run, pause, or cancel anything through the panel.
- Explain how to recover an absent workspace, Permission, source, credential, connector/runtime, or accepted output only when the workflow has an existing observable signal or a safe existing configuration surface. Otherwise state that the condition has not been observed and name the proper next user action; do not prescribe installing, enabling, or authorizing a connector by inference.
- Keep workflow-specific source details, statuses, and output labels intact. The panel is an index and recovery aid; it does not replace or collapse the underlying evidence view.

**Acceptance criteria:**

- All three workflows expose the same distinction between explicit action-ready, needs user action, waiting, blocked, partial, stale, and unavailable states without treating one as another.
- A malformed or failed authority read cannot appear as ready or empty. No new readiness probe or duplicate state source exists.
- Every recovery item points to an existing safe control or describes the exact missing observation; no new Permission or connector is granted.

**Luna checkpoint:** review every status mapping back to its source read/receipt, the unavailable-versus-empty behavior, truthful recovery text, and confirmation that the shared panel performs no reads or writes.

## Task 3: Create per-workflow source and real-task evidence records

**Allowed files:**

- Create `docs/implementation/priority-4-evidence/project-steward.md`.
- Create `docs/implementation/priority-4-evidence/attributable-researcher.md`.
- Create `docs/implementation/priority-4-evidence/recurring-operator.md`.
- Create `docs/implementation/roadmap-priority-4-status.md` as the concise index linking the three records and their source plans.
- Create or update only `work/opencode-memory/priority4-coordination.md` for the exact-source executor/review/check chronology.
- Do not update the roadmap yet; that is Task 4.

**Record format:** Each workflow record has distinct `source_checkpoint` and `real_task_evidence` sections. The source section records exact source SHA (or explicitly labeled worktree fingerprint if no commit exists), changed-file scope, exact Luna review result, each permitted check with command and unmasked exit code, and warnings/failures. The real-task section records user authorization/task reference, persisted Session/Goal/run/receipt selectors, backend/tool identity and version when authoritative evidence exposes them, configured/requested/observed budgets, output reference/hash, native readback and acceptance result, user interventions/consequential confirmations, recovery observed, and remaining limitations. Every absent field says `NOT RUN`, `not observed`, or `not applicable`; no task prompt, source excerpt, credential, or private output is copied into the record.

**Starting record required:** Record the P4.3 Task 3 result exactly as supplied for this plan: worktree fingerprint `164660dda7eed52a436a14069f146dfca7d88e20661ce22753cde985f363cd52` before and after checks; Cargo check, server typecheck, server build, and UI build exit 0; `git diff --check` exit 2 solely due pre-existing trailing whitespace at `docs/implementation/roadmap-priority-3-status.md:3`. Label it a worktree fingerprint, not a commit SHA; do not claim all five checks passed, and do not modify the unrelated P3 file. Record no real task, runtime, test, external integration, or user acceptance as performed.

**Luna checkpoint:** verify the record schema preserves source revision/backend/tool/budget/output/readback/acceptance/intervention/limitation distinctions; verify unknown values remain explicitly unknown and the P4.3 check exception is not laundered into a green result.

## Task 4: Publish the acceptance checklist and final roadmap handoff

**Allowed files:**

- Update `docs/CURRENT_ROADMAP.md` only in the Priority 4 section and evidence/status links.
- Update `docs/implementation/roadmap-priority-4-status.md` and the three Task 3 evidence records.
- Update `work/opencode-memory/priority4-coordination.md` with the final source SHA, exact five-check report, Luna review, and deviations.
- Create `work/opencode-memory/priority4-source-checks-<source-sha>.json` containing the five exact commands, unmasked exit codes, warning/failure text, SHA/worktree identity, and capture time. Do not change unrelated working files or generated artifacts.

**Acceptance checklist contract:** Prepare a checklist with one user-selected concrete task for each workflow (Project Steward repository/task, Researcher question/source scope/audience, Recurring Operator Goal/commitment/action/observation interval), exact native Session/Goal/run/evidence IDs, current backend/tool/budget, explicit consequential user confirmation boundary, expected output and native readback, applicable interruption/recovery observation, and final user acceptance of the artifact. Mark every task-specific field `OPEN` until separately authorized and observed. Require explicit authorization for external integrations/actions; no test, synthetic fixture, source review, build, or UI label can check a real-task box.

**Status contract:** Report P4.1–P4.3 source/check outcomes individually and report P4.4 source implementation/checks separately. Keep Priority #4 real-task acceptance **OPEN** until all three workflows have their own authorized user task, exact evidence/readback, required consequential confirmation and recovery observations, and user-accepted output. Do not change Priority #1, #2, or #3 acceptance states or imply the sequence override waived them.

**Luna checkpoint:** audit exact source/check provenance, the P4.3 diff-check exception, explicit `NOT RUN` fields, checklist authorization boundaries, and roadmap status wording. Do not mark Priority #4 complete.

## Failure, Authorization, and Recovery Rules

- Route or selector read failures preserve the original workflow page and show a stale/unavailable state; they never auto-select a different Session, Goal, run, report, activation, or Cron row.
- A destination consumes a selector only after its exact native readback resolves or rejects it. A navigation request never repeats a source operation.
- A failed Credential/connector/runtime read does not disclose secret contents. If existing APIs do not expose a reliable diagnostic, present the source as unobserved and link to its current setup surface.
- Permission `ask`/waiting and `deny`/blocked remain the canonical ToolRuntime outcomes; no special cross-workflow bypass or retry is added.
- Missing accepted output is an open acceptance state, not a failure to be repaired by changing Goal status or invoking acceptance automatically.
- If any task discovers that a native source lacks required identity/readback, stop and request a separately scoped plan amendment. Do not change native authority in this cross-workflow UI phase.

## Final Exact-Source Review and Permitted Checks

- DeepSeek implements Tasks 1–4 sequentially; Luna reviews each exact source/doc diff before the next. Source scope is frozen only after the complete diff is reviewed and exact source SHA is recorded.
- Run only these five permitted source checks once at the frozen source SHA: `(cd src-tauri && /Users/charlottehughes/.cargo/bin/cargo check)`; `(cd server-jarvis && bun run typecheck)`; `(cd server-jarvis && bun run build)`; `(cd src-ui && bun run build)`; and `git diff --check`. Record unmasked exits against the exact source SHA and note pre-existing unrelated dirty-file errors separately. Do not change unrelated files to obtain a green diff-check.
- No tests, UI/app runtime, model call, live research, scheduled activation, external integration, project/task execution, or real user acceptance is in this phase. Source checks demonstrate only source buildability and formatting status.
- If the global diff-check reports the already-known unrelated P3 trailing whitespace, record its exact path/line and nonzero exit. Do not say “all five passed.” If another check fails, stop and report rather than repairing outside a reviewed bounded DeepSeek correction.

## Plan Self-Review

- The shared navigation selector is not a new authority: it carries exact IDs only, and each existing destination repeats its native reads.
- The shared readiness panel consumes already-decoded status props and cannot become a second reader, permission evaluator, or lifecycle store.
- Evidence records keep source checks and actual-user-task evidence separate; the known P4.3 check result is represented honestly.
- The acceptance checklist is preparatory only. Real tasks, integration setup, and accepted outputs remain open until the user supplies task-specific authorization and the work is observed.
