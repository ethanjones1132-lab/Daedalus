# Memory Phase 4.4 — Turn Status, Continuity UX, and Source Handoff

**Executor:** OpenCode CLI `opencode-go/deepseek-v4.1-flash` only. Luna performed planning, source review, coordination, and validation.
**Branch:** `codex/memory-deepseek-20261004`.
**Base checkpoint:** Phase 4.3 commit `34ea355a5f342e33282911875991cf83e10bc0f1`.
**Source SHA:** `2f6a226cf36ecd2aa351357b3fcb4ae7d7bafae5` (final Phase 4 source checkpoint; main Part 4.4 implementation commit `39203cc85314b2597a030cb2efc714e8b095cc9b`).
**State:** Production source implemented and fresh-reviewed; all five permitted compiler/type/build/diff checks pass on the exact source SHA. **No tests, fixtures, test declarations, scripted providers, live inference, restarts, packaging, or acceptance experiments were added or run.** Roadmap priority #1 remains active and is not runtime-complete.

## Scope delivered

Part 4.4 integrates the previously prepared/applied memory, native capture receipt, current-source revalidation, and explicit active-objective continuity into the Session UI, and closes the Phase 4 source handoff documentation. No transport or polling loop was added; no new memory authority, store, or inference dependency was introduced.

## UI integration

- New `src-ui/src/components/jarvis/MemoryTurnStatus.tsx`:
  - Read-only projection of an already-decoded diagnostic, committed capture receipt, and confirmed continuity, plus explicit objective controls.
  - Prepared candidates (`diagnostic.prepared`) render with id, row revision, scope (kind + project root), authority, statement classification, source Session/messages/run, verification provenance, and review-due state. A candidate is labeled **used** only when its id is in the native `applied_selected_ids` union; all others are labeled **prepared, not applied**. Applied IDs are listed separately; an empty applied list is shown as "No memory was used in this turn" and is never confused with a failed read.
  - A missing diagnostic shows pending/unavailable; a malformed/failed read shows `read_error`. Current list/preview state is never substituted for the historical turn snapshot. Per-stage applied detail is explicitly reported as not part of the persisted native diagnostic (counts are the native applied union).
  - Capture receipt is shown separately: `null` renders "Unavailable — no committed native receipt. Nothing is confirmed saved." A committed receipt shows terminal status, saved/pending counts, and per-operation status/memory/replacement/reason. Assistant prose is never used to confirm a save.
  - Current-source evidence (`revalidation`) is shown separately from statement meaning, with state, memory IDs, evidence tool-call IDs, reason code, and an explicit "evidence availability only, not a truth verdict" note.
  - Confirmed objective shows text, source message, dependency count, and continuity revision. Set/Clear/Resume are explicit controls; unavailable is distinct from a confirmed empty objective.
- Extended `src-ui/src/components/jarvis/memory-control-state.ts` with strict `SessionContinuity`/`ActiveObjective` types and `decodeSessionContinuity` (explicit nulls required, positive safe-integer revision), the exact `CLEAR_OBJECTIVE_DIRECTIVE`/`RESUME_OBJECTIVE_DIRECTIVE` constants, and a re-export of the existing strict capture-receipt decoders.
- Extended `src-ui/src/components/jarvis/memory-turn-state.ts` with strict `decodeMemoryScope` and `decodePreparedMemorySelection`; `decodeMemoryTurnDiagnostic` now requires a well-formed `scope`, an array `selected` (each entry strictly decoded, only a missing `statement_kind` defaulting to `unknown`), and a string-array `applied_selected_ids`. Malformed input throws so no invented diagnostic is rendered.
- Integrated `MemoryTurnStatus` into `JarvisView.tsx` after the existing preparation/sync/capture finalization and in the Session status area, preserving run status, transcript, drafts, Session-switch race guards, and duplicate-operation identity.

## Native relay additive extension

`src-tauri/src/jarvis/runner.rs::attempt_relay_memory_finalize` previously emitted a reduced `jarvis://memory-diagnostic` event (`selected` reduced to bare `{id}` and no scope). It now emits the authoritative native `MemoryTurnDiagnostic` metadata already defined by Phase 2/4.3: `scope`, full prepared `selected`, `applied_selected_ids`, state, recall status, error/terminal status, and `revalidation`. No recalled text, raw block, capability, or credential is exposed. This is an additive extension that lets the relay path show the same prepared-vs-applied provenance the direct path shows; it does not change any frozen request/response DTO.

## Turn-status reads and race handling

