# Memory Phase 2 — Source Integration Handoff

**Status:** All four source subphases implemented and reviewed; runtime acceptance remains open.\
**Checked source revision:** `db2abf29fefe07889fe7a1daf906b54666e60d76`\
**Branch:** `codex/memory-deepseek-20261004`\
**Planning:** Luna (`gpt-6-luna`).\
**Implementation:** DeepSeek v4.1 Flash (`opencode-go/deepseek-v4.1-flash`) through OpenCode CLI, sequentially.\
**Product priority:** #1, memory. Roadmap priority #2 and memory Phases 3–4 have not started.

## Four source subphases

| Phase | Scope | Source checkpoint | Implementation plan |
|---|---|---|---|
| 2.1 | Native turn preparation | `846aed7` | [Luna plan](../superpowers/plans/2026-10-04-memory-phase-2-1-native-turns.md) |
| 2.2 | Trusted transport and lifecycle | `3ddbd02` | [Luna plan](../superpowers/plans/2026-10-04-memory-phase-2-2-trusted-transport.md) |
| 2.3 | Live inference context | `e380014` | [Luna plan](../superpowers/plans/2026-10-04-memory-phase-2-3-inference-context.md) |
| 2.4 | Application integration and finalization | `db2abf2` | [Luna plan](../superpowers/plans/2026-10-04-memory-phase-2-4-app-integration.md) |

The earlier checkpoint IDs mark source handoffs, not runtime acceptance. Phase 2.4 includes the reviewed dependency corrections and final transport adapter. Source ledgers record individual commits and checks:

- [2.1 ledger](memory-phase-2-1-progress.md)
- [2.2 ledger](memory-phase-2-2-progress.md)
- [2.3 ledger](memory-phase-2-3-progress.md)
- [2.4 ledger](memory-phase-2-4-progress.md)

## Implemented source

- Native preparation binds a turn to its exact saved user message, persisted Session scope, exact UTF-8 hash and memory-store revision. Recall is bounded to five labelled items, 600 Unicode scalars per item and 4,000 scalars for the framed block. Prompt history stops before the exact current source row.
- A private capability connects Native to its owned Bun generation. Bun holds immutable, expiring preparations and authenticated receipts. Production semantic mutations invalidate unconsumed preparations before committing; a live owned registry must acknowledge invalidation.
- Supported direct, orchestrated and CLI inference paths consume only validated references, fit ephemeral context against the actual request budget and report retained IDs. Request retries rebuild from clean bases; recalled blocks stay out of durable history, caches and TaskRun context. Runtime tool evidence remains diagnostic metadata and cannot establish accepted memory facts.
- UI direct SSE awaits the saved user row and native history. Native relay independently persists and prepares its own source. Both send references, preserve stable turn identity and attempt authenticated finalization before terminal publication. Both finalization waits are bounded to five seconds; pending/failed synchronization preserves the ordinary inference outcome without inventing evidence.
- User-wide memory opt-in is explicit, false by default, and consumed per submission. Prepared selection and actually applied IDs stay distinct. Async state updates are guarded against changed Session/turn ownership. The main UI continues using direct SSE; correlated relay callers use the register-before-invoke adapter documented in the 2.4 ledger. Unregistered relay metadata is ignored conservatively.

## Final source checks

Root independently ran these on the checked source revision, with full output and no test execution:

| Check | Result |
|---|---|
| `cargo check` in `src-tauri` | PASS |
| `bun run typecheck` in `server-jarvis` | PASS |
| `bun run build` in `server-jarvis` | PASS |
| `bun run build` in `src-ui` | PASS |
| `git diff --check` | PASS |

Two preexisting Rust warnings and the existing UI chunk-size warning remain. Local UI dependency files offloaded by iCloud were restored from matching cached/package versions; dependency manifests and lockfiles were not changed for that restoration. Compilation and bundling provide source evidence only.

## Runtime evidence still required — NOT RUN

No test files/functions were added and no tests, ephemeral SQL assertions or live acceptance experiments were run. This follows the workspace instruction requiring an explicit request for tests. Phase 1 and all Phase 2 test/runtime gates remain open.

Required evidence includes cross-Session recall, Agent/project isolation and user opt-in; owned-process restart and generation loss; replay/TTL and invalidation races; actual direct/orchestrated/CLI request contents and budget boundaries; UI draft/Stop/Session-switch behavior; relay correlation and terminal synchronization without an inference run ID; authenticated applied-ID/tool evidence; deletion affecting the next turn; and restart continuity. Packaged app behavior is not verified.

HTTP-only, cron, Agent and MCP surfaces outside native preparation are not advertised as memory-enabled. Unsupported/resumable CLI modes continue ordinary inference with unavailable memory. Safe capture, correction, forgetting/source suppression, objective continuity and the remaining classification/control work belong to memory Phases 3–4. The parent Phase 2 Done gate and roadmap priority #1 completion criteria remain unchecked.
