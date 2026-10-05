# Roadmap Priority 2 — Part 3: Commitments and scheduled activations

**Owner:** Luna, planning/review/coordination. **Production executor:** OpenCode CLI `opencode-go/deepseek-v4.1-flash` only.

## Outcome

Existing Commitments and cron scheduling become explicit Goal relationships. A scheduled activation can produce a correlated run, and cancellation, restart, retries, approval/permission waits, resource limits, and notifications preserve truthful status without duplicate effects.

## Prerequisite

Part 2 is committed and reviewed. Build on its durable Goal/run/checkpoint identifiers and use current SQLite cron/session authority. Keep the existing Commitment and Cron UI/API compatible for unlinked records.

## Implementation scope

1. Add validated optional Goal references to the existing Commitment record and CRUD flow. Preserve manually created unlinked commitments and current JSON store readability; avoid treating commitment completion as Goal acceptance.
2. Associate cron jobs, activations, and cron run records with Goal and stable activation/run IDs. Preserve existing cron job CRUD, agent/session binding, and history.
3. Establish a deterministic schedule boundary and persisted claim/dedupe record. Reconcile a due activation after restart; a completed activation is never dispatched again. Ambiguous in-flight effects become an actionable wait/reconciliation state rather than automatic replay.
4. Make disable, delete, Goal cancellation, and user cancellation stop future activation and propagate to in-flight execution through current runtime controls. Record the terminal reason and keep cancellation distinct from completion.
5. Enforce existing Agent lifecycle activation boundary, Permission policy, allowlisted execution context, and configured time/iteration/resource bounds on every unattended activation. Missing permission or invalid/stale Agent projection creates a specific `waiting_for_user` or `blocked` state, not a privileged fallback.
6. Emit preference-aware meaningful notifications for progress, completion, failure, and user action requests using existing event/notification paths; do not notify on every internal step.
7. Add UI links from Goal to commitment, schedule, activation history and run state, with clear controls for pause/cancel/retry and actionable blockers.

## Source review criteria

- Existing unlinked cron/commitment consumers remain backward compatible.
- Each scheduled activation is attributable to a Goal, schedule occurrence, and run; uniqueness/dedupe is durable.
- Restart, disable, cancellation and missed-run decisions use persisted state and cannot reissue confirmed-complete effects.
- Permission and resource limits are checked server/native-side at activation and resume; UI status reflects authoritative state.
- Notifications identify actionable state without asserting unverified completion.

## Allowed verification

Only source/diff, Cargo/Bun/UI type and build checks. Do not add/run tests, fixtures, test declarations, scheduler scripts, native app instances, live inference, restart demonstrations, or runtime acceptance. Report missed-run/restart/cancel acceptance as NOT RUN.

## Checkpoint

Complete focused Luna review, run all allowed checks against this part's exact source SHA, commit only explicitly named paths, and record the ledger before beginning Part 4.
