# Memory Phase 3.3 — Turn Capture Lifecycle and Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture each recorded user instruction across UI direct SSE and native relay exits, associate actual assistant messages with the original turn, and report only durable, truthful receipts.

**Architecture:** Extend the existing whole-lifecycle finalizers rather than adding another transport. Direct SSE keeps UI-owned message persistence; native relay persists its accumulated successful assistant answer through one native helper before capture and returns its DB message ID in the terminal event so UI does not duplicate the append. Both paths retain the immutable original Session/turn identity and try authenticated phase 2 sync plus capture even when assistant append or sync fails. Keep one whole 5-second finalization bound per path: relay sync+append+capture shares its existing 5-second wait; direct UI append+sync+capture shares one 5-second race. A timeout returns pending/unavailable without a late UI repaint or changed terminal inference result.

**Tech Stack:** Rust/Tauri commands and native relay, React/TypeScript direct SSE, Bun/Rust memory contract, SQLite.

**Spec:** `docs/superpowers/specs/2026-10-04-memory-phase-3-four-part-design.md`; predecessor contracts in `docs/superpowers/plans/2026-10-04-memory-phase-3-1-native-capture.md` and `.../2026-10-04-memory-phase-3-2-derived-invalidation.md`; parent `docs/superpowers/plans/2026-10-04-memory-phase-3-safe-capture.md`.

## Global Constraints

- Use `PersistedMemoryTurn` immutable source/scope/hash; `run_id` and terminal are nullable. No public input can set terminal state, Agent/project scope, assistant evidence, or provenance.
- Preserve existing Phase 2 `sync_memory_turn(db,transport,request,now)` and `runner::finalize_relay_memory_turn(db,transport,identity)->Result<MemoryTurnDiagnostic,MemoryError>` externally; extend helper internals or add a sibling capture finalizer without breaking relay diagnostics.
- Capture after terminal/stream exit, never between registration and stream consumption. One turn may receive one terminal receipt; exact replay is no-op; conflicting source/terminal tuple is `operation_conflict`.
- UI direct SSE and native relay must both capture for complete, partial, cancelled, error, session-switch, no-assistant, timeout, and null-run outcomes, always using the original turn IDs.
- UI confirmation requires a committed receipt. No assistant prose acknowledgement. Blocked-only/error receipt maps to failed; unresolved operation maps to pending; saved only with committed saved_count > 0; otherwise unchanged.
- Late success cannot replace a finalized cancelled/unterminated receipt. Capture failure cannot alter normal inference completion/publication; failure is observable metadata only.
- No tests are added or run under current instructions. Listed future regression scenarios are **NOT RUN / requires explicit user request**.

## Review Focus

1. Sync error does not skip eligible capture from immutable saved user source. **NOT RUN:** future `capture_sync_failure_still_commits_explicit_source`.
2. Session switch/cancel cannot redirect capture to current UI Session. **NOT RUN:** future `capture_ui_session_switch_uses_original_identity`.
3. Duplicate finally/recovery calls cannot duplicate receipt or writes. **NOT RUN:** future `capture_same_turn_replay_is_exact_noop`.
4. Relay/UI time bounds cannot be exceeded or late repaint a finalized result. **NOT RUN:** future `memory_finalize_one_bound_no_late_repaint`.
5. Assistant association verifies same Session/turn but never confers fact authority. **NOT RUN:** future `capture_assistant_turn_association_rejects_foreign_session`.

---

## Frozen interfaces and replay rules

Native command exact requests: `CaptureTurnRequest{session_id,turn_id}` for `memory_capture_turn -> CaptureReceipt`; `CaptureReceiptsRequest{session_id,turn_id}` for read-only `memory_capture_receipts -> Option<CaptureReceipt>`. Commands accept one request DTO plus injected state; no terminal/evidence/provenance inputs. `CaptureOperationReceipt{operation_id,status,memory_id,replacement_id,reason_code}` status `saved|forgotten|corrected|pending|blocked`; `CaptureReceipt{turn_id,session_id,terminal_status,operations,store_revision,continuity_revision,saved_count,pending_count}`. Exact saved/changed receipt JSON is replayed. Terminal tuple hash binds phase 2 status, bound IDs/hash, generation, terminal timestamps/run ID/evidence refs. Preterminal receipt may be augmented once without rerunning mutations; identical terminal replay is no-op; conflicting source/status fails; late success never upgrades finalized unterminated/cancelled.

Source grammar stays: exact whole trimmed user text `Remember: <text>`, `Remember that <text>`, `Constraint: <text>`, `Decision: <text>`, `Correct memory <id>@<revision>: <text>`, `Forget memory <id>@<revision>`, `Accept memory proposal <id>` (fixed prefix case-insensitive). Only persisted user text admits facts. Generic verified observation unsupported; assistant text can only be exact-substring staged proposal, excluded until later exact same-Session acceptance. Operation id `turn/<turn_id>/user/0`; versioned SHA-256 canonical input and conflict behavior from Part 3.1.

