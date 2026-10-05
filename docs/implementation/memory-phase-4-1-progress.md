# Memory Phase 4.1 — Native classification and operator controls

**Execution:** DeepSeek v4.1 Flash (`opencode-go/deepseek-v4.1-flash`) via OpenCode CLI.
**Branch:** `codex/memory-deepseek-20261004`.
**Source SHA (execution HEAD):** `b9e0a4f432b4e7b1d59e164b74c4114aafb46cb4`.
**Status:** Production source implemented; permitted compiler/type/build checks pass. **No tests, fixtures, or live/restart acceptance were written or run.** Priority #1 remains active and is not runtime-complete.

## Scope delivered

Conservative native statement classification and scoped Memory operator controls only. Session projection/identity, bound-workspace candidate resolution, and fresh-source revalidation are explicitly deferred to Parts 4.2–4.4 and were not touched.

## Native classification

- Added `MemoryStatementKind { normative_constraint, descriptive_fact, unknown }` in `contracts.rs` with snake_case serialization and a manual `Default = Unknown`.
- Added required `statement_kind` to `ScopedMemoryEntry` with `#[serde(default)]` so older persisted payloads decode as `unknown`.
- Added required `statement_kind` to `PreparedMemorySelection` (`turn.rs`), likewise `#[serde(default)]`, and populated it from the selected scoped entry when building prepared items.
- Migration `apply_scoped_memory_migrations`: additive `memory.statement_kind TEXT NOT NULL DEFAULT 'unknown'`. SQLite cannot add a column `CHECK` via `ALTER TABLE`, so the three-value constraint is enforced by `memory_statement_kind_validate_bi` / `_bu` BEFORE INSERT/UPDATE triggers, matching the existing scope/authority trigger pattern. All existing content/provenance/status/revision is preserved; no title/category/source inference.
- `statement_kind` is included in the store-revision `semantic_change` predicate. Because the revision triggers were originally created with `IF NOT EXISTS`, the migration drops and recreates `memory_store_revision_au` and `memory_row_revision_au` only when the column is first introduced (inside the existing `scoped_memory_migration` savepoint, so ALTER + trigger rebuild roll back together on failure).
- `scoped.rs`: added `parse_statement_kind` / `statement_kind_str`, added `m.statement_kind` to the scoped select (index 31) and `scoped_from_row`. Added `save_scoped_memory_with_kind`, `update_scoped_memory_with_kind` (absent kind preserves the prior row kind), and transactional `classify_scoped_memory`. Frozen `save_scoped_memory` / `update_scoped_memory` remain as compatibility wrappers (unknown / preserve).
- `classify_scoped_memory` validates writable scope, expected revision, and ownership inside one `with_memory_savepoint` alongside its before/after `classify` audit event. Same-kind is a native no-op (`changed:false`, no event, no revision bump). Cross-scope id returns `not_found`; invalid enum is rejected by serde before any transaction and by the DB trigger as defence in depth.
- `capture.rs`: only `explicit_constraint` save initializes `normative_constraint`; `explicit_remember` / `explicit_decision` and staged proposals stay `unknown`. `replace_scoped_memory` resolves an absent replacement kind to the target's prior kind, so correction inherits classification unless deliberately overridden. Added `correct_scoped_memory_with_kind`; the frozen `correct_scoped_memory` wrapper passes `None`.
- Correction replay hash: only the **operator manual** correction hash (`manual_correct_operation_hash` / `manual_correct_hash`) participates in the optional kind, and **only when the kind is present**. `None` appends nothing, so a legacy operator correction whose request omits `statement_kind` keeps the exact Phase 3 hash (`manual_correct` + session/id/revision + scope + draft, no trailing null) and already-recorded ledger rows still replay byte-for-byte. `Some(kind)` appends the snake_case classification string so a deliberate reclassification participates in conflict detection (same identity/different kind → `operation_conflict`). The automatic-capture correction hash path is untouched and remains byte-identical to Phase 3.
- `capture_contracts.rs`: `ScopedCorrectRequest` gained optional `statement_kind` (`#[serde(default)]`).
- `commands/memory.rs`: `ScopedSaveRequest` / `ScopedUpdateRequest` gained optional `statement_kind`; added `ScopedClassifyRequest`, `execute_scoped_classify`, and registered `memory_scoped_classify`. Save absent → `unknown`; update absent → preserve; classify runs through the same derived-gated mutation/invalidation path as other knowledge mutations. Registered in `lib.rs`.
- `commands/memory_capture.rs`: manual correct replay and commit pass `request.statement_kind` through.

