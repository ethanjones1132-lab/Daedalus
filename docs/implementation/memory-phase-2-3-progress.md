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
- `orchestration/prompt-cache-stable.ts` required **no source change**: the
  cache-stable head stays memory-free because injection is a cloned tail.
  `claude-cli.ts` gains the fresh-turn capability probe and resume-flag
  detection described in the corrective pass below.

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
  CLI authoritative `result` success/partial/error and `error`, admission
  deadline, cancellation, and the outer error path. A CLI `message_stop` is a
  transport terminator only and never latches completion. Abrupt client
  disconnect is `unterminated`; `finally` records a last
  `unterminated`/`cancelled` before `ensureTerminal`. A model/tool success is
  never recorded as an accepted fact.

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
  retry; cross-provider cascade candidates; recursive re-entry; Claude
  delegate; and main memory-enabled Claude CLI fresh-turn mode.
- Standalone HTTP-only, cron, Agent, and MCP inference paths do not supply a
  preparation reference. They now receive a stable server-local transient
  `turn_id` and an explicit `memory_status unavailable` frame, and can never
  elevate a status from the client-supplied `memory_status` hint.
- `chatCompletionWithFallback` refits and attaches the snapshot independently
  for every cascade candidate and same-model retry, against that attempt's own
  messages, tool schemas, output reserve, and context constraint (the stage
  ceiling intersected with the provider window when both are known; a
  conservative floor otherwise). `requestBody` is passed memory-free as the
  clean base, so no attempt re-fits a list that already carries memory.
- Live conductor supervision (`persistentConductor.supervise`) is an internal
  control-plane call with cached prefix state; it is deliberately excluded so
  no recalled block can enter conductor cache state.
- The delegate/main-CLI context window is unknown at this seam; both use the
  conservative fallback plus an explicit `TURN_MEMORY_CLI_OVERHEAD_RESERVE_TOKENS`
  reserve for stock/MCP tool schemas and output overhead, and omit memory
  truthfully when it cannot be safely fit.
- Tool evidence paths only from a runtime argument that resolves inside the
  trusted execution workspace or an authorized session grant (relative paths
  resolve against the execution workspace, never the Bun process cwd); CLI and
  delegate tool events are never turned into fabricated evidence.

## Root-review corrective pass

A root review of the initial 2.3 source identified six concrete gaps. All were
corrected in source in this same session with no tests/runtime execution.

1. **CLI terminal is authoritative.** `recordMemoryTerminal("completed")` was
   removed from the CLI `message_stop` handler (now a transport terminator
   only). The CLI `result` record is now the authoritative outcome: `is_error`
   or an `error` subtype → `failed`; a partial/interrupt/length/max-turns
   subtype → `partial`; otherwise `completed`; recorded before the result frame
   is published. Missing result falls through to `finally` normalization
   (`unterminated`). Every direct/orchestrated terminal branch remains
   explicitly recorded. `StreamSession` and the CLI/cancelled frames now carry
   the stable `turn_id` even when no inference `run_id` exists.
2. **CLI fresh-turn support is verified, not assumed.** Added
   `configuredCliForcesResume` (handles `--resume=<id>`, `--session-id=<id>`,
   `-r=`, `-c=`) and a bounded, cached `claudeCliSupportsNoSessionPersistence`
   probe of `--help`. Unsupported/unknown capability reports `unavailable`
   (`cli_mode_unsupported` / `cli_capability_unavailable`), runs ordinary
   inference without a memory appendix or an unknown flag, preserves existing
   permission arguments, and records `unavailable` with empty applied IDs on
   the private receipt. Applied IDs are observed only on real dispatched
   events, never on pre-spawn `init`/`error`, and memory-enabled CLI sessions
   are neither resumed nor persisted.
