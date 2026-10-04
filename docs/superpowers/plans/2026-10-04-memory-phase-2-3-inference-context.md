# Memory Phase 2.3 — Actual Inference Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consume only native-prepared references after resolving the real workspace and place bounded recall data in every supported final inference request without retaining it in turn history or caches.

**Architecture:** Bun's authenticated in-memory registry is the sole source of a prepared envelope. The chat stream resolves effective workspace first, atomically consumes a matching one-shot reference, and passes an ephemeral value through direct and orchestrated provider boundaries. Final request assembly fits memory against real model/token budgets after compaction; runtime observations report only applied IDs and bounded evidence to the phase 2.2 authenticated receipt path.

**Tech Stack:** Bun/TypeScript, existing tokenizer/provider catalog and prompt assembly, `server-jarvis/src/native-memory.ts`, Ollama/llama.cpp/OpenRouter paths, Claude CLI main/delegate invocation and orchestration pipeline.

**Spec:** `docs/superpowers/specs/2026-10-04-memory-four-phase-design.md`; split `docs/superpowers/specs/2026-10-04-memory-phase-2-four-part-design.md`; parent `docs/superpowers/plans/2026-10-04-memory-phase-2-live-recall.md`; predecessors plans `...phase-2-1-native-turns.md` and `...phase-2-2-trusted-transport.md`.

## Global Constraints

- Chat accepts references only: `turn_id`, `memory_preparation_id`, and initial status. Never accept memory text, scope, Agent identity, effective workspace, terminal status, or provenance from HTTP input.
- Resolve effective workspace using existing affinity/permission logic first. Project recall requires canonical equality of prepared `scope.project_root`, prepared `effective_workspace`, and actual active workspace. Mismatch emits `scope_mismatch`, zero memory injection, unchanged grants, usable ordinary inference.
- Envelopes are one-use, session/turn/exact-hash/app-instance/expiry bound. A replay/mismatch consumes no recall and cannot create runtime evidence. No new inference deadline after consume.
- Maximum five items, 600 Unicode scalar values/item, 4,000 scalar values/framed block, and provider input budget after reserving prompt/system/tool schemas/current user/output. Drop lowest-ranked complete items; unknown context window uses existing conservative fallback.
- Recall data is a data-only framed message in cloned outgoing request. Never splice into user input, reusable history, compaction, TaskRun/discovered facts, cached stage prompts, skills, permissions, or saved Session messages.
- Every provider retry/stage emits actual applied IDs/status; prepared selection is not proof of application. Terminal status/tool success does not establish verified facts.
- Main memory-enabled Claude CLI bypasses `cliSessionMap` resume and disables persistence; unsupported mode reports unavailable and runs ordinary inference without recall. Delegate remains existing no-persistence flow.
- No test creation/run or live SQL/runtime check under current instruction. Run only `bun run typecheck`, `bun run build`, and authorized `cargo check` if source changes require Rust type compatibility.

## Review Focus

1. User-forged memory/workspace/Agent fields or actual workspace mismatch must result in zero injection and no permission change; tests `prepared_chat_forwards_reference_not_envelope`, `prepared_chat_scope_matches_actual_affinity` in Task 1.
2. Rapid replay, stale hash, wrong Session, expiry, or concurrent consume must allow at most one winner; `prepared_chat_hash_session_turn_bound` in Task 1.
3. Direct and each orchestration/provider fallback must receive the same selected data at final outgoing seam; `memory_paths_same_snapshot_ample_budget` in Task 3.
4. Budget shrink, Unicode, hostile closing markers, and output reservations must not overflow or split items; `memory_paths_budget_drops_lowest_rank` and `memory_paths_unicode_and_data_delimiters` in Task 2.
5. CLI resume, compaction, or cache reuse must not leak deleted/former memory to a later turn; `memory_cli_fresh_turn_no_resume` and `memory_paths_no_context_retention` in Task 3.

---

## File Map and Interfaces

