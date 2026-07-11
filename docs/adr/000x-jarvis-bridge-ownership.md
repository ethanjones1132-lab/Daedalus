# ADR: Jarvis device bridge ownership

## Decision

The Bun server owns the remote device bridge transport and its authenticated
streaming protocol. Tauri owns local lifecycle controls (`start`, `stop`,
`restart`, and `health`) but does not maintain a second remote request protocol.

The bridge remains loopback-bound until pairing provisions `JARVIS_BRIDGE_SECRET`.
Every remote request must use the v1 signed envelope and a unique request ID.

## Consequences

- Bun is the only transport implementation to extend for remote Android/device
  communication.
- Rust lifecycle commands can restart or inspect the listener without accepting
  unauthenticated chat payloads.
- Pairing, secret storage, replay persistence, and encrypted non-loopback
  exposure remain prerequisites for opening the listener beyond localhost.
