# Memory Phase 3.1 — Native Capture Persistence and Admission — Implementation Ledger

**Plan:** `docs/superpowers/plans/2026-10-04-memory-phase-3-1-native-capture.md`
**Binding split:** `docs/superpowers/specs/2026-10-04-memory-phase-3-four-part-design.md`
**Parent plan:** `docs/superpowers/plans/2026-10-04-memory-phase-3-safe-capture.md`
**Priority:** `docs/CURRENT_ROADMAP.md` #1 (Phase 3.1 source only)
**Worker:** DeepSeek v4.1 Flash on OpenCode CLI (Luna planned)

- **Execution baseline:** `af9299c6a8c6ef8a296302e712bbe745921319e7`
- **Branch:** `codex/memory-deepseek-20261004`
- **Part:** 3.1 of 4 (source primitives only; no live caller, no command registration)
- **Commit:** not made (left for root review per instruction).

## Execution environment

- Platform: macOS (darwin), shell zsh. Worktree: `Daedalus-memory-deepseek`.
- Rust: `/Users/charlottehughes/.cargo/bin` — cargo/rustc 1.99.0.
- Bun: `/Users/charlottehughes/.bun/bin` — 1.4.2.
- Per the workspace rule and the plan's Global Constraints, **no test file was
  created, no test function/declaration was added, and no tests, ephemeral SQL
  assertions, or live capture/admission experiments were run.** Every planned
  regression scenario is deferred and reported **NOT RUN / requires explicit
  user request**.
- Preexisting dirty docs (`AGENTS.md`, `PRIORITIES.md`, `README.md`,
  `docs/COMPLETION_BACKLOG.md`, `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md`)
  and the untracked generated `src-tauri/gen/schemas/*` were not touched.

## Changed files

| File | Change |
|---|---|
| `src-tauri/src/db/migrations.rs` | Added additive `apply_memory_capture_migrations`; registered after `apply_memory_turn_migrations` |
| `src-tauri/src/jarvis/memory/contracts.rs` | Added `operation_conflict`, `invalid_acceptance`, `unsupported_verification`, `capture_unavailable` error codes + constructors |
| `src-tauri/src/jarvis/memory/mod.rs` | Declared `capture`, `capture_contracts`, `continuity` modules |
| `src-tauri/src/jarvis/memory/capture_contracts.rs` | **New** — frozen Phase 3.1 DTOs/statuses/request envelopes |
| `src-tauri/src/jarvis/memory/capture.rs` | **New** — grammar, canonical hash, ledger, capture/correct/forget/proposal primitives |
| `src-tauri/src/jarvis/memory/continuity.rs` | **New** — continuity read model + source-suppression persistence |
| `server-jarvis/src/memory-contract.ts` | Added the four error codes and the Phase 3.1 wire-type mirror |

Not modified: `src-tauri/src/lib.rs` (command registration), `scoped.rs`,
`turn.rs`, `transport.rs`, any UI/relay/command caller. No command is exposed
and no existing phase 1/2 signature changed.

## Task 1 — Additive operation, receipt, and suppression persistence

