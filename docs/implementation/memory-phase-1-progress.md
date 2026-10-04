# Memory Phase 1 — Implementation Ledger

**Plan:** `docs/superpowers/plans/2026-10-04-memory-phase-1-scoped-foundation.md`
**Spec:** `docs/superpowers/specs/2026-10-04-memory-four-phase-design.md`
**Priority:** `docs/CURRENT_ROADMAP.md` #1 (Phase 1 only)
**Worker:** DeepSeek v4.1 Flash on OpenCode CLI
**Baseline checkout:** `1cb1ce6` (roadmap baseline) + carried-over planning docs

## Execution environment

- Platform: macOS (darwin), shell zsh.
- Bun: `1.4.2` at `/Users/charlottehughes/.bun/bin/bun` — available.
- Rust toolchain: **UNAVAILABLE**. `cargo`, `rustc`, `rustup` are not on PATH (verified). No Rust build or `cargo test` / `cargo check` was executed. Installing system/global tooling is out of scope for this handoff.
- Per handoff: no tests were added, and no test suite was run. Plan test steps are recorded as **NOT RUN**.

## Global constraints honored

- Rust/Tauri App SQLite remains the sole durable memory authority; no second writable store was introduced.
- Agent identity is resolved from persisted `sessions.agent_id`; project scope is an explicit, validated `sessions.project_root` binding. Scope selection is separate from filesystem authorization.
- Legacy rows are preserved additively and default to `legacy_unscoped` / `legacy_unknown`; they are not auto-shared.
- Recall filters scope/status/expiry/tier/authority before ranking and limit.
- Recalled text is data only: no permission/policy/skill activation paths were added.
- FTS retrieval is preserved with a scoped LIKE fallback.

## Task status

| Task | Status | Commit |
|---|---|---|
| 1. Preserve legacy data + schema contracts | Implemented (source) | `2c14b2c` |
| 2. Resolve Agent/project identity from Sessions | Implemented (source) | `598cf19` |
| 3. Transactional scoped mutation + provenance | Implemented (source) | `dfc907f` |
| 4. Recall only eligible scoped candidates | Implemented (source) | `e9c967a` |
| 5. Expose scoped manual native commands | Implemented (source) | `c3646a2` |
| 6. Explicit legacy adoption + compatibility | Implemented (source) | pending commit |

## Files and interface rulings

### Task 1
- `src-tauri/src/db/migrations.rs`
  - Replaced the destructive `DROP TABLE memory` path-schema branch with `ALTER TABLE memory RENAME TO memory_legacy_path_backup`; refuses to proceed if a backup collision would lose data.
  - Added `pub fn apply_scoped_memory_migrations(conn)` called at the end of `run_migrations`, wrapped in `SAVEPOINT scoped_memory_migration`.
  - Adds `sessions.project_root`; `memory.{scope_kind,project_root,authority_kind,source_run_id,verified_at,revision}`; singleton `memory_store_state(singleton,revision)`; index `idx_memory_scope_eligibility`.
  - Triggers: scope-shape/enum/positive-revision validation; `memory_scope_immutable_bu` (established scopes immutable, legacy adoptable); `memory_store_revision_ai/au/ad`; `memory_row_revision_au`.
  - Ruling: store revision bumps only for the semantic field set from the plan; usage/last_used/relevance_score/updated_at_ms do not invalidate.
- `src-tauri/src/jarvis/memory/contracts.rs` (new): frozen DTOs/errors (`MemoryError{code,message}`, `MemoryScope`, `ScopeSelector`, `MemoryDraft`, `MemoryProvenance`, `ScopedMemoryEntry`, `ScopedMemoryRecall`, `RecallOptions`, `RecallPreview`, `MutationResult`). Request DTOs deny unknown fields.
- `src-tauri/src/jarvis/memory/mod.rs`: registered `contracts`, `scope`, `scoped`.
- `server-jarvis/src/memory-contract.ts` (new): wire-types-only mirror; no DB access.

### Task 2
- `src-tauri/src/jarvis/memory/scope.rs` (new): `normalize_project_root`, `bind_session_workspace`, `resolve_session_memory_scope`, `resolve_write_scope`.
  - Ruling: project selector on an unbound Session returns `invalid_scope` (does not silently become Agent or User); explicit `user` selector yields `{kind:user, agent_id:"", project_root:null}`.
  - Rejects empty/NUL/`~`/relative/parent-traversal/root/file paths; canonicalizes existing directories; revalidates bindings on resolution.
- `src-tauri/src/commands/sessions.rs`: `SessionSummary` gained nullable `project_root`; `list_session_rows` selects it; `create_session_row` starts unbound.

### Task 3
- `src-tauri/src/jarvis/memory/scoped.rs` (new): `with_memory_savepoint`, `memory_store_revision`, `save/read/list/update/tombstone/restore_scoped_memory`.
  - Mutation + audit event + store revision are atomic inside the savepoint; `changed:false` reserved for already-tombstoned delete / already-active restore.
  - Manual authority constructed by the caller; verified observations rejected in Phase 1 (Phase 3 owns trusted evidence).
