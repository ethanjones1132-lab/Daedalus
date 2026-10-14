# Memory Phase 1 — Scoped Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Rust-owned, scoped durable memory store and manually callable Native surface that later phases can use without guessing Agent identity, workspace scope, provenance, or lifecycle eligibility.

**Architecture:** Extend the existing App SQLite memory table and FTS5 index; Rust remains the only durable memory authority. Resolve ownership from persisted Sessions and an explicit canonical workspace binding, then apply eligibility before candidate ranking. Bun receives typed snapshots in phase 2 and keeps its existing TaskRun/tool-context cache separate.

**Tech Stack:** Rust 2021 (repository `rust-version = "1.85.0"`), Tauri 2, rusqlite 0.32 with bundled SQLite/FTS5, serde, chrono, existing Bun/TypeScript tooling; no additional persistence service or embedding dependency.

**Spec:** `docs/superpowers/specs/2026-10-04-memory-four-phase-design.md`; parent priority and completion criteria: `docs/CURRENT_ROADMAP.md`, #1.

## Global Constraints

- Rust/Tauri's native memory engine and App SQLite database remain the durable memory authority. Bun consumes bounded recall context and retains its distinct TaskRun/tool-context cache; it must not introduce a second writable durable memory store.
- Agent identity comes from the persisted Session/Agent relationship. Project scope is an explicit, validated workspace binding. Scope selection is separate from filesystem authorization.
- Existing unscoped records are preserved by additive migration. They do not become automatically shared across projects or Agents. Make any rescoping deliberate and inspectable.
- User-wide knowledge is explicitly scoped; sharing across Agents is an explicit policy, never a wildcard fallback.
- Filter Agent/project scope, status, expiry, and tier before ranking/limiting recalled entries.
- Recalled text is data, not authority. It cannot grant filesystem access, change Permission policy, or activate prompt deltas or skills.
- Preserve current FTS-based retrieval for the first slice. Add semantic retrieval only if the acceptance scenarios establish a need.
- Keep the existing native housekeeping helper's skill mutation, prompt deltas, and unrelated learning behaviors outside this priority.
- This phase ships scoped store/manual operations. Phase 2 owns live preparation transport and prompt injection; phase 3 owns automatic capture/transactional correction; phase 4 owns operator UI and live acceptance.
- Content remains limited to 4096 UTF-8 bytes. Phase 1 recall limits are 5 returned entries and 30 eligible candidates; user-wide inclusion defaults to false.
- Future commands below are implementation checks, not checks performed during planning. Cargo, rustc, and rustup are currently unavailable on the local PATH; no current live memory behavior has been validated.

## Review Focus

1. An overlapping high-ranked record in another Agent/project must neither leak nor displace an eligible result; pin with `scoped_candidates_filter_before_limit` in Task 4.
2. A symlink, deleted workspace, relative path, or parent traversal must not silently establish another project identity; pin with Task 2 normalization/binding tests.
3. A pre-scope or oldest path-schema database must retain its original information without making it shared memory; pin with Task 1 legacy migration tests and Task 6 adoption tests.
4. A forged verified observation or a message ID belonging to another Session must fail with no write/event; pin with `provenance_requires_matching_session_messages` in Task 3.
5. A database/event-write failure or obsolete revision must not return a successful mutation or leave a partially saved record; pin with Task 3 transaction tests and Task 5 command tests.

---

## Verified Baseline and File Map

Source reviewed at roadmap baseline `1cb1ce6947edd84154c326fc19d0fbf9e71e0e2e`; inspect the execution checkout before changing it.

- `src-tauri/src/db/migrations.rs` creates memory and patches Agent/source/status/expiry/tier columns; its initial path-schema compatibility block currently drops old `memory` tables. Replace that destructive branch with preservation.
- `src-tauri/src/jarvis/memory/engine.rs` owns existing entries, FTS, events, manual CRUD, summaries, and housekeeping. `create_or_merge_memory` hardcodes `agent_id='jarvis'`; its similarity search and recall have no project scope. Existing housekeeping also mutates skills.
- `src-tauri/src/commands/sessions.rs` owns `sessions.agent_id`; there is no persisted project binding. `SessionSummary` and `create_session_row` are canonical, while `commands/jarvis_commands.rs::summary_to_jarvis_session` projects a smaller UI shape.
- `server-jarvis/src/memory-recall.ts` reads App SQLite independently and hides failures as empty results; it has no production caller found. Do not activate it. `orchestration/session-memory.ts` owns separate workspace-aware TaskRun/tool caches, not accepted durable project facts.
- The actual UI `JarvisView.tsx::streamFromJarvisApi` directly fetches `/chat/stream`, while `runner.rs::run_jarvis_message` supplies a second native relay. A phase 2 handoff must cover both.
- Bun `orchestration/workspace-affinity.ts` infers workspace from user prose/history; that inference is not durable memory scope authority.

