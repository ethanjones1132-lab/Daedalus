# Memory Phase 3.2 — Derived Context Invalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every accepted-memory mutation invalidate unconsumed preparations and sanitize affected prompt-derived state before committing, including late writes and legacy mutation routes.

**Architecture:** Extend the existing capability-authenticated phase 2 mutation gate with an optional derived-state invalidation payload. Bun evicts only memory-derived prompt state and ACKs after durable cleanup; native commits mutation plus suppression/outbox only after that ACK. Native prompt history is sanitized by stable message ID while operator transcripts remain visible. Runtime tool/file/check caches and unrelated TaskRuns keep their current independent lifecycle.

**Tech Stack:** Rust/Tauri, rusqlite, Bun/TypeScript, existing private native-memory transport, React history mapping only if necessary.

**Spec:** `docs/superpowers/specs/2026-10-04-memory-phase-3-four-part-design.md`; parent and Part 3.1 contract: `docs/superpowers/plans/2026-10-04-memory-phase-3-safe-capture.md`, `docs/superpowers/plans/2026-10-04-memory-phase-3-1-native-capture.md`.

## Global Constraints

- Preserve the frozen Phase 2 API `with_memory_mutation_gate<T>(db:&AppDb,transport:&NativeMemoryTransport,reason:&str,now:DateTime<Utc>,mutation:impl FnOnce(&Connection)->Result<T,MemoryError>)->Result<T,MemoryError>`; factor a shared private coordinator that takes the operation mutex once.
- Add `with_memory_derived_mutation_gate<T>(db:&AppDb,transport:&NativeMemoryTransport,invalidation:&MemoryDerivedInvalidation,now:DateTime<Utc>,mutation:impl FnOnce(&Connection)->Result<T,MemoryError>)->Result<T,MemoryError>` and `drain_memory_derived_invalidations(db:&AppDb,transport:&NativeMemoryTransport,now:DateTime<Utc>)->Result<(),MemoryError>`.
- Derived DTO is exactly `{operation_id:String,affected_session_ids:Vec<String>,memory_ids:Vec<String>,source_message_ids:Vec<String>}` mirrored in TS; native namespace key is `session/<session_id>/operation/<operation_id>`.
- Gate ACK happens before SQLite commit. Live owned Bun unknown/unavailable fails closed as `invalidation_unavailable`; never terminate healthy Bun to force success. No network under AppDb mutex and no nested gate.
- Suppress an entire source message if exact spans cannot be proven. Keep operator transcript visible; use exact neutral `[Memory source removed]` in all future model-facing history.
- Late assistant/cache writes from an already-started turn cannot restore stale memory context. Drain durable invalidation outbox before serving history/preparation.
- Clear only memory-derived conductor/prompt state; preserve independent tool results, file snapshots, check evidence, permissions, and unrelated Session TaskRuns.
- No tests are added or run under current instructions. Regression scenarios are **NOT RUN / requires explicit user request**. Only source checks/build/typecheck/diff checks are authorized.

## Review Focus

1. Mutation failure cannot commit when Bun fails to ACK cleanup. **NOT RUN:** future `capture_mutation_invalidation_failure_is_no_commit`.
2. Suppression preserves visible transcript while preventing prompt resurrection. **NOT RUN:** future `capture_forget_sanitizes_future_prompt_history`.
3. Late started-turn persistence cannot reintroduce old context. **NOT RUN:** future `capture_forget_late_assistant_and_cache_write_stay_suppressed`.
4. Affected-session cleanup does not erase independent tool/check caches or unrelated TaskRuns. **NOT RUN:** future `memory_derived_invalidation_is_scoped_and_idempotent`.
5. Compaction never reintroduces raw forgotten source into model context. **NOT RUN:** future `capture_forget_compaction_cannot_resurrect`.

---

## Frozen contracts and predecessor interface

Consume Part 3.1 DTOs and helpers: `capture_recorded_turn(conn:&Connection,turn:&PersistedMemoryTurn,now:DateTime<Utc>)->Result<CaptureReceipt,MemoryError>`, `correct_scoped_memory(...)`, `forget_scoped_memory(...)`, `stage_memory_proposal(...)`, `suppress_memory_sources(conn:&Connection,scope:&MemoryScope,memory_ids:&[String],now:DateTime<Utc>)->Result<Vec<String>,MemoryError>`, and `memory_derived_invalidations` outbox. Capture grammar is only the whole trimmed user message with a single fixed directive: `Remember:`, `Remember that`, `Constraint:`, `Decision:`, `Correct memory <id>@<revision>:`, `Forget memory <id>@<revision>`, `Accept memory proposal <id>`; ordinary text yields no operation, ambiguous/quoted/multiple text is pending. User source alone admits facts, generic verified observations stay unsupported.

