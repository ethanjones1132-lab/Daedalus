# Memory Phase 2.1 — Implementation Ledger

**Plan:** `docs/superpowers/plans/2026-10-04-memory-phase-2-1-native-turns.md`
**Binding split:** `docs/superpowers/specs/2026-10-04-memory-phase-2-four-part-design.md`
**Spec:** `docs/superpowers/specs/2026-10-04-memory-four-phase-design.md`
**Parent plan:** `docs/superpowers/plans/2026-10-04-memory-phase-2-live-recall.md`
**Priority:** `docs/CURRENT_ROADMAP.md` #1 (Phase 2.1 source only)
**Worker:** DeepSeek v4.1 Flash on OpenCode CLI

- **Execution baseline:** `dfe39904b8d7fa3ed731e5342e7e80437a6a3b40`
- **Branch:** `codex/memory-deepseek-20261004`
- **Source commit:** `083a9d0` — `feat: record native memory turn identity and bounded context`

## Execution environment

- Platform: macOS (darwin), shell zsh.
- Rust: `/Users/charlottehughes/.cargo/bin` — `cargo` 1.99.0, `rustc` 1.99.0.
- Bun: `/Users/charlottehughes/.bun/bin` — `1.4.2`.
- `sha2` resolved to the already-locked `0.10.9`; `Cargo.lock` only gained the
  `home-base` dependency edge. No global installs, credential edits, pushes, or
  environment changes were performed.
- Per the workspace rule and the plan's Global Constraints, no test files were
  created, no tests were run, and no ephemeral SQL assertions were executed.

## Scope delivered (Task 1–4)

Task 1 (DTOs + bounded rendering) and Tasks 2–3 (schema + immutable source
binding + native history) share one focused module, so they land in one source
commit. Task 4 is additive parity only; no command route, process capability,
UI, inference, or mutation interception was added (those are Phase 2.2+).

| Task | Status | Source |
|---|---|---|
| 1. Prepared turn DTOs and bounded rendering | Implemented (source) | `083a9d0` |
| 2. Durable preparation schema + immutable source binding | Implemented (source) | `083a9d0` |
| 3. Native history and diagnostic read helpers | Implemented (source) | `083a9d0` |
| 4. Stable preparation contracts handed to 2.2 | Implemented (source) | `083a9d0` |
| 5. Scoped source checkpoint ledger | This document | pending commit |

## Files changed

- `src-tauri/Cargo.toml` / `Cargo.lock` — added `sha2 = "0.10"` solely for
  interoperable exact-byte SHA-256.
- `src-tauri/src/jarvis/memory/contracts.rs` — added only the three additive
  Phase 2 error variants (`turn_conflict`, `invalid_turn`,
  `invalidation_unavailable`) plus their constructors. No Phase 1 DTO,
  function, enum spelling, or field changed.
- `src-tauri/src/jarvis/memory/turn.rs` (new) — frozen Phase 2 turn DTOs;
  `MemoryRecallStatus`, `MemoryTurnState`, `MemoryTurnTerminalStatus`;
  `build_prepared_memory_items`, `render_memory_block`,
  `prepare_memory_turn_record`, `mark_memory_turn_registered`,
  `mark_memory_turn_registration_failed`, `read_memory_turn`,
  `history_for_memory_turn`; exact-byte SHA-256; bounded escaping/whole-item
  drop.
- `src-tauri/src/jarvis/memory/mod.rs` — registered `pub mod turn;`.
- `src-tauri/src/db/migrations.rs` — additive, idempotent
  `apply_memory_turn_migrations` (`memory_turn_preparations` + two indexes),
  invoked after `apply_scoped_memory_migrations`. Existing Session, message,
  and memory rows are untouched.
- `server-jarvis/src/memory-contract.ts` — types-only wire mirrors with exact
  snake_case names, enum spellings, and Rust nullability. No DB access.

## Frozen-interface compliance

- `PrepareMemoryTurnRequest { session_id, turn_id, user_message_id,
  include_user_scope }` with `deny_unknown_fields`; `#[serde(default)]` is used
  only on `include_user_scope`.
- `MemoryTurnPreparation { turn_id, preparation_id: Option<String>, status }`.
- `PreparedMemorySelection` carries no item text; `selected_json` persists
  `PreparedMemorySelection[]` only. The durable row stores the immutable
  original `user_message` and `message_hash`, never recalled text or the
  rendered block.
- `PrepareMemoryTurnOutcome::New { envelope: PreparedMemoryTurn } |
  Existing { preparation: MemoryTurnPreparation }`; `Existing` contains no
  block.
- `PreparedMemoryTurn` carries `schema_version: 1`, opaque `preparation_id`,
  turn/session IDs, exact lower-case 64-char hash, scope, include-user choice,
  effective workspace, store revision, bounded selected items, block,
  timestamps, and app instance ID.
- Replay compares Session, source-message ID, exact message bytes, opt-in,
  resolved scope, and app instance; mismatch is `turn_conflict` and never
  mutates the original row. Exact replay returns `Existing` without re-recall,
  rebinding, selection change, or ID replacement.
- TTL is exactly 120 seconds (`now + 120s`, RFC3339 UTC). Project effective
  workspace is the canonical project root; Agent scope is `None`.

## Interface rulings (recorded)

