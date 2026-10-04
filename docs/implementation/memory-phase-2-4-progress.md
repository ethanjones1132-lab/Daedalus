# Memory Phase 2.4 — Implementation Ledger

**Plan:** `docs/superpowers/plans/2026-10-04-memory-phase-2-4-app-integration.md`
**Binding split:** `docs/superpowers/specs/2026-10-04-memory-phase-2-four-part-design.md`
**Spec:** `docs/superpowers/specs/2026-10-04-memory-four-phase-design.md`
**Parent plan:** `docs/superpowers/plans/2026-10-04-memory-phase-2-live-recall.md`
**Priority:** `docs/CURRENT_ROADMAP.md` #1 (Phase 2.4 source only)
**Worker:** DeepSeek v4.1 Flash on OpenCode CLI

- **Execution baseline:** `dfe39904b8d7fa3ed731e5342e7e80437a6a3b40`
- **Predecessor HEAD:** `e380014` (`fix: intersect unknown-context floor with stage ceiling instead of replacing it`)
- **Branch:** `codex/memory-deepseek-20261004`
- **Phase 2.4 source commit:** see the phase-scoped commit recorded with this ledger.

## Execution environment

- Platform: macOS (darwin), shell zsh.
- Rust: `/Users/charlottehughes/.cargo/bin` — `cargo`/`rustc` 1.99.0.
- Bun: `/Users/charlottehughes/.bun/bin` — `1.4.2`.
- Per the workspace rule and the plan's Global Constraints, **no test file was
  created, no test function was added, and no tests, ephemeral SQL assertions,
  or live transport/inference experiments were run.** Every planned test step
  is deferred and reported NOT RUN.
- Environment repair (not a source change): several `src-ui/node_modules`
  type/native artifacts (`lucide-react` `.d.ts`, `lightningcss-darwin-arm64`,
  `@tailwindcss/oxide-darwin-arm64`) had been iCloud-offloaded to `.icloud`
  placeholders, so the bundled `bun run build` could not resolve them. They were
  restored by re-running the existing locked install for those packages only
  (`bun install --frozen-lockfile` with the package directory removed). No
  dependency, lockfile, or manifest changed. The untracked generated
  `src-tauri/gen/schemas/macOS-schema.json` was not touched or staged.

## Scope delivered (Tasks 1–3)

| Task | Status | Source |
|---|---|---|
| 1. UI direct SSE consumes a persisted native turn | Implemented (source) | `memory-turn-state.ts` (new), `JarvisView.tsx` |
| 2. Native relay onto the same preparation/history/finalization path | Implemented (source) | `jarvis_commands.rs`, `runner.rs` |
| 3. Truthful memory-turn diagnostics in both transports | Implemented (source) | `memory-turn-state.ts`, `JarvisView.tsx`, `runner.rs` |
| 4. Integration inventory + honest runtime gate | This document | pending commit |

## Task 1 — UI direct SSE on a persisted native turn

`src-ui/src/components/jarvis/memory-turn-state.ts` (new):

- Frozen `MemoryRecallStatus` (11 values), `MemoryTurnState` (8 values), and
  `MemoryTurnTerminalStatus` (5 values) in exact lockstep with Rust.
- `decodeMemoryTurnPreparation(value): MemoryTurnPreparation` rejects
  malformed/non-object/missing-identity/bad-status input by throwing so the
  caller degrades to ordinary inference.
- `decodeMemoryStatusFrame(value): MemoryStatusFrame | null` rejects
  non-object/malformed frames with `null`; an unknown `status` value degrades
  to `unavailable` (never an invented status). It reads only `turn_id`,
  `status`, `selected_ids`, `store_revision`, `code` — never content.
- `decodeMemoryTurnDiagnostic(value)` parses the authoritative native
  diagnostic and keeps prepared `selectedIds` distinct from actual
  `appliedSelectedIds` (the latter may validly be empty).
- `formatMemoryTurnLabel(transient, diagnostic)` reports a plain status plus
  selected/applied counts; counts come only from the native diagnostic.

`JarvisView.tsx::streamFromJarvisApi`:

- Mints exactly one `crypto.randomUUID()` turn id per submitted turn, held
  stable across every frame and the terminal sync. It is distinct from the
  opaque native preparation id.
