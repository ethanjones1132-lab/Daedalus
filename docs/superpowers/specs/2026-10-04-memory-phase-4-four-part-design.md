# Memory Phase 4 — Four sequential source parts

**Authority:** `2026-10-04-memory-four-phase-design.md` and the full parent implementation plan `2026-10-04-memory-phase-4-continuity-controls.md` remain binding. This breakdown changes work sequencing only; all requirements and completion criteria remain in force.

**Workflow:** Luna plans and reviews; OpenCode CLI executes each sequential part with `opencode-go/deepseek-v4.1-flash`. Do not substitute executor/model. All product source changes come through that executor.

**Validation constraint:** No tests/test declarations/fixtures, product test runs, scripted acceptance, live app/inference/restart experiments are authorized. Those gates are **NOT RUN** and remain open. Permitted source checks are compiler/type/build and `git diff --check`; source compilation does not close priority #1.

## Scope and sequence

| Part | Deliverable | Parent plan coverage |
|---|---|---|
| 4.1 | Native additive statement classification, kind-aware save/update/correction, scoped list/preview/inspection and receipt-backed create/edit/correct/forget/restore/adopt/classify UI | Phase 4 additive classification contract; Tasks 2–3 |
| 4.2 | Persisted Agent/project Session projections and New Session controls; authenticate bound project as a validated workspace candidate under existing authorization | Task 1 |
| 4.3 | Require fresh current-turn canonical Tool runtime reads for descriptive/unknown workspace statements; bypass warm same-scope cache/historical hints; authenticated revalidation receipt and native persistence | Task 5 |
| 4.4 | Actual applied-vs-prepared status, capture receipts, revalidation and objective continuity UX; full source review; evidence summary and truthful roadmap status | Task 4 and source-only portion of Task 6 |

The task dependencies are sequential. Part 4.1 may use current native Session-scoped commands without changing Session projection. Part 4.2 establishes durable Session identity and authorized bound-workspace selection. Part 4.3 consumes those authenticated identities and Part 4.1 classification. Part 4.4 integrates the completed contracts and writes the final source handoff.

## Shared invariants

- Phase 1 native SQLite scope/authority/provenance and Phase 2 preparation/applied-ID/invalidator contracts are unchanged except named additive fields.
- Phase 3 capture/correction/forget/source-suppression, operation idempotency and objective continuity remain authoritative. A forgotten transcript stays inspectable but cannot revive prompt context.
- `MemoryStatementKind` is exactly `normative_constraint|descriptive_fact|unknown`. Existing data migrates to `unknown`; no title/category/source inference.
- Only explicit constraint capture initializes normative meaning. Revalidation is not a semantic truth verdict, auto-capture, permission grant, or durable rewrite.
- Agent identity comes from persisted Session ownership. Project binding is a requested workspace candidate checked under existing Tool runtime, sandbox, grant and write authorization.
- Native confirmed receipts distinguish completed mutations from pending/unavailable. Prepared candidates and actual applied memory remain distinct.
- Roadmap #1 stays active; priorities #2–#5 stay queued until actual required evidence exists.

## Plans

1. [Part 4.1 — Native Classification and Operator Controls](../plans/2026-10-04-memory-phase-4-1-operator-controls.md)
2. [Part 4.2 — Persisted Session Identity and Bound Workspace](../plans/2026-10-04-memory-phase-4-2-session-identity.md)
3. [Part 4.3 — Fresh Workspace Evidence and Revalidation Receipts](../plans/2026-10-04-memory-phase-4-3-fresh-source.md)
4. [Part 4.4 — Turn Status, Continuity UX, and Source Handoff](../plans/2026-10-04-memory-phase-4-4-status-handoff.md)
