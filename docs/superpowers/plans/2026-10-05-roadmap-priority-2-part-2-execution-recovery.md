# Roadmap Priority 2 — Part 2: Goal-linked execution and recovery

**Owner:** Luna, planning/review/coordination. **Production executor:** OpenCode CLI `opencode-go/deepseek-v4.1-flash` only.

## Outcome

A Goal can own resumable execution progress that connects its TaskPlan/TaskRun and native Session runs to durable checkpoints and evidence references. On interruption or restart, Jarvis can distinguish unfinished work from effects already completed and resume without silently converting a failed, cancelled, blocked, or waiting Goal into success.

## Prerequisite

Part 1 is committed and reviewed. Use its canonical Goal ID, state-transition contract, acceptance criteria identities, and association DTOs. Do not implement against the older Memory Phase 2 plan.

## Implementation scope

1. Extend existing TaskRun/TaskPlan and native Session-run records additively with Goal/run correlation IDs; preserve ordinary Goal-less chat and existing TaskRun continuation semantics.
2. Define a durable execution checkpoint that records the current plan item/stage, state, attempt/idempotency identity, start/finish or interruption, and evidence pointers. Store only necessary references and structured state; avoid duplicating transcripts or raw memory blocks.
3. Reconcile Goal, TaskRun, and native `session_runs` outcomes through explicit transitions. A recovered `active` run becomes resumable/paused or waiting based on persisted facts; only verified acceptance can later complete the Goal.
4. Thread Session cancellation, blocker/missing-approval requests, and pause/resume through existing run/context lifecycles. Keep waiting-for-user, blocked, paused, failed, cancelled, and completed distinct and actionable.
5. Add retry/checkpoint semantics with a durable effect identity so a restart can inspect whether a prior operation began, finished, or has ambiguous outcome before attempting it again. Never blindly replay an ambiguous external side effect.
6. Surface Goal-linked current progress, blocker/wait request, last run outcome, and evidence pointers using existing session/run UI. Retain context for a user to resume the exact Goal.
7. Apply current Permission policy and existing resource/time/iteration bounds at run entry and every resumed boundary; no goal text can expand grants.

## Source review criteria

- Goal-to-TaskRun-to-Session-run identifiers remain stable and round-trip through persistence.
- Restart reconciliation is deterministic and refuses to duplicate ambiguous side effects.
- Cancellation and failure are not reported as completion; resumption continues the recorded Goal rather than a similarly worded unrelated task.
- Evidence links identify reviewable output or verification records without copying raw transcripts.
- Legacy TaskRuns and ordinary Sessions preserve behavior when no Goal ID is present.

## Allowed verification

Use diff/source review, compiler/type/build checks only. Do not add/run tests, fixtures, test declarations, scripted providers, or live/runtime restart scenarios. Record tests and restart acceptance as NOT RUN; source shape alone cannot establish restart behavior.

## Checkpoint

After Part 1, implement, review, check, and commit this part before scheduling integration. Record exact source SHA, logs/status, review, and commit in the Priority 2 coordination ledger.
