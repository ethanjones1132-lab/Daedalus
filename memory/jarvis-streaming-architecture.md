---
name: jarvis-streaming-architecture
description: How Jarvis chat streaming works end-to-end and the invariants that prevent decode errors + chat-leak bugs
metadata:
  type: project
---

Chat flow: React UI → Rust `jarvis_send_message` (src-tauri/src/commands/jarvis_commands.rs, spawns a tokio task) → POSTs Bun `/chat/stream` (server-jarvis/src/index.ts `streamJarvis`) → model SSE. Rust parses the custom SSE envelope (`type`: init/stream_event/message_stop/error/result/reasoning_step/reasoning_chunk/tool_call/tool_result/cancelled) and re-emits Tauri events `jarvis://token|reasoning_chunk|reasoning_step|tool_call|tool_result|done|error`. A separate `hermes` JSON-RPC/stdio path exists but chat still uses HTTP.

On 2026-06-14 I consolidated 4 divergent streaming code paths in index.ts into **server-jarvis/src/stream-emitter.ts** (`StreamSession` + `VisibleTextPipe`). Maintain these invariants:
- **Every stream emits exactly one terminal `message_stop`** — `StreamSession.ensureTerminal()` runs in `streamJarvis`'s `finally`. Without this, reqwest yields "error decoding response body" and the Rust client surfaced it as a scary error. Don't add a path that finishes without going through `session.finish()`/`ensureTerminal()`.
- **Reasoning is ALWAYS stripped from visible text**, regardless of `cfg.reasoning.enabled`; the toggle only controls whether reasoning_step/chunk/complete events are forwarded. `VisibleTextPipe` owns this + `<tool_call>` sanitisation. Don't emit raw model `content` straight to `stream_event`.
- Rust `stream_read_error_is_fatal(received_message_stop, has_partial_text)`: a broken transport tail is graceful once any visible text streamed (not only after message_stop). See [[windows-hang-root-cause]].

Recurring gotcha that bit the UI twice (ChatPanel + PrizePicksPanel): see [[jarvis-tauri-listen-race]].

Build note: `server-jarvis/dist/index.js` is a committed artifact the launcher prefers in packaged builds — run `bun run build` after editing src. tauri.conf.json `resources` must be `../server-jarvis/dist/index.js` (one `..`, relative to src-tauri).