Bounded waits are source contracts: `runner.rs::RELAY_MEMORY_FINALIZE_TIMEOUT_MS` stays 5,000 ms for the whole relay sync+assistant append+capture attempt, not 5 seconds per substep; its background worker returns data only and emits no late diagnostic. UI's whole finalization race remains one 5,000 ms timeout shared by direct assistant append+sync+capture; after timeout neither status nor active Session is repainted by worker completion. For relay, terminal event includes the returned DB assistant ID (nullable); UI uses it to suppress duplicate append while still finalizing local transcript state. Preserve existing ownership of ordinary terminal delivery and abort/history/draft behavior.

## File Map

- Modify `src-tauri/src/jarvis/memory/capture.rs`, `transport.rs`, `commands/memory.rs`, `commands/sessions.rs::append_message`, `src-tauri/src/lib.rs`.
- Modify `src-tauri/src/jarvis/runner.rs` finalization helper, `TerminalRunAccumulator`, and terminal event payload; the runner owns relay assistant append using accumulated successful output and `commands::sessions::insert_message_row` with turn association. Emit `{session_id,turn_id,assistant_message_id}` (nullable) on terminal event so UI suppresses duplicate append.
- Modify `src-ui/src/components/jarvis/JarvisView.tsx` direct `streamFromJarvisApi` finalization, relay terminal adapter and existing capture status projection; create `src-ui/src/components/jarvis/memory-capture-state.ts`. Move `append_message` out of `setMessages` updater into an explicit awaited coordinator; direct UI owns direct append, native runner owns registered relay append. Reuse phase 2 preparation identity.
- Modify `server-jarvis/src/memory-contract.ts` only if exact DTO parity is needed; no independent capture store/route.

## Task 1: Commit one recorded source with idempotent terminal receipt

**Files:** `capture.rs`, `commands/memory.rs`, `turn.rs`/`transport.rs` only as necessary.

**Interfaces:** Implement/consume `capture_recorded_turn(conn:&Connection,turn:&PersistedMemoryTurn,now:DateTime<Utc>)->Result<CaptureReceipt,MemoryError>` and `read_capture_receipt(conn:&Connection,session_id:&str,turn_id:&str)->Result<Option<CaptureReceipt>,MemoryError>`. Tauri async `memory_capture_turn(request:CaptureTurnRequest)` attempts private sync, re-reads immutable turn, and invokes safe Part 3.2 derived mutation gate without holding AppDb mutex during HTTP.

UI state interface is exactly `captureReceiptState(receipt:CaptureReceipt|null,errorCode:string|null):{state:'saved'|'pending'|'unchanged'|'failed';savedCount:number}` in `memory-capture-state.ts`; do not add/modify its test file under current validation instructions.

- [ ] **Step 1: Implement lifecycle admission table.** For `completed|partial|cancelled|failed|unterminated`, commit only eligible user operations independent of inference outcome. For prepared/invalidated/expired/unavailable with no start, a recorded explicit instruction may commit but receipt terminal stays null until authoritative recovery. No assistant fact is admitted; no run ID is fabricated.
- [ ] **Step 2: Implement sync-failure behavior.** Always attempt capture from an existing immutable native turn even if private phase 2 sync fails. Return committed user admission and separately emit metadata-only `capture_unavailable` diagnostic when sync failed; do not add that diagnostic to the frozen `CaptureReceipt` DTO. Do not admit assistant/proposal evidence unless it is authenticated and tied to an existing terminal record. Storage or mutation-gate failure returns error and no save confirmation.
- [ ] **Step 3: Implement terminal ledger.** Enforce `(session_id,operation_id)`, `turn_id` unique capture receipt, canonical SHA-256, exact response replay, and terminal tuple conflict behavior. Lookup exact replay before attempting mutation invalidation; recheck uniqueness inside transaction. Add no second inference deadline.
- [ ] **Step 4: Implement receipt projection.** saved_count counts `saved|corrected`; pending_count counts only `pending`; blocked never confirms save. Implement the exact `captureReceiptState` interface above: capture error or blocked-only -> `failed`; unresolved operation -> `pending`; committed saved_count > 0 -> `saved`; otherwise `unchanged`.
- [ ] **Step 5: Check Rust/Bun compiler/types and `git diff --check`.** Terminal matrix, sync-error, replay/conflict scenarios are **NOT RUN / requires explicit user request**.

## Task 2: Associate actual assistant append with its originating turn

**Files:** `commands/sessions.rs::append_message` and internal insert helper; UI and relay append callsites.

**Interfaces:** Preserve existing Tauri append arguments for callers, add optional `memory_turn_id:Option<String>` defaulting to `None`. When supplied for an assistant message, validate persisted Session/turn identity and insert the actual generated message ID into `memory_turn_messages` in the same SQLite transaction as the append. Native relay calls `insert_message_row` through the equivalent transaction-aware helper; direct SSE calls the Tauri command. Reject cross-Session or non-assistant associations. This is transcript association only, never factual verification.

