# Priority 2 Part 3 — UI slice handoff

**Scope:** Roadmap Priority #2, Part 3 (commitments and scheduled activations), Goal-detail UI slice.
**Final production source checkpoint:** `015772e52e0279c53680630cd40a54939cb85e74` (`fix(goals): reconcile only on evidence relevant to each schedule op`), following the initial UI slice `f655346437071e98a75c14a779f750113efff2ba` and the honesty/usability slice `5e085baf8450dc1467cf1e3ceaf945d934037ef9`.
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

## Final correction behaviors (`5e085baf`, refined in `015772e5`)

- **Commitments availability:** a failed or malformed (non-array) `get_commitments` response is treated as unavailable. The panel shows the read error and never the authoritative "no commitments linked" empty state; if previously loaded commitments remain, they are marked possibly stale.
- **Schedule availability:** a failed or malformed (non-array) `list_cron_jobs` or `get_in_flight_cron_jobs` response marks schedule authority unavailable. The UI never shows "no schedules linked" and never leaves stale controls actionable: previously loaded schedules are explicitly marked stale and all schedule controls are disabled while the authority is unreadable.
- **Read-only reconciliation:** a **Refresh** action re-reads the authoritative schedule + activation/run state. It never re-submits the mutation and is not named or treated as retry; it keeps any in-flight write.
- **Evidence-gated clearing (`015772e5`):** Refresh (and the mutation's own confirming readback) clears a pending failed/uncertain operation only when the readbacks relevant to that operation succeeded. Pause/resume depend only on the native schedule list (`enabled` state). Run now requires both the activation and run history readbacks for that job that would evidence the new execution. Cancel requires the in-flight readback (itself required for any `ok` result) plus the same activation/run history. If a relevant history readback fails or returns a non-array, schedule authority may still be available and history UI still shows "could not be read", but the operation remains uncertain (controls stay disabled) until a later successful reconciliation. A job missing from the refreshed linked list is never treated as reconciled.
- History responses (`get_cron_activations`/`get_cron_runs`) that are non-array or fail are shown as "could not be read", never as "no history".

## Canonical doc updates

- `docs/CURRENT_ROADMAP.md` Part 3 checkpoint records the final UI SHA.
- `docs/implementation/roadmap-priority-2-status.md` Part 3 section records the final UI SHA.

## Not run / open limits

- Tests, fixtures, scripted providers, live execution, native app instances, restart/interruption, missed-run/cancellation demonstrations, real-goal acceptance, packaging, and installation are **NOT RUN**.
- The five allowed compiler/type/build/diff checks were **NOT RUN** by the source executor; the coordinator runs them against the exact committed source SHA.
- Part 3 runtime/acceptance behavior remains unverified. Part 3 must not be treated as delivered until the coordinator review and checks are recorded.
- Part 4 (trusted acceptance-manifest execution and verified delivery evidence) remains reserved; the Goal completion gate stays closed.

## Remaining Part 3 items

With this slice, the seven planned Part 3 source items (Commitment Goal references, cron/activation/run association, deterministic claim/dedupe and restart reconciliation, cancellation propagation, activation/resume authority and resource gates, preference-aware notifications, and Goal schedule/activation UI with actionable blockers) are source-implemented across checkpoints `5b1d6211b879ec80a4ee620d05687a7f47b26e9a`, `0baf5b4f4cec6102397bde2553a635e2dde3de73`, and the cancellation/resource/notification commits up to `2506bc0adadddec0c9ea4293368caea880a01a36`, plus the final UI slice `015772e52e0279c53680630cd40a54939cb85e74`. What remains is review plus the allowed checks against the exact SHA and all runtime acceptance evidence, not further planned Part 3 source.