- **Awaits** `append_message` first and captures the returned persisted DB row
  id as `user_message_id`; the optimistic UI id is reconciled to it (the
  1d4727cf dedupe invariant). No preparation/history/fetch starts before the
  persisted row exists. An append failure records the error, marks capture
  unavailable, and runs ordinary inference with no fake saved row.
- Calls `memory_prepare_turn` with the native Session id, turn id, exact
  persisted message id and the per-turn opt-in. On success the opaque
  `preparation_id` and public `status` are used; on any failure it sends the
  ordinary stream with a typed failure status and **no** preparation reference.
- Calls `memory_turn_history` with the native Session/message ids to build the
  model prompt history (excludes the current row by native identity). On
  failure it sends empty prior history plus a visible history warning; UI
  cached history is never used as inference authority.
- Sends only ordinary chat fields plus `turn_id`, `memory_preparation_id`
  (when registered) and the public `memory_status` initial hint.
- Decodes `memory_status` frames and ignores any whose `turn_id` differs; a
  stale Session/turn completion cannot repaint another turn.
- `finalizeMemoryTurn` performs one ID-only `memory_sync_turn({session_id,
  turn_id})` in the `finally` path (success, error, cancellation, EOF and
  stale-Session teardown), then reads `memory_turn_diagnostic` as authority.
  A bounded sync failure is logged and the ordinary inference outcome is
  preserved; a stale diagnostic result is never applied.
- The assistant response is appended exactly as before with no recalled block.

Per-turn user-wide opt-in: a labeled `Include user-wide memory` checkbox
defaults to false and resets on `activeSession` change so it cannot silently
carry to another Session/Agent.

## Task 2 — Native relay on the same pipeline

`src-tauri/src/commands/jarvis_commands.rs::jarvis_send_message`:

- Persists the exact user row **first** when a real Session exists and uses the
  returned message id for both memory preparation and native history; a blank
  Session id runs ordinary relay inference and cannot become memory-enabled.
- Builds the model history from `history_for_memory_turn` (strict native
  boundary that excludes the source row and all later rows); the operator
  transcript command is untouched.
- Runs `prepare_memory_turn` inside `spawn_blocking` through the existing owned
  transport and shared operation gate, with `include_user_scope: false`. A
  preparation failure degrades to `unavailable` with no reference and ordinary
  relay inference.
- Passes one stable `turn_id`, the optional opaque `memory_preparation_id`, and
  the initial `MemoryRecallStatus` to `run_jarvis_message`, which now accepts
  exactly those three additive parameters.

`src-tauri/src/jarvis/runner.rs`:

- Added the frozen shared `finalize_relay_memory_turn(db: &AppDb,
  transport: &NativeMemoryTransport, identity: MemoryTurnIdentityRequest) ->
  Result<MemoryTurnDiagnostic, MemoryError>`, which calls the authenticated
  `sync_memory_turn` once (ID-only).
- `attempt_relay_memory_finalize` is a one-shot wrapper (tracks a `finalized`
  flag) invoked **before** every terminal publication: HTTP-client build
  failure, POST failure, non-success status, `error` frame, `result` aggregate,
  `[DONE]`, `cancelled`, and the EOF safety net. It only runs when a real
  persisted Session/turn identity exists. A bounded sync failure emits nothing
  fabricated; it logs ids only and the ordinary terminal outcome is preserved.
- The relay request body adds `turn_id`, `memory_status` and (only when
  registered) `memory_preparation_id`. The memory envelope/block is never
  serialized.
- `memory_status` / `memory_applied` frames are forwarded as
  `jarvis://memory-status` / `jarvis://memory-applied` preserving the turn id;
  frames for a different turn are dropped. The relay accumulator never invents
  applied IDs, evidence, or terminal success.
- Terminal `jarvis://done` payloads now also carry `turn_id`.

## Task 3 — Truthful diagnostics, both transports

- UI status vocabulary is exhaustive and typed; unknown/absent values degrade
  to `unavailable` rather than displaying a fabricated status.
- Prepared selected ids and actual applied ids are displayed separately and
  counted only from the native `memory_turn_diagnostic`; the transient SSE
  status is used only while no diagnostic exists.
