# Memory Phase 3.1 — Native Capture Persistence and Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add additive native persistence and transactional primitives for explicit capture, correction, forgetting, proposal acceptance, and suppression without enabling live unsafe callers.

**Architecture:** Rust/App SQLite remains the only accepted-memory authority. This part creates operation/receipt/continuity storage, deterministic parsing, exact provenance validation, and composable savepoint operations; it does not wire lifecycle callers before 3.2 has installed invalidation gates. Assistant proposals remain ineligible until a later exact user acceptance.

**Tech Stack:** Rust, Tauri, rusqlite/SQLite, serde, SHA-256, existing Bun memory wire types.

**Spec:** `docs/superpowers/specs/2026-10-04-memory-phase-3-four-part-design.md`; parent contract: `docs/superpowers/plans/2026-10-04-memory-phase-3-safe-capture.md`.

## Global Constraints

- Only native saved user source may admit accepted factual knowledge; generic `verified_observation` capture remains unsupported.
- Use phase 1 `with_memory_savepoint`, `save_scoped_memory`, `read_scoped_memory`, `tombstone_scoped_memory`, and `memory_store_revision`; inner results remain provisional until the outer savepoint releases.
- Automatic capture scope comes only from immutable phase 2 `PersistedMemoryTurn`; no public DTO accepts Agent, project root, terminal outcome, assistant evidence, recalled text, or arbitrary provenance.
- One savepoint covers each memory mutation, audit, source suppression, continuity effects, and operation ledger. Exact retries return the persisted original response; mismatched payloads return `operation_conflict` without partial writes.
- Correction replacement points `supersedes_id` to the old row; do not reuse the legacy tombstone helper's backwards relationship argument.
- Part 3.1 creates primitives but does not activate a live mutation/capture command until Part 3.2 routes it through `with_memory_mutation_gate` or `with_memory_derived_mutation_gate`.
- Never persist rejected secret content in diagnostics; retain existing transcript visibility and permissions.
- No tests are added or run under current instructions. Regression scenarios below are **NOT RUN / requires explicit user request**. Use compiler/type/build/diff checks only when implementing.

## Review Focus

1. Ambiguous or quoted directives cannot mutate accepted memory. **NOT RUN:** future regression scenario `capture_admission_ambiguous_or_quoted_is_pending`.
2. Assistant prose and successful tools cannot establish verified facts. **NOT RUN:** future `capture_verified_observation_rejects_runtime_success_only`.
3. Reused operation IDs cannot duplicate or change successful mutations. **NOT RUN:** future `capture_manual_mutation_retry_returns_original_result`.
4. Scope rebinding cannot move historical facts or authorize cross-scope targets. **NOT RUN:** future `capture_source_foreign_session_rejects`.
5. Old summary-derived objectives cannot seed new typed continuity. **NOT RUN:** future `capture_migration_repeats_without_promoting_old_summary`.

---

## Frozen contracts shared by Parts 3.1–3.4

Consume exact phase 1 types from `memory/contracts.rs`: `MemoryScope`, `ScopeSelector`, `MemoryDraft`, `MemoryProvenance`, `ScopedMemoryEntry`, `MutationResult`, `MemoryError`; and `scoped::{save_scoped_memory,read_scoped_memory,tombstone_scoped_memory,memory_store_revision,with_memory_savepoint}`. Consume phase 2 `MemoryTurnIdentityRequest`, `MemoryTurnTerminalStatus`, and `turn::read_memory_turn(conn:&Connection,session_id:&str,turn_id:&str)->Result<PersistedMemoryTurn,MemoryError>`. The turn snapshot owns immutable source message ID/content/hash/scope/workspace/store revision/selections/generation; nullable `run_id` and terminal are legitimate.