Create focused Rust modules: `memory/contracts.rs` for DTOs/errors, `memory/scope.rs` for canonical scope/binding, and `memory/scoped.rs` for transactions/eligible retrieval. Register them in `memory/mod.rs`. Keep legacy `MemoryEntry` intact; `ScopedMemoryEntry` wraps it, avoiding changes to every existing constructor. Tests live in each module's `#[cfg(test)] mod tests`, following the repository's Rust pattern. `server-jarvis/src/memory-contract.ts` is a wire-types-only module with a literal round-trip fixture test; no database access. Do not redesign MemoryView in this phase.

## Cross-phase Interfaces: Frozen Store and Wire Contracts

All serde enum values and field names below use snake_case. DTO decoding denies unknown fields for requests. `MemoryError { code: MemoryErrorCode, message: String }` serializes without SQL, paths unrelated to the selected scope, or submitted secret content. Codes: `invalid_scope`, `invalid_path`, `workspace_unavailable`, `session_not_found`, `not_found`, `invalid_payload`, `invalid_provenance`, `revision_conflict`, `storage_unavailable`.

- `MemoryScope { kind: MemoryScopeKind, agent_id: String, project_root: Option<String> }`; kinds `project | agent | user | legacy_unscoped`. Project requires a nonempty exact Session Agent ID and canonical root; do not lowercase or substitute an Agent slug for the persisted ID; Agent requires Agent ID and null root; explicitly user-wide records use Agent ID `""` and null root. Legacy is readable only through operator inspection/adoption.
- `ScopeSelector { kind: WritableScopeKind }`; kinds `project | agent | user`. External scoped APIs take `session_id + selector`, never caller-supplied Agent ownership. Project is the default choice when bound; no bound project defaults to Agent scope, never user-wide.
- `MemoryDraft { title: String, content: String, tags: Vec<String>, category: String, expires_at: Option<String>, review_after: Option<String> }`; allowed categories remain `general | user | feedback | project | reference`. Category is descriptive and never grants scope.
- `MemoryProvenance { authority_kind: AuthorityKind, source: String, source_session_id: Option<String>, source_message_ids: Vec<String>, source_run_id: Option<String>, verified_at: Option<String> }`; authority kinds `manual | user_statement | verified_observation | assistant_proposal | legacy_unknown`. Manual commands construct `manual` themselves. All cited messages must exist in the cited Session and its Agent must match a project/Agent scope. Verified observations require a verified timestamp and attributable native capture evidence; they cannot be asserted through the manual command DTO. Phase 3 defines that trusted evidence admission.
- `ScopedMemoryEntry { entry: MemoryEntry, scope: MemoryScope, authority_kind: AuthorityKind, source_run_id: Option<String>, verified_at: Option<String>, revision: i64 }`.
- `ScopedMemoryRecall { memory: ScopedMemoryEntry, score: f64, matched_terms: Vec<String>, stale: bool }`; expired records are excluded, while `review_after <= now` marks stale. Live eligibility excludes `legacy_unknown` and `assistant_proposal`. Phase 4 establishes revalidation; stale project facts cannot be treated as fresh observations.
- `RecallOptions { limit: usize, include_user_scope: bool }`, default `{limit:5, include_user_scope:false}`; `RecallPreview { scope: MemoryScope, store_revision: i64, entries: Vec<ScopedMemoryRecall> }`.
- `MutationResult { memory: ScopedMemoryEntry, store_revision: i64, changed: bool }`; changed false is reserved for an already-tombstoned delete or already-active restore. `expected_revision` is required for update/delete/restore/adopt; conflicting revisions return `revision_conflict`.

### Schema additions

Use `add_column_if_missing` after existing schema patches; do not rebuild the current memory table or FTS triggers. Add:

