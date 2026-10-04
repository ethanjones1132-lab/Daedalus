# Memory Phase 3.4 — Objective Continuity and Safe Review Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve explicitly accepted Session objectives across ordinary side questions, corrections, interruption and restart while removing implicit transcript-summary memory promotion.

**Architecture:** Native SQLite is the durable authority for typed objective state. During preparation, native code validates an exact objective directive against its saved user source and places a bounded, untrusted ephemeral continuity snapshot/mode in the private envelope so the current turn can use a replacement immediately without recursively running the mutation gate. After turn exit/recovery, capture atomically commits the directive through Part 3.2's derived mutation gate; this invalidates other stale preparations. Bun applies preserve/resume/replace/clear to TaskRun state without allowing side questions to replace or advance it. Legacy review/end commands remain compatible and never create memories or skills.

**Tech Stack:** Rust/Tauri, rusqlite, existing phase 2 turn envelope and bounded renderer, Bun/TypeScript TaskRun persistence, existing Session review/end commands.

**Spec:** `docs/superpowers/specs/2026-10-04-memory-phase-3-four-part-design.md`; parent `docs/superpowers/plans/2026-10-04-memory-phase-3-safe-capture.md`; preceding contracts in `2026-10-04-memory-phase-3-1-native-capture.md`, `...3-2-derived-invalidation.md`, and `...3-3-turn-lifecycle.md`.

## Global Constraints

- Exact objective controls only: `Objective: <text>` replaces, exact `Clear active objective` clears, exact `Continue active objective` resumes. All other text, correction, question, failed/cancelled turn, or assistant suggestion preserves objective.
- Auto objective source is the persisted user message in the Session; a replacement must be a nonempty exact substring of it and pass phase 1's 4096-byte content safety boundary. Clear requires the exact persisted clear message. Native never fabricates user source from assistant text.
- Phase 2 prepared envelope gets optional `continuity:{snapshot:SessionContinuity,mode:'preserve'|'resume'|'replace'|'clear'}`. It is private native-created metadata, not permission/workspace authority. No HTTP-only caller can forge it.
- Preparation validates and previews an explicit objective action but does not mutate durable continuity; post-turn capture commits it atomically under Part 3.2's gate. This avoids recursively acquiring the already-held phase 2 preparation operation mutex and ensures current objective is available on the directive turn. Startup recovery commits recorded explicit instructions if turn finalization was interrupted.
- A correction changes knowledge only; it does not replace objective. Objective dependencies list accepted memory IDs only; if a forgotten memory is a declared dependency, Part 3.2 clears objective with an explicit event.
- Objective excerpt <=600 Unicode scalars; objective plus recall in one JSON-safe untrusted data frame <=4000 Unicode scalars. Bun uses a native-format-parity renderer over typed continuity plus prepared memory items, retaining the typed snapshot while removing whole lowest-ranked entries and returning `applied_selected_ids` for exactly retained entries. Never pass a stale preformatted block with a trimmed ID list. If objective plus frame cannot fit the provider budget, omit the whole block and report `budget_omitted`; zero recall is valid when the objective frame fits.
- Side turns use `preserve` ephemeral turn contract and retain stored TaskRun unchanged only when native accepted `active_objective` exists; with no active objective, omit continuity so ordinary tasks keep existing behavior. `resume` uses existing continuation with accepted objective. Replace/clear changes only explicit objective and corresponding TaskRun boundary, never widens grants or adds scheduler behavior.
- `review_session(conn:&Connection,session_id:&str)->Result<Value,String>`, `commit_session_end(conn:&Connection,session_id:&str)->Result<(),String>`, `jarvis_review_session`, `jarvis_commit_session_end`, and stable commit ID response remain compatible. Review/end never call `run_post_turn_housekeeping`, `update_session_memory_from_turn`, summary extraction, deferred review, consolidation, or skill mutation.
- No tests are added or run under current instructions. Regression scenarios below are **NOT RUN / requires explicit user request**.

