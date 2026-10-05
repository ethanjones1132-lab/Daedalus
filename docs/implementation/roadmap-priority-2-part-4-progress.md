# Priority 2, Part 4 — Trusted Delivery Handoff

**Source checkpoint:** `ff4aa1750b36c7172b47156b28b40e58b3ec8147`
**Plan:** [Trusted accepted delivery](../superpowers/plans/2026-10-05-roadmap-priority-2-part-4-trusted-delivery.md)
**Status:** native execution and acceptance foundations are source-implemented; integrated Goal/Action Registry acceptance-evidence UI remains open. Priority #2 is not complete or runtime-accepted.

## Implemented source

- Native SQLite trust registry for versioned acceptance manifests, bound to an enabled Agent, canonical project root, and one exact Action Registry ID. Users explicitly add, replace, and remove manifests through Settings; no manifest is auto-seeded.
- Manifest execution and acceptance allowlists are separate. Bounded filesystem writers can be used only for the approved execution step; acceptance remains read-only. All effects go through canonical ToolRuntime and current Permission policy.
- Native execution uses an explicit operation UUID, exact manifest/action/scope/projection bindings, durable receipts, bounded transport, idempotent retry, and blocked/waiting/ambiguous states on non-success. Tool success remains pending acceptance.
- Native acceptance evaluates manifest-defined read-only checks against current Goal criteria, persists exact criterion/tool/hash/evidence rows, and confirms Action Registry terminal evidence and Goal completion by exact durable readback.
- Cancellation persists intent first, signals the exact owned Bun instance and execution ID, and returns a durable cancelled or ambiguous receipt only after native readback.
- Settings UI exposes manifest administration and operation run/retry/cancel controls. It freezes the exact operation tuple, creates a new UUID only for a new user action, reuses the same tuple for retry, and validates native receipt identity before display.

## Remaining source work

The saved Part 4 plan's integrated Goal/Action Registry evidence UX is not complete. `run_trusted_acceptance` and `get_trusted_acceptance` are registered native commands, but no UI currently invokes them. `GoalsView` still says trusted acceptance is not implemented and shows only pending accepted output; `ActionRegistryView` does not expose `execution_evidence` or `acceptance_evidence`.

Implement the remaining UI slice so a user can explicitly run acceptance checks only for an exact native `pending_acceptance` execution ID; then read back the Goal, criteria, acceptance receipt, and Action Registry row before showing accepted/completed. Display criterion-level results and evidence/output references from authoritative native receipts only. Preserve pending, partial, blocked, ambiguous, unavailable, and failed states without inferring completion.

## Checkpoint chain and checks

The production source commits, in order from the Part 3 UI checkpoint, are listed in [Priority 2 status](roadmap-priority-2-status.md), ending at `ff4aa1750b36c7172b47156b28b40e58b3ec8147`. Five permitted checks passed on that exact source SHA: Cargo check, server typecheck, server build, UI build, and `git diff --check`. See [exact check report](../../../opencode-memory/part4-ui-final-ff4aa175-checks.json). Earlier scoped reports are in the coordinator work area for dispatch, acceptance, and cancellation checkpoints.

No tests, runtime checks, live dispatch, acceptance execution, restart demonstrations, packaging, or installation were run. All Priority #2 completion criteria remain open; Priority #1 acceptance remains incomplete/open.
