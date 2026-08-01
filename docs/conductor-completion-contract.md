# Conductor completion contract

This document is the release-facing contract for when a Jarvis write-intent
TaskRun may be recorded as successful. It is the offline twin of
`decideCompletion` in `server-jarvis/src/orchestration/completion-policy.ts` and
the release gates in `server-jarvis/src/eval/conductor-performance.ts`.

## Authority

1. **TaskPlan ledger completion is authoritative over synthesizer prose.**
   A run whose TaskPlan still has open items must not be recorded as
   `success`, regardless of what the synthesizer claims in natural language.
   Open plan items map to `taskStatus` remaining active/paused and
   `runOutcome=partial` with reason `task_plan_open`.

2. **Every autonomous plan verification needs structured grounding.**
   Conductor `mark_verified` directives and acceptance-check evaluation must
   carry structured evidence (tool effects, diffs, check results). Reviewer
   prose alone cannot independently prove a write, readback, test pass, or
   completed child task.

3. **Write success needs a non-`none`, ran, passing check.**
   A write-intent TaskRun may be `success` only when an authoritative check
   ran and passed (`tier !== "none"`, `ran === true`, `passed === true`).
   `check_tier=none` (or missing) yields `partial` with reason
   `write_unverified` and keeps the TaskRun resumable.

4. **Delegate success requires delegate-row write evidence and ground-truth metadata.**
   A successful delegate write is proven by a successful write-effect tool
   (`write_file` / `edit_file` / `multi_edit` / `apply_patch`) in the **same**
   stage row as `delegate_cleanup`, plus successful ground-truth metadata
   (e.g. `git_metadata`) when the path requires it. A later native fallback
   write does not clear a failed delegate row
   (`delegate_failed_before_fallback` in replay).

5. **Partial keeps the TaskRun resumable.**
   Outcomes `partial` and `degraded` leave the TaskRun in a paused/active
   state so a later `continue` in the same session can finish remaining plan
   items. They are not terminal failures of the TaskRun ledger.

6. **Replay and benchmark thresholds are release gates.**
   Layer-1 replay (`conductor-replay`) and the performance benchmark
   (`conductor-performance` / `benchmark-conductor-completion.ts`) are
   release gates, not diagnostics. Shipping requires:

   | Metric | Threshold |
   |---|---:|
   | Executor no-tool ratio | ≤ 10% |
   | Delegate verified-write rate | ≥ 80% once ≥5 delegate fixtures exist |
   | Unverified successes | 0 |
   | False-complete runs | 0 |
   | Duplicate write-pressure runs | 0 |

   Below five delegate fixtures the benchmark reports
   `delegate_gate="insufficient_sample"` and does not claim delegate success.

## Transport vs TaskRun completion

- **Terminal transport completion** is an SSE outcome frame
  (`result` / `error` / `cancelled`) for a single `/chat/stream` request.
  `message_stop` is transport only and is not a user-visible outcome.
- **TaskRun completion** is the ledger status after `decideCompletion`. A
  transport `result` with `subtype=partial` (and a machine-readable
  `completion_reason` such as `task_plan_open` or `write_unverified`) means
  the stream finished cleanly while the TaskRun remains open.

See `docs/sse-stream-contract.md` for the wire-level `completion_reason` and
subtype rules.

## Multi-item smoke

`scripts/smoke-jarvis-runtime.ps1 -CompletionIntegritySmoke` is the live
proof of this contract for a four-item Group A plan: all four artifacts must
exist with exact contents, intermediate turns must not report success, and
post-smoke replay for the smoke session must report no completion, delegate,
or write-pressure invariant violations.
