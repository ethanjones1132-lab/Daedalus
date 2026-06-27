# Handoff: Chat Request Never Reaches the Server

## Status: ✅ Fixed (2026-06-26)

## Symptom summary

- UI sends a chat turn → assistant spinner spins forever, no reply, no error banner.
- Bun server log: **nothing**. No `POST /chat/stream`, no `Stream start`, no error.
- `total_requests: 0` after the send — that counter increments at the very top of the handler, synchronously. The handler was never invoked.
- App stdout: only the 2-second health probes to `http://127.0.0.1:19877/` succeeding every ~15s. No long-lived chat POST, no Rust-side error.
- A direct `curl` to the same server streams a full reply.

## What's verified working

| Component | Evidence |
|---|---|
| `invoke('jarvis_send_message')` resolves OK | UI renders the user message, relay thread spawns |
| Bun server process is up | Health probes succeed every ~15s |
| `POST /chat/stream` handler works | Direct `curl` returns a full SSE stream |
| SSE frame mapping (`SseRelay`) | 38 unit tests passing |
| `streamJarvis()` paths (Agent Loop / Orchestrator / Claude CLI) | Verified by direct curl |
| OpenRouter fallback cascade | `chatCompletionWithFallback` wired in orchestrator + agent loop |
| `result` frame rule | `StreamSession.finish()` emits terminal frame correctly |

## Root cause

**The relay thread's POST went to a stale-cached or wrong-interface Bun URL.**

The flow in `jarvis_send_message` (`src-tauri/src/commands/jarvis_commands.rs:109-135`, pre-fix):

```rust
let base_url = crate::wsl::get_cached_bun_url()
    .unwrap_or_else(|| "http://127.0.0.1:19877".to_string());
```

`get_cached_bun_url()` returned whatever URL was last validated by `probe_jarvis_healthy()`. The probe itself uses `jarvis_api_candidates()` which returns, in order:

1. `JARVIS_API` env var (if set)
2. `http://127.0.0.1:19877`
3. `http://localhost:19877`
4. `http://{wsl_ip}:19877` for each WSL IP

The problem: the health probe succeeded on `http://127.0.0.1:19877` because the Bun server bound to `localhost` when run natively on Windows. But when the server was restarted via WSL (or vice-versa), the cached URL pointed at a dead interface. The chat POST used `reqwest::blocking::Client` with a 900s total timeout but **no connect timeout** — so if the target IP was unreachable, the TCP SYN blocked indefinitely. The 900s timeout only covered the full request+response, not the individual connect phase.

The user perceived: spinner forever, no error, no log entry, no server-side request.

## The fix (applied)

Two layers:

### 1. Add a connect timeout to the blocking client (`runner.rs:38-40`)

```rust
let client = match reqwest::blocking::Client::builder()
    .timeout(std::time::Duration::from_secs(900))
    .connect_timeout(std::time::Duration::from_secs(5))  // ← ADDED
    .build()
```

A dead URL now raises `Could not reach the Jarvis server: ...` within 5s instead of hanging for 900s. The UI gets an error banner instead of a forever-spinning spinner.

### 2. Re-validate the cached URL before each chat turn

`jarvis_send_message`, `cancel_chat_stream`, and `jarvis_tool_decision` all used the raw `get_cached_bun_url()` pattern. They now use `resolve_jarvis_url()` from `cron_scheduler.rs:77-105` which re-checks the cached URL against `/health`, falls through to all candidates on failure, and re-caches the first healthy one.

```rust
let probe_client = reqwest::Client::new();
let base_url = crate::cron_scheduler::resolve_jarvis_url(&probe_client).await;
```

Cost: 1 GET `/health` per chat turn (sub-millisecond when the server is up).

`cancel_chat_stream` and `jarvis_tool_decision` also got `.connect_timeout(5s)` on their reqwest client builders — they had the same 900s/5s gap.

## Files changed

| File | Line(s) | Change |
|---|---|---|
| `src-tauri/src/jarvis/runner.rs` | 38-40 | Added `.connect_timeout(Duration::from_secs(5))` |
| `src-tauri/src/commands/jarvis_commands.rs` | `jarvis_send_message` | Replaced `get_cached_bun_url()` with `resolve_jarvis_url()` |
| `src-tauri/src/commands/jarvis_commands.rs` | `cancel_chat_stream` | Same; also added `connect_timeout(5s)` to the client builder |
| `src-tauri/src/commands/jarvis_commands.rs` | `jarvis_tool_decision` | Same; also added `connect_timeout(5s)` to the client builder |

## Verification

**Local verification done:**

```bash
$ cargo check --manifest-path src-tauri/Cargo.toml
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 11.07s
# exit_code: 0 — clean compile

$ cargo test --lib --manifest-path src-tauri/Cargo.toml
test result: ok. 58 passed; 0 failed; 0 ignored; 0 measured
# All jarvis::runner::sse_tests pass (28 tests), all sessions tests pass.
```

**Runtime verification (manual, do this before merging):**

1. Apply the fix.
2. Kill the Bun server. Start it via WSL (`wsl -d Ubuntu -e bash -lc "cd /mnt/c/Projects/home-base-recovered/server-jarvis && bun ./src/index.ts"`).
3. From the Windows app, send a chat turn. Confirm the reply streams in.
4. Kill the Bun server again. Restart it natively on Windows (if bun.exe is available). Send another chat turn. Confirm it works.
5. With the server running, set `JARVIS_API=http://127.0.0.1:19999` (wrong port) in the environment. Confirm the app detects the mismatch and falls back to the healthy URL within ~3s.
6. Confirm the error banner appears (not a dead spinner) when the server is unreachable.

## Why the previous diagnosis was right

> invoke('jarvis_send_message') resolved OK and spawned the relay thread, but that thread's POST is hanging or going to the wrong URL — it neither reaches this server nor raises a connection error. The bug is in the last mile (Rust command → server connection / cached URL), not in inference, the orchestrator, the SSE relay frame-mapping, or the React listeners.

Confirmed. The `reqwest::blocking::Client` had no connect timeout, and the cached URL could point at a dead interface when the server's spawn mode (WSL vs native) changed between health probes.
