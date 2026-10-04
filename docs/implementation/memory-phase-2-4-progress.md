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
- **Phase 2.4 source commit:** `7de87c7` — `feat: prepare native recall on both Session transports`.
- **Phase 2.4 root-review corrective commit:** `f14b275` — `fix: harden phase 2.4 persistence, finalization ordering, and relay diagnostics` (see "Root-review corrective pass").
- **Phase 2.4 second root-review corrective commit:** `ad933bc` — `fix: bound phase 2.4 finalization, submission, and relay correlation` (see "Third root-review corrective pass"). This ledger update is a follow-up docs commit.

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

## Root-review corrective pass

A root source review identified six concrete gaps in the initial 2.4 pass. All
were corrected in source with no tests/runtime execution. This pass supersedes
the corresponding descriptions above where they differ.

1. **No inference without a saved source row (UI).** The append is awaited and
   its returned id validated. A rejected append or a missing/empty/invalid row
   id now stops before preparation/history/fetch and throws a truthful
   persistence failure (`Could not save your message: …`) to the existing draft
   recovery path; the optimistic bubble is never represented as saved. A
   recall/history failure after a saved row still runs ordinary inference.
2. **Complete, ordered, idempotent finalization (UI).** The full persisted-turn
   append→prepare→history→fetch→read lifecycle is wrapped in an outer
   `try/finally`, and a memoized `finalizeMemoryTurn` promise ensures one
   ID-only `memory_sync_turn({session_id, turn_id})` per saved turn. `handleFrame`
   is now `async` and awaited; the `result`/`error`/`cancelled` branches and the
   EOF-unterminated branch finalize before any local terminal publication, and
   the read-loop finally finalizes before the run-record write. Setup/HTTP/body
   failures finalize via the outer finally. Sync is attempted even after a
   Session switch/abort (old-identity), but the diagnostic display and all state
   writes stay guarded by `requestIsCurrent()` so a stale Session is never
   repainted. No inference run id is used.
3. **Truthful, observable diagnostics (UI).** Sync/readback failures and
   nonterminal read-backs now surface the compact `memoryFinalizationNotice`
   instead of being log-only; a `registered`/`started`/`prepared` read-back is
   labelled as nonterminal and never as success. `decodeMemoryTurnPreparation`
   verifies `turn_id`, and the diagnostic tuple `{turn_id, session_id}` is
   checked before use. History rows are validated
   (`decodeNativeHistoryRows`); unknown/malformed rows degrade to empty history
   plus a visible warning rather than blindly mapping or using a UI cache. A
   preparation catch maps only a real typed `status`/`code` via
   `coerceMemoryRecallStatus`, otherwise `unavailable` (never a blanket
   `registration_failed`). The `ready` label is now `ready` (not `recalled`) so
   prepared selection is not presented as actual use. The per-turn user-wide
   opt-in is snapshotted then reset to the Session default (false) on every
   submit, and still resets on Session change, so it cannot silently carry
   across an Agent change within the same Session.
4. **Relay finalization is surfaced and consumed (Rust + UI).** The relay
   finalizer now emits a metadata-only `jarvis://memory-status` failure
   (`status: unavailable`, `code: memory_finalization_failed`) with the stable
   Session/turn on sync failure, and an authoritative `jarvis://memory-diagnostic`
   projection (turn/session, store revision, selected **ids only**, applied ids,
   state/status/error/terminal) on success — never scope, recalled text, or the
   block. The UI adds guarded `jarvis://memory-status` and
   `jarvis://memory-diagnostic` listeners (previously no consumer), keyed by
   Session identity and first-seen turn per submission so a late event cannot
   overwrite another turn. Durable counts come only from the native diagnostic.
   Relay terminal `jarvis://error` payloads now carry `turn_id`.
5. **Relay terminal ordering and history/join honesty (Rust).** In
   `ResultThenDone`, finalization now occurs before the terminal error/done
   emission; setup, cancellation, failed/partial/no-run-id and EOF branches
   were re-inspected and finalize before terminal publication. A failed native
   history read no longer silently `.unwrap_or_default()`s: ordinary relay
   inference still runs with empty history, but an observable metadata-only
   `jarvis://memory-status` history warning (`code: history_unavailable`) is
   emitted. A `spawn_blocking` join failure during preparation no longer
   returns early after a persisted row: it falls back to typed `unavailable`
   and ordinary relay inference (where the terminal finalizer runs). A blank
   Session still fabricates no row and stays an explicitly memory-unavailable
   ordinary path.
6. **Bounded finalization (UI).** `finalizeMemoryTurn` races the ID-only sync
   against a 5,000 ms UI deadline (`MEMORY_FINALIZE_TIMEOUT_MS`), above the
   owned transport's own 1 s connect / 3 s total request bounds, so a native
   task or operation-gate backlog cannot postpone terminal publication
   indefinitely. On timeout or failure it shows a truthful pending/unavailable
   notice and the ordinary result; it never manufactures receipt/terminal
   evidence, never retries the same finalizer, ignores late completion, and
   retains the exact captured `{session_id, turn_id}` tuple. A successful sync
   then performs a guarded native `memory_turn_diagnostic` read-back as the sole
   authority for selected/applied counts.

## Third root-review corrective pass

A second root review identified four remaining source-level races/coverage
gaps. All were corrected in source with no tests/runtime execution.

