# Priority 2, Part 4 — Trusted Delivery Handoff

**Final source checkpoint:** `200e4e190b9a6c5f1c25ca41743e46a5251603d8`
**Plan:** [Trusted accepted delivery](../superpowers/plans/2026-10-05-roadmap-priority-2-part-4-trusted-delivery.md)
**Status:** all four planned Part 4 source slices are complete, including integrated Goal/Action Registry acceptance-evidence UI. Priority #2 is not complete or runtime-accepted.

## Implemented source

- Native SQLite trust registry for versioned acceptance manifests, bound to an enabled Agent, canonical project root, and one exact Action Registry ID. Users explicitly add, replace, and remove manifests through Settings; no manifest is auto-seeded.
- Manifest execution and acceptance allowlists are separate. Bounded filesystem writers can be used only for the approved execution step; acceptance remains read-only. All effects go through canonical ToolRuntime and current Permission policy.
- Native execution uses an explicit operation UUID, exact manifest/action/scope/projection bindings, durable receipts, bounded transport, idempotent retry, and blocked/waiting/ambiguous states on non-success. Tool success remains pending acceptance.
- Native acceptance evaluates manifest-defined read-only checks against current Goal criteria, persists exact criterion/tool/hash/evidence rows, and confirms Action Registry terminal evidence and Goal completion by exact durable readback.
- Cancellation persists intent first, signals the exact owned Bun instance and execution ID, and returns a durable cancelled or ambiguous receipt only after native readback.
- Settings UI exposes manifest administration and operation run/retry/cancel controls. It freezes the exact operation tuple, creates a new UUID only for a new user action, reuses the same tuple for retry, and validates native receipt identity before display.

## Planned source slices — complete

1. Native trusted-manifest registry, strict versioned schema, exact Agent/project scope, Action Registry identity binding, and explicit Settings administration.
2. Fail-closed eligibility and canonical ToolRuntime dispatch under current Permission/resource/cancellation policy; durable execution receipts and runtime-owned acceptance checks/evidence.
3. Ambiguity-safe operation UUID semantics, idempotent same-operation retry, durable cancellation intent, native reconciliation, and truthful Settings run/retry/cancel controls.
4. Integrated Goal and Action Registry acceptance-evidence UI. `GoalsView` loads exact native execution/manifest/acceptance receipts, permits explicit checks only for the exact pending-acceptance execution, and re-reads Goal/criteria/Action Registry state. `ActionRegistryView` displays evidence only from authoritative native receipts. Strict decoding requires the native identity tuple and SHA-256 fields; the run command receipt must match the persisted receipt payload, including evidence and criterion rows, before confirmed accepted/completed display.

The evidence UI source checkpoints are `adb823cea6ada338b3b827d6e5a33008e3b83bf0` and its strict decoder/identity/readback follow-up `200e4e190b9a6c5f1c25ca41743e46a5251603d8`. No planned Part 4 source item remains.

## Checkpoint chain and checks

The production source commits, in order from the Part 3 UI checkpoint, are listed in [Priority 2 status](roadmap-priority-2-status.md), ending at `ff4aa1750b36c7172b47156b28b40e58b3ec8147`; the acceptance-evidence UI commits are `adb823cea6ada338b3b827d6e5a33008e3b83bf0` and `200e4e190b9a6c5f1c25ca41743e46a5251603d8`. Five permitted checks passed on exact final SHA `200e4e190b9a6c5f1c25ca41743e46a5251603d8`: Cargo check, server typecheck, server build, UI build, and `git diff --check`. See [exact check report](../../../opencode-memory/part4-acceptance-ui-final-200e4e1-checks.json).

No tests, runtime checks, live dispatch, acceptance execution, restart demonstrations, packaging, or installation were run. No planned Part 4 source work remains, but live action execution, trusted acceptance execution, restart/interruption recovery, and real-goal delivery must still be demonstrated and reviewed. All Priority #2 completion criteria remain open; Priority #1 acceptance remains incomplete/open.
