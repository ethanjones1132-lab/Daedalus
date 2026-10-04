# Memory Phase 2.4 — Application Integration and Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect native Session turns to live bounded recall through both UI direct SSE and the native relay, expose truthful per-turn status, and persist final authenticated runtime diagnostics before terminal publication.

**Architecture:** Both application transports await native user-message persistence, ask Native for the same prepared-turn contract and native prompt history, then send only references to Bun. The UI owns visible Session transcript and resilient draft/abort behavior; native relay independently derives a persisted Session/source row. Both finalize by syncing authenticated Bun receipt metadata into App SQLite, never treating model success as accepted memory.

**Tech Stack:** React/TypeScript/Vitest (tests proposed only), Tauri 2 Rust commands, existing `JarvisView.tsx` direct `/chat/stream`, `jarvis_commands.rs` and `jarvis/runner.rs` relay, native memory command set from 2.2, Bun stream/status protocol from 2.3.

**Spec:** `docs/superpowers/specs/2026-10-04-memory-four-phase-design.md`; split `docs/superpowers/specs/2026-10-04-memory-phase-2-four-part-design.md`; parent `docs/superpowers/plans/2026-10-04-memory-phase-2-live-recall.md`; predecessors `...phase-2-1-native-turns.md`, `...phase-2-2-trusted-transport.md`, `...phase-2-3-inference-context.md`.

## Global Constraints

- Both native-integrated transports are required: UI direct `/chat/stream` and native relay. Do not implement one as the other or advertise HTTP-only/cron/Agent/MCP memory readiness.
- Each submitted turn gets one `crypto.randomUUID()` turn ID, held stable through all events and terminal sync. Persist user row first; preparation must reference the exact native user message ID.
- UI uses `memory_turn_history` to build model prompt history before source row; operator transcript remains separate and unchanged. Never use UI cached history as inference authority.
- User-wide memory opt-in is explicit, labeled `Include user-wide memory`, per turn, default false, and must not carry to a different Session/Agent silently.
- Request sends references/status only: `turn_id`, `memory_preparation_id`, `initial_memory_status`, plus ordinary chat fields. No envelope, block, scope, capability, or provenance crosses webview.
- Recall failure degrades to ordinary inference with typed visible status. Message persistence failure stays truthful and does not fabricate a saved row. Do not fabricate runtime evidence or accept memory from terminal events.
- Relay and direct terminal finalization syncs identifiers only and occur before terminal done/error publication, with bounded attempt and ordinary inference outcome preserved on sync failure. Cancellation, failure, EOF and absent inference run ID are handled.
- No test files/tests/live SQL/runtime smoke in this execution. Only compile/type/build checks are authorized; document required runtime evidence as NOT RUN and leave parent gate open.

## Review Focus

1. Slow append or preparation must never start inference without the persisted exact row and stable ID; future test `ui_memory_append_then_prepare_then_fetch` in Task 1.
2. Session switch/abort while native work is pending must not leak stale diagnostics or fetched memory; `ui_memory_stale_session_ignores_diagnostics` in Task 1.
3. History failure, preparation failure, or append failure must preserve ordinary inference/draft honesty and avoid fake message/evidence; `ui_memory_failures_keep_inference_usable` in Task 1.
4. Native relay EOF/cancel/error and direct answer without `agent_run_id` must synchronize once before terminal publication; `relay_memory_terminal_sync` in Task 2.
5. UI-visible and native diagnostics must distinguish prepared `selected` IDs from actual `applied_selected_ids`; `ui_memory_status_is_authenticated_metadata` in Task 3.

---

## File Map and Frozen Interfaces

At baseline `dfe39904b8d7fa3ed731e5342e7e80437a6a3b40`, `src-ui/src/components/jarvis/JarvisView.tsx::streamFromJarvisApi` directly calls Bun `/chat/stream`, currently starts `append_message` without awaiting it and passes UI history. The independent native relay is `src-tauri/src/commands/jarvis_commands.rs::jarvis_send_message` through `src-tauri/src/jarvis/runner.rs::run_jarvis_message`; it persists natively and emits relay events. Keep both.

Use 2.2 commands unchanged: `memory_prepare_turn(request) -> MemoryTurnPreparation`, `memory_turn_history(request) -> Vec<PromptHistoryMessage>`, `memory_sync_turn(request) -> MemoryTurnDiagnostic`, `memory_turn_diagnostic(request) -> MemoryTurnDiagnostic`, each request-wrapped. UI decoders are `decodeMemoryTurnPreparation(value): MemoryTurnPreparation` and `decodeMemoryStatusFrame(value): MemoryStatusFrame | null`. Extend `run_jarvis_message(..., turn_id: String, memory_preparation_id: Option<String>, initial_memory_status: MemoryRecallStatus, ...) -> Result<(), String>` only by additive parameters compatible with existing relay semantics. Shared Rust finalizer signature: `finalize_relay_memory_turn(db: &AppDb, transport: &NativeMemoryTransport, identity: MemoryTurnIdentityRequest) -> Result<MemoryTurnDiagnostic, MemoryError>`.

