# Roadmap Priority 2 — Part 1 source checkpoint

**Date:** 2026-10-05
**Part:** Durable Goal authority and links
**Status:** Source implementation and Luna review complete; committed as `7bf50fafe01f785252874ccb09ad8de23d4a6a45`. Runtime acceptance remains NOT RUN.

## Source changes

- Added an additive SQLite migration for `goals`, `goal_criteria`, `goal_events`, and `goal_links`, plus nullable `goal_id` associations on native `session_runs`, `cron_jobs`, and `cron_runs`. Migration uses an idempotent savepoint and leaves existing records intact.
- Added native Goal create/list/read/update/transition and association commands in `src-tauri/src/commands/goals.rs`, registered them in Tauri, and added a minimal Goals view/navigation with objective, user-owned criteria, truthful lifecycle state, and linked-record status.
- Added optional defaulted `Commitment.goal_id` while preserving old JSON-store rows and unlinked CRUD.
- Goal objective and criteria authority are stored as `user_statement`; criterion IDs remain stable for unchanged text. Invalid IDs and illegal transitions fail closed; terminal states are distinct and immutable. A status-only transition to `completed` is refused until verified acceptance is implemented in Part 4.
- Supplied Agent scope is checked against an enabled native Agent record. Supplied project roots are canonicalized by the existing trusted memory-scope validator; scope attribution grants no tool or filesystem permissions.
- Goal links verify target existence in the target's authority (SQLite for Cron and Session runs, native JSON for Commitments), enforce Agent/workspace compatibility and conflicting-Goal checks, validate a Cron-bound Session Agent against both its job and Goal, and re-canonicalize project roots before association. TaskPlan/TaskRun/evidence links are reserved but rejected until their owning authorities are wired in later parts.
- Goal detail reads are tied to a selection generation; late prior-selection responses are ignored. In-flight state changes are guarded against duplicate transitions.

## Review and checks

Luna reviewed migration idempotency/additivity, Goal identity and state transitions, accepted-completion guard, target authority/scope checks, Agent/project validation, UI request-generation handling, and Goal-less consumer compatibility. Findings from focused passes were corrected through the exact production executor before acceptance.

Independent coordinator check helper ran after commit and recorded source revision `7bf50fafe01f785252874ccb09ad8de23d4a6a45`; all five checks passed:

| Check | Result |
|---|---|
| Rust `cargo check` | PASS; two unrelated existing warnings in `supervisor.rs` and `wsl.rs` |
| Bun server typecheck | PASS |
| Bun server build | PASS |
| UI TypeScript + Vite build | PASS; existing bundle-size advisory only |
| `git diff --check` | PASS |

The first executor UI typecheck saw missing cached `lucide-react` declarations. The prescribed coordinator helper restored the exact already-installed cached package and the final UI build passed. No manifest or dependency versions changed.

## Explicit NOT RUN

Tests, fixtures, test declarations, scripted providers, live inference/runtime, real-goal delivery, interruption/restart, missed-schedule replay, acceptance-manifest execution, packaging, and installation remain NOT RUN. Priority #1 remains incomplete/open; Priority #2 remains runtime-incomplete. No completion criterion is checked off.

**Source commit SHA:** `7bf50fafe01f785252874ccb09ad8de23d4a6a45`. All five allowed checks were rerun against the exact committed revision.
