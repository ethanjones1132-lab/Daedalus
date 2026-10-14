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
# Memory Phase 4.4 — Turn Status, Continuity UX, and Source Handoff

## Part scope

Integrate actual prepared/applied memory, native capture receipts, revalidation results and explicit active-objective continuity in the Session UI. Finish the Phase 4 source handoff with accurate roadmap and progress records. Real demonstrations and test gates are not executed in this authorization and remain open.

## Files and responsibilities

- Create `src-ui/src/components/jarvis/MemoryTurnStatus.tsx`; extend production `memory-control-state.ts`; integrate `src-ui/src/components/jarvis/JarvisView.tsx` after native preparation/sync/capture finalization.
- Reuse existing `memory_turn_diagnostic`, `memory_capture_receipts`, `memory_continuity_read`, and `memory_continuity_set`; add no new transport or polling loop.
- Modify `docs/implementation/memory-phase-4-{1,2,3}-progress.md`, create `docs/implementation/memory-phase-4-4-progress.md` and `docs/implementation/memory-phase-4-summary.md`, and update `docs/CURRENT_ROADMAP.md` only to report source status and clearly open runtime gates.
- Copy the four plans, part breakdown and final status docs to project `outputs/` for user review. Do not modify preexisting unrelated dirty baseline documents.

## Interfaces

- `MemoryTurnStatus({session_id,turn_id,diagnostic,receipt,continuity,read_error})` distinguishes prepared candidates from actual applied IDs. Only native `applied_selected_ids` (union across stages/attempts) may be labeled “used”; a current preview/list is never substituted for a historical turn snapshot.
- Decode receipts and continuity with strict validation. Unknown/malformed/missing reads display unavailable or pending, never empty/saved/ready.
- Show scoped turn identity, prepared and applied IDs/provenance/revision, per-stage status if available, capture receipt separately, revalidation state/IDs/reason, and confirmed active objective. Keep visible transcript distinct from prompt suppression.
- Set/Clear/Resume are explicit native continuity operations. Set uses an existing persisted user message and native substring validation; ordinary questions, corrections and cancellation preserve objective. Resume follows normal turn transport. Never infer goal from assistant output.
- Capture status requires native committed receipt; assistant acknowledgement cannot confirm save. A null receipt is unavailable, not a zero-save result. On Session switch, bind asynchronous read to immutable Session/turn and discard stale response.

## Steps

- [ ] Integrate `MemoryTurnStatus` into the existing Session activity/status area. Preserve run status, transcript, drafts, Session-switch race protection and no-duplicate operation identity.
- [ ] Show actual application separately from prepared selection, with `applied_selected_ids` as authoritative; show fresh-source status separately from accepted/descriptive statement meaning.
- [ ] Read native capture receipt and objective after existing finalization and on reopening Session; do not introduce repeated capture or polling that mutates state.
- [ ] Wire explicit objective set/clear/resume actions through existing native continuity commands and revision/source contracts.
- [ ] Do final full production-source review against all six parent Phase 4 tasks, accepted design, preserved Phase 1–3 contracts, all parts' review risks, and dirty baseline. Resolve load-bearing findings through the same DeepSeek executor before source checkpoint.
- [ ] Run permitted final source checks only: Cargo check, Bun typecheck, server build, UI build, and `git diff --check`. Do not add/run tests or live acceptance. Store exact check outputs keyed to source SHA.
- [ ] Update canonical roadmap/status and Phase 4 summary to say source implemented/compiled only; mark scripted, live inference, cross-Session/restart, packaging, and all test gates **NOT RUN** and keep priority #1 completion unchecked. Do not start priorities #2–#5.
- [ ] Copy user-facing plans and final handoff/breakdown/status to `outputs/`; produce precise final SHA/evidence and limitations.

## Completion gate

The Phase 4 source work is complete only when all four reviewed source checkpoints exist and final compiler/type/build/diff checks pass on the final source SHA with no open source-review blockers. This does not satisfy the roadmap #1 done gate: tests and all actual-inference/restart scenarios remain NOT RUN, so #1 stays active and no runtime-complete claim is allowed.