## Wire and Bun

- `server-jarvis/src/memory-contract.ts`: added `MemoryStatementKind`, `ScopedMemoryEntry.statement_kind`, `PreparedMemorySelection.statement_kind`, optional `statement_kind` on save/update/correct requests, and `ScopedClassifyRequest`.
- `server-jarvis/src/native-memory.ts`: `validateEnvelope` now rejects a registered native envelope whose selections lack a valid `statement_kind`; inference or arbitrary `/chat/stream` fields can never supply it. Per the design, old registrations are gone on restart and current native/Bun processes are rebuilt together.

## UI operator controls

- New `src-ui/src/components/jarvis/memory-control-state.ts`: strict decoders `decodeScopedMemoryEntries`, `decodeRecallPreview`, `decodeMutationResult`, `decodeCorrectionResult`, `decodeForgetResult`, plus `MemoryControlTarget`, `MemoryMutationState`, and helpers. Nested scope/authority/provenance/classification/lifecycle/revision are preserved; missing response classification decodes as `unknown`; malformed supplied classification throws.
- New `src-ui/src/components/jarvis/MemoryScopeControls.tsx`: explicit existing-Session chooser, project/Agent/user scope selector, inactive-inspection toggle, and a local (never persisted) user-wide recall opt-in.
- Rewrote `MemoryView.tsx`: with no selected Session the operator must choose one; scoped list/recall use `memory_scoped_list` / `memory_scoped_recall_preview`; legacy recovery is a separate deliberate mode. Added receipt-backed create, edit, correct (stable per-target operation UUID across retries), classify, forget (reason + confirmation + stable operation UUID), restore, and legacy adopt. A mutation is shown as confirmed only from a decoded native receipt; errors show unavailable with the draft retained. A captured `scopeGeneration` guard prevents a late result from rendering under a different Session/scope. Preview is presented only as a scoped recall query, never as actual turn selection.

## Permitted checks actually run

| Check | Command | Result |
|---|---|---|
| Whitespace/conflict | `git diff --check` | PASS (exit 0) |
| Rust compile | `cargo check --manifest-path src-tauri/Cargo.toml` | PASS (exit 0); only pre-existing `supervisor.rs`/`wsl.rs` warnings |
| Bun typecheck | `server-jarvis: bun run typecheck` | PASS (exit 0) |
| Bun build | `server-jarvis: bun run build` | PASS (exit 0); 197 modules bundled |
| UI build | `src-ui: bun run build` (`tsc -b && vite build`) | PASS (exit 0); existing large-chunk warning only |

No tests/test declarations/fixtures were added or edited; no product tests, scripted runtime probes, live inference, restarts, or acceptance experiments were run. These remain **NOT RUN / requires user request**.

The focused correction pass (operator-correction hash compatibility) re-ran only `git diff --check` (PASS) and `cargo check --manifest-path src-tauri/Cargo.toml` (PASS); no tests or runtime experiments were run for it.

The five-finding correction pass re-ran, with actual exit statuses: `git diff --check` → exit 0; `cargo check --manifest-path src-tauri/Cargo.toml` → exit 0 (only pre-existing `supervisor.rs`/`wsl.rs` warnings); `server-jarvis: bun run typecheck` → exit 0; `server-jarvis: bun run build` → exit 0 (197 modules); `src-ui: bun run build` → exit 0 (2,721 modules transformed, existing large-chunk warning only). No check was masked by a pipeline.

## Focused source-review corrections (same session)