| Table | Column/table | Exact definition |
|---|---|---|
| `sessions` | `project_root` | `TEXT` (null means no project binding) |
| `memory` | `scope_kind` | `TEXT NOT NULL DEFAULT 'legacy_unscoped'` |
| `memory` | `project_root` | `TEXT` |
| `memory` | `authority_kind` | `TEXT NOT NULL DEFAULT 'legacy_unknown'` |
| `memory` | `source_run_id` | `TEXT` |
| `memory` | `verified_at` | `TEXT` |
| `memory` | `revision` | `INTEGER NOT NULL DEFAULT 1` |
| new `memory_store_state` | singleton state | `singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL DEFAULT 0`; insert `(1,0)` once |

Create index `idx_memory_scope_eligibility(scope_kind, agent_id, project_root, status, tier)`. Add INSERT/UPDATE validation triggers for new scoped rows: allowed enum values; project/Agent/user column combinations; positive revision; no reassignment of an established scope except explicit legacy adoption. Existing legacy rows retain their original Agent IDs and metadata. All timestamps written by scoped operations normalize to RFC3339 UTC; malformed persisted expiry/review timestamps exclude that record from recall and emit a structured native warning containing only memory ID and invalid timestamp field, never memory content.

Create `memory_store_revision_ai/au/ad` triggers: INSERT/DELETE increment singleton revision; UPDATE increments it only when title/content/tags/category, Agent/scope/root, source/provenance fields, confidence, status, expiry/review date, supersedes_id, metadata, tier, or summary changes (compare nullable values with SQLite `IS NOT`). Recall usage_count/last_used_at/relevance_score-only updates and the existing updated_at_ms trigger do not invalidate context. Add `memory_row_revision_au` for those same semantic fields when NEW.revision=OLD.revision, covering legacy mutations while scoped updates set revision explicitly. Revision is monotonic invalidation, not a mutation count. Read the store revision after the transaction commits. No-op scoped operations execute no UPDATE; per-row revision increments once per successful semantic update.

Existing `source`, `source_session_id`, `source_message_ids`, `expires_at`, `review_after`, `status`, `supersedes_id`, tier/cold metadata, and `memory_events` remain. Existing records default to legacy quarantine without inference from category/title/source-session. Explicit adoption creates an event containing before/after scope; it does not rewrite original provenance as verified. Preserve oldest `path`-schema tables as `memory_legacy_path_backup` before creating the current schema; never silently delete the backup or expose those file paths to automatic retrieval.

### Exact native interfaces consumed by phases 2–4

```rust
// scope.rs
pub fn normalize_project_root(raw: &str) -> Result<String, MemoryError>;
pub fn bind_session_workspace(conn: &Connection, session_id: &str, root: Option<&str>)
    -> Result<MemoryScope, MemoryError>;
pub fn resolve_session_memory_scope(conn: &Connection, session_id: &str)
    -> Result<MemoryScope, MemoryError>;
pub fn resolve_write_scope(conn: &Connection, session_id: &str, selector: &ScopeSelector)
    -> Result<MemoryScope, MemoryError>;
// scoped.rs; now is supplied for deterministic lifecycle tests.
pub(crate) fn with_memory_savepoint<T>(conn: &Connection,
    operation: impl FnOnce(&Connection) -> Result<T, MemoryError>) -> Result<T, MemoryError>;
pub fn save_scoped_memory(conn: &Connection, scope: &MemoryScope, draft: MemoryDraft,
    provenance: &MemoryProvenance, now: DateTime<Utc>) -> Result<MutationResult, MemoryError>;
pub fn read_scoped_memory(conn: &Connection, scope: &MemoryScope, id: &str)
    -> Result<ScopedMemoryEntry, MemoryError>;
pub fn list_scoped_memories(conn: &Connection, scope: &MemoryScope, include_inactive: bool)
    -> Result<Vec<ScopedMemoryEntry>, MemoryError>;
pub fn update_scoped_memory(conn: &Connection, scope: &MemoryScope, id: &str,
    expected_revision: i64, draft: MemoryDraft, provenance: &MemoryProvenance, now: DateTime<Utc>)
    -> Result<MutationResult, MemoryError>;
pub fn tombstone_scoped_memory(conn: &Connection, scope: &MemoryScope, id: &str,
    expected_revision: i64, reason: &str, now: DateTime<Utc>) -> Result<MutationResult, MemoryError>;
pub fn restore_scoped_memory(conn: &Connection, scope: &MemoryScope, id: &str,
    expected_revision: i64, now: DateTime<Utc>) -> Result<MutationResult, MemoryError>;
pub fn recall_scoped_memories(conn: &Connection, scope: &MemoryScope, query: &str,
    options: &RecallOptions, now: DateTime<Utc>) -> Result<RecallPreview, MemoryError>;
pub fn adopt_legacy_memory(conn: &Connection, id: &str, expected_revision: i64,
    target: &MemoryScope, now: DateTime<Utc>) -> Result<MutationResult, MemoryError>;
pub fn memory_store_revision(conn: &Connection) -> Result<i64, MemoryError>;
```

