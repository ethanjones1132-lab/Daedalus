// ═══════════════════════════════════════════════════════════════
// ── Turn timing (post-answer path) ──
// ═══════════════════════════════════════════════════════════════
// Minimal, side-effect-free monotonic timing for the work that runs AFTER the
// answer has streamed and BEFORE the terminal SSE frame is written.
//
// Audit item 2 established that terminal emission waits for the post-pipeline
// finalization/learning tail, but not which operation took the observed time.
// These measurements are diagnostic only:
//
//   · They NEVER change ordering, run/learning semantics, or return values —
//     `measure`/`measureAsync` return the wrapped operation's own value and
//     rethrow its own error after reporting.
//   · They emit ONLY a fixed label, a bounded run id, and a bounded integer
//     duration. No prompt, response, credential, memory text, or other payload
//     can reach the line, and a failing sink can never fail the turn.
//   · A slow or absent clock cannot produce an unbounded or negative number.
//     When either sample is invalid (throws or is not finite) the observation
//     is OMITTED rather than defaulted to 0 — a defaulted sample would turn a
//     large monotonic reading into a large fabricated duration.
//
// Line format (one line per measurement, unambiguous labels):
//   [Jarvis Timing] run=<id> op=<label> ms=<duration>
const LINE_PREFIX = "[Jarvis Timing]";
const MAX_RUN_ID_LENGTH = 64;
const MAX_REPORTED_MS = 900_000;

/**
 * Fixed measurement vocabulary. Never extend with free-form text.
 *
 * `tail_before_terminal` = pipeline return → immediately before the
 * branch-specific terminal work (inference bookkeeping, `recordMemoryTerminal`
 * and the terminal send). It is NOT the last-token → terminal interval: the
 * answer streams during the synthesizer stage, inside the recorded run
 * duration, before this timing starts.
 */
export type TurnTimingLabel =
  | "run_finalize"
  | "optimize_and_apply"
  | "self_tuning_proposals"
  | "pre_terminal_frames"
  | "terminal_send"
  | "tail_before_terminal";

export interface TurnTimingClock {
  now(): number;
}

export interface TurnTimingOptions {
  clock?: TurnTimingClock;
  emit?: (line: string) => void;
}

export interface TurnTiming {
  /** Time one synchronous operation and return its result unchanged. */
  measure<T>(label: TurnTimingLabel, fn: () => T): T;
  /** Time one awaited operation and return its result unchanged. */
  measureAsync<T>(label: TurnTimingLabel, fn: () => Promise<T>): Promise<T>;
  /** Report the total time since this timing was created. */
  markTotal(label: TurnTimingLabel): void;
}

const defaultClock: TurnTimingClock = {
  now: () => (typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now()),
};

const defaultEmit = (line: string): void => {
  console.log(line);
};

/** Replace anything that is not a plain identifier character, then bound. */
function boundedRunId(runId: unknown): string {
  const raw = typeof runId === "string" ? runId : "";
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized.slice(0, MAX_RUN_ID_LENGTH) || "unknown";
}

function boundedMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_REPORTED_MS, Math.max(0, Math.round(value)));
}

export function createTurnTiming(runId: unknown, options: TurnTimingOptions = {}): TurnTiming {
  const clock = options.clock ?? defaultClock;
  const emit = options.emit ?? defaultEmit;
  const run = boundedRunId(runId);
  const startedAt = sampleNow(clock);

  function report(label: TurnTimingLabel, durationMs: number): void {
    try {
      emit(`${LINE_PREFIX} run=${run} op=${label} ms=${boundedMs(durationMs)}`);
    } catch {
      // Diagnostics must never fail the turn.
    }
  }

  return {
    measure<T>(label: TurnTimingLabel, fn: () => T): T {
      const before = sampleNow(clock);
      try {
        return fn();
      } finally {
        const after = sampleNow(clock);
        if (before !== null && after !== null) report(label, after - before);
      }
    },
    async measureAsync<T>(label: TurnTimingLabel, fn: () => Promise<T>): Promise<T> {
      const before = sampleNow(clock);
      try {
        return await fn();
      } finally {
        const after = sampleNow(clock);
        if (before !== null && after !== null) report(label, after - before);
      }
    },
    markTotal(label: TurnTimingLabel): void {
      const endedAt = sampleNow(clock);
      if (startedAt === null || endedAt === null) return;
      report(label, endedAt - startedAt);
    },
  };
}

/**
 * One monotonic sample, or `null` when the clock threw or returned something
 * that is not finite. A `null` sample means "no usable observation" — callers
 * must omit the measurement, never substitute a zero baseline.
 */
function sampleNow(clock: TurnTimingClock): number | null {
  try {
    const value = clock.now();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
