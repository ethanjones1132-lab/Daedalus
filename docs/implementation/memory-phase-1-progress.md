# Memory Phase 1 — Implementation Ledger

**Plan:** `docs/superpowers/plans/2026-10-04-memory-phase-1-scoped-foundation.md`
**Spec:** `docs/superpowers/specs/2026-10-04-memory-four-phase-design.md`
**Priority:** `docs/CURRENT_ROADMAP.md` #1 (Phase 1 only)
**Worker:** DeepSeek v4.1 Flash on OpenCode CLI
**Baseline checkout:** `1cb1ce6` (roadmap baseline) + carried-over planning docs

## Execution environment

- Platform: macOS (darwin), shell zsh.
- Bun: `1.4.2` at `/Users/charlottehughes/.bun/bin/bun` — available.
- Rust: **installed**, but not on the default PATH. `/Users/charlottehughes/.cargo/bin` contains
  `cargo` 1.99.0 and `rustc` 1.99.0. Adding that directory to the child-process PATH is sufficient;
  no toolchain installation was performed. Local builds only generated gitignored artifacts
  (`src-tauri/target`, `server-jarvis/dist`, `src-ui/dist`) plus `src-tauri/gen/schemas/macOS-schema.json`
  (generated platform schema, intentionally left untracked).
- Per handoff: no tests were added and no test suite was run. Plan test steps are **NOT RUN**.

## Global constraints honored

- Rust/Tauri App SQLite remains the sole durable memory authority; no second writable store.
- Agent identity comes from persisted `sessions.agent_id`; project scope is an explicit, validated
  `sessions.project_root` binding, separate from filesystem authorization.
- Legacy rows are preserved additively and default to `legacy_unscoped` / `legacy_unknown`.
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
| 6. Explicit legacy adoption + compatibility | Implemented (source) | `0486dd8` |
| Review-driven hardening (provenance, revisions, timestamps, UNC) | Implemented (source) | `8a1e92a` |

## Files and interface rulings

### Task 1
- `src-tauri/src/db/migrations.rs`
  - Replaced the destructive `DROP TABLE memory` path-schema branch with
    `ALTER TABLE memory RENAME TO memory_legacy_path_backup`; refuses to proceed on backup collision.
  - Added `pub fn apply_scoped_memory_migrations(conn)` at the end of `run_migrations`, wrapped in
    `SAVEPOINT scoped_memory_migration`.
  - Adds `sessions.project_root`; `memory.{scope_kind,project_root,authority_kind,source_run_id,verified_at,revision}`;
    singleton `memory_store_state`; index `idx_memory_scope_eligibility`.
  - Triggers: scope-shape/enum/positive-revision validation; `memory_scope_immutable_bu`;
    `memory_store_revision_ai/au/ad`; `memory_row_revision_au`.
  - Ruling: store revision bumps only for the semantic field set from the plan; usage/last_used/
    relevance_score/updated_at_ms do not invalidate.
- `src-tauri/src/jarvis/memory/contracts.rs` (new): frozen DTOs/errors; request DTOs deny unknown fields.
- `src-tauri/src/jarvis/memory/mod.rs`: registered `contracts`, `scope`, `scoped`.
- `server-jarvis/src/memory-contract.ts` (new): wire-types-only mirror; no DB access.

### Task 2
- `src-tauri/src/jarvis/memory/scope.rs` (new): `normalize_project_root`, `bind_session_workspace`,
  `resolve_session_memory_scope`, `resolve_write_scope`.
  - Ruling: project selector on an unbound Session returns `invalid_scope`; explicit `user` selector
    yields `{kind:user, agent_id:"", project_root:null}`.
  - Rejects empty/NUL/`~`/relative/parent-traversal/root/file paths; canonicalizes existing directories;
    revalidates bindings on resolution.
  - Windows canonicalization converts `\\?\UNC\server\share\...` back to `\\server\share\...` and
    `\\?\C:\...` to `C:\...`, preserving a valid absolute UNC identity across revalidation.
- `src-tauri/src/commands/sessions.rs`: `SessionSummary.project_root` added (nullable); list selects it;
  `create_session_row` starts unbound.

### Task 3
- `src-tauri/src/jarvis/memory/scoped.rs` (new): `with_memory_savepoint`, `memory_store_revision`,
  `save/read/list/update/tombstone/restore_scoped_memory`.
  - Mutation + audit event + store revision are atomic inside the savepoint.
  - `changed:false` is reserved for an already-tombstoned delete / already-active restore **at the
    expected revision**; a stale `expected_revision` now returns `revision_conflict` even for those
    lifecycle no-ops.
  - Provenance validation now: source-less manual/proposal writes are valid; any supplied
    `source_session_id` must exist, its Agent must match project/Agent scope, and every cited message
    must belong to that Session (user_statement citations must additionally be user-role messages).
    Verified observations remain unsupported until Phase 3 trusted evidence.
- `src-tauri/src/jarvis/memory/engine.rs`: exposed the reusable helpers as `pub(crate)`.