- No recalled content, source text, capability, or raw receipt is read from or
  rendered from an SSE frame; no terminal SSE claim is treated as durable
  native evidence.
- Native `memory_turn_diagnostic` read-back remains the authority; the UI never
  treats model/tool success as accepted memory.

## Frozen-interface compliance

- 2.2 commands consumed unchanged: `memory_prepare_turn`,
  `memory_turn_history`, `memory_sync_turn`, `memory_turn_diagnostic` (all
  request-wrapped).
- `finalize_relay_memory_turn` matches the frozen signature.
  `run_jarvis_message` was extended only by additive parameters
  (`turn_id: String`, `memory_preparation_id: Option<String>`,
  `initial_memory_status: MemoryRecallStatus`) and keeps existing relay
  semantics.
- No envelope, block, scope, capability, or provenance crosses the webview;
  both transports send references/status only.
- No recalled text enters durable preparation metadata/history/compaction/
  caches. No new native DTO/status/enum was added.

## Exact source commands run

| Command | Result |
|---|---|
| `/Users/charlottehughes/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml` (workdir repo root) | **PASS** — only the 2 pre-existing warnings (`supervisor.rs` deprecated `fetch_update`, `wsl.rs` unused `shlex_join`) |
| `bun run build` (workdir `src-ui`) | **PASS** — `tsc -b` then `vite build` (2717 modules); after restoring the iCloud-offloaded build artifacts |
| `bun run typecheck` (workdir `server-jarvis`) | **PASS** — `tsc --noEmit`, exit 0 |
| `bun run build` (workdir `server-jarvis`) | **PASS** — bundled `dist/index.js` (196 modules) |
| `git diff --check` (repo root) | **PASS** — no whitespace errors |

No `cargo test`, `bun test`, ephemeral SQL script, or live inference/transport
experiment was run. `server-jarvis` source was not changed in 2.4; its
typecheck/build are recorded as integration compatibility evidence only.

## Commands and gates NOT RUN

- `(cd src-ui && bun run test -- src/components/jarvis/memory-turn-state.test.ts src/components/jarvis/JarvisView.memory-turn.test.tsx)`
- `cargo test --manifest-path src-tauri/Cargo.toml relay_memory -- --nocapture`
- Any live direct-SSE + relay smoke with a configured backend.
- Phase 1, 2.1, 2.2, and 2.3 test/runtime gates remain **OPEN** and unchanged.

No test files (`memory-turn-state.test.ts`, `JarvisView.memory-turn.test.tsx`,
`turn-memory-context.test.ts`, `relay_memory` tests, etc.) were created.

## Risks and pending evidence

- **Runtime/test gate open.** The append→prepare→history→fetch order, stale
  Session/turn suppression, opt-in reset, typed degradation, one-shot terminal
  sync on every relay branch, and the selected-vs-applied distinction are
  asserted by inspection, `cargo check`, `tsc`, and bundling only.
- **Environment repair.** The `src-ui` build required restoring iCloud-offloaded
  `node_modules` artifacts. This is an environment action, not a source change;
  no dependency/lockfile/manifest changed.
- **Relay default opt-in.** The relay path has no operator opt-in control and
  always passes `include_user_scope: false`; user-wide recall cannot be enabled
  through the relay in this phase.
- **Sync failure is non-fatal.** A bounded native sync/ACK failure preserves the
  ordinary inference outcome and logs ids only. Missing/nonterminal receipts are
  recorded truthfully by the 2.2 sync path (`unterminated`/`expired`), never as
  terminal success.
- **Phase 2 done gate remains OPEN.** 2.4 closes only the application-wiring
  source task. Runtime tests, lifecycle races, live configured-backend smoke,
  deletion-next-turn behavior, direct/orchestrated route proof, and restart
  evidence are not run here.

## Completion boundary

Phase 2.4 source is delivered: both native-integrated transports await a
persisted user source row, use the same native preparation/history rules, send
references only, expose truthful status, and sync authenticated receipts before
terminal publication. `cargo check`, the UI build, and the Bun typecheck/build
pass. This ledger is **not** runtime evidence, does **not** close the parent
Phase 2 done gate, does not update roadmap priority completion, and does not
advance to Phase 3.
