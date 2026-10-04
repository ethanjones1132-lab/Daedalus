# Memory Phase 2.3 — Implementation Ledger

**Plan:** `docs/superpowers/plans/2026-10-04-memory-phase-2-3-inference-context.md`
**Binding split:** `docs/superpowers/specs/2026-10-04-memory-phase-2-four-part-design.md`
**Spec:** `docs/superpowers/specs/2026-10-04-memory-four-phase-design.md`
**Parent plan:** `docs/superpowers/plans/2026-10-04-memory-phase-2-live-recall.md`
**Priority:** `docs/CURRENT_ROADMAP.md` #1 (Phase 2.3 source only)
**Worker:** DeepSeek v4.1 Flash on OpenCode CLI

- **Execution baseline:** `dfe39904b8d7fa3ed731e5342e7e80437a6a3b40`
- **Predecessor HEAD:** `3ddbd02` (`fix: harden phase 2.2 transport ownership, registry bounds, and receipt lifecycle`)
- **Branch:** `codex/memory-deepseek-20261004`

## Execution environment

- Platform: macOS (darwin), shell zsh.
- Rust: `/Users/charlottehughes/.cargo/bin` — `cargo`/`rustc` 1.99.0.
- Bun: `/Users/charlottehughes/.bun/bin` — `1.4.2`.
- Per the workspace rule and the plan's Global Constraints, **no test file was
  created, no test function was added, and no tests, ephemeral SQL assertions,
  or live transport/inference experiments were run.** Every planned test step
  is deferred and reported NOT RUN.
- Local builds regenerated only gitignored artifacts
  (`server-jarvis/dist`); the untracked generated
  `src-tauri/gen/schemas/macOS-schema.json` was not touched or staged.

## Scope delivered (Tasks 1–4)

| Task | Status | Source |
|---|---|---|
| 1. Resolve the trusted reference at the real workspace boundary | Implemented | `chat-routes.ts`, `native-memory.ts`, `index.ts` |
| 2. Token-budgeted ephemeral final-message utility | Implemented | `turn-memory-context.ts` (new) |
| 3. Thread the ephemeral snapshot through all inference assembly paths | Implemented | `index.ts`, `pipeline.ts`, `claude-delegate.ts` |
| 4. Exact per-turn runtime observations for authenticated sync | Implemented | `native-memory.ts` (helper), `index.ts`, `tool-runtime.ts` |
| 5. Source checkpoint ledger | This document | pending commit |

## Task 1 — Reference resolution at actual workspace affinity

- `chat-routes.ts`: `ChatStreamOptions` extended with exactly `turnId?`,
  `memoryPreparationId?`, and `memoryStatus?`. The public fields read are
  `turn_id`, `memory_preparation_id`, and `memory_status`. Legacy/forged
  `memory`, `scope`, `agent_id`, and `effective_workspace` fields are never
  read or forwarded; scope, authority, and content come only from the
  authenticated native envelope. `memory_status` is parsed against the frozen
  status vocabulary and treated as an informational hint only. The new
  reference keys are added to the options object only when actually present, so
  ordinary callers keep their exact existing options shape and the existing
  route test is preserved unchanged.
- `native-memory.ts`: added `resolveTurnMemory(registry, identity,
  activeWorkspace): ConsumeMemoryResult`, the sole inference entry point. It
  takes references only, fails closed with a null envelope for an empty
  reference, and delegates atomic Session/turn/exact-hash/app-instance/TTL/
  actual-workspace validation to the frozen 2.2 `consume` method. No frozen
  2.2 registry/receipt type was changed.
- `index.ts::streamJarvis`: after existing config + `workspaceAffinity.resolve`
  logic, the reference is consumed exactly once and only when both `turn_id`
  and `memory_preparation_id` are present. A validated envelope produces an
  `ActiveTurnMemory`; any failure produces `null` and ordinary inference.
  `memory_status {turn_id,status,selected_ids,store_revision,code?}` is emitted
  before admission (so setup failure, cancellation, and EOF still carry a
  stable turn identity) with no content. Grants are untouched in every outcome.

## Task 2 — Ephemeral, budget-fitted final-message utility

`server-jarvis/src/turn-memory-context.ts` (new), pure and side-effect free:

- `fitTurnMemory(envelope, baseMessages, inputBudgetTokens)` measures the
  complete outgoing JSON message list with the existing `countTokens`, drops
  whole lowest-ranked items until the framed block plus request fits, returns
  `{block, selected_ids, status}` with `ready`, `empty`, or `budget_omitted`,
  and never split an item.