`apply_memory_capture_migrations(conn) -> rusqlite::Result<()>` runs inside a
named savepoint and is additive/idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`):

- `memory_operations(session_id,operation_id,payload_hash,response_json,created_at, PK(session_id,operation_id))`
- `memory_capture_receipts(turn_id PK,session_id,terminal_hash nullable,receipt_json,updated_at)`
- `session_continuity(session_id PK,active_objective_json nullable,latest_turn_id nullable,revision NOT NULL DEFAULT 1,updated_at)`
- `memory_prompt_suppressions(session_id,message_id,memory_id,reason,created_at, PK(session_id,message_id,memory_id))`
- `memory_turn_messages(turn_id,message_id UNIQUE, PK(turn_id,message_id))`
- `memory_derived_invalidations(session_id,operation_id,scope_json,affected_session_ids_json,memory_ids_json,acknowledged_at nullable, PK(session_id,operation_id))`

JSON columns carry `CHECK(json_valid(...))`; Session/message/turn use the
existing foreign keys. `memory_capture_receipts.turn_id` references
`memory_turn_preparations(turn_id) ON DELETE CASCADE`, and
`session_continuity.latest_turn_id` references the same turn table
`ON DELETE SET NULL`. Suppression rows deliberately have **no** message foreign
key, so a removed source message leaves the audit id recorded rather than
reviving a fact. No `current_goal`/`summary` is read or backfilled into accepted
memory or typed continuity.

## Task 2 — Exact contracts and deterministic admission

`capture_contracts.rs` defines `CaptureOperationStatus`
(`saved|forgotten|corrected|pending|blocked`), `CaptureOperationReceipt`,
`CaptureReceipt`, `CorrectionResult`, `ForgetResult`, `ActiveObjective`,
`SessionContinuity`, and the seven request DTOs (`CaptureTurnRequest`,
`CaptureReceiptsRequest`, `ScopedCorrectRequest`, `ScopedForgetRequest`,
`StageProposalRequest`, `ContinuityReadRequest`, `ContinuitySetRequest`) — each
`#[serde(rename_all = "snake_case", deny_unknown_fields)]`, so a forged
`agent_id`, `terminal_status`, or `verified_at` request field is rejected before
any transaction opens. `terminal_status` reuses the frozen Phase 2 enum.

`capture.rs::parse_user_memory_operation(&PersistedMemoryTurn) ->
Result<Option<UserMemoryOperation>, MemoryError>` implements the whole-message
grammar (case-insensitive fixed prefix, nonempty payload): `Remember:`,
`Remember that`, `Constraint:`, `Decision:`, `Correct memory <id>@<revision>:`,
`Forget memory <id>@<revision>`, `Accept memory proposal <id>`. Sources are the
six frozen values. Payload Unicode is preserved; title is the first 80 Unicode
scalars; tags empty; category `project` for project scope else `user`; dates
null. Multiple directives, quote/code-fenced directives, hypothetical language,
vague assent, and near-miss directive first words become `Pending` with no
mutation; ordinary text returns `Ok(None)`.

`server-jarvis/src/memory-contract.ts` mirrors the error codes and all DTOs.

## Task 3 — Safe native capture and proposal primitives

`capture.rs` produces the frozen interfaces:

- `capture_recorded_turn(conn,&PersistedMemoryTurn,now) -> CaptureReceipt`
- `stage_memory_proposal(conn,StageProposalRequest,now) -> MutationResult`
- `correct_scoped_memory(conn,session_id,scope,id,expected_revision,draft,provenance,operation_id,now) -> CorrectionResult`
- `forget_scoped_memory(conn,session_id,scope,id,expected_revision,reason,operation_id,now) -> ForgetResult`

Behavior encoded in source:

- **Canonical hash.** SHA-256 over a versioned canonical array (kind, resolved
  scope, source message id/hash, target id/revision, exact draft fields/reason);
  proposal staging additionally hashes the assistant message id/content hash.
  Timestamps and nullable run ids are excluded. Operator manual operations hash
  the explicit request draft plus native-resolved scope and Session.
- **Canonical turn reload, then full observation comparison.**
  `capture_recorded_turn` loads the persisted turn by identity and makes the
  reloaded `PersistedMemoryTurn` the only authority: it recomputes the SHA-256
  of the actually saved user message and rejects any provided observation that
  differs in source/user message/hash/scope, in the complete
  `terminal_tuple_hash` (state/recall status/terminal status/started+finished
  timestamps/run id/applied ids/runtime evidence plus app/Bun generation), or in
  the immutable prepared snapshot (`preparation_id`, `include_user_scope`,
  `effective_workspace`, `store_revision`, `selected`, `prepared_at`,
  `expires_at`). A fabricated terminal evidence/generation/selected-id payload is
  `operation_conflict`; a plain helper caller can never supply terminal
  authority. Part 3.2 re-reads the turn inside the mutation gate to handle a
  legitimate race.