Baseline `dfe39904b8d7fa3ed731e5342e7e80437a6a3b40`: `chat-routes.ts` forwards ordinary stream options to `index.ts::streamJarvis`; workspace affinity is resolved in `index.ts` before TaskRun. `index.ts` branches to CLI before orchestration. Direct provider messages are assembled after active-history compaction. Orchestration uses `orchestration/pipeline.ts` and Claude delegate assembly. Existing `orchestration/session-memory.ts` owns TaskRun/tool caches and must stay separate. Do not activate `memory-recall.ts`'s App DB access; remove only if actual production imports require preventing it from being activated.

Keep the Phase 2.2 registry and receipt types unchanged. Extend `ChatStreamOptions` with exactly `turnId?: string`, `memoryPreparationId?: string`, `memoryStatus?: MemoryRecallStatus`. `resolveTurnMemory(registry, identity, activeWorkspace): ConsumeMemoryResult` consumes the frozen 2.2 contract `{envelope: PreparedMemoryTurn | null, status: MemoryRecallStatus, code?: string}`; only `ready|empty` carries a validated immutable envelope, every failure carries null. Use frozen `ConsumeMemoryRequest`, `ConsumeMemoryResult`, `MemoryAppliedObservation`, `MemoryTerminalObservation`, and `NativeMemoryRuntimeReceipt` definitions/method signatures from 2.2; do not create parallel DTOs. `fitTurnMemory(envelope: PreparedMemoryTurn, baseMessages: readonly ChatHistoryMessage[], inputBudgetTokens: number): AppliedTurnMemory` returns `{block,selected_ids,status}` using existing `countTokens`. `withTurnMemory(messages, applied): ChatHistoryMessage[]` clones the outgoing list. Add `turnMemory?: PreparedMemoryTurn` to `PipelineExecuteOptions`, `RunClaudeDelegateInput`, and `BuildClaudeDelegateInvocationInput`; it never enters `TaskRun`, `contextMessage`, or a cache.

## Tasks

### Task 1: Resolve the trusted reference at real workspace affinity boundary

**Files:** Modify `server-jarvis/src/chat-routes.ts` only; do not edit existing `chat-routes.test.ts` except a minimal compile-only type fixture change if strictly required. Future new behavioral coverage is confined to `memory-turn-routing.test.ts`, which is not created in this authorized source pass. Modify `server-jarvis/src/index.ts` `streamJarvis` after actual config/workspace affinity resolution; modify `native-memory.ts` registry consumption and status observation.

**Interfaces:** HTTP request may include `turn_id`, `memory_preparation_id`, and `memory_status`; reject/ignore legacy `memory`, `scope`, `agent_id`, and `effective_workspace` fields without allowing them into inference. Existing ordinary streams keep working and report unavailable when there is no authenticated preparation. The client `memory_status` is informational only; it can never manufacture `ready` or `applied` absent a trusted registry envelope/receipt. Consume registry one-time only after actual workspace resolution. Match `session_id`, `turn_id`, SHA256 of exact current persisted user message, app instance, TTL, and actual workspace. Project equality is canonical `scope.project_root === envelope.effective_workspace === activeWorkspacePath`; Agent scope has null project constraint. Scope mismatch returns no envelope and leaves workspace grants unchanged.

- [ ] **Step 1: Future route tests** `prepared_chat_forwards_reference_not_envelope`, `prepared_chat_hash_session_turn_bound`, `prepared_chat_scope_matches_actual_affinity`, and `ordinary_http_stream_reports_memory_unavailable`. Assert forged fields never reach inference; mismatch cases emit status and zero content; same canonical symlink root succeeds; unresolved root fails closed; Session/hash/turn/app/expiry mismatches cannot inject; one racing request consumes.
- [ ] **Step 2: Future command** `(cd server-jarvis && bun test src/chat-routes.test.ts src/memory-turn-routing.test.ts)`; expected: PASS. Do not create/run now.
- [ ] **Step 3: Implement route DTO and workspace-time consume.** Status SSE is `memory_status {turn_id,status,selected_ids,store_revision,code?}` with no content. The public request field is `memory_status` (mapped to internal `ChatStreamOptions.memoryStatus`); it is an initial diagnostic hint only, never proof of readiness/application. Keep user message/grant classification inputs original. Emit stable turn identity even for direct response without `agent_run_id`, setup failure, cancellation or EOF; terminal observation can be finalized in phase 2.4.
- [ ] **Step 4: Run authorized source check** `(cd server-jarvis && bun run typecheck)`; expected PASS; route test results remain NOT RUN.