- `withTurnMemory(messages, applied)` returns a cloned outgoing list with at
  most one added data message; the original list and message objects are not
  mutated.
- `resolveTurnMemoryInputBudget` reserves output tokens and tool-schema tokens
  from the provider context window and uses the existing conservative
  `16_384`-token fallback when the window is unknown (never unlimited).
- Framing is the exact frozen native frame (`FRAME_PREFIX` / `FRAME_SUFFIX`)
  around `JSON.stringify(item.text)`; item text is the already-bounded,
  already-labelled native string. Recalled text is data with no authority and
  cannot introduce framing, Markdown instructions, or policy.

## Task 3 — Snapshot at every supported final provider boundary

- **Direct Ollama / llama.cpp / OpenRouter agent loop** (`index.ts`): injected
  after compaction, context optimization, cache-stable assembly, and
  normalization into the request's cloned message list only, before dispatch.
  Output tokens and tool schemas are reserved. The native-tool-protocol retry
  re-observes the same fitted request.
- **Orchestrated router/planner/executor/reviewer/rewriter/synthesizer**
  (`index.ts::callModelAttempt`): fitted per stage against the fully assembled
  request at the final provider seam and attached to `requestBody.messages`.
  The coordinator, all pipeline stages, replans, and recursive segments reach
  this single provider seam.
- **Claude delegate** (`claude-delegate.ts`, `pipeline.ts`): `turnMemory` is
  carried on `BuildClaudeDelegateInvocationInput`, `RunClaudeDelegateInput`,
  and `PipelineExecuteOptions`, propagated through delegate launches and
  recursive re-entry, fitted against the delegate prompt under the
  conservative fallback, appended as a data appendix, and delivered on both
  positional and stdin paths. Never read from or written to
  TaskRun/contextMessage/caches.
- **Main Claude CLI** (`index.ts`): a memory-enabled turn bypasses
  `cliSessionMap` resume and adds `--no-session-persistence`; it receives
  bounded history + current user + the data appendix. If the configured CLI
  args force resume/continue, the mode is unsupported: `memory_status`
  reports `unavailable` with `cli_mode_unsupported` and ordinary CLI inference
  runs without recall.
- `orchestration/prompt-cache-stable.ts` and `claude-cli.ts` required **no
  source change**: the cache-stable head stays memory-free because injection is
  a cloned tail, and the CLI adds `--no-session-persistence` at the call site
  while `streamClaudeCli` already omits `--resume` when no session id is given.

## Task 4 — Exact observations for authenticated sync

- `tool-runtime.ts`: added optional `ExecutionContext.onToolResult` and a
  single non-throwing observation call after every canonical execution
  (including direct and orchestrated tool calls). It receives the raw,
  untruncated result envelope.
- `index.ts`: `observeToolEvidence` hashes the raw result text with SHA-256
  before any caller truncation, attaches a canonical path only from a
  path-shaped argument that resolves on disk via the shared path-identity
  helper, and records bounded `MemoryRuntimeEvidence`.
- `memory_applied {turn_id,stage,selected_ids,status}` is emitted per actual
  request and recorded into the authenticated 2.2 receipt; prepared selection
  is never treated as proof of application.
- `recordMemoryTerminal` records the authoritative terminal into the registry
  before any terminal SSE is yielded, at every terminal seam: orchestrator
  success/partial/error/empty/short-circuit, direct success/`ask_user_question`,
  CLI `message_stop`/`error`/error result, admission deadline, cancellation,
  and the outer error path. Abrupt client disconnect is `unterminated`;
  `finally` records a last `unterminated`/`cancelled` before `ensureTerminal`.
  A model/tool success is never recorded as an accepted fact.

## Frozen-interface compliance

- Phase 2.2 registry, consume contract, observation shapes, and receipt types
  are unchanged. `resolveTurnMemory` is additive and returns the frozen
  `ConsumeMemoryResult`.
- `MemoryAppliedObservation`, `MemoryTerminalObservation`, and
  `NativeMemoryRuntimeReceipt` are consumed as-is; no parallel DTO was added
  and no observation carries recalled content.
- No recalled block enters `activeHistory`, `originalHistory`, `contextMessage`,
  compaction/cache state, `TaskRun`/discovered facts, or resumable CLI state.
- No new inference deadline was introduced; consumption does not extend the
  turn.

## Explicit path coverage and honest limitations

