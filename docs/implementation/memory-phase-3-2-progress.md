# Memory Phase 3.2 — Derived context invalidation

**Status:** Production source reviewed after corrective DeepSeek passes; compiler/type/build checks passed. Runtime acceptance remains open.
**Baseline:** Part 3.1 checkpoint `7e55fa9`.
**Branch:** `codex/memory-deepseek-20261004`.
**Plan:** Luna's `2026-10-04-memory-phase-3-2-derived-invalidation.md`.
**Executor:** DeepSeek v4.1 Flash (`opencode-go/deepseek-v4.1-flash`) through OpenCode CLI.

## Native implementation

- The frozen four-field `MemoryDerivedInvalidation` remains ids only. Resolved scope lives in an internal `NativeDerivedMutationPlan`.
- One operation lock covers native plan resolution, canonical replay checks, the private cleanup acknowledgement, and the atomic mutation. HTTP runs without the AppDb mutex. Exact replay and ordinary/pending capture receipts do not repeat semantic invalidation.
- The existing capability-only `/internal/memory/invalidate` route carries optional derived cleanup. A live owned process must acknowledge; unknown ownership fails closed. With no live process, native changes leave pending cleanup for the next preparation/history read.
- Additive `memory_derived_cleanup_outbox` has no Session foreign key. Existing outbox rows are copied without dropping the old table. Original initiating Session and operation identity survive deletion and rebuild the same namespaced wire key on every drain.
- Legacy/manual/scoped memory mutations, adoption, workspace binding and Agent/Session deletion use the cleanup gate. Legacy update/delete/restore reject scoped targets; consolidation selects its legacy candidates and continues to work alongside scoped facts.
- Suppression resolves each source/assistant message's actual Session owner, including replies in other Sessions and memories without an original transcript source. Proposal lineage and all consequence ids are retained; the new replacement directive remains available.
- Application evidence uses the actual applied union after authenticated completion. In-flight, invalidated and recovery-only unterminated records retain conservative prepared-selection coverage.
- Model history replaces suppressed messages with `[Memory source removed]`. Operator transcript rows remain available. Cleanup and history snapshots share the operation lock.
- Compaction snapshots sanitized history and rejects stale output using store, continuity and Session binding revisions. Suppression and binding changes advance the relevant counters.
- A preparation that never started retains a null terminal; recovery does not fabricate an interrupted inference. Capture sync failures remain observable metadata and do not confer assistant authority.

## Bun implementation

- Cleanup raises a durable generation barrier before synchronous host cleanup and records completion only after all required writes succeed. The private route withholds acknowledgement on failure.
- Completed keys retain activity and source/memory coverage. A retry after cleanup succeeded but the native write failed cleans again if new derived activity appeared. Completed keys are not silently evicted.
- Activity tracking is persisted before registry registration/consumption and before Session turn derived state is created. Tracking failures fail closed.
- Session and conductor objects have fixed generation tokens. Cleanup replaces cached objects with detached scrubbed copies. Old objects cannot overwrite newer files or cached state.
- Loaded stale text is scrubbed before prompt use. Typed marker validation rejects corrupt or mismatched persisted state; filename encoding preserves distinct Session identities.
- Memory-origin and unknown legacy facts are removed. TaskRun text is neutralized while retaining IDs, status, plan progress, evidence, checks and grants. Independent tool/file caches remain available.
- Every started Session turn, including ordinary HTTP turns, guards late planning/outcome writes with its original generation. Authenticated terminal, applied-memory and runtime evidence remain recordable.
- The private payload parser requires exactly the frozen fields and bounded values. An empty affected-Session array is a legitimate no-op.

## Independent source checks

| Check | Result |
|---|---|
| `cargo check` in `src-tauri` | PASS |
| `bun run typecheck` in `server-jarvis` | PASS |
| `bun run build` in `server-jarvis` | PASS — 197 modules |
| `git diff --check` | PASS |

Rust reports the existing `supervisor.rs` deprecated atomic call and unused `wsl.rs::shlex_join` warnings. UI source was not changed in this part.

No test files, test declarations or test-only helpers were added. No tests or live/ephemeral acceptance experiments were run. Root reviewed source and corrections; compilation and bundling do not prove runtime behavior.

## Open gates and handoff

Runtime/test gates remain **NOT RUN**: rollback/cleanup failure, deleted-Session outbox survival, same-operation retries after new activity, cross-Session suppression, late writers, compaction races, and process/database restart.

A valid parsed operation that later fails admission may cause conservative cleanup before its blocked receipt is known. Old unreleased marker formats fail closed. If activity markers cannot be trusted or durably written, Session derived-state creation is refused; degraded inference behavior requires runtime acceptance.

Part 3.3 supplies direct/relay assistant association, capture on lifecycle exits, bounded receipt publication and recovery capture. Part 3.4 supplies objective continuity and removes implicit review/end learning. Roadmap priority #1 remains active; no runtime gate is closed.