### Task 4
- `scoped.rs::recall_scoped_memories`: scoped FTS candidates (limit 30) then scoped LIKE fallback;
  eligibility excludes non-active/tombstoned/cold/expired/malformed/legacy/assistant-proposal records;
  pure re-scoring then limit clamp 0–5; read-only preview (no usage/event/revision writes).
  - Ruling: FTS failure falls back to LIKE; like/storage failure returns typed `storage_unavailable`.
  - Eligibility uses a strict date-time shape guard (`GLOB`) plus `julianday()` (fractional-second
    preserving) before the candidate limit, so malformed persisted timestamps cannot consume the budget.
  - Rust parsing excludes any residual malformed timestamp, emits a structured warning containing only
    `memory_id` and the field name, and never treats it as not-stale.

### Task 5
- `src-tauri/src/commands/memory.rs`: request DTOs and `execute_*` helpers plus Tauri commands
  `memory_bind_session_workspace`, `memory_scoped_{save,read,list,update,delete,restore,recall_preview}`,
  `memory_adopt_legacy`, all returning `Result<T, MemoryError>`.
  - Ownership resolved from the persisted Session; manual provenance is constructed natively.
- `src-tauri/src/lib.rs`: registered the nine new commands.

### Task 6
- `engine.rs` compatibility protection: `active_memories` (consolidation) and `find_similar_memory`
  merge candidates restricted to `scope_kind='legacy_unscoped'`; `update_manual_memory` and
  `restore_memory` reject explicitly scoped records; old delete may still tombstone scoped rows with
  operator authority and revisions advance via triggers.
- `scoped.rs::adopt_legacy_memory`: deliberate, audited adoption; manual source -> `manual` authority,
  otherwise remains `legacy_unknown` (ineligible until a new explicit correction/verified record).

## Commands actually run

| Command | Result |
|---|---|
| `bun install --no-save` (server-jarvis) | OK (8 local dev deps) |
| `bun run typecheck` (server-jarvis) | **PASS** (`tsc --noEmit`, no output) |
| `bun run build` (server-jarvis) | OK — produced gitignored `dist/index.js` (Tauri resource) |
| `bun install` + `bun run build` (src-ui) | OK — produced gitignored `dist/` (Tauri `frontendDist`) |
| `PATH=$HOME/.cargo/bin:$PATH cargo check --manifest-path src-tauri/Cargo.toml` | **PASS** (only pre-existing warnings: deprecated `fetch_update` in `supervisor.rs`, unused `shlex_join` in `wsl.rs`) |
| `PATH=$HOME/.cargo/bin:$PATH cargo check --tests --manifest-path src-tauri/Cargo.toml` | **PASS** (compiles test cfg; tests not executed) |
| scoped `git add`/`git commit` | Commits per task (see table) |

Local build prerequisites (`server-jarvis/dist/index.js`, `src-ui/dist`) were generated only to satisfy
the Tauri build script; both are gitignored and were not committed.

## Commands NOT RUN

- `cargo test ...` for any Phase 1 scenario — **NOT RUN** (tests not authorized for this handoff).
- The plan's phase-gate command set and the live multi-Agent/project isolation, restart/continuity, and
  real-database migration checks — **NOT RUN**.
- `bun test src/memory-contract.test.ts` — **NOT RUN**; the test file was intentionally not created.
- Any runtime SQL/trigger execution or ephemeral SQL script — **NOT RUN** (not authorized).

## Review Focus rulings (source re-read against final HEAD)

1. Cross-scope ranking/leak: scope/eligibility predicates applied in SQL before `LIMIT 30`, then
   re-scored; cross-scope reads/mutations return `not_found` with no event.
2. Path normalization: symlink/trailing-separator equivalence via `canonicalize`; relative/parent/NUL/
   file/root rejected; Windows UNC/verbatim handling corrected by inspection only (not compiled/executed
   on Windows).
3. Legacy preservation: additive migration + `memory_legacy_path_backup` + defaults; adoption explicit.
4. Provenance: source-less manual writes preserved; supplied provenance must be internally consistent
   (existing Session, Agent matches project/Agent scope, cited messages belong to the Session, user-role
   for user_statement); verified observations rejected in Phase 1.
5. Atomicity/revision: savepoint wrapping plus typed `storage_unavailable`; stale `expected_revision`
   now fails before any lifecycle no-op.

## Toolchain / contract limitations (open)

- Tests were not authorized, so no runtime evidence exists for trigger behavior, migration idempotency,
  or end-to-end isolation.
- Windows path normalization is `#[cfg(windows)]` and has not been compiled or executed on Windows.
- `MemoryError` is returned from Tauri commands; verified to compile, not runtime-verified.

## Phase 1 completion gate

**NOT PASSED / OPEN.** All six tasks plus the review-driven hardening have source implementations that
compile (`cargo check` and `cargo check --tests` pass). The required `cargo test` phase-gate evidence,
live isolation/restart checks, and storage-reopen proof were not run and remain absent.
`docs/CURRENT_ROADMAP.md` was intentionally left unchanged (no executed Rust test evidence).
