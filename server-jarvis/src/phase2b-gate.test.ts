// ═══════════════════════════════════════════════════════════════
// ── P2B-02: Phase 2B Done-Gate Test Harness ──
// ═══════════════════════════════════════════════════════════════
//
// This file is the authoritative gate suite for Phase 2B completion.
// It MUST remain green before any Phase 3 / Tier-A work begins.
//
// Three gates — each must pass independently:
//
//   FUNCTIONAL GATE
//     Cron runs bind a projection snapshot from inline request data.
//     Tool calls route through canonical ToolRuntime — not legacy path.
//     Multiple concurrent cron contexts maintain snapshot isolation.
//     Search bundle executes end-to-end through cron runtime.
//
//   SAFETY GATE
//     Cron surface is always non-interactive.
//     Approval-required and dangerous tools are denied for cron runs.
//     Safe tools are allowed.
//     Policy denial outcome is identical to equivalent agent surface.
//
//   STABILITY GATE
//     CronRunResult captures structured tool dispatch history.
//     classifyFailure classifies transient vs permanent vs timeout correctly.
//     canRetry enforces retriable-class + count < max_retries.
//     Tool dispatch history is preserved