- `src-tauri/src/jarvis/memory/engine.rs`: exposed `write_memory_event`, `score_memory`, `query_terms`, `fts_expr`, `validate_memory_payload`/`SafetyBlock`, `memory_columns`, `prefixed_memory_columns`, `memory_from_row` as `pub(crate)`.
- `MemoryEntry` was left intact; `ScopedMemoryEntry` wraps it.

### Task 4
- `scoped.rs`: `recall_scoped_memories` — scoped FTS candidate query (limit 30) then scoped LIKE fallback; eligibility excludes non-active/tombstoned/cold/expired/malformed-date/legacy/assistant-proposal records; pure re-scoring then limit clamp 0–5; read-only preview (no usage/event/revision writes).
  - Ruling: FTS failure falls back to LIKE; LIKE/storage failure returns typed `storage_unavailable`.
  - Ruling: candidate filter requires non-empty matched terms to avoid unrelated records on hostile input.

### Task 5
- `src-tauri/src/commands/memory.rs`: request DTOs and `execute_*` helpers plus Tauri commands `memory_bind_session_workspace`, `memory_scoped_{save,read,list,update,delete,restore,recall_preview}`, `memory_adopt_legacy`, all returning `Result<T, MemoryError>`.
  - Ownership resolved from the persisted Session; manual provenance is constructed natively (`authority_kind=manual`, source `manual`, cited Session = request Session, no message/run IDs, `verified_at=null`).
- `src-tauri/src/lib.rs`: registered the nine new commands.

### Task 6
- `engine.rs` compatibility protection:
  - `active_memories` (consolidation) restricted to `scope_kind='legacy_unscoped'`.
  - `find_similar_memory` merge candidates restricted to legacy rows.
  - `update_manual_memory` and `restore_memory` reject explicitly scoped records with an actionable error (directing callers to scoped APIs).
  - Old delete (`tombstone_memory`) may still tombstone scoped rows with operator authority; per-row and store revisions advance via triggers.
- `scoped.rs::adopt_legacy_memory`: deliberate, audited adoption; preserves original content/provenance; manual source -> `manual` authority, otherwise remains `legacy_unknown` (ineligible until a new explicit correction/verified record).

## Commands actually run

| Command | Result |
|---|---|
| `bun install --no-save` (server-jarvis) | Installed 8 local dev deps; OK |
| `bun run typecheck` (server-jarvis) | **PASS** (`tsc --noEmit`, no output) after adding `memory-contract.ts` |
| `git status` / scoped `git add` / `git commit` | Commits created per task |

## Commands NOT RUN (blocked or prohibited)

- `cargo test ...` and `cargo check --manifest-path src-tauri/Cargo.toml` — **NOT RUN**: no Rust toolchain on PATH. This is a toolchain blocker, not a passing result.
- All Rust `#[test]` scenarios named in the plan — **NOT RUN** (no toolchain; and the handoff instructed not to add/run tests).
- `bun test src/memory-contract.test.ts` — **NOT RUN**; the test file was intentionally not created per handoff (no tests).
- Live multi-Agent/project isolation, restart/continuity, and migration-on-real-database checks — **NOT RUN**.

## Review Focus rulings (source-level re-read)

1. Cross-scope ranking/leak: scope/eligibility predicates are applied in SQL before `LIMIT 30`, then re-scored. Implementation matches intent; not executed.
2. Path normalization: symlink/trailing-separator equivalence via `canonicalize`; relative/parent/NUL/file/root rejected. Windows verbatim prefix handling is `#[cfg(windows)]` and **unvalidated** on macOS.
3. Legacy preservation: additive migration + `memory_legacy_path_backup` + defaults; adoption is explicit. Not executed against a real pre-scope DB.
4. Provenance forged/foreign message: manual authority is natively constructed; `user_statement` citations are role-checked against the cited Session. Not executed.
5. Atomicity/revision: savepoint wrapping plus typed `storage_unavailable`. Not executed.

## Toolchain / contract blockers (open)

- Rust compiler absent: no compile-time verification of any Phase 1 Rust source. Type errors, borrow errors, or trigger/DDL issues may remain.
- `MemoryError` is returned from Tauri commands; validated by inspection only (Tauri requires `Serialize`, which it implements).
- Windows path normalization and WAL/trigger behavior on a real persisted database are unverified.
- Roadmap priority #1 and Phase 1 gate remain **OPEN**. `docs/CURRENT_ROADMAP.md` was intentionally left unchanged (no executed Rust evidence).

## Phase 1 completion gate

**NOT PASSED / OPEN.** Source implementation for all six tasks exists, but the required Rust `cargo test`/`cargo check` evidence, the phase-gate commands, and the live/reopen checks were not run. Per the plan and roadmap, the gate cannot pass without a real Rust toolchain and executed evidence.
