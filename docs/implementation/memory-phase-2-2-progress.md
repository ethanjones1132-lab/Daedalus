# Memory Phase 2.2 — Implementation Ledger

**Plan:** `docs/superpowers/plans/2026-10-04-memory-phase-2-2-trusted-transport.md`
**Binding split:** `docs/superpowers/specs/2026-10-04-memory-phase-2-four-part-design.md`
**Spec:** `docs/superpowers/specs/2026-10-04-memory-four-phase-design.md`
**Parent plan:** `docs/superpowers/plans/2026-10-04-memory-phase-2-live-recall.md`
**Priority:** `docs/CURRENT_ROADMAP.md` #1 (Phase 2.2 source only)
**Worker:** DeepSeek v4.1 Flash on OpenCode CLI

- **Execution baseline:** `dfe39904b8d7fa3ed731e5342e7e80437a6a3b40`
- **Predecessor HEAD:** `846aed7` (`docs: record memory phase 2.1 root-review corrections`)
- **Branch:** `codex/memory-deepseek-20261004`
- **Phase 2.2 source commits:** `ea813c2` (transport/registry/commands, Tasks 1–3), `19b97b8` (precommit mutation gate, Task 4), `227c3be` (always require the live invalidation ACK), and the root-review corrective commit (below).

## Execution environment

- Platform: macOS (darwin), shell zsh.
- Rust: `/Users/charlottehughes/.cargo/bin` — `cargo`/`rustc` 1.99.0.
- Bun: `/Users/charlottehughes/.bun/bin` — `1.4.2`.
- Per the workspace rule and the plan's Global Constraints, **no test files
  were created, no test functions were added, and no tests, ephemeral SQL
  assertions, or live transport experiments were run.** The plan's test steps
  are deferred and reported as NOT RUN.
- Local builds only regenerated gitignored artifacts
  (`src-tauri/target`, `server-jarvis/dist`) and the untracked generated
  `src-tauri/gen/schemas/macOS-schema.json`.

## Scope delivered (Tasks 1–5)

| Task | Status | Source |
|---|---|---|
| 1. Owned process capability + private Bun bootstrap | Implemented (source) | commit A |
| 2. Bounded authenticated registry + receipt protocol | Implemented (source) | commit A |
| 3. Native turn commands, recovery, acknowledgements | Implemented (source) | commit A |
| 4. Gate every production semantic mutation before commit | Implemented (source) | commit B |
| 5. Source checkpoint ledger | This document | commit C |

## Task 1 — Owned process authority

- `src-tauri/src/jarvis/memory/transport.rs` (new): process-lifetime
  `OnceLock<NativeMemoryTransport>`. Generates an app-lifetime capability as
  two concatenated UUID v4 values without separators, plus a separate app
  instance UUID. Owns a bounded blocking `reqwest` client (1 s connect / 3 s
  total) created lazily on the blocking thread.
- `src-tauri/src/lib.rs::spawn_jarvis_server`: all three owned launch modes
  (Windows WSL, native Windows `.exe`, native Unix/WSL) receive
  `JARVIS_NATIVE_MEMORY_CAPABILITY` and `JARVIS_NATIVE_APP_INSTANCE_ID` via
  `.env(...)` only. The WSL branch additionally forwards both names through
  `WSLENV` via the existing `forward_env_to_wsl` helper; values are never
  interpolated into the `bash -lc` command string. Neither value is logged,
  written to config, or placed on the Tauri process environment.
- `src-tauri/src/process_lifecycle.rs`: owns the tracked Bun child handle.
  `bun_server_is_alive()` is the only ownership evidence; a TCP listener on
  the port is never treated as ownership. Spawn/stop transitions bump the
  owned generation and clear the recorded `bun_instance_id`. Lock order is
  `transport state -> CHILDREN`, never the reverse (the CHILDREN guard is
  dropped before any transport-state call).
- `server-jarvis/src/native-memory.ts` (new): captures and deletes both
  variables from `process.env` at module evaluation, before any tool runtime
  or child launch can clone the environment; keeps them in module-private
  closure state. An independently started HTTP-only server has no capability
  and reports `memory_unavailable`.

## Task 2 — Ephemeral authenticated registry

- Registry methods match the frozen parent contract exactly:
  `register`, `consume`, `invalidate`, `observeApplied`, `observeTerminal`,
  `observeToolEvidence`, `receipt`, `ack`. `handleNativeMemoryRequest(req,
  registry)` returns `null` for non-internal paths and runs before general
  OPTIONS/CORS handling in `server-jarvis/src/index.ts::baseFetch`.