3. **Budgets use the real request.** Main CLI now fits against bounded history
   + current user + the appended system prompt; delegate fits against the full
   delegate prompt; both add an explicit
   `TURN_MEMORY_CLI_OVERHEAD_RESERVE_TOKENS` reserve for unknown stock/MCP tool
   schemas and output overhead and omit memory truthfully when it cannot fit.
   Direct/orchestrated cascade candidates refit independently against their own
   assembled messages/tools/output/context.
4. **Canonical evidence path is trustworthy.** `canonicalToolArgumentPath`
   resolves relative arguments against the trusted execution workspace and
   accepts only real paths contained in the execution workspace or an
   authorized session grant (never the Bun process cwd); unknown/outside paths
   are `null`. The raw output is hashed before caller truncation; CLI/delegate
   tool events never fabricate evidence.
5. **Native-tool fallback no longer reuses the fitted carrier.** Both the
   shared orchestrator and direct branches now rebuild a clean cloned base
   without the memory carrier, add the text-tool instructions, refit against
   the changed system/tool cost and output budget, attach exactly one new
   carrier, and observe that retry's own IDs. `chatCompletionWithFallback`
   refits per candidate from the clean `requestBody`.
6. **Ordinary streams report unavailable.** A stable server-local transient
   `turn_id` is generated when the caller supplies none (a caller-provided
   native turn id is preserved exactly), so `memory_status unavailable` is
   emitted for ordinary HTTP/cron/Agent streams and terminal frames always
   carry `turn_id`. The client `memory_status` field can never elevate a
   status without a consumed authenticated envelope.

Also added: `CallModelFn.contextCeilingTokens` and executor/rewriter stage
ceilings so the memory fit intersects the stage transcript bound with the
provider context window.

## `MIN_BODY_SCALARS` note

There is no `MIN_BODY_SCALARS` declaration in TypeScript. The only declaration
is `src-tauri/src/jarvis/memory/turn.rs::MIN_BODY_SCALARS`, and it is used by
the bounded native label renderer (lines 293/295), so there was nothing unused
to remove; the bounded renderer behavior is unchanged.

## Exact source commands run

| Command | Result |
|---|---|
| `bun run typecheck` (workdir `server-jarvis`) | **PASS** — `tsc --noEmit`, exit 0 (re-run after the corrective pass) |
| `bun run build` (workdir `server-jarvis`) | **PASS** — bundled `dist/index.js` (196 modules; re-run after the corrective pass) |
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
- **Cascade refit.** Each candidate/retry now refits from the clean base; the
  per-candidate context window is the stage ceiling intersected with the
  provider window, falling back to the conservative floor when either is
  unknown. Not exercised live.
- **CLI capability probe.** `--no-session-persistence` support is probed via a
  bounded, cached `claude --help`; a failed/timed-out probe fails closed to
  `unavailable` and ordinary inference. Not exercised against a real binary
  here, and the probe's own side effects (one short-lived `--help` process per
  executable path) are cached for the process lifetime.
- **Evidence is not authority.** Tool success/hash observations are bounded
  diagnostics; they never establish durable verified facts.
- **Phase 2.4 dependency.** UI direct SSE/native relay wiring, terminal sync/ACK
  finalization, diagnostics UI, and the evidence inventory remain Phase 2.4.

## Completion boundary

Phase 2.3 source is delivered and has passed a root-review corrective pass: the
trusted reference is consumed only after real workspace resolution, a single
one-shot envelope is bounded and injected at every supported final provider
boundary (with independent per-candidate/retry refit from a clean base), recall
never enters durable history/caches/TaskRun, CLI terminal status comes from the
authoritative result, unsupported CLI modes report unavailable without an
unknown flag, and applied IDs/status/terminal/evidence flow to the
authenticated 2.2 receipt. `bun run typecheck` and `bun run build` pass. Phase
2.3 runtime/test acceptance and the Phase 1/2.1/2.2 test gates remain **OPEN**;
this ledger is not runtime evidence, does not claim UI integration or live
smoke, and does not advance to Phase 2.4.