- **Ledger immutable replay.** The `(session_id, operation_id)` payload hash is
  checked before any receipt replay or augmentation; same identity/different
  payload is `operation_conflict`. The ledger `response_json` is the frozen
  original user-operation result and is **never** overwritten by a later terminal
  augmentation. The row is inserted inside the transaction
  (`ON CONFLICT DO NOTHING`) to resolve races.
- **Capture transaction.** Scope, provenance, source message id/content/hash,
  and terminal tuple come exclusively from the reloaded canonical persisted
  turn; null run/terminal are legitimate. Memory/audit/suppression/ledger/
  receipt row are written in one outer `with_memory_savepoint`.
  `terminal_hash` is stored SQL `NULL` pre-terminal and frozen once final. A
  repeated pre-terminal observation is a no-op (no null→null rewrite). A
  one-time null→authoritative terminal augmentation retains the original
  mutation revisions. Any finalized terminal-tuple change — including a
  cancelled/unterminated→completed late success or same-terminal changed
  evidence/timestamps/source — returns `operation_conflict` and records one
  bounded, content-free `capture_terminal_conflict` event outside the rolled-back
  mutation without overwriting the frozen ledger/receipt. An operation ledger row
  observed without its atomically-written capture receipt is corrupt storage and
  fails `storage_unavailable`; it is never used to synthesize a receipt.
- **Correction.** Inserts the replacement, points `supersedes_id` at the old
  row, tombstones the old row, suppresses the old row's exact source messages,
  clears any active objective that declared a dependency on the old row (with an
  explicit continuity event), and writes the lineage audit — all atomically. The
  replacement's own new user source is **not** suppressed. Expected-revision
  mismatch writes nothing.
- **Forget.** Validates the expected revision before the already-tombstoned
  no-op (exact ledger replay is handled before the body), tombstones exactly the
  requested id in the exact scope, establishes suppression even for a historical
  tombstone, clears dependent objectives, and returns the persisted
  `suppressed_message_ids` for inspectability. No fuzzy match, multi-record
  change, scope move, or transcript copy.
- **Proposal staging/acceptance.** Staging requires an authoritative terminal
  turn and an exact persisted `(turn_id, assistant_message_id)` association
  (`EXISTS`, multiple assistant rows allowed); there is no permissive unmapped
  fallback, so staging is rejected truthfully until Part 3.3 creates
  associations. The draft content must be an exact nonempty contiguous substring
  of that assistant message; it saves `assistant_proposal` authority (excluded
  from recall). Acceptance requires the proposal in the exact turn scope with
  `assistant_proposal` authority, `source_session_id` equal to the accepting
  Session, and an exact association lineage to a same-Session, same-scope staging
  turn. Acceptance must be strictly later than both the assistant source and the
  staging turn's user source by actual `(created_at, rowid)` order. It creates a
  `user_statement`/`accepted_proposal` replacement sourced from the acceptance
  user message and tombstones the proposal in the same outer transaction.
- **Safety blocks.** Save and correction content-safety failures
  (`invalid_payload`/`invalid_provenance`) are attempted inside a nested
  savepoint and become a `blocked` operation receipt only after that savepoint
  rolls back; no replacement row or audit event survives and the rejected
  content is never persisted in diagnostics. Target/revision/scope/storage
  failures remain errors. A blocked save never confirms saving.

## Task 4 — Review and handoff to Part 3.2

- No source call site invokes the new helpers: no Tauri command is registered,
  no existing mutator was routed through them, and the Phase 2 transport/turn
  signatures are unchanged. The helpers operate on `&Connection` only and do no
  HTTP; Part 3.2 must wrap them in `with_memory_mutation_gate` /
  `with_memory_derived_mutation_gate` and perform the invalidation ACK before
  the native mutation.
