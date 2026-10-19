# Release provenance

How a built Jarvis release proves **what** shipped and **which commit** it came
from, and how `scripts/verify-deploy.ps1` checks that on disk.

For the shipped-release pipeline (build → package → sign → hash → install →
launch → health → chat) and the `jarvis-release.json` record, see
[`release-pipeline.md`](release-pipeline.md). This document is about the
provenance *rules*; that one is about the pipeline that applies them.

## Two records, two jobs

| Record | Written by | Describes | Checked by |
|---|---|---|---|
| `.jarvis-deploy-manifest.json` | `scripts/build-and-deploy.ps1` | a developer's local deploy onto the Desktop | `scripts/verify-deploy.ps1` |
| `jarvis-release.json` | `scripts/release-build.ps1` | a shipped release: the installer and everything packaged with it | `scripts/release-smoke.ps1` |

Both are built from the same primitives, which now live in one place:
`scripts/lib/release-common.ps1`. Before that file existed, the source-tree
digest was implemented separately in `build-and-deploy.ps1` and
`verify-deploy.ps1`, and the build bake separately in a third place — which
is how a `cargo tauri build` came to silently replace the identity-baked
server bundle with an ordinary one. The digest algorithm is frozen, and
`scripts/release-pipeline.Tests.ps1` pins it to the original implementation
rather than to itself, because every deploy manifest ever written is
verified against it.

## What is recorded

`scripts/build-and-deploy.ps1` writes a deploy manifest,
`.jarvis-deploy-manifest.json`, next to the runtime artifacts. It is the single
release record for a deploy:

| Field | Meaning |
| --- | --- |
| `git_sha` | The commit the build came from (`git rev-parse HEAD`, captured before the build so it matches the SHA baked into the bundle). |
| `git_dirty` | Whether the worktree was dirty at build time. |
| `source_tree_sha256` | SHA-256 over every file under `server-jarvis/src`, `src-tauri/src`, `src-ui/src`, and `scripts` (`<relative-path>:<file-hash>` joined by `\n`). |
| `index_js_sha256` | SHA-256 of `index.js` (the bundled Bun server). |
| `inference_metrics_sha256` | SHA-256 of `automate_inference_metrics.py`. |
| `claude_proxy_sha256` | SHA-256 of `resources/claude_cli_proxy.py`. |
| `opencode_go_models_sha256` | SHA-256 of `resources/opencode_go_openai_models.json`. |
| `prompts_tree_sha256` | Git tree object id for `server-jarvis/src/prompts`. |
| `exe_mtime` | Last-write time (UTC) of the deployed `Jarvis.exe`. |
| `installer_name` | File name of the deployed NSIS installer, or `null` when none was bundled. |
| `installer_sha256` | SHA-256 of that installer, or `null` when none was bundled. |
| `deployed_at` | Timestamp the manifest was written. |

The git SHA is bound into the running system in two places, not just written to
the manifest:

- The Bun server bundle bakes it in via
  `bun build --define process.env.JARVIS_GIT_SHA=...`; the server reports it from
  `/health`.
- `src-tauri/build.rs` embeds it into the Rust binary
  (`cargo:rustc-env=JARVIS_GIT_SHA`).

That is what lets verification tell an on-disk build apart from the one actually
answering requests (the 2026-07 stale-bundle incident).

The bake itself is implemented once, in
`server-jarvis/src/build-frontend.ts`, and is called by both the deploy build
(`scripts/build-and-deploy.ps1`) and the Tauri release build (through
`beforeBuildCommand` in `src-tauri/tauri.conf.json`). The build identity reaches
it through the environment (`JARVIS_BUILD_GIT_SHA` and friends) and is folded
in with `bun build --define`.

The fold is *checked*, not assumed. `bun build` exits 0 even when a define
folds to a bare JS identifier, which yields a bundle that throws a
ReferenceError at module load; and a bundle that never folded reads the
environment at runtime and reports `git_sha: "dev"`. Both are caught by
`Test-JarvisBundleProvenance` in `scripts/lib/release-common.ps1`, which looks
for the commit and the source-tree digest in the built file and for the
absence of the runtime environment lookup.

## Installer provenance (NSIS)

`cargo build --release` does not produce an installer — only a prior
`cargo tauri build` writes one under
`src-tauri/target/release/bundle/nsis/`. When `build-and-deploy.ps1` finds that
bundle it copies it to the deploy directory as `Jarvis-installer.exe` and records
its SHA-256 as `installer_sha256`, so the installer is tied to the same
`git_sha` as the runtime it accompanies. When no installer exists, the
`installer_*` fields are `null`.

## How it is verified

`scripts/verify-deploy.ps1` re-reads the manifest and re-hashes the artifacts on
disk, failing (exit 1) on any mismatch:

- manifest `git_sha` / `git_dirty` / `source_tree_sha256` vs the current repo;
- `index.js`, proxy, metrics, and model-list hashes;
- `prompts/` presence;
- when a `/health` server is reachable, its reported `git_sha`, `git_dirty`,
  `source_tree_sha256`, and listener command line.

Installer verification is **additive and optional**:

- **Installer present and the manifest records `installer_sha256`** — the
  installer's SHA-256 must match, or verification fails.
- **Installer present but the manifest predates installer provenance** — a
  warning is printed and verification continues (the runtime checks still
  stand).
- **No installer present** — verification prints a skip message and continues.
  Existing behaviour is unchanged when no installer exists.

## Rebuilding / regenerating a manifest

Re-run `scripts/build-and-deploy.ps1` (add `-RestartServer` to relaunch the
deployed bundle), which regenerates the manifest from the current build. After
deploying, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-deploy.ps1
```
