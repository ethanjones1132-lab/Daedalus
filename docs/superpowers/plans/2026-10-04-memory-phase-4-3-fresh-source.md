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
# Memory Phase 4.3 — Fresh Workspace Evidence and Revalidation Receipts

## Part scope

Add the current-source revalidation policy and authenticated receipt metadata, then route eligible descriptive/unknown workspace memory through existing current-turn Tool runtime reads and evidence gates. Normative requirements remain user constraints. No durable memory changes occur as a side effect.

## Files and responsibilities

- Create `server-jarvis/src/memory-revalidation.ts`.
- Modify `server-jarvis/src/{memory-contract.ts,native-memory.ts,index.ts}` and `server-jarvis/src/orchestration/{pipeline.ts,session-memory.ts,session-runtime-persistence.ts}`.
- Modify `src-tauri/src/jarvis/memory/{turn.rs,transport.rs}` and the additive migration only as needed for persisted revalidation JSON. Consume Part 4.1 `statement_kind` and Part 4.2 authenticated workspace identity.
- Add freshness fields to UI diagnostic decoding/status data shape only if needed; Part 4.4 owns integrated visible status presentation.

## Interfaces

- Add `MemoryRevalidationPolicy {memory_ids:string[],requires_fresh_workspace_reads:boolean}` and `MemoryRevalidationResult {state:'not_required'|'required'|'fresh_evidence'|'unavailable',memory_ids:string[],evidence_tool_call_ids:string[],reason_code:string|null}` to shared wire types.
- Persist result on native turns with additive `revalidation_json TEXT NOT NULL DEFAULT '{"state":"not_required","memory_ids":[],"evidence_tool_call_ids":[],"reason_code":null}' CHECK(json_valid(revalidation_json))`; expose it in authenticated runtime receipt, `PersistedMemoryTurn`, `MemoryTurnDiagnostic`, and read-back. Validate IDs/reason/state against immutable turn tuple and current Bun generation.
- Add `statement_kind` to prepared selections; old persisted selection decodes as unknown. Build policy from authenticated prepared rows and canonical workspace only; public `/chat/stream` input cannot set it.
- Implement exact named contracts `buildMemoryRevalidationPolicy(selected,workspace)` and `assessMemoryRevalidation(policy,currentCalls,currentEvidence,request,workspace)` over existing `ToolCallRecord`, `MemoryRuntimeEvidence`, and `assessWorkspaceEvidence` semantics.
- Descriptive and unknown project statements are historical context and require current source reads before today's workspace claims. Normative constraints remain constraints, even on conflict. User/Agent preferences do not require workspace reads.
- Bypass the workspace read-result cache and historical same-workspace read hints for this turn only when policy requires freshness. Keep separate TaskRun/check evidence and other scope caches intact. Fresh reads are current, successful, content-bearing canonical read calls tied to this turn/project; cache hits, listing/metadata, hashes alone, checks, model claims, or other turn refs do not qualify.
- Report `fresh_evidence` as availability of a fresh read only. Missing targets, denial, unreadable/deleted source, unsupported CLI evidence or malformed receipt produce observable `unavailable` with a reason; they do not widen permission or auto-save/verify facts.
- Use existing insufficient-evidence behavior before current workspace claims when no eligible fresh source is available. Keep writes, acceptance, checks, TaskPlan and Permission policy unchanged.

## Steps

- [ ] Inspect consumed native envelope, `assessWorkspaceEvidence`, canonical read handlers, warm cache lookup, shared context hints, runtime receipt sync and turn persistence.
- [ ] Implement policy/result decoders and classification-to-policy rules from the parent spec; keep normative/Agent/user and ordinary turns `not_required`.
- [ ] Integrate turn-local cache bypass and historical workspace hint omission for required reads without deleting independent TaskRun/check evidence.
- [ ] Assess only authenticated current-turn content-bearing successful read calls through existing evidence rules; bind recorded tool-call IDs/result to native immutable tuple and generation.
- [ ] Surface unavailable/mismatch status for denial, missing source, scope conflict and unsupported evidence paths. Do not rewrite memory or claim semantic correctness.
- [ ] Check scalar/context budget framing remains within existing Phase 2 caps and recalled data remains unpersisted in histories, summaries, TaskRun facts and reusable caches.
- [ ] Review source against parent Phase 4 Task 5 and matrix. Run only `cargo check`, Bun typecheck/build, UI build if affected, and `git diff --check`. No tests, fixture probes, inference or restart acceptance.
- [ ] Record exact changed files/checks/source SHA and unverified runtime semantics in `docs/implementation/memory-phase-4-3-progress.md`.

## Handoff

Part 4 consumes native revalidation diagnostics and Phase 2/3 turn data for compact UI status, explicit objective controls and truthful evidence handoff. It must label current evidence availability separately from durable memory truth or save receipts.
