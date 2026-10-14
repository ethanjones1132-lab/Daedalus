# Roadmap Priority 4 — Complete Workflows Beyond Coding

> **For agentic workers:** The user explicitly authorized Priority #4 source/workflow work after Priority #3 source/evaluation work, even if Priority #3's empirical gate fails. Use the saved Luna plan and the assigned OpenCode `opencode-go/deepseek-v4.1-flash` executor sequentially, with Luna review and the five allowed source checks per exact SHA. Do not perform a real user task or external action without its own task-specific authorization.

**Goal:** Make three user-selected workflows—project stewardship, research, and recurring operation—work end to end with inspectable outputs, durable state, understandable permission boundaries, and usable recovery paths.

**Architecture:** Compose existing Sessions, Agent/workspace authority, Goals, Action Registry, memory, learning, Cron, and in-app notices into three explicit workflows. Each phase adds only the missing source contract and user-visible readback for that workflow; no model claim or attempted mutation is treated as accepted delivery. A final readiness phase aligns onboarding and evidence views while leaving real-task acceptance visibly open until the user supplies or authorizes the relevant task.

**Tech Stack:** Existing Rust/Tauri native commands and SQLite authority, TypeScript/Bun ToolRuntime, React/Tauri views, current Goal/trusted-manifest APIs, memory, Cron, and approved in-app notification surface.

