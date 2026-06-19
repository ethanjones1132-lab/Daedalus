---
name: home-base-writable-path
description: Which path to use to actually WRITE files in the home-base repo from this Windows/WSL setup
metadata:
  type: reference
---

The session's default cwd is `\\wsl.localhost\ubuntu\mnt\wslg\distro\home\ethan\.openclaw\agents\coderclaw\workspace\home-base`, but that `/mnt/wslg/distro` view is **read-only** (Write/Edit/touch fail with EROFS).

Read tools work there, but to WRITE/Edit use the real distro-root path: `\\wsl.localhost\ubuntu\home\ethan\.openclaw\agents\coderclaw\workspace\home-base\...` (same underlying files, writable). Verified they're the same files, not copies. The harness tracks file state per path string, so Read a file via the SAME `\\wsl.localhost\ubuntu\home\ethan\...` prefix before Edit-ing it.

Toolchains (bun, cargo 1.96) live in WSL: run cargo via `wsl.exe -- bash -lc "cd ~/.openclaw/agents/coderclaw/workspace/home-base/src-tauri && cargo test …"`. Server tests: `cd server-jarvis && bun test`. UI typecheck: `cd src-ui && bunx tsc -b`.
