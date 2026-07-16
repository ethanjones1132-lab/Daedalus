// 2026-07-13 live-session finding: a real user sent an identical
// "create the plan" message 3 times, 2-4 minutes apart, while the previous
// turn for that session was still running (session 7254c3ae). Each resend
// silently aborted the prior in-flight turn via ActiveStreamRegistry.begin()
// — real provider calls and file reads were discarded with no user-visible
// signal and no distinguishable telemetry: the `cancelled` frame carried no
// reason, so the UI/Rust relay both hardcoded `cancelledReason: "user_stop"`
// regardless of cause. A superseded turn (impatient duplicate send racing
// live work) and a deliberate Stop-button click are operationally very
// different signals; only one of the 3 sends here ever produced an answer,
// meaning ~2 full turns' worth of compute and wall-clock time were wasted
// invisibly. classifyAbortReason() makes the two cases distinguishable.
export const SUPERSEDED_ABORT_REASON = "Superseded by a newer Session turn";
export const USER_STOP_ABORT_REASON = "User cancelled";
export const CLIENT_DISCONNECTED_ABORT_REASON = "Client disconnected";

export type CancelReason = "superseded" | "user_stop" | "client_disconnected" | "unknown";

/** Classify an AbortSignal.reason into a stable, telemetry-friendly category. */
export function classifyAbortReason(reason: unknown): CancelReason {
  if (reason === SUPERSEDED_ABORT_REASON) return "superseded";
  if (reason === CLIENT_DISCONNECTED_ABORT_REASON) return "client_disconnected";
  if (reason === USER_STOP_ABORT_REASON) return "user_stop";
  return "unknown";
}

export interface StreamLease {
  readonly controller: AbortController;
  release(): boolean;
}

interface StreamEntry {
  readonly controller: AbortController;
  readonly generation: symbol;
}

/**
 * Owns the one turn-wide user-cancellation domain for each Session.
 *
 * A lease may only remove its own generation. This prevents an older stream's
 * `finally` block from deleting a replacement stream that started with the
 * same Session id.
 */
export class ActiveStreamRegistry {
  private readonly entries = new Map<string, StreamEntry>();

  get size(): number {
    return this.entries.size;
  }

  begin(sessionId: string): StreamLease {
    const previous = this.entries.get(sessionId);
    if (previous && !previous.controller.signal.aborted) {
      previous.controller.abort(SUPERSEDED_ABORT_REASON);
    }

    const entry: StreamEntry = {
      controller: new AbortController(),
      generation: Symbol(sessionId),
    };
    this.entries.set(sessionId, entry);

    return {
      controller: entry.controller,
      release: () => {
        const current = this.entries.get(sessionId);
        if (current?.generation !== entry.generation) return false;
        this.entries.delete(sessionId);
        return true;
      },
    };
  }

  cancel(sessionId: string, reason: unknown = USER_STOP_ABORT_REASON): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.controller.signal.aborted) return false;
    entry.controller.abort(reason);
    return true;
  }
}

/** Register one abort callback and return an idempotent cleanup function. */
export function registerAbortHandler(signal: AbortSignal, handler: () => void): () => void {
  let active = true;
  const wrapped = () => {
    if (!active) return;
    active = false;
    handler();
  };

  if (signal.aborted) {
    wrapped();
  } else {
    signal.addEventListener("abort", wrapped, { once: true });
  }

  return () => {
    if (!active) return;
    active = false;
    signal.removeEventListener("abort", wrapped);
  };
}

interface CancellableReader {
  cancel(reason?: unknown): Promise<void>;
}

/** Collapse timeout, disconnect, and user-abort races into one reader cancel. */
export function createIdempotentReaderCancel(reader: CancellableReader): (reason?: unknown) => Promise<void> {
  let cancellation: Promise<void> | null = null;
  return (reason?: unknown) => {
    cancellation ??= Promise.resolve().then(() => reader.cancel(reason));
    return cancellation;
  };
}

/** Final-answer grace is earned only by visible user-facing prose. */
export function shouldArmFinalGrace(options: {
  isFinalAnswerStream: boolean;
  visibleChars: number;
}): boolean {
  return options.isFinalAnswerStream && options.visibleChars > 0;
}

export type ReadStopReason =
  | "first_token_timeout"
  | "stream_idle_timeout"
  | "turn_cancelled"
  | "turn_deadline_exceeded"
  | "stage_deadline_exceeded"
  | "visible_progress_timeout"
  | "degenerate_stream";

export interface StreamTerminalEvent {
  readonly type?: string;
  readonly [key: string]: unknown;
}

/**
 * Return the first user-visible terminal outcome from a stream event list.
 * Transport markers such as `message_stop` are deliberately ignored, and
 * late outcomes are dropped so callers cannot report two completions.
 */
export function collectTerminalEvents<T extends StreamTerminalEvent>(events: T[]): T[] {
  const terminal = events.find((event) =>
    event.type === "result" || event.type === "error" || event.type === "cancelled",
  );
  return terminal ? [terminal] : [];
}

/** Resolve concurrent reader-stop signals once, with model timeout precedence. */
export function resolveReadStopReason(options: {
  firstTokenTimedOut: boolean;
  streamIdleTimedOut: boolean;
  visibleProgressTimedOut?: boolean;
  turnDeadlineExceeded?: boolean;
  /** T1.1: per-stage stream deadline (elapsed-accounting budget). */
  stageDeadlineExceeded?: boolean;
  /** Set by the periodic tail-repetition check (stream-degeneration.ts). */
  degenerateStreamDetected?: boolean;
  signal: AbortSignal;
}): ReadStopReason | null {
  if (options.firstTokenTimedOut) return "first_token_timeout";
  if (options.streamIdleTimedOut) return "stream_idle_timeout";
  if (options.degenerateStreamDetected) return "degenerate_stream";
  if (options.signal.aborted) return "turn_cancelled";
  // Stage deadline precedes turn deadline: a coordinator that burns its 15s
  // must fail as stage_deadline even if the turn still has room.
  if (options.stageDeadlineExceeded) return "stage_deadline_exceeded";
  if (options.turnDeadlineExceeded) return "turn_deadline_exceeded";
  if (options.visibleProgressTimedOut) return "visible_progress_timeout";
  return null;
}