1. **Finalization is now fully bounded.** The UI no longer awaits a separate
   unbounded `memory_turn_diagnostic`: `memory_sync_turn` already returns the
   authenticated `MemoryTurnDiagnostic`, so the entire sync+decode is inside the
   single 5,000 ms race. Late completion after the deadline can never reach the
   decode/repaint path, the timer is cleared, and a returned tuple that does not
   match `{turn_id, session_id}` is an observable failure
   (`Memory status did not match this turn.`). On the relay side,
   `attempt_relay_memory_finalize` now runs the blocking authenticated sync on an
   `AppHandle`-owned worker thread and waits at most `RELAY_MEMORY_FINALIZE_TIMEOUT_MS`
   (5,000 ms) on a channel; the worker only returns data and never emits. The
   caller emits exactly once — the native diagnostic projection, or a typed
   `memory_finalization_failed` / `memory_finalization_pending` /
   `memory_turn_mismatch` status — before the ordinary terminal publication, and
   a late worker completion only sends to a dropped channel.
2. **Submission guard includes abort/Stop; every awaited finalizer re-checks
   ownership.** `stopIfStale` now uses `submissionAlive` = `requestIsCurrent()
   && !controller.signal.aborted && !stopRequestedRef.current`, evaluated after
   the awaited append, after preparation, after history and before fetch, so a
   Stop during setup cannot race `/chat/cancel` and then still launch inference.
   The display guard `requestIsCurrent` stays separate so a legitimate
   cancellation terminal can still render. Every terminal `handleFrame` branch
   (`result`, `error`, `cancelled`) and the EOF-unterminated branch now
   re-check `requestIsCurrent()` immediately after `await finalizeMemoryTurn()`
   and before any activity/state/terminal mutation, so a Session switch during
   the bounded wait cannot repaint another Session. The read-loop and outer
   finalies keep the same guard (run dispatch/persist and
   `finalizeAssistantMessage` remain `requestIsCurrent`-gated).
3. **Relay correlation is explicit, not first-seen.** A new
   `src-ui/.../relay-memory-correlation.ts` is the concrete seam: the relay
   invoker calls `registerRelayMemoryTurn(sessionId, turnId)` **before** invoking
   `jarvis_send_message` with the same caller-supplied `turn_id` (now an additive
   optional native parameter; Native still prepares against its own saved row and
   never trusts it as authority). Relay memory events are accepted only when
   `isRegisteredRelayMemoryTurn(sessionId, turnId)` matches exactly; registration
   is replaced on a new register and cleared on every direct submission and
   Session change, so a delayed older relay event cannot bind or overwrite a
   newer submission. Unregistered/legacy events are rejected conservatively.
   Terminal relay listeners (`jarvis://done`, `jarvis://error`,
   `jarvis://cancelled`) also require the registered correlation when the event
   carries a `turn_id`, so an old relay terminal cannot finalize a newer direct
   turn; events without a `turn_id` keep the existing behavior.
4. **Relay warning codes are visible and owner-scoped.** The relay
   `jarvis://memory-status` listener now maps `history_unavailable` to the
   history warning and `memory_finalization_failed` / `memory_finalization_pending`
   to the finalization notice, so a typed failure is a compact visible warning
   that a later `ready` frame cannot overwrite. A relay owner ref drops the
   previous turn's warning/diagnostic whenever a different registered relay
   submission becomes active, and all memory state is reset on Session change and
   each new submission. The native diagnostic remains the authority, with
   selected and applied IDs shown separately, and a direct read-back that is
   still `registered`/`started`/`unterminated` is labelled as that actual
   nonterminal state rather than implied finished. The per-turn opt-in is still
   snapshotted then reset to the Session default (false).

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

All commands below were run **unfiltered** as separate simple commands with the
tool's `workdir` argument (no `cd`, no pipes/`tail`, no chained directories):

| Command | Result |
|---|---|
| `/Users/charlottehughes/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml` (workdir repo root) | **PASS** — only the 2 pre-existing warnings (`supervisor.rs` deprecated `fetch_update`, `wsl.rs` unused `shlex_join`) |
| `bun run build` (workdir `src-ui`) | **PASS** — `tsc -b` then `vite build` (2717 modules) |
| `bun run typecheck` (workdir `server-jarvis`) | **PASS** — `tsc --noEmit`, exit 0 |
| `bun run build` (workdir `server-jarvis`) | **PASS** — bundled `dist/index.js` (196 modules) |
| `git diff --check` (workdir repo root) | **PASS** — no whitespace errors |

The same five commands were re-run after the second and third corrective passes
and all **PASS**. The `src-ui` native build artifacts
(`lightningcss-darwin-arm64`, `@tailwindcss/oxide-darwin-arm64`) were restored
from the existing locked install immediately before the build because iCloud had
re-offloaded them; no dependency, lockfile, or manifest changed.

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
  ordinary inference outcome and surfaces a metadata-only failure notice. Missing
  or nonterminal receipts are recorded truthfully by the 2.2 sync path
  (`unterminated`/`expired`), never as terminal success.
- **Finalization is bounded at 5,000 ms (UI).** The UI deadline is above the
  owned transport's own 1 s connect / 3 s total request bounds. If the deadline
  elapses (e.g. a native operation-gate backlog), the client shows a
  pending/unavailable notice and the ordinary result; it does not retry, and a
  late native success is not re-applied. The exact `{session_id, turn_id}` tuple
  is captured before the race. This bound is a UI honesty measure only; the
  native operation gate itself remains authoritative and unchanged.
- **Relay event gating is best-effort ordering.** Relay status/diagnostic
  listeners accept the current Session plus the first turn id seen per
  submission; with no cross-process generation token in the event payload they
  cannot order two same-Session turns beyond that first-seen rule. Native
  diagnostic read-back remains the durable authority.
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