### Task 2: Build token-budgeted ephemeral final-message utility

**Files:** Create `server-jarvis/src/turn-memory-context.ts`; modify only if required `server-jarvis/src/tokenizer.ts` or existing provider context-budget utility; add future `turn-memory-context.test.ts` (not created in this run).

**Interfaces:** `fitTurnMemory` and `withTurnMemory` as above. Use existing `countTokens` against the complete outgoing JSON message and available request schema/tool cost. Budget calculation reserves system prompts, tool schemas, current user message, and configured output tokens first; intersect provider/catalog context size with current stage transcript/context ceiling when both exist. Unknown context window uses existing conservative fallback. Drop lowest-ranked complete entries until the framed block plus request fits; if none fit return empty block, `budget_omitted`, empty applied IDs. Use a fixed safety/data framing and JSON-escaped item data, never Markdown instructions from memory.

- [ ] **Step 1: Future tests** `turn_memory_budget_reserves_output_and_tools`, `turn_memory_drops_lowest_rank_complete_items`, `turn_memory_budget_zero_omits_all`, `turn_memory_unicode_and_marker_escape`, `turn_memory_clones_messages`. Assert exact budget boundary, no partial item, complete JSON/schema cost counted, original message array untouched, role/content unchanged except one added data message, memory never changes tool schemas or grants, emoji/combining marks remain valid and selected IDs match block.
- [ ] **Step 2: Future command** `(cd server-jarvis && bun test src/turn-memory-context.test.ts)`; expected PASS; not run now.
- [ ] **Step 3: Implement pure utility** with stable source rank ordering; preserve each source item as untrusted escaped data and include fixed no-authority framing. Never infer ranking or provenance from text. Fit each provider fallback independently if context budget differs.
- [ ] **Step 4: Source checkpoint** `(cd server-jarvis && bun run typecheck)`; expected PASS.

### Task 3: Thread ephemeral snapshot through all supported inference assembly paths

**Files:** Modify final request assembly in `server-jarvis/src/index.ts`, `orchestration/pipeline.ts`, `orchestration/claude-delegate.ts`, `claude-cli.ts`, and `orchestration/prompt-cache-stable.ts` only where needed for a separate ephemeral memory argument. Keep `orchestration/session-memory.ts` TaskRun storage contracts unchanged. Existing inactive App DB memory reader is not an integration path.

**Interfaces:** Direct Ollama/llama.cpp/OpenRouter uses `withTurnMemory` after compaction, at final outgoing messages. Pipeline options carry `turnMemory?: PreparedMemoryTurn` explicitly through planner, executor, reviewer, rewriter, synthesizer and replan/segment invocations; use same snapshot, budget-fit per call. Claude delegate input carries ephemeral field directly to invocation builder; never `contextMessage`/TaskRun. Main CLI receives bounded native `history + current user` and data appendix, uses no `--resume` or persistence, bypasses `cliSessionMap`; unsupported mode emits unavailable and runs ordinary CLI inference with no memory. Emit one `memory_applied` observation per actual request with stage/provider and applied ID list/status. On terminal completion, partial, cancellation, failure, or abrupt close, phase 2.4 will sync via native; keep receipt updater callable but do not fabricate terminal results here.