1. **Title label.** The parent plan mentions "ID/revision/stale/title labels",
   but the frozen `PreparedMemoryItem` has only `selection` + `text` and
   `PreparedMemorySelection` has no title field. To avoid inventing a competing
   interface, the excerpt is built as `"<title>: <content>"` (warm tier:
   `"<title>: <summary>"`) in `build_prepared_memory_items`, while
   `render_memory_block` adds compact `id/revision/stale/authority` labels from
   the frozen selection. This preserves the title data without extending the
   frozen DTO.
2. **Retrieval failure.** `recall_scoped_memories` errors are caught inside the
   preparation transaction and persisted with `recall_status=retrieval_failed`
   and an empty selection/block so the turn remains diagnosable and ordinary
   inference stays possible. It is not reported as a prepared/ready turn.
3. **Budget omission.** When entries existed but no item fits the 4,000-scalar
   framed block, `recall_status=budget_omitted` and the block is empty; the
   selection metadata is still persisted.
4. **Library-only scope.** No `commands/memory_turn.rs`, no `invoke_handler`
   registration, no transport/registry, no UI, and no mutation gate were added.
   These remain Phase 2.2/2.3/2.4 deliverables.

## Review Focus coverage (source-level)

1. `prepare_turn_requires_exact_persisted_user_row` (future): source message
   must exist in the requesting Session with role `user`, else `invalid_turn`
   before any row is written. Cross-session/missing/assistant IDs cannot yield
   a preparation.
2. `prepared_memory_block_uses_unicode_scalar_limits` (future): per-item
   escaped JSON element is bounded to 600 Unicode scalar values; the whole
   escaped frame to 4,000; truncation uses `chars()` (no byte splitting);
   framing is never truncated.
3. `prepared_items_preserve_only_recall_preview_selection` (future): items come
   from the already-ranked, Phase 1-eligibility-filtered `RecallPreview.entries`
   in order, capped at five; warm-tier rows use the local summary.
4. `memory_turn_identity_conflict_is_atomic` (future): replay mismatch returns
   `turn_conflict` and performs no UPDATE on the original row.
5. `memory_turn_history_excludes_current_and_later_rows` (future): history is
   `created_at,rowid`-ordered and bounded strictly before the source `rowid`.

## Exact source commands run

| Command | Result |
|---|---|
| `cargo check --manifest-path src-tauri/Cargo.toml` (baseline, pre-change) | **PASS** — 2 pre-existing warnings only |
| `cargo check --manifest-path src-tauri/Cargo.toml` (post-change) | **PASS** — same 2 pre-existing warnings (`supervisor.rs` deprecated `fetch_update`, `wsl.rs` unused `shlex_join`); `sha2` 0.10.9 compiled |
| `(cd server-jarvis && bun run typecheck)` | **PASS** — `tsc --noEmit`, exit 0 |
| `git diff --check` | **PASS** — no whitespace errors |

No `cargo test`, `bun test`, ephemeral SQL, or runtime/live experiment was run.

## Commands NOT RUN (open gates)

- `cargo test --manifest-path src-tauri/Cargo.toml prepared_memory -- --nocapture`
- `cargo test --manifest-path src-tauri/Cargo.toml memory_turn_ -- --nocapture`
- `cargo test --manifest-path src-tauri/Cargo.toml memory_turn_history -- --nocapture`
- `cargo test --manifest-path src-tauri/Cargo.toml memory_turn_contract -- --nocapture`
- `(cd server-jarvis && bun test src/memory-contract.test.ts)`
- Any migration idempotency, replay-conflict, Unicode-boundary, or history-order
  runtime assertion.
- Phase 1's still-pending test gate (unchanged by this phase).

No test files were created and no test functions were added. All named tests
above are future proposals from the plan, not current evidence.
`server-jarvis/src/memory-contract.test.ts` was intentionally not created.

## Risks and pending evidence

- **Runtime/test gate open.** Exact migration idempotency, migration
  additivity against an existing database, replay-conflict atomicity, Unicode
  scalar limits, and history ordering are asserted by inspection and
  compilation only, not by executed tests.
- **Cross-package parity.** Rust and TypeScript turn DTOs compile and
  typecheck, but the cross-language fixture decode is not yet run.
- **Concurrency.** Preparation/replay relies on the Phase 2.2 `AppDb` mutex for
  serialization; the savepoint plus `turn_id` primary key make a lost race fail
  closed rather than overwrite identity, but this is not raced in a test here.
- **Downstream.** Phase 2.2 must read `recall_status` back (e.g. via
  `read_memory_turn`) after a `New` outcome, because the frozen `New { envelope }`
  variant intentionally carries no status. No process capability, registration,
  sync, or invalidation exists yet; ordinary inference is unaffected.
- **Phase 1 warning.** `authority_str` was already `pub(crate)` in `scoped.rs`;
  no Phase 1 file semantics changed.

## Completion boundary

Phase 2.1 source is delivered: additive turn persistence, exact
source-message hashing, bounded selection rendering, native prior-history
access, and Rust/TS DTO parity compile. The Phase 2.1 runtime/test gate and
the Phase 1 test gate remain **OPEN**. This ledger is not Phase 2 runtime
evidence, does not mark roadmap priority #1 complete, and does not advance to
Phase 2.2 implementation.
