> **For agentic workers:** Execute the parts sequentially with the existing exact DeepSeek v4.1 Flash OpenCode CLI workflow. Steps use checkbox syntax for tracking.

**Goal:** Complete Phase 4 native operator controls, cross-Session identity, conservative source freshness handling, and truthful diagnostics while preserving the Phase 1–3 authority and safety contracts.

**Architecture:** Native Rust/Tauri and App SQLite remain durable memory authority. The Bun server uses only authenticated turn preparations and the existing Tool runtime/evidence machinery; React presents native-scoped controls and receipts. All four parts are dependent and sequential: native/UI operator controls, persisted Session identity and safe bound-workspace resolution, source revalidation, then turn-status/continuity UI and documentation closure.

**Tech Stack:** Existing Rust 2021/Tauri 2, rusqlite, React/TypeScript, Bun, Tool runtime and evidence-gate interfaces. Add no persistence service, embedding, verifier, inference dependency, test provider, test declaration, or test fixture.

**Spec:** `docs/superpowers/specs/2026-10-04-memory-four-phase-design.md`; full Phase 4 requirements and frozen parent contracts in `docs/superpowers/plans/2026-10-04-memory-phase-4-continuity-controls.md`.

## Global constraints

- The parent Phase 4 plan and accepted four-phase design are binding. These sequential parts change execution boundaries only; do not omit or narrow their requirements.
- Rust/Tauri App SQLite is the only durable memory authority. Do not create a second writable Bun store.
- Preserve Phase 1 scope, ownership, provenance, revision and legacy isolation; Phase 2 preparation, private transport, invalidation and applied-ID receipts; Phase 3 capture, idempotency, suppression, objective continuity and failure semantics.
- Keep `MemoryDraft` unchanged. `MemoryStatementKind` is `normative_constraint|descriptive_fact|unknown`; existing rows migrate to `unknown` without inferred classification.
- Only explicit constraint capture initializes `normative_constraint`; remember/decision capture remains `unknown`. No generic automatic `verified_observation` capture.
- Fresh evidence means a current authorized source read exists; it is not a semantic truth verdict, verification claim, or permission grant. Never silently rewrite accepted memory or override a normative user requirement.
- Bindings and recalled text do not create workspace grants. Existing Tool runtime policy, sandboxing, write/check/TaskPlan gates, and direct/native surfaces remain authoritative.
- Do not add or run tests, test declarations, fixtures, scripted runtime probes, live inference, restarts, or acceptance experiments. They are explicitly **NOT RUN / requires user request**. Use source inspection, `git diff --check`, Cargo check, Bun typecheck/build, and UI build only. Record missing checks as not run; never claim priority #1 runtime-complete.
- No scope beyond Phase 4. No push, merge, deploy, global install, permission/settings changes, broad staging/reset/clean, or mutation of unrelated dirty baseline files.

## Review focus

1. Memory list, preview, inspection or mutation resolves the wrong Session/scope after switching while a request is pending; capture target identity and guard stale results.
2. A new Session loses selected Agent/project, or an authenticated project candidate widens grants; resolve native identity and use existing authorization before workspace selection.
3. Cached or historical workspace results are misreported as fresh; only same-turn current content-bearing Tool runtime reads may support `fresh_evidence`.
4. Stale/conflicting source appears to erase a normative requirement or unknown accepted decision; surface conflict and require operator acceptance for durable changes.
5. Missing/malformed/replayed receipt or diagnostic appears as success; show unavailable/pending until native read-back confirms.

---
# Memory Phase 4.1 — Native Classification and Operator Controls

## Part scope

Implement conservative statement classification through native transactions and wire validators, then deliver scoped Memory list/preview/inspect/create/edit/correct/forget/restore/adoption/classification controls. Do not change Session identity projection or turn freshness behavior in this part.

## Files and responsibilities

