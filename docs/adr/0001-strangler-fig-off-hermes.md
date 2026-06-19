# Strangler-fig migration off Hermes runtime

**Status:** COMPLETED (May 18, 2026)

The three-layer strangler-fig migration is complete:

1. **Inference backends** — Ollama + `claude_cli_proxy` auto-spawned at boot. Done.
2. **Native surface** — SQLite-backed `commands/*` are the sole canonical path. All duplicate `jarvis_*` commands removed. Done.
3. **Chat surface** — `ChatPanel` component uses `jarvis_send_message` → Bun server → inference backend. No Hermes in the loop. Done.

Hermes deletion is complete — the entire `src-tauri/src/jarvis/hermes/` module, all `hermes_*` Tauri commands, Hermes test files, `hermes_protocol.yaml`, and the `thiserror` dependency have been removed. The `HermesChat.tsx`, `HermesApprovalModal.tsx`, and `hermes.ts` frontend files have been deleted.

The Bun server stays as the HTTP surface for chat streaming. The `claude_cli_proxy` (port 19878) is the single fan-out to all three inference backends.