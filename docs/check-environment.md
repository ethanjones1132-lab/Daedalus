# Check environment: staging build inputs

`scripts/verify.sh --only rust` runs `cargo check`, and Tauri's build script
needs two generated inputs (`frontendDist` and the bundled MCP stdio binary in
`src-tauri/tauri.conf.json`). Both are gitignored, so a **fresh worktree starts
without them** and the Rust check cannot run:

| Input | Produced by |
| --- | --- |
| `src-ui/dist/index.html` | `cd src-ui && npm run build` (`tsc -b && vite build`) |
| `server-jarvis/dist/mcp-stdio-server.js` | `cd server-jarvis && bun run build` |

Run this first in any new worktree:

```bash
bash scripts/stage-build-inputs.sh
```

It prints one line per input and copies each one from the repository's main
checkout, located through the git common dir (`git rev-parse --show-toplevel`
and `git rev-parse --git-common-dir`) — so it works in a linked worktree
without knowing where the main checkout lives.

Expected output on a fresh worktree:

```
staged src-ui/dist from <main checkout>/src-ui/dist
staged server-jarvis/dist from <main checkout>/server-jarvis/dist
```

A second run is a no-op that still exits 0:

```
already present src-ui/dist
already present server-jarvis/dist
```

Rules the script keeps:

- It only writes inside the worktree it is run from, and only into the two
  `dist` directories above.
- It never overwrites a tracked file (it refuses if git tracks anything under
  the target directory), never follows a symlinked target, and never deletes.
- It does not change `scripts/verify.sh`, the merge floor, CI, or any check
  command. It only makes their inputs present.

If an input is missing in the main checkout too, the script exits 1, names the
directory, and prints the build command above instead of guessing.

For the full Rust gate (`cargo test --lib`) on Windows, `scripts/verify-rust.ps1`
builds both inputs from source in the current checkout (no copy from another
worktree) and runs the tests in one command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-rust.ps1
```

See `release-pipeline.md` ("Checking the Rust crate in a fresh worktree").

## Checking the script itself

The script finds the repo through git, so run it from inside a checkout — a
throwaway copy must sit inside the worktree, not in a temp directory. Two runs
in a fresh worktree are the whole acceptance:

```bash
bash scripts/stage-build-inputs.sh   # staged src-ui/dist from <main checkout>/src-ui/dist
                                     # staged server-jarvis/dist from <main checkout>/server-jarvis/dist
bash scripts/stage-build-inputs.sh   # already present src-ui/dist
                                     # already present server-jarvis/dist
```

To watch the restore path without touching tracked files, make a copy inside
the worktree, delete one sentinel file there, and rerun the copy's script:

```bash
mkdir -p .tmp-accept/src-ui .tmp-accept/server-jarvis
cp -R scripts .tmp-accept/
cp -R src-ui/dist .tmp-accept/src-ui/dist
cp -R server-jarvis/dist .tmp-accept/server-jarvis/dist
rm .tmp-accept/src-ui/dist/index.html
bash .tmp-accept/scripts/stage-build-inputs.sh
# staged src-ui/dist from <main checkout>/src-ui/dist
# already present server-jarvis/dist
rm -rf .tmp-accept
```
