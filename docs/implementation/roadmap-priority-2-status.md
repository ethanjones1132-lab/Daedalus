# Roadmap Priority 2 — Status and evidence

**As of:** 2026-10-05
**Scope:** Roadmap Priority #2, “Connect goals, commitments, scheduling, and execution.”
**State:** Four source plans are complete; Part 1 source checkpoint `7bf50fafe01f785252874ccb09ad8de23d4a6a45` is committed and all five allowed checks passed against that exact SHA. Part 2 is next. No Priority #2 runtime acceptance has been run.

## Sequencing ruling

The user explicitly directed source work to begin on Priority #2 on 2026-10-05 while Priority #1's acceptance remains outstanding. This is a sequencing override for source work only. Priority #1 is **incomplete/open**: its source Phases 1–4 are implemented, but all tests and live, cross-Session, restart, and runtime acceptance remain **NOT RUN**. Priority #2 is active for source work, not accepted or runtime-complete. Priorities #3–#5 remain queued.

## Starting code evidence

- SQLite owns sessions, native session runs, cron jobs, and cron runs: `src-tauri/src/db/migrations.rs`.
- Cron CRUD and scheduler: `src-tauri/src/commands/cron.rs`, `src-tauri/src/cron_scheduler.rs`.
- TaskPlan and TaskRun contracts: `server-jarvis/src/orchestration/task-run.ts`; per-Session TaskRun persistence: `server-jarvis/src/orchestration/session-memory.ts` and `session-runtime-persistence.ts`.
- Commitments currently use manual JSON CRUD in `src-tauri/src/commands/system.rs`.
- Action Registry is file-backed in `src-tauri/src/commands/action_registry.rs`; eligible dispatch currently returns `unavailable` / `verification_manifest_missing`.
- No roadmap Priority #2-specific implementation plan/spec was found in the inspected repository documentation before these four plans were authored.

## Four sequential plans

1. [Durable Goal authority and links](../superpowers/plans/2026-10-05-roadmap-priority-2-part-1-goal-authority.md)
2. [Goal-linked execution and recovery](../superpowers/plans/2026-10-05-roadmap-priority-2-part-2-execution-recovery.md)
3. [Commitments and scheduled activations](../superpowers/plans/2026-10-05-roadmap-priority-2-part-3-commitments-scheduling.md)
4. [Trusted accepted delivery](../superpowers/plans/2026-10-05-roadmap-priority-2-part-4-trusted-delivery.md)

## Part 1 source checkpoint — durable Goal authority and links

Implemented in source:

- Additive migration `apply_goal_migrations` creating `goals`, `goal_criteria` (stable per-criterion ids), `goal_events` (lifecycle audit), and `goal_links` (association point), and adding nullable `goal_id` columns to `session_runs`, `cron_jobs`, and `cron_runs`.
- Native commands `goal_create`, `goal_list`, `goal_get`, `goal_update`, `goal_transition`, `goal_links_list`, `goal_link_add`, `goal_link_remove` in `src-tauri/src/commands/goals.rs`, using existing SQLite/transaction/IPC patterns.
- `goal_link_add` resolves the target through its own authoritative store before persisting: `cron_job`/`cron_run`/`session_run` are checked by primary key in the native SQLite authority and `commitment` through the native JSON commitment store (`fetch_commitment`). `task_plan`/`task_run`/`evidence` remain declared association kinds but are rejected with a clear not-yet-supported error. The lookup also enforces target Goal association, Agent identity, and exact workspace scope; Cron-bound Sessions must match their job and Goal Agent, and both persisted workspace roots are re-canonicalized. No invented authority or broad state scan is used.
- `goal_create` validates supplied scope against existing native authorities: an explicit `agent_id` must resolve to a known, enabled Agent row and an explicit `project_root` must canonicalize through the trusted memory-scope validator (`normalize_project_root`). Omitted scope keeps the default Jarvis Goal usable. These values are attribution only and never grant permissions. Link creation checks target existence, conflicting Goal association, Agent identity, and exact revalidated workspace scope; unconnected TaskPlan/TaskRun/evidence types remain rejected.
- `Commitment` gains an optional, defaulted `goal_id` field; associations are declared but not wired.
- Goal view + navigation entry in the React UI showing criteria, truthful current status, allowed transitions, and linked-record empty state. Detail reads are bound to the selection generation (stale responses discarded), detail is cleared/preserved consistently across selection changes, and duplicate status transitions are guarded by an in-flight lock.

Validated in source: user-owned objective/criteria authority (`user_statement` only), stable criterion identity across updates, an explicit eight-state lifecycle with terminal states distinct, fail-closed missing/invalid Goal IDs and link targets, validated scope attribution, and refusal to set `completed` without an acceptance gate (Part 4). No permissions are granted and no work is dispatched.

Independent coordinator checks against committed source SHA `7bf50fafe01f785252874ccb09ad8de23d4a6a45`: Rust `cargo check`, Bun server typecheck, Bun server build, UI TypeScript + Vite build, and `git diff --check` all PASS. Rust emitted only two unrelated existing warnings; UI emitted an existing bundle-size advisory. The exact cached `lucide-react` declaration was restored by the prescribed helper; no manifest or version changed. **NOT RUN:** tests, fixtures, scripted provider, live inference/runtime, restart/interruption, real-goal acceptance, packaging, and installation. Priority #1 remains incomplete/open; Priority #2 runtime acceptance remains open; #3–#5 remain queued.

## Execution protocol

Luna owns plans, reviews, coordination and allowed non-test checks. Every production source change is executed only by OpenCode CLI model `opencode-go/deepseek-v4.1-flash`. Tests, fixtures, test declarations, scripted providers, live inference/runtime/restart acceptance, packaging and installation remain NOT RUN. Compiler/type/build/diff/source checks may be recorded by exact source SHA.

Part 1 review and allowed-check evidence: [Part 1 progress](roadmap-priority-2-part-1-progress.md). Source commit SHA: `7bf50fafe01f785252874ccb09ad8de23d4a6a45`. Detailed sequential checkpoints are tracked in the coordinator ledger at `/Users/charlottehughes/Documents/Codex/2026-10-04/ca/work/opencode-memory/PHASE2-COORDINATION.md`.
