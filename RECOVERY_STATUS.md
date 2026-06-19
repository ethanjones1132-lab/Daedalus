# Home-Base Recovery Status

**Last verified:** 2026-06-18 (comprehensive build pass)
**Tree:** `C:\Projects\home-base-recovered\` — the running source of truth after the WSL disk loss.

> This file reflects **verified** build state, not aspiration. Every claim below was
> produced by actually running the tool and reading its output (`scripts/verify.sh`,
> `cargo check`, `bun build`, `bunx tsc`, `python -m py_compile`). Prior versions of
> this file were stale; do not trust an entry here unless it cites the command that proved it.

## Subsystem build state (2026-06-18)

| Subsystem | Status | Evidence |
|-----------|--------|----------|
| Python — `claude_cli_proxy` + entire `workspace/action-registry/` (22 files) | ✅ **GREEN** | `python -m py_compile` passes on all 25 `.py` files incl. proxy & smoke |
| Rust backend (`src-tauri/`) | ✗ **DOES NOT BUILD** | `cargo check` → was 383 errors; `Cargo.toml` was incomplete (see below) |
| Bun server (`server-jarvis/`) | ✗ **BROKEN (false green)** | `bun build src/index.ts` exits 0 but tree-shakes to empty `// @bun`; entrypoint is a husk; `bun test` **hangs** |
| React UI (`src-ui/`) | ✗ **DOES NOT TYPECHECK** | `bunx tsc -b` → truncated/corrupted `.tsx` (invalid chars, missing closing tags) |

### Important: `bun build` passing is a FALSE signal
`server-jarvis/src/index.ts` is a 31-line **truncated husk**: it defines two helper
functions that reference `spawn` and `BRIDGE_PORT` which are never imported or defined.
`bun build` (a bundler, not a typechecker) tree-shakes the unused functions away and
emits an empty bundle, so it "passes." The real server bootstrap is **lost**. Treat the
server as non-building until `index.ts` is reconstructed.

## What was fixed in the 2026-06-18 pass

- **`Cargo.toml` dependencies restored.** The recovered manifest was a stripped fragment
  (v0.1.0) missing crates the code provably uses. Re-derived from `use` sites in
  `src-tauri/src` and re-added: `rusqlite` (bundled), `reqwest` (json+blocking),
  `chrono` (serde), `uuid` (v4+serde), `serde_yaml`, `thiserror`. After this, the
  `unresolved/unlinked crate` errors disappeared; remaining `cargo check` failures moved
  to **dependency-crate compilation** (`cannot find type Box` in `tracing`,
  `parking_lot_core`, `sync_wrapper`). That pattern is a stale `target/` incremental cache
  or toolchain/edition-2024 mismatch — **next step: `cargo clean` then re-check** to expose
  the real first-party lib errors before authoring any Rust fixes.
- **Poisonous recovery debris quarantined** to `_quarantine/` (gitignored): `genai.ts`,
  `genai/genai.ts`, and `nul` — these contained captured filesystem **error strings**
  (`EROFS: read-only file system ...` from the dead WSL mount), not source.
- **Real `.gitignore` written.** The previous `.gitignore` was itself an EROFS error string.
- **Empty `src/` directory** (held only a 21-byte stub) confirmed empty.

## Corrected inventory vs. the old "unrecoverable" list

The prior status listed these as truncated or unrecoverable. **They are now complete and
verified** (all 25 Python files pass `py_compile`; the Rust memory files exist on disk):
`workspace/action-registry/**` (store.py, cli.py, models.py, base.py, jarvis.py,
test_store.py, ...), `automate_inference_metrics.py`,
`src-tauri/src/jarvis/memory/{engine.rs, frontmatter.rs, types.rs}`. Earlier recovery passes
restored them; the Rust ones still need to *compile*, which is blocked on the cache/toolchain
issue above, not on missing content.

## Genuinely missing / lost (need OpenCode / Antigravity 6/14 source — see `_recovery/MISSING-FILES-GAP.md`)

Imported by present code but absent on disk (these break the Bun server graph):
- `server-jarvis/src/agent-schema.ts` (imported by `agent-lifecycle.ts`)
- `server-jarvis/src/projection-store.ts` (imported by `agent-lifecycle.ts`)
- `server-jarvis/src/activation-boundary.ts` (imported by `cron-runtime.ts`)
- `server-jarvis/src/orchestration/{prompt-loader,modes,router}.ts` (imported by `orchestration/pipeline.ts`)
- `server-jarvis/src/self-tuning/mod.ts` (only `self-tuning/store.ts` survived)
- `server-jarvis/src/index.ts` — present but a **husk**; real bootstrap lost.
- `orchestration/pipeline.ts` — present but a 452-byte **fragment** (interface only).

## Prioritized next steps

1. **Put this tree under version control** (it was entirely untracked). Protect the source of truth first.
2. **Rust:** `cargo clean` → `cargo check` to surface real first-party errors; fix from a clean cache.
3. **Bun server:** reconstruct `index.ts` bootstrap + the lost modules above; fix the **hanging test** (a socket/bridge test with no timeout) by bounding it.
4. **UI:** repair corrupted/truncated `.tsx` — start with `App.tsx` (invalid chars line 1) and `CompanionSprite.tsx`, then the components missing closing tags (`ApprovalsView`, `CommitmentsView`, ...).
5. **Recover the genuinely-lost files** from the OpenCode / Antigravity (6/14) snapshots per `_recovery/MISSING-FILES-GAP.md`; re-author from architecture docs only where snapshots don't exist.

## How to re-verify

```bash
# from C:\Projects\home-base-recovered (Git Bash)
bash scripts/verify.sh                 # all subsystems (note: bun test currently hangs — see step 3)
cargo check --manifest-path src-tauri/Cargo.toml
bunx tsc -b src-ui
python -m py_compile scripts/claude_cli_proxy.py
```