Phase 3 correction will create a new row whose `supersedes_id` points to the previous row, and tombstone the previous row atomically. Do not reuse legacy `tombstone_memory`'s argument as the replacement relationship: its existing direction is unsuitable. Phase 3 owns the correction transaction and turn-operation ledger.

## Task 1: Preserve legacy data and establish schema contracts

**Files:** Modify `src-tauri/src/db/migrations.rs::{run_migrations,apply_schema_patches,tests}`; create `src-tauri/src/jarvis/memory/contracts.rs`; modify `src-tauri/src/jarvis/memory/mod.rs`; create `server-jarvis/src/memory-contract.ts` and `server-jarvis/src/memory-contract.test.ts`.

**Interfaces:** Consumes existing `run_migrations(&Connection) -> rusqlite::Result<()>`. Produces the schema/types above and `pub fn apply_scoped_memory_migrations(conn: &Connection) -> rusqlite::Result<()>` called after existing patches; TS exports the corresponding wire interfaces, not a database client.

- [ ] **Step 1: Write failing schema and serialization tests.** `scoped_memory_migration_preserves_legacy_and_repeats` inserts a pre-scope record with Agent `a`, event, FTS content, tombstone, and expiry; assert two migrations preserve all original fields, assign `legacy_unscoped/legacy_unknown`, and keep exactly one state row. `path_schema_memory_is_backed_up` asserts old `path/content` values survive in `memory_legacy_path_backup`. `scoped_schema_rejects_invalid_scope_shape` asserts project with null root and user with Agent `a` cannot be inserted. Rust `memory_wire_fixture_round_trips` and Bun test of the same name assert matching enum values/nulls/nested `entry` shape; request fixture with injected `agent_id` is rejected.
- [ ] **Step 2: Confirm failures.** Run `cargo test --manifest-path src-tauri/Cargo.toml scoped_memory_migration -- --nocapture`, `cargo test --manifest-path src-tauri/Cargo.toml path_schema_memory -- --nocapture`, and `(cd server-jarvis && bun test src/memory-contract.test.ts)`. Expected: new migration/type assertions fail before implementation. First establish Rust 1.85+ and platform Tauri build prerequisites on the execution machine; a missing executable/toolchain is a blocker, not a failed product test.
- [ ] **Step 3: Implement the schema, preservation branch, enums/DTOs, and fixture.** Use additive patches, named scope/index/revision triggers, a savepoint for the scoped migration group, and a failure if an unexpected backup collision would lose data. Keep current FTS synchronization intact. Do not materialize prose-based project ownership.
- [ ] **Step 4: Run the focused commands plus `cargo test --manifest-path src-tauri/Cargo.toml scoped_schema -- --nocapture` and `cargo test --manifest-path src-tauri/Cargo.toml memory_wire -- --nocapture`.** Expected: PASS; repeated migration produces no duplicate records/events and does not increment revision merely by rerunning the scoped migration.
- [ ] **Step 5: Commit this task during implementation.** `git add src-tauri/src/db/migrations.rs src-tauri/src/jarvis/memory/contracts.rs src-tauri/src/jarvis/memory/mod.rs server-jarvis/src/memory-contract.ts server-jarvis/src/memory-contract.test.ts` then `git commit -m "feat: establish scoped memory persistence contracts"`.

## Task 2: Resolve Agent and project identity from Native Sessions

**Files:** Create `src-tauri/src/jarvis/memory/scope.rs`; modify `src-tauri/src/jarvis/memory/mod.rs`; modify `src-tauri/src/commands/sessions.rs::{SessionSummary,list_session_rows,tests}` only to expose the nullable binding. Keep `create_session_row`'s existing signature compatible; new Sessions start unbound.

**Interfaces:** Consumes Task 1 `MemoryScope`, `ScopeSelector`, `MemoryError`, `sessions.project_root`. Produces the four `scope.rs` signatures above. Binding is an explicit operator action, not a filesystem grant.