## Review Focus

1. Ordinary questions/corrections/cancellation cannot replace an explicit objective. **NOT RUN:** future `capture_continuity_side_question_keeps_objective`.
2. Objective appears in the turn when there are no recalled facts and survives the shared frame budget. **NOT RUN:** future `capture_continuity_prompt_with_empty_recall_is_bounded`.
3. Bun keeps independent active TaskRun/plan on preserve side turns. **NOT RUN:** future `native_continuity_preserves_taskrun_on_side_question`.
4. Review/end do not promote transcript or mutate skills. **NOT RUN:** future `capture_legacy_review_end_do_not_promote_or_mutate_skills`.
5. Old summary-derived goal cannot be revived after DB/Bun restart. **NOT RUN:** future `capture_continuity_reopen_preserves_active_objective`.

---

## Frozen interfaces and exact action modes

Requests: `ContinuityReadRequest{session_id}`; `ContinuitySetRequest{session_id,expected_revision,source_message_id,objective,operation_id}`. `set_session_continuity(conn:&Connection,request:ContinuitySetRequest,now:DateTime<Utc>)->Result<SessionContinuity,MemoryError>` is an explicit operator action, gated by `with_memory_derived_mutation_gate`. Source must be persisted user message in this Session; a non-null objective exactly matches a nonempty source substring and is <=4096 UTF-8 bytes; clear requires exact persisted user content `Clear active objective`. Same `(session_id,operation_id)` retry yields original continuity revision/response; payload mismatch conflicts.

Turn action interpretation is exactly `Objective: <text>` (replace; `<text>` nonempty exact source substring), `Clear active objective` (clear), `Continue active objective` (resume), otherwise `preserve`. The current turn's prepared envelope contains the preexisting snapshot with an ephemeral replacement/clear applied for rendering and corresponding mode. If continuity is null and message is ordinary, omit the payload entirely. Durable state changes only during `apply_turn_continuity(conn:&Connection,turn:&PersistedMemoryTurn,now:DateTime<Utc>)->Result<SessionContinuity,MemoryError>` inside `capture_recorded_turn`'s same outer savepoint as receipt/ledger. Automatic continuity operation ID is `turn/<turn_id>/user/0`, canonical hash includes action mode, source message ID/hash, and exact objective text; same exact replay returns original continuity revision. Do not create a second operation slot for a single user turn.

Shared renderer interface: `turn.rs::render_memory_block_with_continuity(items:&[PreparedMemoryItem],continuity:&SessionContinuity)->String`, retaining existing memory-only render function unchanged. Objective rendered as JSON-escaped untrusted data; total combined frame <=4000 scalars with memory entries dropped lowest-ranked first; objective scalar excerpt <=600. Zero items still emits a current active objective. Bun `fitTurnMemory` mirrors native framing from typed continuity plus prepared items; when it drops items to meet the provider budget it drops complete lowest-ranked entries and updates block and applied IDs together. If objective+frame alone cannot fit, omit the complete block and report `budget_omitted`.

Bun private `BeginTaskRunInput` gains optional `continuity` typed payload, consumed before legacy heuristic objective replacement. Modes are `preserve|resume|replace|clear`; only native envelope supplies authoritative objective. Preserve is emitted only when native accepted active objective exists. Existing TaskRun/tool/check evidence and permission grants remain separate.

## File Map

- Modify `src-tauri/src/jarvis/memory/continuity.rs`, `capture.rs`, `turn.rs`, `transport.rs`, and `commands/memory_capture.rs` (or named memory command module from Part 3.2): typed read/set, ephemeral preparation preview, and atomic post-turn capture update.
- Modify `src-tauri/src/jarvis/memory/engine.rs::{review_session,commit_session_end}` and `commands/recovery_stubs.rs`; preserve response/command signatures.
- Modify Bun wire contract, `server-jarvis/src/index.ts`/native envelope decode, `orchestration/task-run.ts`, `orchestration/session-memory.ts`, `session-runtime-persistence.ts` only where needed to carry continuity privately and persist TaskRun policy.
- Keep existing direct and relay envelope construction paths aligned; no UI redesign or new operator controls here.