- Additional interfaces handed off:
  `continuity::suppress_memory_sources(conn:&Connection,scope:&MemoryScope,memory_ids:&[String],now:DateTime<Utc>) -> Result<Vec<String>,MemoryError>`,
  `continuity::clear_continuity_dependent_on(conn:&Connection,memory_ids:&[String],now:DateTime<Utc>) -> Result<Vec<String>,MemoryError>`,
  and
  `capture::read_capture_receipt(conn:&Connection,session_id:&str,turn_id:&str) -> Result<Option<CaptureReceipt>,MemoryError>`.
  The receipt reader is read-only and returns the stored receipt without
  rewriting its revision.
- **Remaining next-part work:** Part 3.2 installs the derived invalidation gate,
  adds real UUID operator operations with a gate, writes/drains the
  `memory_derived_invalidations` outbox, and registers the Tauri commands.
  Part 3.3 supplies lifecycle callers and populates `memory_turn_messages`.
  Part 3.4 owns `set_session_continuity`/`apply_turn_continuity`.

## Root-review corrective pass

A root source review of the first 3.1 pass required seven corrections. All were
made in source with no tests/runtime execution.

1. **Correction/acceptance source suppression.** `replace_scoped_memory` (used
   by both correction and proposal acceptance) now calls
   `suppress_memory_sources` for the superseded target's exact source messages
   and `clear_continuity_dependent_on` for any active objective that declared a
   dependency on it. The replacement's own new user source is not suppressed.
2. **Strict proposal staging/acceptance lineage.** Staging now requires an
   authoritative terminal turn plus an exact `(turn_id, assistant_message_id)`
   `memory_turn_messages` association (`EXISTS`, no unmapped fallback), and is
   rejected truthfully until Part 3.3 creates associations. Acceptance requires
   the exact association lineage to a same-Session, same-scope staging turn and
   strictly-later `(created_at, rowid)` ordering versus both the assistant
   source and the staging turn's user source — not assistant role alone.
3. **Turn revalidation and immutable ledger.** `capture_recorded_turn`
   revalidates the persisted immutable turn source/hash/scope and the ledger
   `payload_hash` before any receipt replay or augmentation. Terminal hash is
   stored `NULL` pre-terminal and frozen once final; repeated pre-terminal calls
   are no-ops; the ledger `response_json` is never rewritten on augmentation.
4. **Late terminal conflict.** Any finalized terminal-tuple change (including
   cancelled/unterminated→completed) now returns `operation_conflict` and records
   a bounded, content-free `capture_terminal_conflict` event outside the
   rolled-back mutation, without overwriting the successful ledger/receipt.
5. **Forget expected-revision and consequence ids.** `forget_scoped_memory_body`
   validates `expected_revision` before the already-tombstoned no-op, establishes
   suppression for a historical tombstone, and returns the persisted
   `suppressed_message_ids`.
6. **Correction safety blocking.** Save and correction mutations run in nested
   savepoints; only `invalid_payload`/`invalid_provenance` are converted to a
   `blocked` receipt after rollback, leaving no partial replacement row or event.
   Target/revision/scope/storage failures remain errors.
7. **Foreign keys.** `memory_capture_receipts.turn_id` and
   `session_continuity.latest_turn_id` now reference
   `memory_turn_preparations(turn_id)`; suppression rows intentionally keep no
   message FK so audit ids survive a deleted message.

## Final root-review authority fix

A final source review found one remaining authority hole plus a corrupt-pair
repair hazard. Both are corrected in source with no tests/runtime execution.

- `revalidate_turn_snapshot` now compares the complete `terminal_tuple_hash`
  against the reloaded persisted turn and additionally compares every immutable
  prepared-snapshot field (`preparation_id`, `include_user_scope`,
  `effective_workspace`, `store_revision`, `selected`, `prepared_at`,
  `expires_at`). `capture_recorded_turn` **uses the reloaded canonical turn** for
  all downstream computation, so a provided turn can never freeze fabricated
  terminal evidence, generation, timestamps, or selected ids even through the
  plain helper. A provided observation that differs is `operation_conflict`.
  Commands in Part 3.2 re-read the turn inside the mutation gate to absorb any
  legitimate race.
