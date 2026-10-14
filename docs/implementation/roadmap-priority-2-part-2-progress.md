# Roadmap Priority 2 — Part 2 source progress

**Part:** Goal-linked execution and recovery
**Source commit:** `1157cc6fff5dd8fb09ae9af007e681ec01f2dc19`
**Review and coordination:** Luna
**Production source execution:** OpenCode CLI `opencode-go/deepseek-v4.1-flash`

## Implemented source

- Native Goal preparation validates the selected Goal, its Agent/workspace scope, and the exact persisted user message row, then registers a bounded one-shot Goal/Session/turn/source-row/hash/TaskRun binding.
- Bun consumes the registration only after the request carries the exact source-row identity and the actual message body matches the bound SHA-256. Direct UI and native relay paths forward that identity; missing/malformed/mismatched IDs do not associate the run to a Goal.
- Native terminal recording verifies a private consumed receipt correlated to the exact Session/turn/Goal/source/TaskRun/run identity. A public client Goal ID cannot establish attribution.
- Goal-linked TaskRun checkpoints and restart state are persisted through the existing runtime store and exposed through authorized read references. Final accepted-output evidence remains pending the trusted acceptance-manifest implementation in Part 4.
- Existing Goal-less streams and legacy native run API remain compatible.

## Review and validation

Luna focused review confirmed that native saved-source identity is transported end to end and that registration consumption compares exact Session, turn, source-row ID, and actual-message hash before one-shot deletion. Native relay conditionally sends the same persisted source ID only for registered Goal turns. `git diff --name-only` showed no test files; no tests were added or run.

Independent coordinator checks against the exact committed source SHA all passed:

- Rust `cargo check` — PASS (two existing warnings: deprecated atomic method in `src/supervisor.rs`, unused helper in `src/wsl.rs`).
- Server typecheck — PASS.
- Server build — PASS.
- UI TypeScript + Vite build — PASS (existing bundle-size advisory).
- `git diff --check` — PASS.

## Open acceptance

Tests, live runtime, restart/interruption demonstration, real-goal acceptance, packaging, and installation were NOT RUN. Part 2 source work is checkpointed, but Priority #2 remains runtime-incomplete until its roadmap completion criteria have evidence. Priority #1 remains incomplete/open under the user's explicit source-work sequencing direction; #3–#5 remain queued.
