# Memory Phase 4.3 — Fresh Workspace Evidence and Revalidation Receipts

**Executor:** OpenCode CLI `opencode-go/deepseek-v4.1-flash` only.
**Branch:** `codex/memory-deepseek-20261004`.
**Base checkpoint:** Phase 4.2 commit `bbda00fee0af9ff51af8a160d1a3ef52a0c4098a`.
**State:** Source and permitted checks complete; awaiting commit. **Tests, fixtures, and runtime/acceptance gates were not run.** Roadmap priority #1 remains active.

## Delivered

- Added `server-jarvis/src/memory-revalidation.ts` for policy and current-source evidence assessment. Project-scoped `descriptive_fact`/`unknown` selections require current reads; normative constraints and explicit user/Agent preferences do not. `fresh_evidence` requires successful content-bearing `read_file`/`grep` activity plus authenticated current-turn evidence tied to a path inside the active workspace. Missing/denied/unreadable/unsupported evidence is `unavailable`; no semantic truth, permission, or durable memory change is implied.
- Added additive Bun/Rust revalidation wire metadata, a `revalidation_json` migration/default for compatibility, and receipt diagnostics. Native receipt validation reconstructs the exact required ID set from the immutable prepared selection intersected with authenticated applied-selected IDs. It rejects extras/duplicates, inconsistent state/reason values, and evidence that is not a successful `read_file`/`grep` with a canonical path inside the effective workspace.
- Terminal status is based only on relevant selections actually applied in the turn; prepared-but-budget-omitted items are excluded. A missing workspace remains a required-but-unavailable result. Historical workspace tool-result and discovered-fact hints are suppressed whenever fresh reads are required, even when workspace is absent. Independent TaskRun/check evidence is untouched.
- The existing workspace read cache is bypassed when fresh reads are required. External CLI turns report `unsupported_cli_evidence`; they cannot claim fresh reads without trusted Tool runtime evidence.
- Added fixed memory-role framing inside the existing item/block size caps. UI receives only an optional lenient status decoder; integrated visible status remains Part 4.4.
- Carried forward two reviewed Part 4.2 corrections through DeepSeek: an authenticated binding supersedes an older historical workspace path, while a current-message explicit path retains precedence; the Agent selector locks to the actual identity of a created-but-unbound pending Session until retry or New Chat abandonment.

## Source paths

- `server-jarvis/src/index.ts`
- `server-jarvis/src/memory-contract.ts`
- `server-jarvis/src/memory-workspace.ts`
- `server-jarvis/src/memory-revalidation.ts` (new)
- `server-jarvis/src/native-memory.ts`
- `server-jarvis/src/orchestration/pipeline.ts`
- `server-jarvis/src/orchestration/session-memory.ts`
- `src-tauri/src/db/migrations.rs`
- `src-tauri/src/jarvis/memory/turn.rs`
- `src-ui/src/components/jarvis/JarvisView.tsx`
- `src-ui/src/components/jarvis/MemoryScopeControls.tsx`
- `src-ui/src/components/jarvis/memory-turn-state.ts`

## Independent permitted checks

All checks below passed on the Phase 4.3 working-tree source; the report initially records base HEAD `bbda00fee0af9ff51af8a160d1a3ef52a0c4098a` and will be bound to the commit SHA in the coordination checkpoint after commit.

| Check | Result |
|---|---|
| `cargo check --manifest-path src-tauri/Cargo.toml` | PASS; pre-existing warnings in `supervisor.rs` and `wsl.rs` |
| `server-jarvis: bun run typecheck` | PASS |
| `server-jarvis: bun run build` | PASS; 200 modules |
| `src-ui: bun run build` | PASS; 2,721 modules; existing large-chunk warning |
| `git diff --check` | PASS |

No tests or test declarations/fixtures were added or run. Scripted/live inference, restart, app flow, and runtime acceptance evidence are **NOT RUN**. Compiler/build results do not make roadmap priority #1 runtime-complete. Freshness is source-reviewed only; no observed runtime receipt has proven an end-to-end `fresh_evidence` result.
