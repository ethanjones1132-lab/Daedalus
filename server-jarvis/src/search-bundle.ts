// ═══════════════════════════════════════════════════════════════
// ── Search Bundle ──
// ═══════════════════════════════════════════════════════════════
// The read-only search triad (read_file/glob/grep) now shares the canonical
// filesystem handlers. This module re-exports registerSearchBundle so existing
// callers (cron-runtime, mcp-adapter, and the chat surface) keep importing the
// search triad from one place, with a single implementation behind it.

export { registerSearchBundle } from "./filesystem-bundle";
