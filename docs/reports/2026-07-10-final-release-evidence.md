# Jarvis final release evidence

Date: 2026-07-10

## Implemented

- Bun owns the authenticated device bridge. v1 HMAC envelopes, five-minute expiry, replay protection, signed cancellation envelopes, and cancellation abort propagation are implemented and tested.
- Discord delivery retries transient failures, persists SQLite receipts, exposes loopback send/receipt endpoints, and renders the latest receipt in Channels. The token is sourced from `JARVIS_DISCORD_BOT_TOKEN` and never enters React state or receipt rows.
- System Health displays server version, SHA, model, model-resolution state, build timestamp, conductor metrics, and terminal-stage state. Legacy non-shipped route IDs fall back to Overview rather than exposing placeholders.
- Release verification now supports `verify-deploy.ps1 -ExpectSha` and smoke fixtures for manifest/health/listener provenance, native session authority, conductor-health shape, and exactly one terminal SSE outcome.

## Verification

- Server: 744 passed, 0 failed.
- Rust: 82 passed, 0 failed.
- UI: 67 passed, 0 failed.
- UI production build: passed.
- Packaged listener: PID 66016, Desktop `index.js` provenance matched manifest and `/health` SHA `0ca584bb611fbb77e16d45c83bedf74c1d160846`.
- Release smoke: terminal outcome present; session authority fixture passed with HTTP 410; conductor-health fixture passed.
- Discord endpoint smoke: receipts endpoint returned an empty receipt set; send endpoint correctly returned `discord_secret_unavailable` (503) without attempting an unauthenticated delivery.

## External-state gates

The live model smoke currently returns provider authentication failure (HTTP 401). Discord delivery and paired-device tests require operator-provisioned credentials. These are intentionally reported as external gates rather than bypassed with fake success.
