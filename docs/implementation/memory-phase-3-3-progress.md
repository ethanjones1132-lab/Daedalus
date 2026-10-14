# Memory Phase 3.3 — Reviewed source ledger

**Status:** Source implemented, reviewed, and independently compiled/bundled. Tests and runtime acceptance remain open.
**Plan:** Luna's `2026-10-04-memory-phase-3-3-turn-lifecycle.md`.
**Executor:** DeepSeek v4.1 Flash (`opencode-go/deepseek-v4.1-flash`) through sequential OpenCode runs. Root reviewed production source and requested corrections from the same executor.
**Source baseline:** Part 3.2 checkpoint `1280f0aa8d3a7bc1e28f86aa5454f36193b964e9`.
**Branch:** `codex/memory-deepseek-20261004`.

## Native source

- Assistant append validates the existing same-Session turn and atomically inserts the actual message, immutable turn association, and current source suppression. Exact content replay returns the existing DB ID; differing content conflicts. Calls without a turn ID retain ordinary transcript behavior.
- Late attachments consult current tombstones, memory revisions and suppression. Authenticated completion uses actual applied IDs only; unknown application uses prepared plus applied IDs. Manual facts without original message sources participate. Future inference history is neutralized while operator transcript stays raw.
- Relay finalization binds the original newly saved user message ID/hash before sync, association or capture. A reused turn ID cannot attach a new answer to or publish the receipt of an older source. Source-conflict ordinary transcript append stays unassociated.
- Relay accumulates emitted answer chunks and aggregate results, owns completed assistant persistence, and reports nullable DB ID plus native ownership on all terminal paths. A null ID never authorizes a duplicate UI append.
- Sync, append and capture failures are independent. A sync-only diagnostic does not fail an already committed capture receipt. One whole five-second wait covers the relay worker; it returns data only and cannot publish late status after timeout.
- One shared gated capture resolver serves the native command, relay and startup recovery. Recovery handles missing receipts and allowed preterminal receipt augmentation with newly authoritative terminal metadata. Replay does not re-save operations or repeat semantic cleanup. No DB mutex is held across the HTTP gate.

## UI source

- Direct finalization is memoized and sequential: assistant append, sync, capture, with independent failure handling. One five-second race covers the whole attempt.
- The worker returns data only. Only the timely winner may publish under the original Session, send generation and controller. Timed-out work may finish durable persistence but cannot repaint the UI.
- Original saved user source is prepared/bound even if the Session switches during append; the stale guard then stops inference. Finally always attempts capture against the originating turn.
- Direct assistant persistence reconciles the actual DB ID onto the exact local assistant bubble. Registered relay persistence is native-owned; legacy idle relay append runs outside React state updaters with an owner epoch and local bubble ID. Aggregates reset between submissions/Sessions/terminals.
- Registered relay terminal settles its tuple; later memory status, diagnostic and capture events cannot replace it. Receipt and diagnostic identity checks are separate.
- The capture decoder validates terminal enum, safe integer revisions/counts, unique nonempty operation IDs, optional field types and exact status/count agreement. Actual capture errors or blocked-only receipts show Failed; unresolved operations show Pending before Saved; committed positive saved count shows Saved; otherwise Unchanged. Bounded timeout shows Pending. Assistant prose never confirms a save.

## Independent source checks

All following root checks returned exit 0 on the reviewed source:

| Check | Result |
|---|---|
| `cargo check --manifest-path src-tauri/Cargo.toml` | PASS |
| `bun run typecheck` — server-jarvis | PASS |
| `bun run build` — server-jarvis | PASS; 197 modules |
| `bun run build` — src-ui | PASS; TypeScript and Vite, 2,719 modules |
| `git diff --check` | PASS |

A static diff inspection found no added test declarations; no test files were added. Existing Rust warnings in `supervisor.rs` and `wsl.rs`, and the existing UI chunk-size warning, remain.

## Local dependency restoration

Documents file-provider placeholders caused UI dependency types/binaries to be missing or renamed during worker runs. Root restored exact existing installed cached files immediately before the independent build: lucide-react 1.21.0 declarations, lightningcss-darwin-arm64 1.32.0 and Tailwind oxide 4.3.1 native binaries. Installed Rollup/esbuild cache restoration remains available if offloaded. No manifest or lockfile changed. The temporary ambient any-type shim was removed; the passing build uses the real package declarations. Worker logs and its earlier ledger retain the historical dependency failures.

## Open gates — NOT RUN

No tests or runtime/live acceptance experiments were added or run. Lifecycle, cancellation, Session-switch, timeout, source conflict, replay, rollback, late-write and recovery behavior remains unverified at runtime. Relay association deliberately requires authenticated completed terminal metadata; a sync failure may leave no associated assistant row. Packaged/installed behavior remains unverified.

Part 3.4 is next. Priority #1 remains active and Phase 4 remains pending. Source checks are not runtime acceptance.