- Routes: `POST /internal/memory/preparations` (body exactly
  `PreparedMemoryTurn`, response `{preparation_id,bun_instance_id}`),
  `POST /internal/memory/invalidate` (body `{app_instance_id,reason}`,
  response `{invalidated_count,bun_instance_id}`),
  `GET /internal/memory/turns/{preparation_id}` (receipt),
  `POST /internal/memory/turns/{preparation_id}/ack` (`{turn_id}`).
- Caps: 256 unconsumed, 256 receipts, 128 KiB request bodies, 100 evidence
  refs / 64 KiB evidence, TTL 120 s (server monotonic), one consume. A full
  registry refuses the new registration (`registry_full`) and never evicts an
  active identity. Exact duplicate registration is idempotent before
  consumption; a conflicting body is rejected.
- Receipts carry metadata only (`NativeMemoryRuntimeReceipt`): immutable tuple
  plus lifecycle/run/status/applied-id/evidence. No recalled text. ACK drops a
  receipt only after native persistence; a missing receipt is truthful.
- Native protocol in `transport.rs` performs HTTP with no AppDb mutex held and
  maps registration responses to the owned generation.

## Task 3 — Native commands, recovery, acknowledgements

- `src-tauri/src/commands/memory_turn.rs` (new): request-wrapped
  `memory_prepare_turn`, `memory_turn_history`, `memory_sync_turn`,
  `memory_turn_diagnostic`. Prepare/sync run inside `spawn_blocking` (no
  blocking HTTP on the Tauri executor) and hold the shared operation gate.
- Preparation generates an opaque preparation id before registration; a
  retrieval failure persisted as `retrieval_failed`/`unavailable` skips
  registration and never overwrites itself; a `budget_omitted` empty carrier is
  not registered; public `preparation_id` is non-null only after a successful
  registration into a live `registered` ready/empty, unexpired turn.
- `memory_sync_turn` validates the exact immutable tuple and Bun generation
  against the durable row, persists applied ids / terminal state / evidence
  idempotently, preserves the first terminal outcome, and only then ACKs.
- Startup recovery runs in `lib.rs::bootstrap_services` before the server is
  ensured: `prepared|registered` -> `expired`, `started` -> `unterminated`.
  Durable opaque ids are retained; public references stay null; no old turn is
  re-recalled or re-registered.

## Task 4 — Precommit mutation gate (complete caller inventory)

`with_memory_mutation_gate` acquires the operation gate, invalidates the live
owned registry **before** the AppDb mutex (HTTP completes first), marks native
`prepared|registered` rows `invalidated`, then invokes the mutation callback
under the AppDb mutex. Whenever the tracked child is confirmed alive the gate
requires an authenticated invalidation ACK, even if no registration response
was recorded: a lost response can still have left an envelope in the registry,
so skipping the ACK on an unrecorded generation would let a stale envelope be
consumed after commit. A live owned registry that cannot acknowledge returns
`invalidation_unavailable` and invokes no callback. A confirmed exited/replaced
tracked child permits the mutation (a port probe is not ownership evidence).
Never stops a healthy child.

Gated production writers (top-entry, before the AppDb lock):

| Writer | Adapter |
|---|---|
| Legacy manual save | `commands/memory.rs::memory_save` |
| Legacy manual update | `commands/memory.rs::memory_update` |
| Legacy delete | `commands/memory.rs::memory_delete` |
| Legacy restore | `commands/memory.rs::memory_restore` |
| Consolidation run | `commands/memory.rs::memory_run_now` |
| Session workspace bind/unbind | `commands/memory.rs::memory_bind_session_workspace` |
| Scoped save/update/delete/restore/adopt | `commands/memory.rs::memory_scoped_{save,update,delete,restore}` / `memory_adopt_legacy` |
| Session deletion | `commands/sessions.rs::delete_session`, `commands/jarvis_commands.rs::jarvis_delete_session` |
| Session review (deferred-review writes) | `commands/recovery_stubs.rs::jarvis_review_session` |
| Session-end commit (consolidation + counter reset) | `commands/recovery_stubs.rs::jarvis_commit_session_end` |

Explicitly excluded (read-only or usage-only): `memory_list`, `memory_read`,
`memory_search`, `memory_recall_preview`, `memory_events_list`,
`memory_runs_list`, `memory_scoped_read`, `memory_scoped_list`,
`memory_scoped_recall_preview`, `list_recent_memories`, `get_session_history`,
`history_for_chat_stream`, `jarvis_get_tier_stats`,
`jarvis_list_memories_by_tier`, `jarvis_recall_cold_memory`, and any
usage/last-used/relevance-only write.

Inactive engine paths (no production caller; inventoried, not wrapped):
`create_or_merge_memory` (only reached through the gated save/update and
`apply_deferred_review`), `apply_deferred_review` (through the gated
`review_session`), `run_tier_management`, `run_post_turn_housekeeping`,
`increment_review_counter`, `cache_cold_content`. Phase 1 compatibility rules
are unchanged.

