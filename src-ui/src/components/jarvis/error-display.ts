import type { StatusVariant } from '../ui';

/**
 * Per-code metadata for the assistant-bubble error display.
 *
 * The server emits a small, stable set of structured `error` codes on
 * terminal SSE frames (e.g. `turn_deadline_exceeded`, `first_token_timeout`).
 * Each one is a different failure mode with a different user-facing meaning
 * and a different next-step hint. Rendering them all as a single red
 * `<Pill>error</Pill>` loses the actionable signal — a turn deadline is a
 * soft "your request was long, try again" event, not a hard model failure.
 *
 * This helper is the single source of truth for that mapping; the bubble
 * consumes it via the `errorCode` field on the `JarvisMessage`. Unknown
 * codes degrade to a generic red error label with no hint (a misleading
 * hint is worse than no hint when we don't know what happened).
 */
export interface ErrorDisplay {
  /** Short human-readable label for the pill next to the bubble. */
  label: string;
  /** Pill color tone — `warn` is amber (soft), `error` is red (hard). */
  pillVariant: StatusVariant;
  /** Optional actionable hint rendered below the message text. */
  hint?: string;
}

const DISPLAY_BY_CODE: Record<string, ErrorDisplay> = {
  // P0a (2026-07-05): server-authoritative absolute turn deadline.
  // Soft failure — the model was producing, it just took too long.
  turn_deadline_exceeded: {
    label: 'turn deadline',
    pillVariant: 'warn',
    hint: 'This request exceeded the per-turn budget. You can retry, or raise JARVIS_TOTAL_TURN_TIMEOUT_MS in Settings if this is a recurring pattern.',
  },
  // P0-B (2026-07-02): model hung before any token arrived.
  // Hard failure — model is loading, overloaded, or backend unreachable.
  first_token_timeout: {
    label: 'first-token timeout',
    pillVariant: 'error',
    hint: 'The model never produced a first token. Try again, or switch backend in Settings — the model may be loading or unreachable.',
  },
  // P0-B follow-up: model produced some tokens then stopped.
  // Hard failure — stream went silent mid-response.
  stream_idle_timeout: {
    label: 'stream stalled',
    pillVariant: 'error',
    hint: 'The stream went silent mid-response. Try again, or switch backend in Settings.',
  },
  // P0a (2026-07-05): hidden reasoning continued but no visible progress.
  // Soft failure — model is stuck thinking, not a hard hang.
  visible_progress_timeout: {
    label: 'no visible progress',
    pillVariant: 'warn',
    hint: 'The model kept producing hidden reasoning but never surfaced an answer. Try again — the router can pick a different model.',
  },
};

const FALLBACK: ErrorDisplay = {
  label: 'error',
  pillVariant: 'error',
};

export function errorDisplayForCode(code: string | undefined): ErrorDisplay {
  if (!code) return FALLBACK;
  return DISPLAY_BY_CODE[code] ?? FALLBACK;
}