Native phase 2 envelope/receipt remain private capability-only. Do not alter `sync_memory_turn(db,transport,request,now)` semantics or payload trust. Correction/forget and all legacy scoped memory/binding mutation paths must use the new gate. Store one outbox row in the same savepoint as the native mutation/suppressions; only mark it acknowledged after the Bun cleanup response.

## File Map

- Modify `src-tauri/src/jarvis/memory/transport.rs`: add DTO, extend private transport request, share gate implementation, add drain function.
- Modify `src-tauri/src/jarvis/memory/turn.rs`: add suppression-aware history serializer while retaining public history command behavior.
- Create `src-tauri/src/commands/memory_capture.rs` for command executors/registration inputs where separation fits existing command layout; otherwise keep the same named capture command module/responsibility in `commands/memory.rs`. Modify `lib.rs` to register `memory_capture_turn`, `memory_capture_receipts`, `memory_scoped_correct`, `memory_scoped_forget`, and `memory_stage_proposal` now that safe gating exists.
- Modify `src-tauri/src/jarvis/memory/continuity.rs`, `capture.rs`, existing scoped-memory command handlers, and `commands/sessions.rs`: exact suppression/outbox and route every relevant legacy mutator through gate.
- Modify Bun `server-jarvis/src/memory-contract.ts`, `native-memory.ts`, `memory-derived-state.ts` (create), `orchestration/persistent-conductor.ts`, `session-memory.ts`, `session-runtime-persistence.ts`, and relevant chat/history serializers.
- Modify `sessions.rs::compact_session_db` so compaction's model-facing summary input is sanitized; do not remove or rewrite visible transcript rows.
- Existing runtime cache fields have separate ownership; do not clear tool results/file snapshots/check evidence or unrelated TaskRuns.

## Task 1: Implement capability-only derived cleanup and shared mutation gate

**Files:** `transport.rs`, Bun `memory-contract.ts`, `native-memory.ts`, create `memory-derived-state.ts`.

**Interfaces:** `MemoryDerivedInvalidation{operation_id,affected_session_ids,memory_ids,source_message_ids}`; Bun's frozen export is `invalidateMemoryDerivedState(input:MemoryDerivedInvalidation):void`. It must synchronously finish its required persistence before returning; on cleanup failure it throws and the private HTTP route withholds ACK. No fire-and-forget cleanup may produce ACK. Export the exact Rust gate and drain signatures from Global Constraints.

- [ ] **Step 1: Add Rust/TS wire DTO.** Permit it only on authenticated internal native routes. Do not expose memory/source contents, scope paths, or capability in HTTP/public chat/health/log surfaces.
- [ ] **Step 2: Factor the existing gate body.** Private coordinator acquires operation mutex once, ACKs phase 2 unconsumed-preparation invalidation, ACKs derived cleanup, releases all network work, then locks AppDb, marks pending turns invalidated, and invokes mutation callback. The public Phase 2 `with_memory_mutation_gate` retains its signature for non-semantic compatibility uses. Every knowledge/scope mutator—including existing broad `run_gated_mutation` callers that delete/update/restore/adopt scoped rows—must collect its affected Session/memory/source IDs and use a derived payload; `derived:None` is not a bypass for semantic mutations.
- [ ] **Step 3: Implement Bun idempotent cache cleanup.** Namespace operation IDs by Session; repeated same key is a no-op. Evict only memory-derived prompt state for listed affected Sessions and synchronously complete required durable cleanup before return/ACK. Do not clear tool results/file snapshots/checks or independent TaskRun contracts.
- [ ] **Step 4: Implement durable outbox drain before history/preparation.** Send pending cleanup without AppDb lock; ACK is persisted natively only after authenticated Bun success. Unknown/live process errors fail closed; confirmed exited/replaced generation may safely discard that generation's ephemeral registry, but durable outbox remains for restart/retry.
- [ ] **Step 5: Run source checks.** From repository root run `cargo check --manifest-path src-tauri/Cargo.toml`; from `server-jarvis/` run `bun run typecheck`; then from repository root run `git diff --check`. Future gate failure scenarios are **NOT RUN / requires explicit user request**.

## Task 2: Suppress invalidated source in native history and legacy summaries

**Files:** `turn.rs`, `commands/sessions.rs`, `continuity.rs`, `capture.rs`, Bun persistent-conductor/history/session persistence serializers.

**Interfaces:** Keep `history_for_memory_turn(conn:&Connection,session_id:&str,before_message_id:&str)->Result<Vec<PromptHistoryMessage>,MemoryError>` shape `{id,role,content}` and operator `get_session_history` unchanged. Add/use suppression-aware model history path that replaces content with exact `[Memory source removed]` for suppressed IDs.

