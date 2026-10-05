# Roadmap Priority 2 — Status and evidence

**As of:** 2026-10-05
**Scope:** Roadmap Priority #2, “Connect goals, commitments, scheduling, and execution.”
**State:** Four source plans are complete; Parts 1 and 2 are source-checkpointed, and Part 3's seven planned source items are source-implemented across reviewed checkpoints plus a UI-slice checkpoint. All five allowed checks passed against the earlier exact checkpoint SHAs; the UI-slice SHA has not yet had the five allowed checks run by the source executor. No Priority #2 runtime acceptance has been run.

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

## Part 2 source checkpoint — Goal-linked execution and recovery

Source commit `1157cc6fff5dd8fb09ae9af007e681ec01f2dc19` adds a native-validated Goal run registration bound to Goal/Agent/workspace, Session, turn, exact persisted user source-row ID and SHA-256 body hash, with a stable TaskRun/run identity. The Bun process consumes it once only when the actual `/chat/stream` request carries the same bounded source-row ID and exact message body. Direct UI and native relay paths transport that identity; missing or mismatched source IDs remain Goal-less. Native terminal recording verifies the private consumed receipt and rejects client-supplied Goal attribution. Goal-linked TaskRuns persist resumable checkpoints and expose authorized checkpoint references; completion remains pending trusted accepted-output evidence for Part 4.

Independent coordinator checks against exact committed SHA `1157cc6fff5dd8fb09ae9af007e681ec01f2dc19`: Rust `cargo check`, server typecheck, server build, UI TypeScript + Vite build, and `git diff --check` all PASS. Rust reported two existing warnings (`src/supervisor.rs` deprecated atomic method and `src/wsl.rs` unused helper); UI emitted the existing bundle-size advisory. Focused Luna review confirmed exact source-ID transport and compare/hash/one-shot enforcement. No test file was changed and no tests were run. **NOT RUN:** tests, runtime, restart/interruption demonstration, real-goal acceptance, package, or installation. Part 2 source is checkpointed; Priority #1 remains incomplete/open; Priority #2 runtime acceptance remains open; #3–#5 remain queued.

## Part 3 — Commitments and scheduled activations

Part 3 is source-implemented but **not complete**: its seven planned source items are done, but the UI-slice checkpoint's allowed checks and all runtime acceptance remain outstanding.

Earlier reviewed source checkpoints (all five allowed checks passed against each exact SHA):

- `5b1d6211b879ec80a4ee620d05687a7f47b26e9a` — validates optional Commitment Goal references against native Goal authority, preserves unlinked JSON records, and makes the Commitment JSON `goal_id` authoritative for Goal detail, including an explicit-clear marker and fail-closed reads.
- `0baf5b4f4cec6102397bde2553a635e2dde3de73` — native Goal-linked cron CRUD, stable activation identities, unique deterministic occurrence claims, startup ambiguous reconciliation, and run attribution.
- `425d70d`, `1b0e278`, `d916710`, `f301be3`, `2506bc0` — in-flight cancellation propagation with terminal reasons; Agent lifecycle/projection boundary and resource/authority gates on activation and resume producing `waiting_for_user`/`blocked` (never a privileged fallback); claim-time projection identity enforcement; preference-aware, readback-verified notifications.

**UI-slice source checkpoints** `f655346437071e98a75c14a779f750113efff2ba` (initial), `5e085baf8450dc1467cf1e3ceaf945d934037ef9` (honesty/usability corrections), `015772e52e0279c53680630cd40a54939cb85e74` (per-operation evidence-gated reconciliation), and the final `2b226db1e9989445a1c10465ec6f5bf39430f3fd` (`src-ui/src/components/jarvis/GoalsView.tsx` only; no native API change) add Goal-detail links/views for Goal-linked Commitments (from the Commitment JSON authority), Goal-linked cron schedules (from the scheduler-visible `cron_jobs.goal_id`), durable cron activations and run history, and actionable `waiting_for_user`/`blocked`/`ambiguous` reasons read from persisted activation state. Schedule controls use only existing native durable APIs: pause/resume (`disable_cron_job`/`enable_cron_job`), cancel (`cancel_cron_job`, in-flight only), and a manual `run_cron_job` explicitly labeled as a new occurrence — `trigger_missed_cron_job` is not used or relabeled as retry. Every mutation is guarded per job against duplicate submission and confirmed by authoritative native readback before the UI reports success; a mutation whose readback fails is shown as uncertain/error with the previous display retained (no optimistic update), and a native `false` cancellation result is treated as failure.

Honesty/usability corrections: a failed or malformed (non-array) `get_commitments` read is treated as unavailable, so the panel reports the read failure instead of an authoritative "no commitments linked" empty state; a failed or malformed (non-array) `list_cron_jobs` or `get_in_flight_cron_jobs` read similarly marks schedule authority unavailable, so the UI never shows "no schedules linked" and never leaves stale schedule controls actionable — stale rows are explicitly marked and their controls are disabled. A read-only **Refresh** action re-reads the authoritative schedule + activation/run state; it clears a pending failed/uncertain operation only when the observed state shows that operation's own requested effect, applying the same predicate used immediately after the command readback. Pause/resume require the job to show the expected enabled value (false/true). Run now captures the baseline activation/run ids before submission and requires newly observed evidence after the action, keeping its immutable baseline and submission time in the operation context; when the baseline history was unavailable before submission, it requires evidence timestamped at/after the submission time rather than treating readability alone as confirmation. Cancel requires the tracked in-flight execution to be absent after the refresh while activation/run history remains readable. Missing history or an unchanged effect leaves the operation uncertain and keeps its controls disabled; any in-flight write is preserved. It never re-submits the mutation and is not a retry. Goal completion is never inferred from a successful run, a submission, or an attempted transition; the Part 4 acceptance gate remains closed. Unlinked commitment/cron consumers and existing permissions are unchanged.

The five allowed compiler/type/build/diff checks were **NOT RUN** by the source executor against the final UI-slice SHA. **NOT RUN:** tests, fixtures, scripted providers, live execution, restart/interruption, missed-run/cancellation demonstrations, real-goal acceptance, packaging, and installation. Source implementation is not runtime proof. Part 3 must not be treated as delivered until coordinator review, the five allowed checks against the exact SHA, and the runtime acceptance criteria have evidence. Part 4 remains reserved for trusted acceptance-manifest execution and final output evidence.
