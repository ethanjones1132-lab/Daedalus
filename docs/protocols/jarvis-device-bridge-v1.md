# Jarvis device bridge protocol v1

The bridge accepts newline-delimited JSON over its loopback TCP listener. A
request is rejected before chat invocation unless it has this shape:

```json
{
  "protocol_version": 1,
  "request_id": "req-uuid",
  "device_id": "paired-device",
  "issued_at": "2026-07-10T20:00:00.000Z",
  "payload": { "type": "chat", "session_id": "session-id", "message": "..." },
  "signature": "hex-hmac-sha256"
}
```

The signature is HMAC-SHA256 over the dot-joined values
`protocol_version.request_id.device_id.issued_at.JSON(payload)`, using the
paired `JARVIS_BRIDGE_SECRET`. Timestamps have a five-minute acceptance window;
request IDs are replay-protected for the same window. Responses are newline-
delimited JSON events. The upstream Jarvis SSE stream is never exposed as an
unauthenticated side channel.

To cancel an active request, send another signed envelope whose payload is
`{"type":"cancel","target_request_id":"..."}`. The bridge aborts the
upstream request and emits one `cancelled` event; unknown targets return
`bridge_request_not_found`.
