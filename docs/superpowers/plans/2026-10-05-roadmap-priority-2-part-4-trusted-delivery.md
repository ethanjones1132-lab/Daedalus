# Roadmap Priority 2 — Part 4: Trusted accepted delivery

**Owner:** Luna, planning/review/coordination. **Production executor:** OpenCode CLI `opencode-go/deepseek-v4.1-flash` only.

## Outcome

Approved actions execute through Jarvis's canonical Tool runtime under the existing Permission policy. A trusted acceptance manifest is validated before execution, runtime-owned checks determine acceptance, and durable evidence/output references flow back to the Goal and Action Registry. Completion is a verified, reviewable delivery state and cannot be inferred from model prose.

## Prerequisite

Parts 1–3 are committed and reviewed. Use their Goal state, run/checkpoint, schedule, cancellation, permission, resource, and evidence contracts. Continue the existing Action Registry integration; do not create another action source of truth or direct tool executor.

## Trusted manifest source and administration

- Store trusted acceptance manifests in a distinct native SQLite table in the existing `jarvis.db` under Tauri `app_data_dir`; the Action Registry files under `workspace/action-registry` remain untrusted action data and are not a manifest authority.
- Each registered manifest has a stable native manifest ID, schema version, canonical content hash, validated versioned content, exact Agent ID, and canonical project-root scope. The user must explicitly add, replace, or remove a manifest through a Settings trust-management surface. There are no auto-seeded executable manifests.
- Goal, Action Registry, model, and task content may reference a registered manifest ID only. None may supply, replace, mutate, or authorize manifest content. Native code resolves the ID and revalidates its Agent/project scope at dispatch; a missing, stale, malformed, or mismatched binding remains unavailable/blocked.
- The Settings surface must show manifest ID/version/hash and bound Agent/workspace scope, and require an explicit user action for each add/replace/remove. Trust administration does not grant tool permissions; dispatch still uses current native Agent projection and existing ToolRuntime Permission policy.

## Implementation scope

1. Define a versioned trusted acceptance-manifest contract in the app-owned SQLite registry above and validate it against canonical Goal criteria. Manifest selection must be explicit and scoped to project/workspace/Agent; content supplied by a Goal, model, action description, or untrusted registry data cannot grant permission or define a command to trust.
2. Replace the current eligible-action `verification_manifest_missing` unavailable stub only where a trusted manifest resolves and current policy authorizes it. Otherwise preserve an explicit actionable unavailable/blocked/waiting reason.
3. Dispatch the approved action through canonical Tool runtime bundles and a bounded execution context. Revalidate Agent projection and Permission policy at dispatch; honor cancellation, timeout/resource bounds, and durable idempotency from Part 2/3.
4. Execute acceptance criteria using runtime-owned checks and capture exact command/tool identity, exit outcome, timestamps, run ID, and bounded output artifact/evidence references. Model-written success claims are never acceptance evidence.
5. Write execution and acceptance outcomes atomically/idempotently to Goal run/checkpoint/evidence state and the existing Action Registry `execution_evidence`; status transitions must distinguish pending, running, waiting, blocked, paused, completed, failed, and cancelled.
6. Close the Goal only when every required criterion is accepted and reviewable output/evidence is linked. Partial or unavailable verification remains open with a specific blocker. Ensure ambiguous outcomes preserve the exact operation identity for safe reconciliation/retry.
7. Complete integrated Goal/Action Registry UX: approved/waiting/blocked state, progress, evidence and output links, retry/cancel affordances, and confirmed receipt wording only after durable readback. Keep P1 memory acceptance status unchanged.

## Source review criteria

- Trust provenance for each acceptance manifest and command is explicit and cannot be supplied by runtime user/task text.
- All actual effects go through canonical Tool runtime + existing Permission enforcement; no direct shell/process bypass or new permissions.
- Completion derives from exact runtime check results plus durable evidence readback; assistant wording cannot complete a Goal.
- Cancellation/failure/partial/unavailable/ambiguous outcomes cannot become accepted completion.
- Retrying after restart reuses the durable operation identity and does not repeat an effect already known complete.
- Action Registry and Goal remain reconciled after durable write/readback failure without false success messages.

## Allowed verification

Run only source review, migration inspection, compiler/type/build checks, and diff/status checks. Do not add/run tests, fixtures, test declarations, scripted provider, live inference, real action dispatch, runtime acceptance, restart demonstrations, packaging, or installation. Record all Priority #2 completion criteria as NOT RUN/open pending explicit live acceptance work.

## Checkpoint

Require a focused fresh Luna source review of the final dispatch/acceptance paths, all allowed checks against exact final source SHA, and a documentation/evidence checkpoint. No Priority #2 runtime-complete claim is permitted without the roadmap's real-goal, interruption/restart, actionable blocker, distinct cancellation/failure, and accepted evidence/output criteria.