- [ ] **Step 1: Implement optional same-transaction association.** Use a new transactional internal helper; callers that omit turn ID retain existing behavior.
- [ ] **Step 2: Make direct SSE UI final assistant append await completion before capture.** Extract finalized text/identity outside the React state updater; carry original `{session_id,turn_id}` values rather than current selection; if assistant text is absent or append fails, continue to sync and capture from saved user source with no assistant association.
- [ ] **Step 3: Make relay runner own one append.** Accumulate emitted answer text independently from UI React state (including aggregate `ResultThenDone` token); after sync identifies a completed terminal and before capture, append the assistant row with original Session/turn atomically associated. Add returned assistant row ID to terminal event. UI suppresses duplicate DB append for that exact registered relay turn while updating visible message state; no second native/UI append.
- [ ] **Step 4: Prevent stale association.** On a late append after suppression, resolve current suppressed dependencies within the same transaction and write matching suppression/watermark before it can enter future model history; preserve visible transcript.
- [ ] **Step 5: Run Rust/Bun compiler/type/build checks and `git diff --check`.** Association and late append scenarios are **NOT RUN / requires explicit user request**.

## Task 3: Extend native relay whole-lifecycle finalizer with one 5-second bound

**Files:** `src-tauri/src/jarvis/runner.rs`, capture command/helper as needed.

- [ ] **Step 1: Extend finalization worker to sync, append (when authoritative completed and output nonempty), then capture.** Keep `finalize_relay_memory_turn(db,transport,identity)->Result<MemoryTurnDiagnostic,MemoryError>` source-compatible or add an internal sibling returning the diagnostic plus nullable appended assistant message ID. Use explicit independent error branches/finally semantics so capture still dispatches if sync or append fails, against original immutable user source. Preserve sync/append/capture failures in metadata; ordinary terminal still publishes exactly once.
- [ ] **Step 2: Enforce one whole 5-second wait.** Keep `RELAY_MEMORY_FINALIZE_TIMEOUT_MS=5_000` as aggregate wait across synchronization, optional append and capture, not sequential per operation. Worker only sends result; timeout path publishes typed pending/unavailable before ordinary terminal, and worker has no late emit/repaint side effect. Include nullable assistant message ID in the same terminal event, so UI has exact duplicate-append ownership information.
- [ ] **Step 3: Invoke on every exit.** Cover success, partial, error, cancellation, no assistant, and null terminal/run paths; preserve stale guards and original identity across Session switches. Same turn replay uses the ledger.
- [ ] **Step 4: Run Rust `cargo check` and `git diff --check`.** Relay lifecycle/replay/timeout scenarios are **NOT RUN / requires explicit user request**.

## Task 4: Extend UI direct SSE finalization with a shared bound

**Files:** `src-ui/src/components/jarvis/JarvisView.tsx` and existing status projection.

- [ ] **Step 1: Capture original turn identity in finalizer closure/relay adapter.** Ensure `finally`, abort, SSE fetch/read error, session switch, component teardown and native relay terminal adapter reference the prepared turn and source Session, never a later selected Session.
- [ ] **Step 2: Move append out of `setMessages` updater and await persistence.** Direct UI owns direct assistant append with `memory_turn_id`; runner owns correlated relay append and the event's DB row ID prevents duplicate UI append. If append or sync fails, always dispatch capture from the persisted immutable user turn rather than skipping it through a rejected Promise chain.
- [ ] **Step 3: Share one 5-second direct-path finalization race across append, sync and capture.** On timeout, render pending/unavailable before ordinary terminal cleanup; ignore late completion for UI state. Preserve existing 5-second bound; no second timer/reset.
- [ ] **Step 4: Retain every direct SSE branch.** Cover user abort, fetch rejection, decoder/read error, terminal and no-terminal exit, duplicate finally, switch/unmount; capture status must not change assistant response/history/permission behavior.
- [ ] **Step 5: Run UI `bun run build`, Bun typecheck, and `git diff --check`.** UI lifecycle/switch/timeout/duplicate append scenarios are **NOT RUN / requires explicit user request**.

## Task 5: Recovery and end-to-end source handoff

- [ ] **Step 1: Extend startup/recovery sweep.** For unfinalized phase 2 records, distinguish never-started null-terminal preparation from started generation loss (`unterminated`). Capture recorded explicit source idempotently; never infer facts from summaries or run success.
- [ ] **Step 2: Confirm command registration and read-only receipt access.** Register exact DTO command table; `memory_capture_receipts` reads committed receipt only and cannot synthesize one.
- [ ] **Step 3: Run allowed source checks.** From repository root run `cargo check --manifest-path src-tauri/Cargo.toml`; from `server-jarvis/` run `bun run typecheck`; from `src-ui/` run `bun run build`; then from repository root run `git diff --check`. No tests or live experiments run; all such gates remain open.
- [ ] **Step 4: Record explicit handoff to Part 3.4.** Freeze capture command/receipt DTOs, UI state semantics, nullable lifecycle tuple, and terminal hash replay behavior.

## Completion Boundary

3.3 is source-complete when direct SSE and relay paths persist actual assistant association before capture where present, always admit only recorded user directives, sync+capture failures remain observable, repeated/late calls follow immutable terminal rules, and the existing whole-path 5-second bound cannot produce late status changes. Runtime and test acceptance remain open.