Exact new command contracts (wired only after safe gate integration): `memory_capture_turn(CaptureTurnRequest{session_id,turn_id})->CaptureReceipt`; `memory_capture_receipts(CaptureReceiptsRequest{session_id,turn_id})->Option<CaptureReceipt>`; `memory_scoped_correct(ScopedCorrectRequest{session_id,selector,id,expected_revision,draft,operation_id})->CorrectionResult`; `memory_scoped_forget(ScopedForgetRequest{session_id,selector,id,expected_revision,reason,operation_id})->ForgetResult`; `memory_stage_proposal(StageProposalRequest{session_id,turn_id,assistant_message_id,draft,operation_id})->MutationResult`; `memory_continuity_read(ContinuityReadRequest{session_id})->SessionContinuity`; `memory_continuity_set(ContinuitySetRequest{session_id,expected_revision,source_message_id,objective,operation_id})->SessionContinuity`. Each Tauri command receives one `request` object plus injected native state, and each request denies unknown fields.

DTOs: `CaptureOperationReceipt{operation_id,status,memory_id,replacement_id,reason_code}` where status is `saved|forgotten|corrected|pending|blocked`; `CaptureReceipt{turn_id,session_id,terminal_status,operations,store_revision,continuity_revision,saved_count,pending_count}`; `CorrectionResult{previous,replacement,store_revision,changed}`; `ForgetResult{memory,store_revision,changed,suppressed_message_ids}`; `ActiveObjective{text,source_message_id,source_turn_id,depends_on_memory_ids}`; `SessionContinuity{session_id,active_objective,latest_turn_id,revision}`. Errors add `operation_conflict`, `invalid_acceptance`, `unsupported_verification`, `capture_unavailable`, preserving `invalidation_unavailable`.

Grammar is exactly one entire trimmed user message, fixed prefix case-insensitive and payload nonempty: `Remember: <text>`, `Remember that <text>`, `Constraint: <text>`, `Decision: <text>`, `Correct memory <id>@<revision>: <text>`, `Forget memory <id>@<revision>`, `Accept memory proposal <id>`. Sources: `explicit_remember`, `explicit_constraint`, `explicit_decision`, `explicit_correction`, `explicit_forget`, `accepted_proposal`. Preserve payload Unicode; title is first 80 Unicode scalars; tags empty; category `project` for project scope else `user`; dates null. Multiple directives, quote/code, hypothetical, vague/ambiguous language become pending/no mutation. Ordinary text yields no operation.

Operation key is `(session_id,operation_id)`; automatic capture uses `turn/<turn_id>/user/0`; proposal acceptance reuses that slot; operator actions use fresh UUIDs. SHA-256 hashes a versioned canonical array of operation kind, resolved scope, source message ID/hash, target ID/revision, exact draft fields/reason; proposal staging also hashes assistant message ID/content hash. Exclude timestamps and nullable runtime run IDs. Exact retry returns original persisted result; differing payload conflicts. Terminal tuple hash covers authenticated phase 2 status, bound IDs/hash, generation, timestamps/run ID/evidence refs. Identical terminal replay is a no-op; conflicting terminal/source binding fails; preterminal receipt can be augmented once; late success cannot overwrite finalized cancelled/unterminated state. The `memory_capture_receipts` row and any terminal augmentation are written in the same outer savepoint as memory, audit, suppression, continuity, operation ledger, and provisional final revision. A release failure rolls back all effects; only then may the caller publish the committed receipt. Never insert the receipt as a follow-up write after the memory transaction.

Proposal staging requires an exact nonempty contiguous substring of a persisted assistant message tied to the same Session/turn. It creates `assistant_proposal`, never recall eligible. Only a later exact same-Session user message `Accept memory proposal <id>` accepts it; replacement provenance is `user_statement`, source `accepted_proposal`, acceptance user-message ID, with immutable lineage audit. Generic verified-observation admission is unsupported.

## File Map

- Modify `src-tauri/src/db/migrations.rs`: additive capture tables only; no backfill into accepted memory.
- Create `src-tauri/src/jarvis/memory/capture_contracts.rs`: exact public/native wire DTOs and statuses.
- Create `src-tauri/src/jarvis/memory/capture.rs`: grammar, canonical operation hash, capture and proposal transaction helpers.
- Create `src-tauri/src/jarvis/memory/continuity.rs`: continuity read/model and source-suppression persistence helpers (continuity writes are gated in 3.4).
- Modify `src-tauri/src/jarvis/memory/contracts.rs`, `memory/mod.rs`, `server-jarvis/src/memory-contract.ts`: error/status/wire parity.
- Do not modify `lib.rs` command registration or activate callers in this part.