- Covered: direct Ollama, llama.cpp, and OpenRouter; orchestrated coordinator,
  planner, executor, reviewer, rewriter, and synthesizer; native-tool-protocol
  retry; recursive re-entry; Claude delegate; and main memory-enabled Claude
  CLI fresh-turn mode.
- Standalone HTTP-only, cron, Agent, and MCP inference paths do not supply a
  preparation reference and remain memory-unavailable by design.
- `chatCompletionWithFallback`'s *internal* per-candidate cascade reuses the
  already-fitted body; it is not re-fit per internal cascade model. The block
  is ≤4,000 scalars and is fit under a conservative input floor, and every new
  stage/outer attempt refits. This is a bounded limitation, not a claim of
  per-candidate budget exactness.
- Live conductor supervision (`persistentConductor.supervise`) is an internal
  control-plane call with cached prefix state; it is deliberately excluded so
  no recalled block can enter conductor cache state.
- The delegate/main-CLI context window is unknown at this seam; both use the
  conservative fallback rather than assuming an unlimited CLI context.

## `MIN_BODY_SCALARS` note

There is no `MIN_BODY_SCALARS` declaration in TypeScript. The only declaration
is `src-tauri/src/jarvis/memory/turn.rs::MIN_BODY_SCALARS`, and it is used by
the bounded native label renderer (lines 293/295), so there was nothing unused
to remove; the bounded renderer behavior is unchanged.

## Exact source commands run

| Command | Result |
|---|---|
| `bun run typecheck` (workdir `server-jarvis`) | **PASS** — `tsc --noEmit`, exit 0 |
| `bun run build` (workdir `server-jarvis`) | **PASS** — bundled `dist/index.js` (196 modules) |
| `git diff --check` (repo root) | **PASS** — no whitespace errors |

`cargo check` was not required: no Rust source, DTO, migration, or command was
changed in Phase 2.3, so Rust type compatibility is unaffected.

No `cargo test`, `bun test`, ephemeral SQL script, or live inference/transport
experiment was run.

## Commands and gates NOT RUN

- `(cd server-jarvis && bun test src/chat-routes.test.ts src/memory-turn-routing.test.ts)`
- `(cd server-jarvis && bun test src/turn-memory-context.test.ts)`
- `(cd server-jarvis && bun test src/turn-memory-context.test.ts src/memory-inference-paths.test.ts src/claude-cli.test.ts src/orchestration/claude-delegate.test.ts src/orchestration/session-memory.test.ts)`
- `(cd server-jarvis && bun test src/native-memory.test.ts src/memory-inference-paths.test.ts)`
- Any live owned-generation consume/mismatch/TTL/one-winner, cross-path
  snapshot equality, budget-boundary, Unicode/delimiter, context-retention,
  CLI fresh-turn, or runtime-evidence runtime assertion.
- Phase 2.1, 2.2, and Phase 1 test gates remain **OPEN** and unchanged.

No test files (`memory-turn-routing.test.ts`, `turn-memory-context.test.ts`,
`memory-inference-paths.test.ts`, etc.) were created.

## Risks and pending evidence

- **Runtime/test gate open.** Workspace equality at consume time, one-winner
  replay, budget boundaries, Unicode/marker escaping, no-context-retention,
  CLI fresh-turn behavior, and receipt evidence are asserted by inspection,
  typecheck, and bundling only.
- **Cross-language framing parity.** The TS frame strings mirror the frozen
  Rust constants; the cross-language roundtrip is not executed here.
- **Internal cascade refit.** See the coverage/limitations note above.
- **Unsupported CLI mode.** Determined by configured `--resume`/`--continue`/
  `--session-id` flags; a CLI that cannot run without persistence is reported
  unavailable and runs ordinary inference. Not exercised live.
- **Evidence is not authority.** Tool success/hash observations are bounded
  diagnostics; they never establish durable verified facts.
- **Phase 2.4 dependency.** UI direct SSE/native relay wiring, terminal sync/ACK
  finalization, diagnostics UI, and the evidence inventory remain Phase 2.4.

## Completion boundary

Phase 2.3 source is delivered: the trusted reference is consumed only after
real workspace resolution, a single one-shot envelope is bounded and injected
at every supported final provider boundary, recall never enters durable
history/caches/TaskRun, and applied IDs/status/terminal/evidence flow to the
authenticated 2.2 receipt. `bun run typecheck` and `bun run build` pass. Phase
2.3 runtime/test acceptance and the Phase 1/2.1/2.2 test gates remain **OPEN**;
this ledger is not runtime evidence, does not claim UI integration or live
smoke, and does not advance to Phase 2.4.