- The defensive "ledger row without a receipt row" repair was removed. The
  ledger and capture receipt are written in one savepoint and cannot
  legitimately be observed separately; a missing receipt beside an existing
  ledger now fails `storage_unavailable` rather than synthesizing a finalized
  terminal hash alongside a null-terminal original receipt.

## Exact source commands run

All run as separate simple commands with the tool `workdir` (no `cd`, no pipes
into other tools for the source commands):

| Command | Result |
|---|---|
| `/Users/charlottehughes/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml` (workdir repo root) | **PASS** — only the 2 pre-existing warnings (`supervisor.rs` deprecated `fetch_update`, `wsl.rs` unused `shlex_join`) |
| `/Users/charlottehughes/.bun/bin/bun run typecheck` (workdir `server-jarvis`) | **PASS** — `tsc --noEmit`, exit 0 |
| `/Users/charlottehughes/.bun/bin/bun run build` (workdir `server-jarvis`) | **PASS** — bundled `dist` (196 modules) |
| `git diff --check` (workdir repo root) | **PASS** — no whitespace errors |

`src-ui` was not changed, so no UI build was run. No `cargo test`, `bun test`,
ephemeral SQL script, or live capture experiment was run. The same four checks
were re-run after the root-review corrective pass and again after the final
authority fix with identical PASS results.

## Commands and gates NOT RUN

- `capture_admission_ambiguous_or_quoted_is_pending`
- `capture_verified_observation_rejects_runtime_success_only`
- `capture_manual_mutation_retry_returns_original_result`
- `capture_source_foreign_session_rejects`
- `capture_migration_repeats_without_promoting_old_summary`
- `capture_wire_fixture_round_trips` / forged-field rejection
- Any live capture/correct/forget/proposal acceptance or terminal-replay scenario
- Phase 1 and Phase 2 test/runtime gates remain **OPEN** and unchanged.

## Risks and limitations

- **Source only.** Compilation/type/bundle checks are not runtime evidence. The
  replay/conflict, terminal-augmentation, correction-lineage, and
  proposal-acceptance behavior is asserted by inspection and the compiler.
- **Store-revision finality.** These helpers are the outermost savepoint for
  their own operation, so the revision they read after the mutation is the value
  committed when that savepoint releases. A future Part 3.2 wrapper that adds a
  further outer savepoint must re-read the revision after its own release.
- **Suppression scope.** Correction/forget persist source suppression for the
  affected memory's own lineage and clear active objectives that declared a
  direct dependency on it. Whole-message / derived-cache neutralization,
  assistant-turn consequence suppression, and outbox draining belong to Part 3.2.
- **Staging requires Part 3.3 associations.** Proposal staging/acceptance truthfully
  rejects until `memory_turn_messages` associations exist; they are populated by
  the Part 3.3 assistant append.
- **Continuity setter deferred.** The continuity read model, suppression, and
  dependency-clearing consequence exist here; `set_session_continuity` /
  `apply_turn_continuity` and the continuity gate belong to Part 3.4.
- **No command surface.** Nothing can reach these helpers from the UI, relay, or
  any existing mutator until Part 3.2 registers and gates them.

## Completion boundary

Phase 3.1 is source-complete: the additive tables and DTOs compile, the exact
grammar and native transactional primitives exist, deterministic
replay/conflict behavior is encoded, immutable turn revalidation guards capture,
source suppression and dependent-objective clearing are persisted atomically for
corrections/forget, and no live caller can bypass the not-yet-implemented
derived-state gate. This ledger does **not** claim runtime behavior or test
proof, does not close any runtime gate, and does not advance the roadmap
priority. The source is left uncommitted for root review.

## Root source handoff

Root reviewed the native production helpers and corrective continuations. Independent fresh `cargo check` (src-tauri), `bun run typecheck` and `bun run build` (server-jarvis), and `git diff --check` passed after the final correction. Two preexisting Rust warnings remain. Source checkpoint excludes carried dirty docs/generated schemas. No tests or live experiments were added/run; runtime gates remain open.