## Task 1: Persist additive operation, receipt, and suppression state

**Files:** `src-tauri/src/db/migrations.rs`, `src-tauri/src/jarvis/memory/mod.rs`.

**Interfaces:** Produce `apply_memory_capture_migrations(conn:&Connection)->rusqlite::Result<()>` and register migration module/application in the established migration flow.

- [ ] **Step 1: Implement additive named-savepoint migration.** Create `memory_operations(session_id,operation_id,payload_hash,response_json,created_at, PRIMARY KEY(session_id,operation_id))`; `memory_capture_receipts(turn_id PRIMARY KEY,session_id,terminal_hash nullable,receipt_json,updated_at)`; `session_continuity(session_id PRIMARY KEY,active_objective_json nullable,latest_turn_id nullable,revision INTEGER NOT NULL DEFAULT 1,updated_at)`; `memory_prompt_suppressions(session_id,message_id,memory_id,reason,created_at, PRIMARY KEY(session_id,message_id,memory_id))`; `memory_turn_messages(turn_id,message_id UNIQUE, PRIMARY KEY(turn_id,message_id))`; and `memory_derived_invalidations(session_id,operation_id,scope_json,affected_session_ids_json,memory_ids_json,acknowledged_at nullable, PRIMARY KEY(session_id,operation_id))`. Validate JSON columns; use existing Session/message/turn foreign keys; preserve audit IDs if a source message is removed; never seed typed continuity from old summaries/current_goal.
- [ ] **Step 2: Check migration idempotence by source inspection and `git diff --check`.** No runtime/test migration fixture is run or added; future scenario `capture_migration_repeats_without_promoting_old_summary` is **NOT RUN / requires explicit user request**.

## Task 2: Define exact contracts and deterministic admission

**Files:** create `capture_contracts.rs`, `capture.rs`; modify `contracts.rs`, `mod.rs`, `server-jarvis/src/memory-contract.ts`.

**Interfaces:** Produce `parse_user_memory_operation(turn:&PersistedMemoryTurn)->Result<Option<UserMemoryOperation>,MemoryError>`, where `UserMemoryOperation` is `Save{draft,source}|Correct{id,expected_revision,draft}|Forget{id,expected_revision}|AcceptProposal{id}|Pending{reason_code}`. Parser returns empty for ordinary text; parsed data carries no caller authority/scope.

- [ ] **Step 1: Declare the frozen Rust DTOs, enums, and serde rules from this plan's Frozen contracts.** Add `#[serde(deny_unknown_fields)]` to request DTOs; keep terminal status as the phase 2 enum and make nullable fields nullable in Rust/TS fixture contract.
- [ ] **Step 2: Implement whole-message exact grammar.** Accept only the listed directives; retain payload scalars exactly; derive title/category/tags/dates per fixed rules; reject multiple directives and ambiguous/quoted/code-fenced text to pending; ordinary conversational text returns `Ok(None)`.
- [ ] **Step 3: Add error/status wire parity.** Preserve previous snake_case encodings and Phase 2 errors. **NOT RUN / requires explicit user request:** future `capture_wire_fixture_round_trips` and forged-field rejection scenario.
- [ ] **Step 4: Run source checks.** From repository root run `cargo check --manifest-path src-tauri/Cargo.toml`; from `server-jarvis/` run `bun run typecheck`; then from repository root run `git diff --check`. Expected: compile/type/diff checks clean; tests remain unrun.

## Task 3: Implement safe native capture and proposal persistence primitives

**Files:** `capture.rs`, `capture_contracts.rs`, `continuity.rs`; consume `scoped.rs` and `turn.rs`.

