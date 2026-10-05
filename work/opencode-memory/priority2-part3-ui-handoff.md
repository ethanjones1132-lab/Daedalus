# Priority 2 Part 3 — UI slice handoff

**Scope:** Roadmap Priority #2, Part 3 (commitments and scheduled activations), Goal-detail UI slice.
**Production source checkpoint:** `f655346437071e98a75c14a779f750113efff2ba` (`feat(goals): surface linked commitments, schedules, and activations`).
**Production path:** `src-ui/src/components/jarvis/GoalsView.tsx` only. No native API, migration, permission, or App-routing change was needed; every control is backed by an existing native durable command.

## Complete in this slice

- Goal detail now reads and shows **Goal-linked Commitments** from the authoritative Commitment JSON record (`get_commitments`, filtered by `goal_id`). Commitment completion is displayed only as the Commitment's own status and is never treated as Goal acceptance.
- Goal detail now reads and shows **Goal-linked cron schedules** (`list_cron_jobs` filtered by the scheduler-visible `cron_jobs.goal_id`) with schedule, next/last run, run count, agent, enabled/paused, and in-flight state (`get_in_flight_cron_jobs`).
- Each schedule exposes **durable activation history** (`get_cron_activations`) and **run history** (`get_cron_runs`), including activation identity, trigger kind, claim state, occurrence, dispatched/settled timestamps, run identity, and terminal reason.
- **Actionable waiting/blocked reasons** are surfaced from persisted activation state: `waiting_for_user`, `blocked`, and `ambiguous` claim states render the persisted `terminal_reason` as an explicit action/reconciliation prompt. History read failures are tracked per job and shown as "could not be read", never as "no history".
- Controls use only native durable APIs: **pause/resume** (`disable_cron_job`/`enable_cron_job`), **cancel** (`cancel_cron_job`, shown only for an in-flight job), and a manual **Run now** (`run_cron_job`) explicitly described as a new occurrence, not a replay. `trigger_missed_cron_job` is not used or relabeled as retry.
- Every mutation is guarded against duplicate submission per job and requires an authoritative native readback (`list_cron_jobs` + `get_in_flight_cron_jobs` + per-job activations/runs) before the UI reports success. A mutation that succeeds but whose readback fails is shown as uncertain/error and the previous display is retained; nothing is updated optimistically. A native `false` result (e.g. unconfirmed cancel) is treated as a failure, not success.
- Goal detail retains the existing rule that completion is withheld pending the Part 4 trusted-acceptance gate. A successful scheduled run, a submission, or an attempted transition is never used to infer Goal completion.
- Unlinked cron/commitment consumers and the existing `GoalRunProgress` view are preserved; no new permissions were introduced.

## Canonical doc updates

- `docs/CURRENT_ROADMAP.md` Part 3 checkpoint records this SHA.
- `docs/implementation/roadmap-priority-2-status.md` Part 3 section records this SHA.

## Not run / open limits

- Tests, fixtures, scripted providers, live execution, native app instances, restart/interruption, missed-run/cancellation demonstrations, real-goal acceptance, packaging, and installation are **NOT RUN**.
- The five allowed compiler/type/build/diff checks were **NOT RUN** by the source executor; the coordinator runs them against the exact committed source SHA.
- Part 3 runtime/acceptance behavior remains unverified. Part 3 must not be treated as delivered until the coordinator review and checks are recorded.
- Part 4 (trusted acceptance-manifest execution and verified delivery evidence) remains reserved; the Goal completion gate stays closed.

## Remaining Part 3 items

With this slice, the seven planned Part 3 source items (Commitment Goal references, cron/activation/run association, deterministic claim/dedupe and restart reconciliation, cancellation propagation, activation/resume authority and resource gates, preference-aware notifications, and Goal schedule/activation UI with actionable blockers) are source-implemented across checkpoints `5b1d6211b879ec80a4ee620d05687a7f47b26e9a`, `0baf5b4f4cec6102397bde2553a635e2dde3de73`, and the cancellation/resource/notification commits up to `2506bc0adadddec0c9ea4293368caea880a01a36`, plus this UI slice. What remains is review plus the allowed checks against the exact SHA and all runtime acceptance evidence, not further planned Part 3 source.