## Tasks

### Task 1: Make UI direct SSE consume a persisted native turn

**Files:** Create `src-ui/src/components/jarvis/memory-turn-state.ts`; modify `src-ui/src/components/jarvis/JarvisView.tsx` and relevant type module; native command imports/types only as needed. Future tests `memory-turn-state.test.ts` and `JarvisView.memory-turn.test.tsx` are not created in this authorized execution.

**Interfaces:** On submit, mint one UUID; preserve the current immediate UI send gate, generation/abort, optimistic message ID reconciliation, draft recovery and duplicate-bubble behavior. Await native append and capture returned `user_message_id`; only then call `memory_prepare_turn` and `memory_turn_history` with native Session/message IDs. If append succeeds but preparation fails, make ordinary fetch with `memory_status` failure and no preparation reference. If history read fails, send empty prior history and a visible history warning, never stale UI cache. Add per-turn user-wide opt-in checkbox/control default false; reset when Session/Agent changes. Send ordinary stream fields plus only `turn_id`, `memory_preparation_id`, and public `memory_status` initial hint. Decode `memory_status` SSE frames; ignore updates for stale Session/turn generations. Before closing the local turn or publishing the final UI state, run one finally-protected native sync using `{session_id,turn_id}`; ensure disconnect/abort/error paths also attempt it. Always append assistant response as today without recalled block.

- [ ] **Step 1: Future UI tests** `ui_memory_append_then_prepare_then_fetch`, `ui_memory_native_history_not_ui_cache`, `ui_memory_failures_keep_inference_usable`, and `ui_memory_stale_session_ignores_diagnostics`. Assert append resolves before prepare/history/fetch; native history excludes current row; fetch transmits references only; one user bubble and same turn ID across frames; opt-in defaults false and clears on Agent/Session switch; append failure makes no fake row; retrieval/register/history errors remain observable and inference usable; stale async completions cannot fetch or repaint another Session.
- [ ] **Step 2: Future command** `(cd src-ui && bun run test -- src/components/jarvis/memory-turn-state.test.ts src/components/jarvis/JarvisView.memory-turn.test.tsx)`; expected PASS. Do not create/run in current source execution.
- [ ] **Step 3: Implement UI sequence and decoders.** Apply native preparation status to the current turn only. Maintain current transport's error/abort/draft semantics. The UI never sees memory text or private capability and never treats SSE `done`, `error`, or `cancelled` as native receipt contents.
- [ ] **Step 4: Authorized source checks** `(cd src-ui && bun run build)` using actual package scripts; expected PASS. Check package.json first to use exact type/build script names; do not invoke tests.

### Task 2: Bring native relay onto the same preparation/history/finalization path

**Files:** Modify `src-tauri/src/commands/jarvis_commands.rs`, `src-tauri/src/jarvis/runner.rs`, and `src-tauri/src/jarvis/types.rs`; use `commands/memory_turn.rs`, `memory/turn.rs`, and `memory/transport.rs` from 2.2.

**Interfaces:** Ensure a real persisted Session exists and obtain its real saved user-message ID before preparing; a blank Session ID cannot become a memory-enabled turn. Use same `memory_prepare_turn` and `history_for_memory_turn` logic as UI. Relay sends reference fields/status to Bun and never serializes the memory envelope/block. Forward `memory_status` as `jarvis://memory-status` preserving turn identity. Add the exact shared `finalize_relay_memory_turn` helper, which calls authenticated `sync_memory_turn` once before `jarvis://done` or terminal error. Invoke it on success, direct answer with no `agent_run_id`, partial, cancellation, failure and stream EOF. Sync failure emits memory-unavailable metadata then preserves ordinary terminal outcome; terminal publication is bounded and cannot hang an inference indefinitely. Include early setup/error paths, cancellation and EOF wherever a persisted turn identity exists. Relay accumulation does not invent applied IDs, selected IDs, evidence, or terminal success.

- [ ] **Step 1: Future Rust tests** `relay_memory_same_preparation_contract`, `relay_memory_terminal_sync`, `relay_memory_no_run_id_direct_answer`, `relay_memory_eof_and_sync_failure_preserve_outcome`. Assert persisted source row is unique, history excludes it, reference-only payload, each terminal branch syncs at most once before terminal event, no run ID still has turn ID, and sync error is observable without rewriting model result.
- [ ] **Step 2: Future command** `cargo test --manifest-path src-tauri/Cargo.toml relay_memory -- --nocapture`; expected PASS; not run now.
- [ ] **Step 3: Refactor relay terminal branches to the shared finalizer.** Preserve existing session-run semantics, abort propagation and channel payloads unrelated to memory. Check all branches (including early setup errors) publish a memory status and stable turn identity where a persisted turn exists.
- [ ] **Step 4: Authorized source checkpoint** `/Users/charlottehughes/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`; expected PASS.