**Interfaces:** Produce `capture_recorded_turn(conn:&Connection,turn:&PersistedMemoryTurn,now:DateTime<Utc>)->Result<CaptureReceipt,MemoryError>`, `stage_memory_proposal(conn:&Connection,request:StageProposalRequest,now:DateTime<Utc>)->Result<MutationResult,MemoryError>`, and exact `correct_scoped_memory(conn:&Connection,session_id:&str,scope:&MemoryScope,id:&str,expected_revision:i64,draft:MemoryDraft,provenance:&MemoryProvenance,operation_id:&str,now:DateTime<Utc>)->Result<CorrectionResult,MemoryError>` / `forget_scoped_memory(conn:&Connection,session_id:&str,scope:&MemoryScope,id:&str,expected_revision:i64,reason:&str,operation_id:&str,now:DateTime<Utc>)->Result<ForgetResult,MemoryError>`.

- [ ] **Step 1: Implement canonical hash and operation-ledger replay lookup.** Hash the prescribed versioned canonical inputs; return exact prior JSON before producing writes; return `operation_conflict` for same identity/different hash; put uniqueness recheck inside transaction to resolve races.
- [ ] **Step 2: Implement capture transaction.** Resolve scope and provenance exclusively from `PersistedMemoryTurn`; pass actual saved user message ID and content/hash; allow null run/terminal; call phase 1 scoped helpers within one outer `with_memory_savepoint`; include memory/audit/source suppression/continuity/operation ledger/capture-receipt row and provisional final store revision in that savepoint. Release failure rolls back all effects. The command publishes/returns the already-committed receipt only after successful release; there is no post-commit receipt insert.
- [ ] **Step 3: Implement exact correction/forget primitives.** Require target in exact scope and expected revision; correction inserts replacement with `supersedes_id=old.id` and tombstones old atomically; forget tombstones only the requested ID. Persist suppression of source messages and consequence IDs with operation/ledger. No fuzzy match, multi-record change, scope move, or raw transcript copy.
- [ ] **Step 4: Implement proposal staging/acceptance.** Validate assistant message ID/content hash belongs to same Session and turn; require nonempty contiguous exact substring; write proposal authority excluded from recall. Acceptance must arise from a later exact persisted same-Session user directive; create user-statement replacement and lineage audit atomically; reuse automatic user operation slot.
- [ ] **Step 5: Keep live callers disabled and run source checks.** Do not register Tauri commands or route existing mutations here. Run Rust `cargo check`, Bun `bun run typecheck`, and `git diff --check`. All capture/admission/idempotency scenarios listed above are **NOT RUN / requires explicit user request**.

## Task 4: Review and hand off primitives to Part 3.2

- [ ] **Step 1: Check all source call sites.** Confirm no live UI/relay/manual mutator invokes these new helpers before derived invalidation gates exist; existing phase 2 signature remains unchanged.
- [ ] **Step 2: Record produced interfaces for Part 3.2.** Carry exact signatures in Task 3 plus `suppress_memory_sources(conn:&Connection,scope:&MemoryScope,memory_ids:&[String],now:DateTime<Utc>)->Result<Vec<String>,MemoryError>` and `read_capture_receipt(conn:&Connection,session_id:&str,turn_id:&str)->Result<Option<CaptureReceipt>,MemoryError>`; Part 3.2 supplies authenticated derived ACK before a mutating transaction becomes callable. The receipt reader is read-only and must return the stored original receipt without rewriting its revision.
- [ ] **Step 3: Run source checks.** From repository root run `cargo check --manifest-path src-tauri/Cargo.toml`; from `server-jarvis/` run `bun run typecheck`; then from repository root run `git diff --check`. Record actual output; do not run tests or close runtime gates.

## Completion Boundary

3.1 is source-complete when additive tables and DTOs compile, the exact grammar and native transactional primitives exist, deterministic replay/conflict behavior is encoded, source suppression is persisted atomically for corrections/forget, and no live caller can bypass the not-yet-implemented derived-state gate. Do not claim runtime behavior or test proof.