## Task 1: Resolve exact objective intent during preparation without durable mutation

**Files:** phase 2 `turn.rs` preparation path/continuity contracts, private Bun wire fixture definition if needed.

**Interfaces:** Add exact typed continuity preview in `PreparedMemoryTurn`/private serialized envelope: `{snapshot:SessionContinuity,mode:'preserve'|'resume'|'replace'|'clear'}`. Do not alter existing `memory_prepare_turn` request DTO fields; inspect persisted source message already bound by its `user_message_id`.

- [ ] **Step 1: Implement parser over exact persisted source text.** Recognize only exact whole-message controls. For `Objective: <text>`, preserve the exact nonempty suffix (after delimiter) and validate exact substring plus 4096-byte limit. Empty/invalid objective payload is rejected with a bounded reason and leaves stored objective unchanged. For clear/continue require the exact strings. All other messages produce `preserve`; no keyword detection or assistant suggestion.
- [ ] **Step 2: Build ephemeral effective snapshot.** Read current typed Session continuity. If an objective exists, ordinary messages use `preserve`; resume text uses `resume`; replace previews new objective with current user source ID/turn ID and empty dependency list; clear previews `active_objective:null`. With no active objective and an ordinary message, omit continuity. Do not write durable state or invoke the mutation gate from within the already-gated preparation path.
- [ ] **Step 3: Thread preview through both native preparation consumers.** UI direct SSE and native relay must consume the same private envelope and exact mode. Keep phase 2 capability secret/reference-only rules; HTTP-only paths cannot inject this data.
- [ ] **Step 4: Run `cargo check --manifest-path src-tauri/Cargo.toml`, Bun `bun run typecheck`, and `git diff --check`.** Intent/mode scenarios are **NOT RUN / requires explicit user request**.

## Task 2: Render objective with shared 4,000-scalar turn budget

**Files:** `src-tauri/src/jarvis/memory/turn.rs`, Bun turn-memory fit/render path (currently `fitTurnMemory` caller in chat routes).

- [ ] **Step 1: Add compatible continuity wrapper.** Keep existing renderer signature unchanged; add `render_memory_block_with_continuity(items,continuity)` that encodes objective as JSON-escaped untrusted data and adds explicit instruction that it does not grant permission or override tool policy.
- [ ] **Step 2: Enforce bounds.** Truncate objective excerpt to <=600 Unicode scalars; cap complete recall+continuity frame to <=4000 scalars; omit lowest-ranked complete memory excerpts first while preserving objective. Empty recall still includes nonempty active objective.
- [ ] **Step 3: Preserve typed continuity through provider-budget fitting.** Extend wire type and modify `fitTurnMemory` to render from typed continuity and prepared items using native-format parity. Dropping lowest-ranked whole entries updates the framed block and `applied_selected_ids` together. If objective plus frame alone is over provider budget, omit the full block and set truthful `budget_omitted`; never pass a preformatted block with mismatched IDs.
- [ ] **Step 4: Run Rust check, Bun typecheck/build, and `git diff --check`.** Budget/Unicode cases are **NOT RUN / requires explicit user request**.

## Task 3: Commit continuity through existing atomic capture gate and adapt TaskRuns

**Files:** `capture.rs`, `continuity.rs`, `transport.rs` caller, Bun `task-run.ts`, `session-memory.ts`, `session-runtime-persistence.ts`.