- [ ] **Step 1: Write failing tests.** `memory_scope_uses_persisted_agent_and_binding`: Session `s` belongs to `a`; resolve returns Agent scope `a` when unbound, project `a/P` after binding, and `session_not_found` for unknown `s`. `memory_scope_normalizes_symlink_and_trailing_separator`: two existing paths to the same root resolve identically. `memory_scope_rejects_relative_parent_nul_and_file`: each returns `invalid_path`; missing/unreadable root returns `workspace_unavailable` with no binding change. `memory_scope_rebinding_does_not_move_records`: bind P, save memory, bind Q, assert original remains P. `memory_scope_never_falls_back_to_user`: unbound Session cannot request project writes; explicit user selector alone yields `{"kind":"user","agent_id":"","project_root":null}`.
- [ ] **Step 2: Run `cargo test --manifest-path src-tauri/Cargo.toml memory_scope -- --nocapture`.** Expected: FAIL for missing scope module/behavior.
- [ ] **Step 3: Implement scope resolution and binding.** Reject empty, NUL, relative, `~`, and actual parent components; permit directory names containing literal `..`. Canonicalize existing directories with `std::fs::canonicalize`; preserve POSIX case, normalize Windows verbatim prefixes/slashes and drive/UNC case consistently, and never equate Windows/WSL host paths without an explicit existing mapping. Reject filesystem root as a project binding. Persist exact canonical root; revalidate on resolution, failing closed when unavailable. An explicit null unbind returns Agent scope. Scope changes affect future turns; in-flight snapshots retain their binding until their terminal event.
- [ ] **Step 4: Rerun focused tests and `cargo test --manifest-path src-tauri/Cargo.toml session_rows_round_trip -- --nocapture`.** Expected: PASS with existing Session creation/history behavior intact. Add platform-gated Windows normalization cases; do not claim them validated on macOS without execution evidence.
- [ ] **Step 5: Commit.** `git add src-tauri/src/jarvis/memory/scope.rs src-tauri/src/jarvis/memory/mod.rs src-tauri/src/commands/sessions.rs` then `git commit -m "feat: derive memory scope from native session identity"`.

## Task 3: Ship transactional scoped mutation and provenance

**Files:** Create `src-tauri/src/jarvis/memory/scoped.rs`; modify `src-tauri/src/jarvis/memory/mod.rs`; modify narrowly reusable helpers in `src-tauri/src/jarvis/memory/engine.rs` without activating housekeeping.

**Interfaces:** Consumes Tasks 1–2 types/scope. Produces save/read/list/update/tombstone/restore/revision signatures above. Expose `pub(crate)` payload validation/entry decoding/event writer only where needed; scoped saves must not call unscoped `find_similar_memory` or reactivate tombstones by similarity.

- [ ] **Step 1: Write failing tests.** `scoped_mutations_isolate_agents_projects_and_ids`: create identical title/content for `a/P`, `a/Q`, and `b/P`; assert three distinct rows and cross-scope read/update/delete return `not_found`. `scoped_mutations_validate_payload_and_provenance`: 4097-byte content, secret markers, raw transcript, wrong category, nonexistent cited message, and message from another Session all leave zero rows/events. `provenance_requires_matching_session_messages`: accepted `user_statement` points to persisted user message; an assistant message cannot be passed as a user statement; verified timestamp absent rejects verified observation. Manual boundary cannot request verified authority. `scoped_mutations_are_atomic_on_event_failure`: abort event INSERT via test trigger; assert no row/revision change and `storage_unavailable`. `scoped_mutations_revisions_and_lifecycle`: update increments row revision, obsolete expected revision rejects; tombstone excludes future recall, repeated delete changes nothing, restore is explicit and retains original expiry.
- [ ] **Step 2: Run `cargo test --manifest-path src-tauri/Cargo.toml scoped_mutations -- --nocapture` and `cargo test --manifest-path src-tauri/Cargo.toml provenance_requires -- --nocapture`.** Expected: FAIL before store implementation.
- [ ] **Step 3: Implement scoped mutation transactions.** Implement `with_memory_savepoint` with unique named SQL SAVEPOINT/RELEASE and ROLLBACK TO on error, rather than BEGIN/COMMIT. Each store mutation uses it, so phase 3 can place tombstone, replacement, relationship, events, and operation ledger in an outer savepoint. Mutation results inside an outer operation remain provisional; publish a receipt only after outer release and read the final store revision. Mutation plus audit event plus store revision are atomic. Save creates a new record, without heuristic merging. Validate provenance against SQLite messages/Sessions. Normalize dates and reject invalid input dates; restrict confidence/source to trusted native construction rather than manual caller values. Update only active records; restoring an inactive row requires the restore API, and restore cannot override expiry or supersession. Scoped manual update replaces current provenance with manual attribution to the modifying Session, preserving prior source attribution in the immutable before-event; increment revision and record before/after. Never claim an assistant proposal was verified.
- [ ] **Step 4: Rerun the commands.** Expected: PASS; add `scoped_mutations_multibyte_content_limit` asserting byte limit handles emoji without invalid UTF-8 and `scoped_mutations_wrong_scope_has_no_event` asserting rejected cross-scope operations disclose no existing record. Add `scoped_mutations_outer_savepoint_rolls_back_all`: compose successful save and tombstone inside an outer savepoint, induce a final error, assert both rows, events, and revisions revert to their original values.
- [ ] **Step 5: Commit.** `git add src-tauri/src/jarvis/memory/scoped.rs src-tauri/src/jarvis/memory/mod.rs src-tauri/src/jarvis/memory/engine.rs` then `git commit -m "feat: add transactional scoped memory mutations"`.