- [ ] **Step 1: Future provider-spy tests** `memory_paths_same_snapshot_ample_budget`, `memory_paths_budget_drops_lowest_rank`, `memory_paths_unicode_and_data_delimiters`, `memory_paths_no_context_retention`, `memory_cli_fresh_turn_no_resume`. Assert direct routes, all orchestration stages, fallback/retry, and both Claude main/delegate get exactly one bounded block when fit; low-rank complete items drop first; data cannot alter grants/system/skills; history/cache/TaskRun serialization exclude the block; following turn and different Session receive none; main CLI never resumes old context.
- [ ] **Step 2: Future command** `(cd server-jarvis && bun test src/turn-memory-context.test.ts src/memory-inference-paths.test.ts src/claude-cli.test.ts src/orchestration/claude-delegate.test.ts src/orchestration/session-memory.test.ts)`; expected PASS. Not run now.
- [ ] **Step 3: Implement final boundary pass-through.** Inject only after compaction and normalization-sensitive prefix assembly, into cloned request arguments, before provider dispatch. Keep `activeHistory`, `originalHistory`, user message, cached prefix and TaskRun immutable. Refit on provider retry. Hash tool output at trusted Tool runtime observation before truncation, attach canonical path only from runtime-normalized path args; honor evidence limits and do not call it verification authority.
- [ ] **Step 4: Authorized source checks** `(cd server-jarvis && bun run typecheck && bun run build)`; expected PASS. Do not run tests.

### Task 4: Maintain exact per-turn runtime observations for authenticated sync

**Files:** Modify `server-jarvis/src/native-memory.ts`, `index.ts` central stream lifecycle, and canonical Tool runtime observation hooks only; minimal option types in `orchestration/pipeline.ts` as required. Create `docs/implementation/memory-phase-2-3-progress.md` for the source ledger. Use a phase-scoped implementation commit and keep all carried planning documents out.

**Interfaces:** `memory_applied` observations use the frozen `MemoryAppliedObservation {stage,selected_ids,status}` for the internal registry and carry `turn_id` only on public diagnostic frames; no content. Update the phase 2.2 in-memory `NativeMemoryRuntimeReceipt` with actual start/finish, `completed|partial|cancelled|failed|unterminated`, inference run ID if any, applied IDs, and bounded `MemoryRuntimeEvidence`. Turn ID is not an inference run ID. Evidence fields exactly `tool_call_id`, `tool_name`, `canonical_path`, `output_sha256`, `observed_at`, `success`; success/hash alone never yields durable verified fact. `memory_status`/`memory_applied` frames are informational; native sync authenticates from internal receipt, not UI-submitted terminal claims.

- [ ] **Step 1: Future tests** `memory_status_direct_answer_without_run_id`, `memory_status_partial_cancelled_eof`, `memory_applied_ids_are_actual_per_stage`, and `memory_evidence_is_bounded_and_content_free`. Assert every stream terminal class retains stable turn ID, direct answer may have no run ID, only actual provider send adds IDs, evidence capped at 100/64 KiB, output digest precedes context truncation, logs/frames omit content and capability.
- [ ] **Step 2: Future command** `(cd server-jarvis && bun test src/native-memory.test.ts src/memory-inference-paths.test.ts)`; expected PASS; not run now.
- [ ] **Step 3: Implement observation hooks** at provider-send and canonical Tool runtime result seams. Centralize terminal status including abrupt transport loss as `unterminated` when completion is unknowable; never infer success from UI `done` or assistant prose.
- [ ] **Step 4: Authorized source checkpoint** `(cd server-jarvis && bun run typecheck && bun run build)`; expected PASS.

## Handoff and Completion Boundary

Record baseline/source revision, supported request paths, actual type/build checkpoints, and tests/runtime checks NOT RUN in `docs/implementation/memory-phase-2-3-progress.md`; commit only scoped 2.3 changes per task. 2.3 is ready for root review when actual workspace affinity controls atomic reference consumption and all supported direct, orchestrated, delegate and CLI requests receive the same bounded native snapshot only at their final provider boundary; memory remains absent from history/caches; applied IDs/status/evidence flow to the authenticated 2.2 receipt. Ordinary inference remains usable without recall. 2.4 owns UI orchestration, native relay preparation, diagnostics, terminal sync/ACK finalization and evidence inventory. Do not claim UI integration or live smoke. Test proposals and all runtime checks remain NOT RUN; typecheck/build do not establish retrieval quality or true live recall.

Planning self-review: exact wire references, workspace equality, output-budget reserve, provider retry fit, all inference branches, CLI persistence boundary, ephemeral memory and authenticated observations are assigned. No new DTO, status, source authority, or memory cache was added; Phase 2.1/2.2 contracts are inputs only.
