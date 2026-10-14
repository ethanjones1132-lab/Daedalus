# Roadmap Priority 2 — Part 1: Durable Goal authority and links

**Owner:** Luna, planning/review/coordination. **Production executor:** OpenCode CLI `opencode-go/deepseek-v4.1-flash` only.

## Outcome

Create a durable native Goal record that captures the user-owned objective and acceptance criteria, has a stable identifier and explicit lifecycle state, and provides an additive association point for existing TaskPlans, commitments, scheduled activations, runs, and output evidence. This establishes the authority later parts will connect; it does not claim an end-to-end accepted delivery.

## Existing contracts

SQLite migrations in `src-tauri/src/db/migrations.rs` already own Session/run/cron entities. Native Tauri commands are registered through the existing command modules. TaskRun/TaskPlan remains a separate Bun Session execution/checkpoint contract (`server-jarvis/src/orchestration/task-run.ts`, `session-memory.ts`, `session-runtime-persistence.ts`). Commitments remain compatible with `src-tauri/src/commands/system.rs` until the association part. Action Registry remains its existing file-backed store until the delivery part. Reuse current UI navigation and native IPC patterns; don't create a parallel scheduler, run engine, or store.

## Implementation scope

1. Review current migration/versioning and native command registration/UI view patterns. Choose the canonical persisted Goal representation consistent with current SQLite authority.
2. Add an additive schema for Goal identity, user-provided objective, acceptance criteria with stable per-criterion identity, lifecycle state, timestamps, and optional Agent/project/workspace scope only where validated by current native context. Do not treat model-generated summaries as accepted criteria.
3. Define and strictly validate status transitions for `pending`, `running`, `waiting_for_user`, `blocked`, `paused`, `completed`, `failed`, and `cancelled`. Terminal states remain distinct. Do not let a status-only API mark a Goal complete without accepted evidence (the final acceptance gate is implemented later).
4. Add native create/read/list/update and explicit transition operations using transactions and existing IPC conventions. Preserve old consumers through additive command/DTO fields. A missing or invalid Goal ID must fail closed.
5. Add the smallest useful Goal UI for creation, criterion visibility, current status, and reviewable linked-record placeholders/empty state. Preserve existing layout, accessibility, keyboard behavior, and app navigation.
6. Define stable optional `goal_id` association contracts for TaskRun, Commitment, cron activation/run, native Session run, and evidence references; don't wire those relationships prematurely in this part.
7. Update `docs/CURRENT_ROADMAP.md` and implementation evidence only as needed to reflect #2 source progress and the explicit sequence override. Keep #1 incomplete and #2 runtime acceptance open.

## Source integrity follow-up (2026-10-05)

Focused review found three integrity gaps in the initial source pass; the fixes below remain entirely within Part 1 scope:

1. `goal_link_add` now resolves the target through its own authoritative store before persisting. `cron_job`, `cron_run`, and `session_run` are verified by primary key in the native SQLite authority; `commitment` is verified through the native JSON commitment store. `task_plan`, `task_run`, and `evidence` remain declared association kinds (the schema allowlist is unchanged for later parts) but are rejected with a clear not-yet-supported error instead of persisting arbitrary ids. No authority is invented and no broad state is scanned.
2. `GoalsView.loadDetail` binds each detail read to a request generation and the selection identity, discards stale responses, and clears/preserves detail consistently across selection changes. Status transitions are guarded by an in-flight lock so duplicate transitions cannot race.
3. `goal_create` validates supplied scope against existing authorities: an explicit `agent_id` must resolve to a known, enabled Agent row; an explicit `project_root` must canonicalize through `normalize_project_root`. Omitted scope keeps the default Jarvis Goal usable. These values never grant permissions or tool access.

## Boundaries

No execution dispatch, unattended scheduling, automatic completion, new permission grant, new executor, separate Goal store, broad UI redesign, or changes to the older Memory Phase 2 plans. Acceptance-manifest schema may be referenced as a future interface, but execution and verification belong to Part 4.

## Source review criteria

- Goal data is durably committed and read back through native authority.
- Schema migration is additive and existing sessions/commitments/jobs remain readable.
- Criterion identities and state transitions are validated, with invalid/terminal transitions rejected explicitly.
- No inference output or user-supplied text grants filesystem/tool permissions.
- UI never labels a Goal complete without evidence; source UI exposes truthful current state and empty/error states.
- Changes are narrowly scoped and the roadmap clearly keeps Priority #1 acceptance open.

## Allowed verification

Run source diff/status review, migration/API type checks, Cargo check, Bun type check, and permitted UI/server builds through the coordinator's exact cached dependency recovery/check procedure. Do not add/run tests, fixtures, test declarations, providers, app instances, live inference, or runtime acceptance. Record every runtime and test criterion as NOT RUN.

## Checkpoint

Commit only named Part 1 implementation/docs paths after focused Luna review and all prescribed non-test checks pass on the exact source SHA. Record source SHA, check evidence, review findings, and commit in `work/opencode-memory/PHASE2-COORDINATION.md`. Then proceed to Part 2.
