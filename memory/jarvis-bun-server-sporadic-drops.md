---
name: jarvis-bun-server-sporadic-drops
description: Why the Bun server died mid-session on 2026-08-05/06 — heavy /health, restart thrash, EADDRINUSE, Windows ghost sockets
metadata:
  type: project
---

# Bun server sporadic drops (2026-08-05/06)

## Symptoms

- Runtime interrupted mid-turn; many `Jarvis_API: Listening` lines in `server-jarvis.self.log`
- `server-jarvis.err.log`: `Failed to start server. Is port 19877 in use?` / `EADDRINUSE`
- Port 19877 shows LISTENING with a PID that **does not exist** in `tasklist` (Windows ghost socket)
- `/health` times out (>2s / >8s) while TCP connect succeeds
- Flood of `Ollama: Could not resolve Windows host IP, using fallback 172.17.0.1` every ~30s

## Root cause chain

1. **`GET /health` was not a liveness probe.** It awaited `resolveOllamaChatTarget` (up to 4×3s Ollama fetches) and `persistentConductor.describeHealth` (`isAvailable` + `isWarm(2500)`). That regularly exceeded the Rust 2s health budget.
2. **`ensure_jarvis_server_started` treated a missed probe as "server dead"** and killed + respawned the tracked child — mid-turn.
3. **Spawn only killed the tracked handle**, not port squatters. Orphans / half-killed processes left `:19877` held → every new spawn died with EADDRINUSE.
4. **Native Windows Bun rewrote localhost → 172.17.0.1** via the WSL host-IP path, hanging Ollama probes and spamming the log.
5. **Worst state: ghost socket** — netstat LISTENING with a dead PID; `taskkill` cannot free it. Only reboot (or winsock reset + reboot) releases the port.

## Fix (2026-08-06)

| Layer | Change |
|---|---|
| `server-jarvis/src/index.ts` | `/health` is liveness-only (no Ollama/conductor awaits). Deep data stays on `/health/inference` and `/health/conductor-*`. |
| `server-jarvis/src/ollama.ts` | `resolveWindowsHostIP("win32")` → `127.0.0.1` immediately |
| `src-tauri/src/lib.rs` | `reap_stale_bun_listeners()` before every Bun spawn (same pattern as proxy); retry health once if port is open; explicit ghost-socket diagnostic |

## Recovery when port is ghosted

```
netstat -ano | findstr :19877
tasklist /FI "PID eq <pid>"
# If "No tasks" but still LISTENING → reboot required
```

## Verified

- Light `/health` p50 ≈ 8ms, max ≈ 10ms on a fresh process (port 19897)
- `bun test src/ollama.test.ts` — win32 host-IP branch
- `cargo test --lib proxy_reap_tests` — reap + ghost diagnostic

Related: [[jarvis-bun-sqlite-cross-boundary-ioerr]], [[windows-hang-root-cause]].