1. **Recall-preview evidence preserved.** `MemoryView.loadScoped` no longer flattens `RecallPreview` to bare entries. A new `preview` state holds the decoded preview; a normal scoped list clears it. While a hypothetical query preview is active the view shows the effective scope (kind + project root) and store revision in a plain "Hypothetical recall preview — not applied to any turn" banner, and each entry shows native `score`, `matched_terms`, and `fresh`/`stale`. Never labeled applied/used. Normal list behavior, layout, keyboard/focus, loading and error paths are otherwise unchanged.
2. **Malformed nested success rejected.** `decodeMemoryEntry` now validates the full `MemoryEntry` DTO: required strings, finite `relevance_score`/`confidence`/`usage_count`, nullable `source_session_id`/`last_used_at`/`expires_at`/`review_after`/`supersedes_id`/`metadata`, optional `summary`/`drive_file_id`/`archived_at`/`tier`/`updated_at_ms`, and valid JSON-array-of-strings `tags`/`source_message_ids`. `decodeScope` requires `project_root` to be explicitly present and `string | null`. `authority_kind` is validated against the exact enum (`manual|user_statement|verified_observation|assistant_proposal|legacy_unknown`). The only compatibility retained is missing `statement_kind` → `unknown`. Any malformed receipt/status now throws and surfaces as unavailable/error. (Superseded in detail by the final scope-contract correction below, which requires every frozen field's presence and type, not just its validity when present.)
3. **Operation UUID bound to exact payload.** Correction `operationRef` keys now include a canonical serialization of the submitted draft and classification; forget keys include the exact reason. An unchanged target + payload retry keeps the UUID; editing draft/kind/reason mints a new UUID.
4. **Stale scope generation closed synchronously.** Added `markScopeChange()` (increments both `scopeGeneration` and `requestId`) invoked at the moment of every Session/scope/inactive/user-opt-in/legacy control change, so an in-flight read or mutation cannot publish an old scope's result under the newly selected scope. The effect still resets selection/mutation state; pending-control disabling is unchanged.
5. **Preview opt-in label corrected.** The `MemoryScopeControls` checkbox now reads "Include user-wide in preview" with a preview-only tooltip. This view's option affects only the hypothetical preview; the actual turn-scope opt-in belongs to the Session/chat controls in Part 4.2.

The Phase 3 manual-correction hash fix (kind appended only for `Some(kind)`) is preserved unchanged. All five corrections are production source only; no tests/fixtures/test declarations were touched.

## Final scope-contract corrections (same session)

1. **Deliberate Forget confirmation.** (Superseded by the final UI correctness correction, which replaces the inline panel with the shared `ConfirmModal` and keeps the exact reason in the modal detail.) The inspection form has a `Forget…` button that only opens an accessible confirmation showing the record title and exact reason. The `memory_scoped_forget` command is issued only from confirm; cancel issues no command and preserves the reason, draft and open inspection. The reason field still gates the button.
2. **Deliberate legacy adoption target.** (Superseded by the final UI correctness correction, which replaces the inline panel with the shared `ConfirmModal`, and by the legacy revision projection correction below, which replaces the earlier hardcoded `expected_revision: 1` with the authoritative SQL revision.) The per-entry button is `Adopt into scope…` and opens a confirmation that displays the exact target Session, target scope kind, and expected revision. The `memory_adopt_legacy` command is issued only from confirm, using the Session/scope captured at confirmation and the authoritative native revision. `Cancel` issues nothing. Successful adoption is shown only from the decoded native `MutationResult`; a native `revision_conflict` surfaces as unavailable. Native revision validation is unchanged.
3. **`stale` relabeled.** Preview pills now read `review due` / `review not due` (lifecycle review metadata) instead of `fresh`/`stale`, so the UI never implies current-source validation.
4. **Full frozen DTO presence required.** `decodeMemoryEntry` now requires `tier` and `summary` as strings, `updated_at_ms` as a finite number, and explicitly present `string|null` for `source_session_id`/`last_used_at`/`expires_at`/`review_after`/`supersedes_id`/`metadata`/`drive_file_id`/`archived_at`; `tags`/`source_message_ids` must be valid JSON string arrays. `decodeScopedMemoryEntry` requires `source_run_id` and `verified_at` to be explicitly present `string|null`. Only missing `statement_kind` continues to decode as `unknown`. A missing serialized scope/provenance field is malformed and becomes unavailable.

Final pass exit statuses (unmasked): `git diff --check` → 0; `server-jarvis: bun run typecheck` → 0; `server-jarvis: bun run build` → 0 (197 modules); `src-ui: bun run build` → 0 (2,721 modules, existing large-chunk warning only). No Rust file changed in this pass, so `cargo check` was not re-run. No tests, fixtures, or test declarations were touched.

## Final UI correctness corrections (same session)

1. **Strict classification compatibility.** `decodeStatementKind` now treats only a MISSING field (`undefined`) as legacy-compatible `unknown`. A present `null` (or any non-kind value) is malformed and throws → unavailable. This supersedes the earlier `null || undefined` acceptance.
2. **Accessible confirmation flow for Forget, Restore, and Legacy Adopt.** The three actions no longer use inline `role=alertdialog` panels or immediate native calls. Each now opens the existing shared `src-ui/src/components/ui/ConfirmModal.tsx` (imported via `../ui`; not recreated or altered), which owns its focus trap, Escape cancellation, and opener focus return. `Forget…`, `Restore…`, and `Adopt into scope…` only open the modal; the native `memory_scoped_forget` / `memory_scoped_restore` / `memory_adopt_legacy` command is issued only from the modal's confirm. Cancel/Escape issue no command and preserve the draft/reason and open inspection.
   - The Forget modal keeps the required reason and displays it plus the target title; on confirm the stable retry UUID remains bound to the exact target + reason (`forget|<session>|<scope>|<id>|<revision>|<reason>`), so an unchanged retry keeps the UUID and editing the reason mints a new one.
   - The Adopt modal detail shows the exact target Session, target scope kind, and the authoritative SQL revision now projected by the legacy list; native revision validation is unchanged and success is shown only from the decoded native `MutationResult`.
   - The Restore modal detail shows the scoped entry's scope kind (+ project root) and revision.

Final UI pass exit statuses (unmasked): `git diff --check` → 0; `src-ui: bun run build` → 0 (2,721 modules, existing large-chunk warning only). No native contract changed, so no Rust/Bun check was required. No tests, fixtures, or test declarations were touched.

## Legacy revision projection correction (parent reviewer ruling)

Parent reviewer ruling: legacy adoption must display and submit an **authoritative actual revision**, never a hardcoded `1`. Legacy (unscoped) adoption now sources the real per-row SQL revision end to end.

1. **Native revision projection (additive, scoped indexes untouched).** Added `engine::LegacyMemoryEntry { #[serde(flatten)] memory: MemoryEntry, revision: i64 }` and `engine::list_legacy_memories_with_revision`, which selects `memory_columns()` plus the real `revision` column, maps the frozen first 25 columns through `memory_from_row`, and reads the actual DB revision from column index 25. The shared `MemoryEntry`/`memory_columns()`/`memory_from_row` shapes are unchanged, so no scoped column index shifts. Only the `memory_list` command return type changed to `Result<Vec<engine::LegacyMemoryEntry>, String>`; every other command/API struct is unchanged. The flattened serialization keeps the prior legacy JSON fields and adds exactly one field, `revision`.
2. **Strict UI decoding.** `memory-control-state.ts` adds `LegacyMemoryEntry`, `decodeLegacyMemoryEntry`, `decodeLegacyRevision` (positive integer only), and `decodeLegacyMemoryListings`. A record whose `revision` is missing, non-integer, or `<= 0` is decoded as `unavailable` and is **non-adoptable**; it is never guessed. The legacy list keeps such records visible (with an "Adoption unavailable: Native revision unavailable" status) rather than silently dropping them or failing the whole list.
3. **UI uses the real revision.** `MemoryView` renders the decoded listings, shows the exact SQL revision in the adopt `ConfirmModal` detail, and passes `entry.revision` (the actual native value) into both the `MemoryControlTarget` and the `memory_adopt_legacy` request. The two previously hardcoded `expected_revision: 1` expressions are removed; adoption is impossible for an unavailable record because no adopt control is rendered for it. Native adoption semantics are unchanged.

Post-correction exit statuses (unmasked): `git diff --check` → 0; `cargo check --manifest-path src-tauri/Cargo.toml` → 0 (only pre-existing `supervisor.rs`/`wsl.rs` warnings); `server-jarvis: bun run typecheck` → 0; `server-jarvis: bun run build` → 0 (197 modules); `src-ui: bun run build` → 0 (2,721 modules, existing large-chunk warning only). No tests, fixtures, or test declarations were touched.

## Safe-integer legacy revision correction (same session)

`decodeLegacyRevision` now requires `Number.isSafeInteger(value)` and `value > 0` instead of only `Number.isInteger(value)`. A native Rust `i64` revision beyond the JS exact-integer range (`2^53 - 1`) cannot be safely resubmitted as `expected_revision`, so it is now rejected as `Legacy memory revision unavailable`. The existing unavailable/non-adoptable path is preserved: `decodeLegacyMemoryListings` still keeps such records visible with an "Adoption unavailable: Native revision unavailable" status rather than guessing or dropping them. No other code changed.

Checks run (unmasked, actual exit codes): `src-ui: bun run build` → exit 0 (2,721 modules transformed; existing large-chunk warning only); `git diff --check` → exit 0. No tests were added or run.

## Legacy-only recovery-list filter correction (parent reviewer ruling)

`scoped::adopt_legacy_memory` only updates rows where `scope_kind = 'legacy_unscoped'`, but the dedicated recovery list `engine::list_legacy_memories_with_revision` previously selected all `memory` rows, so already-scoped records were displayed as adoptable legacy records even though adoption would not touch them. The dedicated query now adds a native `WHERE scope_kind = 'legacy_unscoped'` filter; the existing ordering (`ORDER BY status ASC, updated_at DESC`) and the real per-row `revision` projection (column index 25) are preserved. The shared `list_memories` and every other API are unchanged.

Checks run (unmasked, actual exit codes): `git diff --check` → 0; `cargo check --manifest-path src-tauri/Cargo.toml` → 0 (only pre-existing `supervisor.rs`/`wsl.rs` warnings); `server-jarvis: bun run typecheck` → 0; `server-jarvis: bun run build` → 0 (197 modules); `src-ui: bun run build` → 0 (2,721 modules; existing large-chunk warning only). No tests, fixtures, test declarations, or runtime experiments were added or run.

## Files changed

Tracked (production only):

- `src-tauri/src/jarvis/memory/contracts.rs`
- `src-tauri/src/jarvis/memory/engine.rs`
- `src-tauri/src/jarvis/memory/scoped.rs`
- `src-tauri/src/jarvis/memory/capture.rs`
- `src-tauri/src/jarvis/memory/capture_contracts.rs`
- `src-tauri/src/jarvis/memory/turn.rs`
- `src-tauri/src/db/migrations.rs`
- `src-tauri/src/commands/memory.rs`
- `src-tauri/src/commands/memory_capture.rs`
- `src-tauri/src/lib.rs`
- `server-jarvis/src/memory-contract.ts`
- `server-jarvis/src/native-memory.ts`
- `src-ui/src/components/jarvis/MemoryView.tsx`

Created (production only):

- `src-ui/src/components/jarvis/memory-control-state.ts`
- `src-ui/src/components/jarvis/MemoryScopeControls.tsx`
- `docs/implementation/memory-phase-4-1-progress.md` (this file)

No tests, fixtures, or test declarations were modified. Existing dirty baseline files (`AGENTS.md`, `PRIORITIES.md`, `README.md`, `docs/COMPLETION_BACKLOG.md`, `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md`) and untracked schema/output artifacts were left untouched. Nothing was staged or committed.

## Gaps and limitations

- The `memory_scoped_tests.rs` file named in the part plan does not exist at this HEAD; no native inline tests exist for these modules. Rust test modules are not compiled by `cargo check`.
- Legacy adoption now submits the authoritative per-row SQL revision projected additively by `engine::list_legacy_memories_with_revision`; a legacy row whose revision is unavailable is shown as non-adoptable rather than guessed. A native `revision_conflict` still surfaces as unavailable.
- The UI is a source-level control surface. No product tests verify focus/confirmation/receipt behavior; those are Phase 4 acceptance work.
- `fresh_evidence`, revalidation receipts, applied-vs-prepared turn status, Session identity projection, and bound-workspace candidate resolution are intentionally absent (Parts 4.2–4.4).
- Compiler/type/build success establishes source compilation and bundling only and does not close priority #1 or constitute runtime acceptance.

## Self-review

Reviewed the production diff against the parent Phase 4 additive classification contract and Phase 1–3 frozen contracts:

- Phase 1 scope/authority/provenance/revision and legacy isolation are unchanged except the named additive field; legacy rows remain read-only until explicitly adopted.
- Phase 2 preparation outputs now carry `statement_kind`; the derived-gated invalidation path is reused for classify. No second writable store was introduced.
- Phase 3 capture/receipt/ledger/suppression/continuity semantics are preserved; the automatic-capture hash is byte-identical and only the operator manual correction hash extends with the optional kind.
- Operator manual correction hash compatibility (Luna source-review correction): the optional kind is appended only for `Some(kind)`. An absent `statement_kind` produces a byte-identical Phase 3 hash, so a replay of any already-recorded operator correction still matches its ledger row. New explicit reclassifications append the classification and therefore participate in conflict detection. Affected callsites inspected: `manual_correct_hash` (used by `replay_manual_correct` and `memory_scoped_correct` in `commands/memory_capture.rs`) and `correct_scoped_memory_with_kind` in `capture.rs`. `correct_operation_hash` and all other Phase 3 ledger/hash semantics are unchanged.
- No public request accepts caller-supplied Agent ownership, authority, source, or verification.
- Remaining known gap: legacy-adopt revision sourcing (above). No unresolved contract or invalidation gap was found in the reviewed diff.