## Frozen-interface compliance

- Consumed Phase 2.1 DTOs/helpers unchanged
  (`PrepareMemoryTurnRequest`, `MemoryTurnPreparation`, `PreparedMemoryTurn`,
  `PreparedMemorySelection`, `PersistedMemoryTurn`, `MemoryTurnDiagnostic`,
  `MemoryTurnIdentityRequest`, `MemoryRecallStatus`, `MemoryTurnState`,
  `prepare_memory_turn_record`, `mark_memory_turn_registered`,
  `mark_memory_turn_registration_failed`, `read_memory_turn`,
  `history_for_memory_turn`). Additive only: `NativeMemoryRuntimeReceipt`,
  `memory_turn_diagnostic`, `apply_memory_turn_receipt`,
  `mark_pending_turns_invalidated`, `recover_pending_memory_turns`.
- Frozen `NativeMemoryTransport` native signatures implemented exactly.
- Frozen registry methods and observation shapes implemented exactly in
  `native-memory.ts`; no observation carries content.
- No new memory text in durable preparation metadata, history, compaction,
  caches, or receipts.

## Exact source commands run

| Command | Result |
|---|---|
| `/Users/charlottehughes/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml` | **PASS** — only the 2 pre-existing warnings (`supervisor.rs` deprecated `fetch_update`, `wsl.rs` unused `shlex_join`) |
| `(cd server-jarvis && bun run typecheck)` | **PASS** — `tsc --noEmit`, exit 0 |
| `(cd server-jarvis && bun run build)` | **PASS** — bundled `dist/index.js` |
| `git diff --check` | **PASS** — no whitespace errors |

No `cargo test`, `bun test`, ephemeral SQL script, or live/runtime transport
experiment was run.

## Root-review corrective pass

A root review of the initial 2.2 source identified concrete gaps; all were
corrected in source in this same session with no test/runtime execution.

1. **Lock order and confirmed ownership.** `process_lifecycle` no longer calls
   the transport at all. CHILDREN is never held while acquiring a lock held
   across HTTP. Ownership is an explicit `BunOwnership::{None,Live,Exited,
   Unknown}` derived from the actual `Child` handle plus an atomic owned
   generation (`bun_generation`). `try_wait` error is `Unknown` and fails
   closed. An unconfirmed termination (`stop_slot` kill/wait failure) retains
   the handle and sets `BUN_TERMINATION_UNCONFIRMED`, which forces `Unknown`
   and does not bump the generation that would authorize an invalidation
   bypass. The gate reads ownership/generation after acquiring the operation
   gate (order `transport state -> CHILDREN`).
2. **Ambiguous registration/invalidation.** Invalidation requires an
   authenticated ACK whenever the tracked child is `Live`, even when
   `bound_generation == None` (a lost registration response), and parses the
   ACK's `bun_instance_id`; an invalid or mismatched ACK never clears the gate.
   Registration first requires a `Live` owned child and re-checks the atomic
   generation after the HTTP round-trip, so a replacement or unrelated listener
   is rejected.
3. **Receipt synchronization.** `sync_memory_turn` verifies the current app
   instance and the current owned generation in addition to the persisted
   tuple. Missing receipt/generation loss is recorded truthfully
   (`started`/`invalidated` -> `unterminated`/`evidence_unavailable`;
   missing-receipt `registered`/`prepared` -> `expired`); an already durable
   terminal is preserved. A nonterminal started receipt is never ACKed. ACK
   failure is logged (ids only, no memory text) and remains retryable.
4. **Native bounds.** Response reads stream through `Read::take(MAX+1)` and
   reject overflow without buffering the whole body. The blocking client is
   built with connect/total timeouts and there is no untimed fallback; build
   failure is unavailable with no HTTP. No secret appears in errors/logs.
5. **Registry lifecycle/capacity.** Tombstones are never evicted before their
   deadline; only expired markers are pruned. Registration reserves combined
   `unconsumed + receipts + tombstones` capacity and is refused under pressure
   (per-category 256 plus a combined 512 identity cap). The accepted envelope
   is deep-cloned and deeply frozen; receipts are returned as clones. TTL is
   `min(120s, native wall expiry)` from registration and invalid/expired
   timestamps are rejected. Envelope schema and 5-item/600-scalar/4,000-block
   bounds are validated. Evidence overflow sets an observable
   `evidence_unavailable` code. `observeApplied`/`observeToolEvidence` act only
   on a started, nonterminal receipt and applied IDs are restricted to the
   original selection.