- One read-only `refreshMemoryTurn(sid, turnId)` reads `memory_continuity_read`, then (when the Session/continuity names a turn) `memory_turn_diagnostic` and `memory_capture_receipts`. It never calls `memory_capture_turn` and adds no polling loop.
- It runs once on Session open and once after direct finalization or a relay capture event. Every await re-checks a monotonic token and the captured Session id, so a late response from a switched Session/turn is discarded; the same identity may be retried without executing a second capture operation.
- The direct finalizer now also stores the full decoded receipt for the panel (in addition to the existing compact `CaptureStateView`).
- Objective Set uses the existing `memory_continuity_set` command with the confirmed continuity revision, a persisted user message id, and the operator's exact objective text; native substring/revision/source validation is unchanged. Clear submits `objective: null`, which native accepts only for a saved user message whose exact content is `Clear active objective`. Resume sends the exact `Continue active objective` directive through the normal turn transport; an override send never clears or restores the operator's own composer draft.
- Each explicit continuity set keeps a stable operation id for an unchanged target/payload and mints a new one when the payload changes; a confirmed result comes only from the decoded native read-back.

## Compatibility and correctness rulings

1. **Relay diagnostic shape.** The full-metadata relay emission (above) is required so the trusted UI can show prepared provenance on the native-relay path; it remains metadata only and exposes no recalled text.
2. **Diagnostic strictness.** `decodeMemoryTurnDiagnostic` now rejects a malformed diagnostic entry rather than silently filtering it. The finalizer, relay listener, and refresh read all catch this and surface unavailable.
3. **`MemoryTurnStatus` extra props.** The part-plan interface (`session_id, turn_id, diagnostic, receipt, continuity, read_error`) is preserved; optional `sourceMessages`, `continuityPending`, `continuityError`, `disabled`, `onSetObjective`, and `onResumeObjective` were added to wire the explicit controls without adding transport.
4. **`MemoryTurnDiagnosticView` extension.** `scope` and `prepared` were added; `selectedIds` is retained (derived from `prepared`) so the existing compact `formatMemoryTurnLabel` is unchanged.
5. **Clear semantics.** The explicit Clear control stays disabled until a persisted user message with exact content `Clear active objective` is selected, matching the unchanged native `validate_continuity_set` rule. No synthetic message is appended.

## Final source-review corrections (same executor)

An independent review of the working-tree diff found two concrete issues; both were fixed through this executor before the source checkpoint:

1. **Relay pending-capture status was clobbered.** The new `refreshMemoryTurn` read mapped a null `memory_capture_receipts` result to the compact `CaptureStateView` `failed`. On the native-relay path a `capture_pending` signal (set by the relay handler) was therefore overwritten with `failed` by the follow-up read. Fix: the refresh read now updates only the full `memoryReceipt` used by the panel and never touches the compact `memoryCaptureState`, which remains owned by the direct finalizer and the relay handler with their proper error codes. A null receipt on reopen still renders "unavailable", never "saved" or "0 saved".
2. **One-frame cross-Session pairing after a switch.** The passive reset effect runs after paint, so for one frame `MemoryTurnStatus` could receive the new `session_id` with the previous Session's diagnostic/receipt/continuity. Fix: render derives `memoryDiagnosticForSession`, `memoryReceiptForSession`, and `memoryContinuityForSession`, passing a value only when its own session id equals the active Session; `memoryTurnId` is derived from those guarded values. `handleSetObjective` and `handleResumeObjective` additionally require `continuity.session_id === activeSession`, so an explicit continuity write or resume can never act on a previous Session's objective.

Both corrections are UI-only; no native contract changed. Post-correction permitted checks (unmasked exit codes): `cargo check --manifest-path src-tauri/Cargo.toml` → 0 (pre-existing `supervisor.rs`/`wsl.rs` warnings only); `server-jarvis: bun run typecheck` → 0; `server-jarvis: bun run build` → 0 (200 modules); `src-ui: bun run build` → 0 (2,722 modules; existing large-chunk warning only); `git diff --check` → 0. No tests, fixtures, or test declarations were touched.

## Fresh pre-answer review correction (same executor)

A later focused source review found that the linear pipeline's no-synthesizer `executeSegment` exit could return planner/executor prose without invoking the Phase 4.3 gate. The exact DeepSeek executor added a shared `finishGated` boundary for answer-capable early exits, including no-synth and reviewer/repair terminal paths, and retained the existing pre-synthesis gate before the only orchestrator stage marked `surfaceAsAnswer`. The speculative planner-only and cascade paths already checked the same gate before returning an answer or starting synthesis. The HTTP route forwards user-visible `stream_event` text only for direct answer and `surfaceAsAnswer` synthesis; conductor `stage_token` is internal and is not forwarded as answer text. The direct provider path filters out freshness-required selections until authenticated current-turn reads satisfy the existing assessor, and the external CLI/delegate paths exclude those selections. A missing or invalid native receipt now fails closed when the prepared policy required current source; it does not substitute prepared IDs or another receipt.

The scoped final reviewer found one further issue: a continuity mutation could commit while its response was lost, but the UI claimed the old objective was unchanged. DeepSeek corrected the UI to preserve the exact Session/revision/source/payload/operation-id tuple across an unchanged retry, read back current continuity only for display under Session/generation guards, and report the operation as ambiguous unless the native set response confirms it. The fresh scoped rereview was clean.

