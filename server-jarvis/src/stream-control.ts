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
      previous.controller.abort("Superseded by a newer Session turn");
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

  cancel(sessionId: string, reason: unknown = "User cancelled"): boolean {
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

export type ReadStopReason =
  | "first_token_timeout"
  | "stream_idle_timeout"
  | "turn_cancelled"
  | "turn_deadline_exceeded"
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
  /** Set by the periodic tail-repetition check (stream-degeneration.ts). */
  degenerateStreamDetected?: boolean;
  signal: AbortSignal;
}): ReadStopReason | null {
  if (options.firstTokenTimedOut) return "first_token_timeout";
  if (options.streamIdleTimedOut) return "stream_idle_timeout";
  if (options.degenerateStreamDetected) return "degenerate_stream";
  if (options.signal.aborted) return "turn_cancelled";
  if (options.turnDeadlineExceeded) return "turn_deadline_exceeded";
  if (options.visibleProgressTimedOut) return "visible_progress_timeout";
  return null;
}