- Modify `src-tauri/src/db/migrations.rs`; `src-tauri/src/jarvis/memory/{contracts,scoped,capture,capture_contracts,turn}.rs`; `src-tauri/src/commands/{memory.rs,memory_scoped_tests.rs}` (production module only; **do not edit test files or test declarations**); `src-tauri/src/lib.rs`.
- Modify `server-jarvis/src/{memory-contract.ts,native-memory.ts}` and shared wire validators/fixtures only where production contract data requires it; do not edit tests/fixtures.
- Modify `src-ui/src/components/jarvis/{MemoryView.tsx,memory-recall-state.ts}`. Create production `memory-control-state.ts` and `MemoryScopeControls.tsx`. Part 4.1 owns the Memory view’s explicit existing-Session selector and project/Agent/user scope selector; Part 4.2 extends the same component for active chat New Session identity and workspace binding. No test files.
- Exact frozen scoped commands and Phase 3 `CorrectionResult`, `ForgetResult`, capture receipts remain as stated in parent plan's “Earlier Contracts Consumed Without Renaming”.

## Interfaces

- Add Rust/shared `MemoryStatementKind` with serialized values `normative_constraint`, `descriptive_fact`, `unknown`; add required `statement_kind` to persisted `ScopedMemoryEntry` and `PreparedMemorySelection`.
- Migrate `memory.statement_kind TEXT NOT NULL DEFAULT 'unknown'` with a three-value CHECK; preserve old content, provenance, status, and revisions. Old persisted selected JSON lacking the field decodes as `unknown`.
- Add optional request `statement_kind`: absent save defaults `unknown`; absent update/correction preserves old kind. Explicit constraint capture alone maps to normative; remember/decision remain unknown.
- Preserve old low-level signatures as compatibility wrappers and add the parent's exact `save_scoped_memory_with_kind`, `update_scoped_memory_with_kind`, and `correct_scoped_memory_with_kind` internal variants. Correction payload hash includes optional kind.
- Add `classify_scoped_memory(conn,scope,id,expected_revision,kind,now)` and `execute_scoped_classify(conn,request,now)` plus registered `memory_scoped_classify`. Ownership/revision/event/invalidation are atomic; same-kind returns `changed:false`; cross-scope/invalid kind changes nothing.
- UI wire decoders preserve nested scope, authority, provenance, classification, lifecycle and revision fields. Missing response classification is compatible as `unknown`; malformed supplied classification is unavailable/error.
- `MemoryControlTarget {session_id,selector,id,expected_revision}` is captured at submission. When the Memory view opens without an active Session, require the operator to choose an existing native Session before scoped list/preview/mutations. Session switching invalidates pending reads and mutations cannot be submitted against an implicit prior scope. Correction/forget each hold one stable operation UUID across retries. A mutation is confirmed only from a decoded native receipt, never assistant text.
- Preview stays a hypothetical query and retains score/matched terms/stale metadata. It is never called actual turn selection. No public control accepts caller-supplied Agent ownership, authority, source, or verification claims.

## Steps

- [ ] Inspect Phase 1–3 command signatures, migrations and operation-gate/invalidation semantics at the current Phase 4 execution HEAD; record any needed additive adaptation before editing.
- [ ] Implement additive statement-kind migration and typed native/shared DTO serialization. Keep all legacy rows and old payloads readable as `unknown`.
- [ ] Implement transactional classification and kind-aware save/update/correction wrappers. Preserve revision checks, correction idempotency, audit events, Phase 2 preparation invalidation, and Phase 3 provenance/source suppression.
- [ ] Update capture admission so `explicit_constraint` gets normative classification only; explicit remember/decision stay unknown and generic verified observation stays blocked.
- [ ] Replace production unscoped Memory list/preview calls with Session-scoped native commands. Implement nested wire decoding and scoped target capture; add deliberate create/edit/correct/forget/restore/adopt/classify actions with receipt-backed states.
- [ ] Preserve keyboard, loading, error and stale-generation behavior. Inactive/superseded/expired entries remain inspectable but are never shown as recall-eligible without native status.
- [ ] Review source against parent Phase 4 Tasks 2–3 and classification extension. Run only permitted source checks (`git diff --check`, `cargo check --manifest-path src-tauri/Cargo.toml`, Bun typecheck, UI build as applicable). Tests/live acceptance remain NOT RUN.
- [ ] Record changed files, source-check commands/results, gaps, and exact source SHA in `docs/implementation/memory-phase-4-1-progress.md`; do not stage unrelated baseline files.

## Handoff

Part 2 may consume classification and Memory operator controls. It must preserve all new contract fields and use persisted native Session identity as the only scope authority.
