---
name: jarvis-build-toolchain
description: "how to build/test each part of home-base across the Windows-git-bash + WSL split (server bun, vite UI, cargo)"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 5707253a-5812-44f3-887d-e77bce44ec76
---

The Bash tool runs as **Windows git-bash over a UNC mount**; the repo also has a native WSL view. Build/verify each part where its toolchain works:

- **server-jarvis (bun tests + `bun build`)** — works from Windows git-bash at the writable view (`//wsl.localhost/ubuntu/home/ethan/.openclaw/agents/coderclaw/workspace/home-base/server-jarvis`). `bun test` and `bun build ./src/index.ts --outdir ./dist --target bun` both fine.
- **src-ui typecheck** — `bun node_modules/typescript/bin/tsc -b` works from Windows. Do NOT use `npx`/`npm` — cmd.exe rejects the UNC cwd ("UNC paths are not supported").
- **src-ui `vite build`** — FAILS from Windows bun (the repo's `node_modules` is Linux-populated; rollup/esbuild native binary resolution breaks). **Build it inside WSL instead:** `wsl.exe -d ubuntu -- bash -lc "cd /home/ethan/.openclaw/agents/coderclaw/workspace/home-base/src-ui && bun node_modules/vite/bin/vite.js build"`. WSL has bun + node 22.
- **src-tauri** — `cargo check` works from Windows git-bash but is slow (~1.5–2 min); run it `run_in_background`.
- **`bun add`** — over the UNC mount it errors `EINVAL: Failed to replace old lockfile` but STILL downloads+extracts the package. Workaround: run it (ignore the lockfile error), then declare the dep manually in `package.json`. `node_modules` is gitignored so deps restore via `bun install` on a real checkout.

See [[home-base-writable-path]] for the read-only `/mnt/wslg/distro` vs writable `/home/ethan` distinction.