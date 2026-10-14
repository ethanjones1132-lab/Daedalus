# Memory Phase 2 — Four Implementation Phases

**Date:** 2026-10-04\
**Status:** All four Luna plans completed; DeepSeek source implementation reviewed and integrated; test/live gate open.\
**Execution baseline:** `dfe39904b8d7fa3ed731e5342e7e80437a6a3b40` on `codex/memory-deepseek-20261004`.\
**Parent:** Memory Phase 2, live recall; this does not mean roadmap priority #2.

## Scope and authority

The user explicitly requested proceeding with memory Phase 2, splitting it into at most four phases, Luna writing their implementation plans, and DeepSeek executing them. This authorizes proceeding from Phase 1's compiled source despite its previously recorded unrun tests. It does not turn those tests into passing evidence.

The current implementation worktree is `/Users/charlottehughes/Documents/Codex/2026-10-04/ca/work/Daedalus-memory-deepseek`. Reuse it; preserve carried-over planning documents. Rust 1.99.0 exists under `/Users/charlottehughes/.cargo/bin`; Bun 1.4.2 exists under `/Users/charlottehughes/.bun/bin`. Native compilation, Bun type checks, and local Bun/UI builds passed for Phase 1. Required Bun/UI build resources and local dependencies are already present. No system tooling installation is required.

Binding architecture and exact Phase 2 contracts remain in:

- [Shared memory design](2026-10-04-memory-four-phase-design.md)
- [Parent live-recall plan](../plans/2026-10-04-memory-phase-2-live-recall.md)
- [Phase 1 contracts](../plans/2026-10-04-memory-phase-1-scoped-foundation.md)
- `docs/CURRENT_ROADMAP.md`, priority #1

Resolve a conflict in favor of the shared design, then record the ruling. In particular, invalidate unconsumed preparations **before** a mutation callback/commit, never after. Preserve frozen names, signatures, enum values, wire casing, and ownership rules. Later memory Phases 3 and 4 retain their existing scopes and are not implemented here.

## Four phases and coverage

| Phase | Deliverable | Parent tasks covered | Source handoff |
|---|---|---|---|
| 2.1 Native turn preparation | Immutable persisted user-message/Session/scope identity, exact hashing, bounded context rendering, native history, wire DTOs/migrations | Task 1 | Pure native turn helpers and matching Bun wire definitions |
| 2.2 Trusted transport and lifecycle | Owned process capability, private Bun registry/routes, native registration/sync/recovery, precommit invalidation on all semantic write paths | Tasks 2 and 6 | Authenticated preparation, mutation coordinator, durable diagnostics and receipts |
| 2.3 Live inference context | Actual workspace-bound consumption, ephemeral final-request injection for direct/orchestrated/CLI paths, applied-ID and runtime lifecycle observations | Tasks 3 and 4 | Server accepts only references and reports actual context application |
| 2.4 Application integration | Native-backed UI direct SSE and native relay, finalization, diagnostic UI, integration/evidence inventory | Tasks 5 and 7 | Complete Phase 2 source integration; test/live gates reported separately |

Implementation is strictly sequential in this order. Planning uses one Luna agent to keep the four plans' interfaces consistent. Each phase's source and compiler/type/build checkpoint is reviewed before handing the next to DeepSeek. Runtime acceptance remains open where unexecuted.

## Contracts and invariants to carry into every plan

- Rust/App SQLite is the only durable accepted-memory authority. Bun keeps its distinct TaskRun/tool caches and an ephemeral preparation registry; it never reads/writes App memory independently.
- Agent/project identity comes from persisted native Session scope; user-wide recall defaults false. Project binding never grants filesystem access.
- Exact UTF-8 message hash binds Session/turn/source identity; public chat accepts references only, never memory text, scope, authority, terminal outcome, or provenance.
- Maximum five entries, 600 Unicode scalar values per item, 4,000 for the whole framed block; provider input budgets may drop lowest-ranked complete items. No recalled blocks in durable history, compaction, TaskRun facts, or reusable cache state.
- Private app-lifetime capability is passed only to the owned Bun process, removed from Bun environment before child launches, and absent from UI, logs, prompt, health/status responses. Native Unix/Windows/WSL ownership and restart paths must be covered by source.
- TTL 120 seconds for unconsumed preparation; one consumption; bounded registry, bodies and evidence as defined by parent plan. No new inference deadline.
- Native operation gate precedes AppDb mutex. No network operations while SQLite mutex is held. Failed invalidation against a live owned registry prevents the mutation callback; confirmed exited/replaced generation permits mutation. Never stop a healthy server to force a write.
- Phase 2.2 must wrap all production semantic memory/binding mutations before live consumption becomes available in 2.3; do not defer that safety invariant to UI integration. Usage-only changes do not invalidate.
- Native receipts are capability-authenticated and generation-bound. Prepared metadata differs from actual applied IDs. Terminal success or tool success does not establish durable verified facts.
- Both UI direct `/chat/stream` and native relay are required. Ordinary inference remains usable when recall is unavailable. Existing Session/draft/abort/history/permission behavior must be retained.
- Main memory-enabled CLI must disable resume/persistence; unsupported mode reports unavailable, not false memory readiness. Independently started HTTP-only/cron/Agent/MCP paths remain outside native memory integration.
- Normative/descriptive typed classification and trusted bound-workspace candidate selection remain later memory Phase 4 work. Phase 2 enforces actual workspace equality and reports mismatches. Do not silently force a bound root or expand permissions.
- Memory capture, correction ledger, source suppression, objective continuity, skill/prompt promotion and a Memory UI redesign remain outside this Phase 2 split.

## Planning and execution requirements

Each Luna plan uses the writing-plans header, Global Constraints, five Review Focus risks, exact files/interfaces, 4–6 meaningful tasks, future validation assertions/commands, source/compiler checkpoints, predecessor/successor contracts, and a completion boundary. Planned tests are proposals, not current evidence. Avoid full implementation bodies, invented DTOs, placeholders, or another layer of subphases.

Workspace instructions prohibit adding/running tests without an explicit human request. The current user request advances source implementation; it does not explicitly request tests. DeepSeek must therefore implement source, run compiler/type/build checks, and record all proposed tests/live runtime checks as NOT RUN. Do not add test files, execute ephemeral SQL assertions, or describe compiled test configurations as executed tests. Do not stop source implementation between these four phases solely to request the already-pending test clarification; the user explicitly directed Phase 2 execution. Do not close the parent Phase 2 runtime gate without its required evidence.

Keep existing tests intact except minimal compatibility fixture/type adjustments needed for compilation. If a removed inactive export has old test consumers, retain compatibility until test changes are explicitly authorized; never activate the independent App-memory DB reader in production.

DeepSeek executes using `opencode-go/deepseek-v4.1-flash`, one phase/session at a time, with scoped commits and durable ledgers. It must not start roadmap priority #2 or memory Phase 3, spawn alternate models, push, merge, deploy, edit credentials/global settings, or delete user data. Preserve carried-over docs rather than sweeping them into implementation commits.

## Plan locations

1. `docs/superpowers/plans/2026-10-04-memory-phase-2-1-native-turns.md`
2. `docs/superpowers/plans/2026-10-04-memory-phase-2-2-trusted-transport.md`
3. `docs/superpowers/plans/2026-10-04-memory-phase-2-3-inference-context.md`
4. `docs/superpowers/plans/2026-10-04-memory-phase-2-4-app-integration.md`

## Source execution handoff

See [the source integration handoff](../../implementation/memory-phase-2-summary.md) and its four ledgers for the checked revision and actual compiler/type/build results. This status does not close the parent runtime gate.