- [ ] **Step 1: Implement `apply_turn_continuity(conn:&Connection,turn:&PersistedMemoryTurn,now:DateTime<Utc>)->Result<SessionContinuity,MemoryError>`.** For exact directive, include continuity update and a `memory_events` audit event in the same `with_memory_derived_mutation_gate`/outer savepoint as capture receipt, source operation, ledger and final revision. Existing unconsumed preparations are invalidated before commit; the currently consumed turn retains its snapshot. Replay-before-invalidation returns original response/revision with no rewrite. Capture recovery uses the same helper/path.
- [ ] **Step 2: Implement public continuity setter safely.** `memory_continuity_set` must use the same derived gate, expected continuity revision and `(session,operation_id)` ledger; `memory_continuity_read` stays read-only. Validate source and exact substring. No call to a public setter from preparation (avoids nested gate).
- [ ] **Step 3: Implement Bun modes.** `preserve`: current turn may answer the side question using that question, but retain stored active TaskRun/plan/status/evidence and do not increment its turn count. `resume`: run existing continuation using original accepted objective. `replace`/`clear`: update explicit objective boundary in current relevant TaskRun only; do not touch unrelated TaskRuns or grants. HTTP-only callers cannot supply native continuity.
- [ ] **Step 4: Keep TaskRun persistence separate.** Preserve task evidence, check cache and tool results. On restart, load typed native continuity from envelope rather than synthesizing it from persisted summary/current_goal; old summary-derived values do not seed new objective.
- [ ] **Step 5: Run Rust check, Bun typecheck/build, and `git diff --check`.** Side-question/restart behavior is **NOT RUN / requires explicit user request**.

## Task 4: Make review/end compatibility read-only with respect to learning

**Files:** `src-tauri/src/jarvis/memory/engine.rs`, `commands/recovery_stubs.rs`, review/end command wiring.

- [ ] **Step 1: Preserve signatures and response shape.** Keep `review_session(conn,session_id)->Result<Value,String>` and `commit_session_end(conn,session_id)->Result<(),String>`, command names, and stable commit ID response.
- [ ] **Step 2: Make review inspect receipts only.** Return `reviewed:true`, `session_id`, `memories_created:0`, `skills_updated:0`, plus accepted capture receipt counts. Never synthesize memory from transcript/summary or invoke `apply_deferred_review`.
- [ ] **Step 3: Make end reset only review bookkeeping.** Preserve active continuity; do not run old housekeeping, Session summary extraction/consolidation, or skill/prompt-delta mutation. Startup/transport recovery captures recorded user instructions instead.
- [ ] **Step 4: Preserve phase 4 handoff.** Commands/receipt interfaces stay available for future controls; Phase 4 owns controls, classification/revalidation and live restart/fresh-workspace proof. Explicit constraint facts remain `user_statement` authority; generic `verified_observation` remains unsupported.
- [ ] **Step 5: Run Rust check, Bun typecheck/build as touched, and `git diff --check`.** Review/end behavior scenarios are **NOT RUN / requires explicit user request**.

## Task 5: Final source gate and handoff

- [ ] **Step 1: Inspect all old goal/summary writers and prompt consumers.** Ensure no call from review/end or new turn processing overwrites typed continuity from every user message or assistant summary.
- [ ] **Step 2: Run only source checks.** From repository root run `cargo check --manifest-path src-tauri/Cargo.toml`; from `server-jarvis/` run `bun run typecheck`; from `src-ui/` run `bun run build`; then from repository root run `git diff --check`. Do not add/run tests or live acceptance experiments.
- [ ] **Step 3: Record Phase 3 source evidence and open gates.** Capture command/receipt schemas, objective directive modes, suppression consequences, bounded prompt evidence from source, compiler/type/build outputs; mark tests/live/cross-Session restart/installed-package proof **NOT RUN**. Do not mark roadmap priority #1 complete or start priority #2.

## Completion Boundary

3.4 source is complete when exact objective directives are validated from native saved user source, same-turn rendering has bounded objective context even with zero recall, capture persists changes through one atomic gated operation, side turns preserve unrelated TaskRun state, and review/end create no memory or skill mutations. Tests and live acceptance remain open.
