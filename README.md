# Jarvis (home-base)

A standalone **Tauri desktop platform** — its own native Rust surface, Bun server, React UI,
memory system, cron, and agent lifecycle — with local-first inference and no runtime
dependency on any external agent framework.

This tree is the **recovered source of truth** rebuilt after a WSL disk loss
(2026-06). Build state is **partial** — see [`RECOVERY_STATUS.md`](RECOVERY_STATUS.md)
for the verified, per-subsystem status before relying on anything here.

## Architecture

| Layer | Path | Role |
|-------|------|------|
| Rust / Tauri backend | `src-tauri/` | Native command surface (SQLite-backed: sessions, memory, cron, agents, channels, models, system), process management, WSL host-IP resolution |
| Bun server | `server-jarvis/` | `JARVIS_API` HTTP surface + the canonical **Tool runtime** (filesystem/shell/web/meta/task/mcp bundles), SSE streaming |
| React UI | `src-ui/` | Vite + TypeScript; talks to Rust via Tauri IPC and to the Bun server over SSE |
| `claude_cli_proxy` | `scripts/claude_cli_proxy.py` | Anthropic-compatible `/v1/messages` shim (port 19878) fanning out to the active inference backend |
| action-registry | `workspace/action-registry/` | Python workspace for cross-surface action items |

**Inference backends** (selected per session): Ollama (local, default), OpenRouter (cloud),
or Claude Code CLI (local) — all reached through `claude_cli_proxy`.

## Read first (for humans and agents)

- [`CONTEXT.md`](CONTEXT.md) — canonical terminology and architecture vocabulary. Use these terms.
- [`AGENTS.md`](AGENTS.md) — working rules for autonomous agents in this repo.
- [`RECOVERY_STATUS.md`](RECOVERY_STATUS.md) — **verified** build state and the prioritized restoration backlog.
- [`HANDOFF.md`](HANDOFF.md) — deeper architecture / component reference.

## Verify

```bash
bash scripts/verify.sh          # all subsystems (see RECOVERY_STATUS.md — bun test currently hangs)
cargo check --manifest-path src-tauri/Cargo.toml
bunx tsc -b src-ui
```

## Status at a glance (2026-06-18)

- ✅ Python (`claude_cli_proxy` + `workspace/action-registry`) — compiles clean.
- ✗ Rust, Bun server, and UI — partially recovered; do not yet build/typecheck. See `RECOVERY_STATUS.md`.

A daily restoration routine (`jarvis-restoration-engine`) advances this backlog one
verified increment at a time.