6. **Bun request/auth/path.** Request bodies stream through
   `req.body.getReader()`, cancel on overflow, and never buffer the whole body
   first. `canonicalWorkspace` returns `null` on realpath failure (no `resolve`
   fallback) and delegates platform/UNC/WSL normalization to the shared
   workspace path-identity helper. Invalidation verifies `app_instance_id`,
   drops in-memory session compaction carriers, and returns this registry's
   actual `bun_instance_id`. The captured capability stays module-private; the
   secret object is not exported.
7. **Durable receipt validity.** `apply_memory_turn_receipt` never manufactures
   `started_at`; a receipt with neither start nor terminal is an authoritative
   validation-end recorded without granting a started lifecycle. Applied IDs
   are filtered to the original selection, evidence is bounded, and a
   conservatively `invalidated` row may reconcile an authenticated
   started/terminal receipt without resurrecting its public reference.
   Bun never consumes invalidated unstarted entries.
8. **Additional owner mutation.** `commands/agents.rs::delete_agent` enters the
   precommit gate before its AppDb lock; `delete_agent_row` remains a pure
   helper. Agent name/model edits are unchanged (they do not alter memory
   scope).

Also corrected: the bounded native item renderer now drops the title label,
then the whole label, when it cannot fit without starving the excerpt.

Corrective-pass files: `src-tauri/src/process_lifecycle.rs`,
`src-tauri/src/jarvis/memory/transport.rs`,
`src-tauri/src/jarvis/memory/turn.rs`, `src-tauri/src/commands/agents.rs`,
`server-jarvis/src/native-memory.ts`,
`server-jarvis/src/orchestration/session-memory.ts`,
`server-jarvis/src/index.ts`, and this ledger.

## Corrective source commands run

| Command | Result |
|---|---|
| `cargo check --manifest-path src-tauri/Cargo.toml` (workdir repo root) | **PASS** — only the 2 pre-existing warnings |
| `bun run typecheck` (workdir `server-jarvis`) | **PASS** — `tsc --noEmit`, exit 0 |
| `bun run build` (workdir `server-jarvis`) | **PASS** — bundled `dist/index.js` |

Two earlier verification invocations were auto-rejected by the OpenCode CLI
before they ran (both used a chained `cd ..`/multi-directory shell command).
They produced no result and are not evidence; the equivalent authorized checks
above were re-run from within the worktree using the tool's `workdir`.

## Commands and gates NOT RUN

- `cargo test --manifest-path src-tauri/Cargo.toml native_memory_capability -- --nocapture`
- `cargo test --manifest-path src-tauri/Cargo.toml memory_receipt -- --nocapture`
- `cargo test --manifest-path src-tauri/Cargo.toml memory_turn -- --nocapture`
- `cargo test --manifest-path src-tauri/Cargo.toml memory_mutation -- --nocapture`
- `(cd server-jarvis && bun test src/native-memory.test.ts)`
- Any live multi-process owned-generation, registry-bounds, TTL, receipt
  idempotency, recovery, or workspace-mismatch runtime assertion.
- Phase 2.1 and Phase 1 test gates remain **OPEN** and unchanged.

`server-jarvis/src/native-memory.test.ts` was intentionally not created.

## Risks and pending evidence

- **Runtime/test gate open.** Capability ownership, WSL/Windows forwarding,
  registry bounds, single-consume, receipt tuple/idempotency, recovery, and
  gate failure/success behavior are asserted by inspection, typecheck, and
  compilation only.
- **Cross-process authority.** The owned generation is tracked by the live
  child handle plus a capability-authenticated registration response. This is
  not exercised against a real WSL/Windows child here.
- **Lock order.** `transport state -> CHILDREN` is enforced by dropping the
  CHILDREN guard before any transport-state call; this is reviewed by
  inspection, not stress-tested.
- **Mutation latency.** Every semantic mutation now performs one bounded
  authenticated invalidation HTTP call whenever the tracked child is alive,
  even for unrelated or no-op mutations. This is the conservative safety cost
  of the precommit invariant; a live child that cannot answer blocks the
  mutation with `invalidation_unavailable` rather than committing unsafely.
- **Phase 2.3 dependency.** `consume`, one-shot state, and
  `observeApplied`/`observeTerminal`/`observeToolEvidence` are implemented and
  exposed for 2.3 but not wired to inference. Phase 2.2 does not claim model
  inference uses recall.
- **CLI/session mode.** Ordinary inference remains usable when recall is
  unavailable; memory-enabled CLI resume/persistence disabling is Phase 2.3
  work.

## Completion boundary

Phase 2.2 source is delivered: owned capability transport, capability-
authenticated ephemeral Bun registry and metadata receipts, native command
adapters and recovery, and precommit mutation invalidation covering all
enumerated production semantic writers compile, typecheck, and build. Phase 2.2
runtime/test acceptance and the Phase 1/2.1 test gates remain **OPEN**. This
ledger is not runtime evidence, does not mark roadmap priority #1 complete, and
does not advance to Phase 2.3.