**Spec:** [Current roadmap Priority 4](../../CURRENT_ROADMAP.md#4-build-complete-workflows-beyond-coding); [Priority 3 and Priority 4 status sequencing](../../implementation/roadmap-priority-3-status.md).

## Sequence ruling and evidence boundary

- The user explicitly directed Priority #4 source/workflow work to begin after Priority #3 source/evaluation work even if the empirical Priority #3 result fails. Priority #3 remains incomplete if its frozen evidence gate fails or is inconclusive. This override does not change Priority #1/#2 acceptance states.
- Priority #4 source implementation may use repository code and checked-in synthetic fixtures. It may not be reported as having completed a real user task merely because source checks, synthetic tasks, or mock integrations pass.
- A real project stewardship task needs a user-selected project/task and scope; changing that project, committing, merging, deploying, or publishing needs the relevant explicit authorization.
- A real research task needs its concrete question, acceptable sources, and output audience. Web/MCP integrations remain bounded by existing ToolRuntime Permission and any connector authorization; do not create connections or send external content on inference.
- A recurring operator must use durable Goal/Cron state and current in-app notices. Email, chat, calendar, cloud, browser, or other external integrations require the relevant explicit user authorization and configured capability; do not send external messages during source work.
- Record missing user tasks, credentials, permissions, or integrations as open evidence requirements with actionable next steps. Never synthesize them or mark them accepted.
- For source checkpoints run only Cargo check, server typecheck, server build, UI build, and diff-check at the exact SHA. No tests or installations unless separately required by the roadmap and explicitly authorized.

## Review Focus

- Project path, Session, Agent, and workspace must be resolved from native persisted state and revalidated before dispatch; model or Goal text cannot supply authority.
- Consequential workspace writes and external actions must honor existing ToolRuntime policy, exact approved action/manifest binding, and current user confirmation requirements.
- Report completion only after authoritative readback and applicable acceptance evidence; submitted requests, tool success, or generated response text are not proof.
- Research citations must bind to actual retrieved source content and remain distinguishable from unavailable, partial, stale, or rejected source results.
- Scheduled operation must expose durable waiting/blocked, cancellation, retry, and terminal states; notification emission must follow verified persistence and remain within the authorized channel.

---

## Phase 4.1 — Project Steward local workflow

**Files (confirm exact owners during a bounded map before edits):**
- Existing `src-ui/src/components/jarvis/JarvisView.tsx`, `GoalsView.tsx`, `AgentsView.tsx`, and/or a focused Project Steward view.
- Existing native Session/Agent/workspace resolution and Goal/Action Registry commands under `src-tauri/src/commands/`.
- Existing Bun `ToolRuntime`, trusted action, and durable execution/acceptance APIs.

- [ ] Define the in-app user flow: select a persisted project/workspace and Agent; state a concrete task; inspect the resolved scope; track the Goal/run; review the resulting diff, source revision, and allowed checks.
- [ ] Bind every dispatch to the canonical native project root, exact Session/Agent projection, user task, current Permission, and approved action where required. Do not accept model-provided project roots, tool calls, arguments, or completion claims.
- [ ] Make proposed changes reviewable and reversible; do not auto-commit, merge, publish, or deploy. Preserve a specific waiting/blocked state when a required permission, workspace, tool, or acceptance read is unavailable.
- [ ] Source checks can validate buildability only. A real stewardship success requires a separately authorized user-selected issue/task and an accepted reviewable artifact.

## Phase 4.2 — Attributable Researcher workflow

**Files (reuse the Phase 3.1 source contract and existing web tools):**
- `src-ui/src/components/jarvis/LearningView.tsx` and a focused research/report view only if current navigation needs one.
- `src-tauri/src/jarvis/learning.rs` and `src-tauri/src/commands/jarvis_commands.rs` for native evidence/readback contract.
- `server-jarvis/src/learning-session.ts`, `web-bundle.ts`, and current `ToolRuntime`/source capture paths.
- Native memory/Goal acceptance APIs only for explicit user acceptance of a saved conclusion.

- [ ] Present a concrete research question, source scope, and output destination, then show results as complete, partial, blocked, or unavailable with exact source/run bindings.
- [ ] Keep retrieved facts, excerpts, hashes, references, and synthesis visibly distinct. Persist accepted conclusions only through existing user-authorized memory/Goal APIs with exact readback.
- [ ] Use existing web ToolRuntime permissions. Add browser/MCP/document integrations only if the selected workflow needs them and the user separately authorizes/configures them.
- [ ] A real researcher workflow remains unaccepted until the user supplies or authorizes a question and accepts a cited output; no source fixture is a substitute.

## Phase 4.3 — Recurring Operator workflow

**Files (reuse existing durable lifecycle):**
- `src-ui/src/components/jarvis/CronView.tsx`, Goal/Commitments views, and current Goal detail/history components.
- Existing `cron_scheduler`, Goal lifecycle, trusted execution receipt, cancellation, and verified in-app notification APIs.
- Narrow native/Bun source files only when review identifies a missing durable contract.

- [ ] Bind schedules to an explicit Goal/commitment and supported action; show next run, last run, durable receipt, and exact state readback.
- [ ] Expose pause, retry, or cancel only when supported by native durable APIs. Retry reuses the same operation identity for ambiguous outcomes; a new run has a new user-authorized identity after prior resolution.
- [ ] Make waiting/blocked reasons actionable and keep accepted, failed, cancelled, and ambiguous outcomes distinct. Never derive completion from a submitted schedule request or model text.
- [ ] Progress and terminal notices may appear only after successful persistence and authoritative readback. Use the current in-app surface; no external notification is sent absent specific authorization.
- [ ] A real recurring-operator success needs an explicitly authorized commitment and an observed complete/recovery interval; source changes or a synthetic schedule are not that evidence.

## Phase 4.4 — Cross-workflow readiness and evidence handoff

**Files (keep the map bounded):**
- Current App navigation and workflow status/detail components.
- `docs/CURRENT_ROADMAP.md`, a Priority 4 status/handoff document, and `work/opencode-memory` coordination record.

- [ ] Align the three workflow entry points and readbacks around shared Goal/Session/evidence identities without creating a parallel source of authority.
- [ ] Document onboarding and recovery steps for absent workspace, Permission, source, credentials, connector, runtime, or accepted output; surface unavailable state instead of empty/complete claims.
- [ ] Keep per-workflow evidence records with exact source revision, backend/tool identity when available, budgets, outputs, readback/acceptance evidence, interventions, and remaining limitations.
- [ ] Prepare a real-task acceptance checklist that requires one user-selected task per workflow, user confirmation at consequential boundaries, observed recovery where relevant, and accepted artifact/readback. Do not run it until the user authorizes the concrete task and any external integrations.
- [ ] Keep Priority #4 open until each required real user workflow completes with accepted evidence; no build, fixture, or code review alone can satisfy the roadmap outcome.

## Completion boundary

Priority #4 source work may be complete while Priority #4 remains unaccepted. The real project-stewardship, researcher, and recurring-operator evidence requires the concrete user task, workspace, audience, credentials, and/or integrations that the user has not yet separately selected or authorized. Report each such item as open rather than fabricating a task or connecting to an external service.
