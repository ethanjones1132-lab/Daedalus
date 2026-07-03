# Jarvis SSE stream contract

The Bun server `/chat/stream` route is a versionless, additive SSE protocol used by the Jarvis React UI and native relays.

## Completion invariants

For every connected Session turn, the server emits exactly one user-visible outcome:

- `result` — success or an error-bearing result (`is_error: true`)
- `error` — a failed turn that has no usable result
- `cancelled` — an explicit user/client cancellation only

`message_stop` is a transport terminator, not a user-visible outcome. It is emitted at most once and may arrive before `result` on compatibility paths such as Claude CLI. A `cancelled` outcome replaces a trailing `message_stop` because the client has already aborted the stream.

If a connected server path exits without an outcome, `StreamSession.ensureTerminal()` emits `error` with code `stream_ended_without_outcome`, followed by `message_stop` if one has not already been sent. Client disconnects are exempt because the stream can no longer be written.

## Progress frames

Known non-outcome frames include `init`, `stream_event`, `agent_activity`, `orchestrator_stage`, `orchestrator_recursion`, `reasoning_step`, `reasoning_chunk`, `reasoning_complete`, `tool_use`, `tool_result`, `cost_info`, `fallback_notice`, `agent_run_id`, and `message_stop`.

The UI explicitly treats `init`, `agent_run_id`, `message_stop`, and `heartbeat` as passive. `fallback_notice` updates transient pipeline status. Unknown frame types are logged once per type per stream so contract drift is visible without flooding the console.

## Liveness

- The server emits `heartbeat` frames every 15 seconds while a Session turn is open. Set `JARVIS_SSE_HEARTBEAT_ENABLED=0` to disable them or `JARVIS_SSE_HEARTBEAT_INTERVAL_MS` to change the interval (clamped to 5–60 seconds).
- The UI treats `heartbeat` as passive protocol activity and resets a 90-second inactivity deadline on every valid frame. Expiry aborts and cancels the reader, then uses the normal error path to clear streaming state and remove an empty assistant bubble.
- First-token and inter-token deadlines are separate. The first semantic content or tool-call delta starts a 60-second inter-token watchdog; only later semantic progress resets it, so meaningless byte trickles cannot keep a stalled model alive.
- A failed client write marks the client disconnected and aborts the upstream request signal. It does not emit `cancelled`, which remains reserved for explicit user cancellation.

## Cancellation ownership

- Each active Session turn owns a generation lease in the Bun server. An older turn's cleanup cannot delete a newer turn registered with the same Session id.
- `/chat/cancel` aborts the current lease but does not delete it. The owning turn removes its lease in `finally`, and repeated cancel requests do not repeat abort or log side effects.
- The turn-wide abort signal is reserved for user Stop, client disconnect, and supersession. Request and stream timeouts remain stage-local.
- Once a response reader exists, user abort, first-token timeout, and inter-token timeout share one idempotent reader-cancel function.

## Tool-result context metadata

Native tool results remain complete in the `tool_result.output` field shown by the UI. If the copy sent back into inference history is shortened to protect the context window, the frame also includes:

```json
{
  "context_truncation": {
    "truncated": true,
    "original_chars": 3000,
    "retained_chars": 1880,
    "removed_chars": 1120,
    "limit_chars": 2000
  }
}
```

The tool card labels this condition as `context trimmed`; the displayed result is still the complete tool output.

## Compatibility rules

- New fields on existing frame types are additive.
- New frame types require an explicit UI handler or passive classification.
- Malformed `data:` JSON is a protocol error: the UI aborts the turn, clears streaming state through its existing error path, and surfaces an actionable error instead of hanging.
- Outcome frames are mutually exclusive. Late outcome attempts are ignored by `StreamSession`.