## Task 4: Recall only eligible scoped candidates

**Files:** Modify `src-tauri/src/jarvis/memory/scoped.rs::{recall_scoped_memories,tests}`; expose existing pure scoring/query-term helpers in `engine.rs` as needed.

**Interfaces:** Consumes `MemoryScope`, `RecallOptions`, `ScopedMemoryEntry`, and revision reader. Produces `RecallPreview` with scoped provenance, stale flag, and current store revision; preview does not mark usage or write recall events. Phase 2 owns live diagnostics/usage accounting.

- [ ] **Step 1: Write failing tests.** `scoped_candidates_filter_before_limit`: insert 31 higher-matching private rows for Q and one valid P row; P recall returns its row. `scoped_recall_agent_and_user_policy`: project P receives same Agent's explicitly Agent-scoped record, P rows, and no Q/b records; explicit user record is absent by default, present only with `include_user_scope:true`; no project binding returns Agent-only plus opt-in user. `scoped_recall_excludes_legacy_tombstone_expired_proposals_cold`: each prohibited class omitted; warm rows expose their local summary for rendering, never fetch Drive; the returned operator record stays intact, and phase 2 renders summary rather than full content for warm-tier prompt excerpts; hot active accepted record included. `scoped_recall_timestamp_boundaries`: expiry exactly now omitted, review exactly now marked stale, malformed dates excluded. `scoped_recall_empty_and_hostile_query`: whitespace/stopword-only returns empty; quote/operator inputs do not execute raw FTS syntax or return unrelated records.
- [ ] **Step 2: Run `cargo test --manifest-path src-tauri/Cargo.toml scoped_recall -- --nocapture` and `cargo test --manifest-path src-tauri/Cargo.toml scoped_candidates -- --nocapture`.** Expected: FAIL before scoped retrieval.
- [ ] **Step 3: Implement FTS and LIKE fallback within the eligible scope.** Join memory to FTS, constrain project/Agent/explicit-user combinations and accepted authority/status/tier/expiry before candidate limit 30, then reuse pure relevance scoring and stable score/ID ordering. Implement date validity/expiry predicates before candidate limits, using SQLite date parsing for normalized values; malformed timestamps cannot consume the candidate budget. Missing or broken FTS may use a scoped literal LIKE fallback; broken storage must return `storage_unavailable`, not an indistinguishable successful empty result. Escape LIKE wildcards. Parse/normalize legacy date values before eligibility; never let malformed timestamps displace valid candidates. Clamp returned limit to 0–5, with 0 returning no entries. Do not call `build_turn_memory_context`: it includes skill/prompt behaviors outside this contract.
- [ ] **Step 4: Rerun the commands; add `scoped_recall_database_failure_is_typed` and `scoped_recall_preview_has_no_write_side_effects`.** Assert failed SELECT returns `storage_unavailable`; successful preview changes neither events, usage, nor store revision. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src-tauri/src/jarvis/memory/scoped.rs src-tauri/src/jarvis/memory/engine.rs` then `git commit -m "feat: retrieve eligible memories within explicit scope"`.

## Task 5: Expose scoped manual commands with truthful results

**Files:** Modify `src-tauri/src/commands/memory.rs`; modify command registration in `src-tauri/src/lib.rs`; create `src-tauri/src/commands/memory_scoped_tests.rs` as the command test module.

**Interfaces:** Consumes Task 2 resolvers and Tasks 3–4 operations. Produces Tauri commands with one `request` DTO argument and `Result<T, MemoryError>`; include State<AppDb> in each Rust command, omitted from wire fields:

| Command | Request fields | Response |
|---|---|---|
| `memory_bind_session_workspace` | `session_id, workspace_root: string|null` | `MemoryScope` |
| `memory_scoped_save` | `session_id, selector, draft` | `MutationResult` |
| `memory_scoped_read` | `session_id, selector, id` | `ScopedMemoryEntry` |
| `memory_scoped_list` | `session_id, selector, include_inactive: bool=false` | `ScopedMemoryEntry[]` |
| `memory_scoped_update` | `session_id, selector, id, expected_revision, draft` | `MutationResult` |
| `memory_scoped_delete` | `session_id, selector, id, expected_revision, reason` | `MutationResult` |
| `memory_scoped_restore` | `session_id, selector, id, expected_revision` | `MutationResult` |
| `memory_scoped_recall_preview` | `session_id, query, options` | `RecallPreview` |
| `memory_adopt_legacy` | `session_id, selector, id, expected_revision` | `MutationResult` |

- [ ] **Step 1: Write failing boundary tests.** `scoped_command_ownership_is_native` rejects request with forged Agent/project/provenance fields and obtains actual persisted owner from Session. `scoped_command_manual_authority_and_receipt` checks forced manual authority, no assistant-message fabrication, and response contains stored ID/revision only after commit. `scoped_command_failure_has_no_saved_result` induces storage failure and asserts error code, no successful receipt. `scoped_command_unknown_session_never_defaults` returns `session_not_found`, never `jarvis`. Test plain request executor helpers, avoiding a mock Tauri app for SQLite behavior.
- [ ] **Step 2: Run `cargo test --manifest-path src-tauri/Cargo.toml scoped_command -- --nocapture`.** Expected: FAIL before command/helpers exist.
- [ ] **Step 3: Implement commands and testable executors.** Define `execute_scoped_save(conn:&Connection, request:ScopedSaveRequest, now:DateTime<Utc>)->Result<MutationResult,MemoryError>` and corresponding `execute_scoped_{read,list,update,delete,restore,recall_preview}` plus `execute_bind_session_workspace`/`execute_adopt_legacy`, with DTO fields from the table and same response types. Commands lock AppDb only around native operations and supply Utc::now; no network calls while holding SQLite mutex. Manual save/update provenance is constructed as `manual`, source `manual`, cited Session set to request Session, message/run IDs empty, verified_at null. Register commands; no UI transport rewrite here.
- [ ] **Step 4: Rerun command tests and `cargo check --manifest-path src-tauri/Cargo.toml`.** Expected: PASS; all commands register and existing command symbols remain valid. Future invocation example: `invoke('memory_scoped_save', {request:{session_id:'s',selector:{kind:'project'},draft:{title:'Constraint',content:'Use local SQLite',tags:[],category:'project',expires_at:null,review_after:null}}})` after an explicit binding succeeds.
- [ ] **Step 5: Commit.** `git add src-tauri/src/commands/memory.rs src-tauri/src/commands/memory_scoped_tests.rs src-tauri/src/lib.rs` then `git commit -m "feat: expose scoped manual memory native commands"`.

## Task 6: Make legacy adoption explicit and close phase 1 gate

**Files:** Modify `src-tauri/src/jarvis/memory/scoped.rs::{adopt_legacy_memory,tests}`, compatibility mutations in `src-tauri/src/commands/memory.rs`/`engine.rs`, and `server-jarvis/src/memory-contract.test.ts`; update phase status/evidence in `docs/CURRENT_ROADMAP.md` only with actual executed results.

**Interfaces:** Consumes all phase 1 contracts. Produces deliberate, audited legacy adoption and compatibility rules that phases 2–4 must retain: existing operator list/read/search remain inspection APIs; old unscoped save creates quarantine records, old mutation cannot rewrite ownership or revive deleted scoped facts silently.

- [ ] **Step 1: Write failing tests.** `legacy_adoption_is_explicit_preserves_source`: only legacy row can be adopted; original provenance/content retained, scope changed, audit before/after saved, row/store revision increases. Adopted manual legacy row gets manual authority only when original source is manual; unknown/automatic old attribution remains `legacy_unknown` and is ineligible until a new explicit correction/verified record. `legacy_adoption_conflict_or_failure_rolls_back` rejects obsolete revision and event failure without scope change. `legacy_commands_cannot_reactivate_scoped_tombstone` verifies old update cannot set scoped tombstone active and old restore refuses scoped records. `legacy_consolidation_and_merge_ignore_scoped_rows` seeds identical titles for legacy, a/P, and a/Q; old save/merge and consolidation leave both scoped rows unchanged. `legacy_admin_delete_invalidates_store_revision` verifies old deletion of a scoped row bumps revisions and scoped recall no longer sees it. `recall_usage_does_not_invalidate_memory_store` updates usage_count/last_used_at/relevance_score and asserts unchanged row/store revisions; content/status/scope changes assert increased revisions. `scoped_store_reopen_preserves_scope_and_provenance` saves to a temporary SQLite file, closes/reopens through migrations, and verifies same IDs/scope/events/expiry; this is a storage check, not live restart evidence.
- [ ] **Step 2: Run `cargo test --manifest-path src-tauri/Cargo.toml legacy_adoption -- --nocapture`, `cargo test --manifest-path src-tauri/Cargo.toml legacy_commands -- --nocapture`, `cargo test --manifest-path src-tauri/Cargo.toml legacy_consolidation -- --nocapture`, and `cargo test --manifest-path src-tauri/Cargo.toml scoped_store_reopen -- --nocapture`.** Expected: FAIL before adoption/compatibility behavior.
- [ ] **Step 3: Implement explicit adoption and compatibility protections.** Read/update exact ID only; no inference from title/category, no automatic promotion of old `jarvis` ownership, no filesystem reads from path backup. Restrict legacy `active_memories` used by consolidation and `find_similar_memory` merge candidates to `scope_kind='legacy_unscoped'` before their limits; do not affect operator list/read/search inspection. Old manual update/restore returns actionable error for scoped records directing callers to scoped APIs; old delete may tombstone with existing operator authority but must increment per-row revision and store revision. Keep inspection endpoints usable for recovery. Do not turn legacy Bun recall helpers into a production path.
- [ ] **Step 4: Run the phase gate.** `cargo test --manifest-path src-tauri/Cargo.toml memory -- --nocapture`; `cargo test --manifest-path src-tauri/Cargo.toml session_rows_round_trip -- --nocapture`; `cargo test --manifest-path src-tauri/Cargo.toml recall_usage_does_not -- --nocapture`; `cargo check --manifest-path src-tauri/Cargo.toml`; `(cd server-jarvis && bun test src/memory-contract.test.ts && bun run typecheck)`. Expected: PASS. Record source revision, actual commands/results, platform/toolchain, storage reopen proof, and unresolved cross-platform/live limitations. Do not mark priority #1 complete or advance to #2.
- [ ] **Step 5: Commit.** Stage only Task 6 files and evidence changes, then `git commit -m "feat: preserve and deliberately adopt legacy memory"`.

## Phase Completion and Handoff

Phase 1 is done when the scoped store/manual Native surface exists and the phase gate passes: two Agents/two projects isolate reads and mutation; pre-scope information remains recoverable; explicit user-wide opt-in works; expiry/tombstone/proposal/legacy eligibility is enforced; provenance and events are atomic; scope cannot be forged through command fields; storage reopening preserves the result. Toolchain absence leaves Rust validation and this phase gate open.

Phase 2 consumes these contracts and adds `memory_prepare_turn`, one shared `turn_id`, bounded snapshots, and validated registration to Bun for UI direct SSE and native relay. A reference-only preparation ID must resolve to a native-created envelope bound to exact Session/turn/message hash/workspace and be consumed once; Bun must not trust arbitrary request Agent/project/context fields. Boot-only native-to-Bun capability must never be exposed to UI, inference, or logs. Its exact envelope/lifecycle contracts are defined in the shared spec and phase 2 plan; phase 1 does not implement or activate that transport.

Phase 4 adds typed classification that distinguishes normative user constraints ("must use SQLite") from descriptive workspace facts ("currently uses SQLite"). Its current-source revalidation does not silently override a user constraint. Phase 3 supplies conservative admission and explicit constraint provenance; generic verified-observation capture remains unsupported. Authority kind describes who supports a statement; it is not that normative/descriptive classification.

Phase 3 consumes expected revisions, source Session/message/run provenance, tombstones, store revision, and composable transactions; it adds atomic correction/forget operations, idempotent terminal capture, and objective-preserving continuity. Phase 4 consumes operator commands, lifecycle diagnostics, and invalidation to implement controls and demonstrate real new-Session/restart behavior. Existing context caches and Skill promotion remain separate throughout.