- [ ] **Step 1: Collect exact affected source IDs.** Use memory provenance and proposal audit lineage; include assistant messages mapped to turns whose applied selected IDs contain invalidated memories, conservatively include prepared selections when application evidence is missing. When spans cannot be proven, suppress whole message.
- [ ] **Step 2: Sanitize all future native prompt-history paths.** UI direct preparation and native relay receive identical stable ID/role rows with neutral marker for suppressed messages. Keep original operator transcript and exports visible.
- [ ] **Step 3: Sanitize native compaction input.** In `compact_session_db`, construct summary from sanitized model-facing history; existing unsanitized old summary/decisions/next_steps for affected Session are cleared under the gated mutation and never used to generate a new summary. Preserve transcript.
- [ ] **Step 4: Remove stale Bun prompt derivatives.** Discard affected conductor conversation/compaction/prompt-cache copies so they rebuild from sanitized native history. Remove accepted-memory-origin discovered facts. Discard untyped legacy discovered facts only in affected scope. If TaskRun text references suppressed source/untyped legacy summary, mark textual reconstruction required and rebuild from structured objective plus sanitized history; preserve independent executed-tool/check evidence and unrelated TaskRuns.
- [ ] **Step 5: Preserve objective dependency semantics.** If the active objective lists a forgotten memory ID in `depends_on_memory_ids`, clear it with an explicit continuity event; otherwise preserve it. Restoring a memory never removes suppression; restored facts re-enter through fresh recall.
- [ ] **Step 6: Run `cargo check`, Bun typecheck, and `git diff --check`.** Future sanitized-history and compaction scenarios are **NOT RUN / requires explicit user request**.

## Task 3: Route all semantic mutation paths and block late persistence

**Files:** `commands/memory_capture.rs` or `commands/memory.rs`, `lib.rs`, scoped memory commands/helpers and binding/adoption/delete/update/restore routes, `commands/sessions.rs`, `turn.rs`, `transport.rs`, Bun native-memory persistence handlers.

- [ ] **Step 1: Prepare metadata before gate, revalidate inside callback.** Resolve exact target/session/scope/revision, affected Sessions, memory IDs, and source IDs before network. Inside callback re-read and validate expected row revision, then atomically insert suppression, outbox and mutation/ledger. A stale revision or failed cleanup writes nothing.
- [ ] **Step 2: Add replay-before-invalidation capture orchestration.** Before entering the gate, check `read_capture_receipt(conn,session_id,turn_id)` and exact operation ledger. For an exact already-committed replay, return original JSON/revision without invalidating. For a new or terminal-augmentation operation, enter the derived gate; recheck key, source tuple, and target revision inside the transaction to close races.
- [ ] **Step 3: Route correction, forget, proposal acceptance, explicit capture, continuity setter (Part 3.4), and legacy/manual scoped memory/binding mutation routes through one shared gate.** Audit every command path including existing broad run-gated callbacks, legacy delete/update/restore/adoption and phase 1 scoped manual APIs. Each semantic path provides affected IDs; usage-only recall counters are not semantic mutations and do not invalidate.
- [ ] **Step 4: Add persistent per-Session invalidation watermark.** Persist watermarks across Bun restart. Reject or sanitize late assistant append/cache persistence from any earlier started snapshot for that Session if its generation/watermark predates invalidation, even when its applied IDs appear unrelated/incomplete. Preserve late assistant response in visible transcript when valid; prompt derivatives contain neutral marker/are rebuilt.
- [ ] **Step 5: Drain cleanup before every next preparation/history read.** A cleanup failure returns typed unavailable instead of serving stale derived context. No new inference timeout is added.
- [ ] **Step 6: Audit runtime state separation.** Preserve independent TaskRuns, tool results, file snapshots, checks, evidence, grants and permissions unless that exact field is proven memory-derived. No broad Session cache reset.
- [ ] **Step 7: Run `cargo check`, Bun typecheck/build checks available to changed packages, and `git diff --check`.** Future late-write/cache-scope scenarios are **NOT RUN / requires explicit user request**.

## Task 4: Part handoff

- [ ] **Step 1: Inspect every `MemoryDraft`/scope mutation call site and verify gate use before any write.** Confirm mutation callback cannot run until preparation invalidation plus derived ACK.
- [ ] **Step 2: Record exact interfaces for Part 3.3.** `memory_capture_turn` invokes the safe phase 2 sync then commits through the same derived gate; `memory_capture_receipts` is read-only; no relay/UI lifecycle caller exists until 3.3.
- [ ] **Step 3: Run source checks.** From repository root run `cargo check --manifest-path src-tauri/Cargo.toml`; from `server-jarvis/` run `bun run typecheck`; from `src-ui/` run `bun run build` only if UI history mapping changed; then from repository root run `git diff --check`. Keep capture/restart/runtime acceptance gates open.

## Completion Boundary

3.2 is source-complete when every knowledge/scope mutation blocks without ACK, suppression/outbox is atomic and drained before future model history/preparation, compaction and Bun derived prompt copies cannot resurrect suppressed sources, late writes respect the watermark, and unrelated TaskRun/tool/check state remains intact. Tests and runtime behavior remain unverified.