## Permitted checks actually run (unmasked exit codes)

The coordinator ran the five checks below against exact source SHA `2f6a226cf36ecd2aa351357b3fcb4ae7d7bafae5`; evidence is in `phase4-source-final-2f6a226-checks.json`.

| Check | Command | Result |
|---|---|---|
| Whitespace/conflict | `git diff --check` | PASS (exit 0) |
| Rust compile | `cargo check --manifest-path src-tauri/Cargo.toml` | PASS (exit 0); only pre-existing `supervisor.rs` fetch_update deprecation and `wsl.rs` dead-code warnings |
| Bun typecheck | `server-jarvis: bun run typecheck` | PASS (exit 0) |
| Bun build | `server-jarvis: bun run build` | PASS (exit 0); 200 modules |
| UI build | `src-ui: bun run build` (`tsc -b && vite build`) | PASS (exit 0); 2,722 modules, existing large-chunk warning only |

No check was masked by a pipeline. Compiler/type/build success establishes source compilation and bundling only.

## NOT RUN gates

- Every native and UI test, test declaration, and fixture.
- The scripted deterministic provider and the four scripted native integration scenarios.
- Live inference on any backend; direct-SSE and native-relay actual-context inspection.
- Cross-Session recall, correction/forget, side-question/resume, failure/interruption, duplicate-terminal, and restart demonstrations.
- Packaging/install and installed-application behavior.

Priority #1 completion checkboxes stay open; priorities #2–#5 were not started.

## Files changed

Modified (production only):

- `src-tauri/src/jarvis/runner.rs`
- `src-ui/src/components/jarvis/JarvisView.tsx`
- `src-ui/src/components/jarvis/memory-control-state.ts`
- `src-ui/src/components/jarvis/memory-turn-state.ts`

Created (production only):

- `src-ui/src/components/jarvis/MemoryTurnStatus.tsx`

Created (this record): `docs/implementation/memory-phase-4-4-progress.md`, `docs/implementation/memory-phase-4-summary.md`.

No test, fixture, or test-declaration file was added or edited. The pre-existing dirty baseline files (`AGENTS.md`, `PRIORITIES.md`, `README.md`, `docs/COMPLETION_BACKLOG.md`, `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md`) and the untracked schema artifacts were left untouched. Four duplicate plan copies initially landed in the worktree-local `outputs/`; they were confirmed byte-identical to the user-facing copies in `/Users/charlottehughes/Documents/Codex/2026-10-04/ca/outputs` and removed from the worktree. The Phase 4.4 source checkpoint was committed with explicit paths.

## Gaps and limitations

- The UI is a source-level surface. No product test verifies the applied-vs-prepared, receipt, switch-race, or continuity behavior; those are Phase 4 acceptance work.
- Per-stage `memory_applied` frame attribution is not persisted in the native diagnostic, so the panel reports only the native applied union and states that stage detail is unavailable.
- The explicit Clear control is usable only with a saved `Clear active objective` user message, per the unchanged native rule.
- Freshness and applied-memory correctness are source-reviewed only; no live receipt has been observed.
- Compiler/type/build success does not close priority #1 or constitute runtime acceptance.

## Self-review across the six parent Phase 4 tasks and Phase 1–3 contracts

- **Parent Task 1 (Session identity):** unchanged by 4.4; the panel reads Session identity from the active Session and never infers or widens Agent/project scope. No grant, binding, or affinity behavior changed.
- **Parent Task 2 (classification):** `statement_kind` is decoded strictly (missing → `unknown`) and displayed; no classification is inferred from content or assistant text.
- **Parent Task 3 (operator controls):** `MemoryView` and its decoders are untouched except additive re-exports; no new mutation path was added.
- **Parent Task 4 (this part):** actual applied memory is distinguished from prepared candidates and from current preview/list state; capture is confirmed only by a committed receipt; the active objective is confirmed only by a native read; Set/Clear/Resume are explicit and native.
- **Parent Task 5 (fresh-source revalidation):** the revalidation result is displayed as evidence-availability metadata separate from statement meaning; no durable memory rewrite, truth verdict, or verified-observation capture is introduced.
- **Parent Task 6 (scripted/live acceptance):** explicitly NOT RUN; no tests, provider, restart, or package evidence was produced.
- **Phase 1–3 contracts preserved:** no second writable store; scope/authority/provenance/revision, derived-gated invalidation, capture idempotency/receipts/suppression, and objective continuity semantics are unchanged. The only native change is the additive relay diagnostic projection, which narrows nothing.
- Fresh source review found and DeepSeek corrected the no-synth pre-answer gate gap and ambiguous continuity-set outcome. The scoped rereview was clean and all five allowed checks passed against the final source SHA. Runtime/test gates remain NOT RUN under the task instruction.