### Task 3: Expose truthful memory-turn diagnostics in both transports

**Files:** Modify `src-ui/src/components/jarvis/memory-turn-state.ts`, `JarvisView.tsx`, and native relay event mapping in `runner.rs`; use the existing `MemoryTurnDiagnostic` metadata DTO. Do not create a Memory UI redesign.

**Interfaces:** Status view must distinguish `MemoryRecallStatus` exact values (`ready`, `empty`, `unavailable`, `retrieval_failed`, `registration_failed`, `expired`, `invalidated`, `scope_mismatch`, `already_consumed`, `budget_omitted`, `applied`) and diagnostic turn states exact frozen values. Show a plain per-turn status and optional selected/applied counts; no memory content, source message, capability, or raw Bun receipt. Prepared selection remains separate from actual applied IDs, which may validly be empty. Native diagnostic read-back remains authority; UI SSE is transient only.

- [ ] **Step 1: Future tests** `ui_memory_status_is_authenticated_metadata`, `ui_memory_applied_is_distinct_from_selected`, `ui_memory_unknown_status_is_safe`, `relay_memory_status_has_no_content`. Assert status decoder rejects malformed/nonobject frames, unknown values degrade to unavailable, IDs/counts sourced only from native diagnostic, no SSE-supplied content or terminal assertion is displayed as persisted success.
- [ ] **Step 2: Future UI command** `(cd src-ui && bun run test -- src/components/jarvis/memory-turn-state.test.ts src/components/jarvis/JarvisView.memory-turn.test.tsx)`; expected PASS; do not run.
- [ ] **Step 3: Implement a compact per-turn status surface** consistent with existing JarvisView feedback; do not add accepted-memory controls/capture/correction/forget behavior from later phases. Read diagnostics only when needed and guard against switched Session.
- [ ] **Step 4: Authorized source checks** `(cd src-ui && bun run build)` and `/Users/charlottehughes/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`; expected PASS.

### Task 4: Inventory integration surface and leave runtime gate honest

**Files:** Create `docs/implementation/memory-phase-2-4-progress.md` as source checkpoint ledger; use a phase-scoped implementation commit and exclude carried planning docs. Do not edit `docs/CURRENT_ROADMAP.md` completion status or claim an evidence gate. Implementation changes remain in owning source files.

**Interfaces:** 2.4 consumes native prep/history/sync and Bun reference-only stream from preceding phases. It finishes app wiring; Phase 2 runtime acceptance still requires actual test and live smoke evidence, which is expressly not authorized here. Ledger stores only actual source revision and command results, with runtime checks explicitly NOT RUN. Do not create synthetic evidence or record fake backend results.

- [ ] **Step 1: Future UI and Rust integration checks** Run only after explicit human authorization: UI memory/history/draft/abort test set, Rust `relay_memory` test set, focused Bun route/inference tests, and available live direct+relay smoke with configured backend. This plan records them as NOT RUN for the current execution.
- [ ] **Step 2: Authorized source checks** `(cd src-ui && bun run build)`, `/Users/charlottehughes/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`, `(cd server-jarvis && bun run typecheck && bun run build)`; expected: PASS before a source integration handoff. These checks are compile/build evidence only.
- [ ] **Step 3: Handoff ledger** Write `docs/implementation/memory-phase-2-4-progress.md` with direct/relay source paths, inspected status/error paths, exact source revision and commands/results, tests/live acceptance NOT RUN/open. Commit scoped 2.4 files only. Preserve the parent Phase 2 Done gate.

## Handoff and Completion Boundary

2.4 source integration is ready when both UI SSE and native relay await a persisted user source row, use the same native preparation/history rules, send references only, expose truthful status, and sync authenticated receipts before terminal publication. This does **not** close the parent Phase 2 done gate. Runtime tests, lifecycle races, live configured-backend smoke, deletion-next-turn behavior, direct/orchestrated route proof, and restart evidence remain open because current instructions prohibit test files/runs and live runtime checks. Do not update roadmap priority completion or start Phase 3.

Planning self-review: covered UI direct SSE distinct from relay, existing Session/abort/draft invariants, user-wide opt-in, native history, typed degradation, terminal finalization, actual metadata distinction, and scope boundary. No tests are represented as run, no user-facing Memory redesign or later-phase capture was added.
