export interface TimeoutScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface IntervalScheduler {
  setInterval(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimeoutScheduler: TimeoutScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const defaultIntervalScheduler: IntervalScheduler = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function createDisconnectAwareWrite(
  write: (chunk: Uint8Array) => Promise<void>,
  onDisconnect: () => void,
): (chunk: Uint8Array) => Promise<void> {
  return async (chunk) => {
    try {
      await write(chunk);
    } catch (error) {
      onDisconnect();
      throw error;
    }
  };
}

/** One-shot deadline that is re-armed only by semantic stream progress. */
export class ResettableWatchdog {
  private handle: unknown = null;
  private active = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: () => void,
    private readonly scheduler: TimeoutScheduler = defaultTimeoutScheduler,
  ) {}

  start(): void {
    this.active = true;
    this.schedule();
  }

  touch(): void {
    if (!this.active) return;
    this.schedule();
  }

  stop(): void {
    this.active = false;
    if (this.handle !== null) {
      this.scheduler.clearTimeout(this.handle);
      this.handle = null;
    }
  }

  private schedule(): void {
    if (this.handle !== null) this.scheduler.clearTimeout(this.handle);
    this.handle = this.scheduler.setTimeout(() => {
      this.handle = null;
      if (!this.active) return;
      this.active = false;
      this.onTimeout();
    }, this.timeoutMs);
  }
}

export class StreamIdleTimeoutError extends Error {
  constructor(
    readonly model: string,
    readonly stage: string,
    readonly windowMs: number,
    readonly provider = "unknown",
  ) {
    super(`Inter-token timeout (${windowMs}ms) on model=${model} stage=${stage}`);
    this.name = "StreamIdleTimeoutError";
  }
}

export class VisibleProgressTimeoutError extends Error {
  constructor(
    readonly model: string,
    readonly stage: string,
    readonly windowMs: number,
    readonly provider = "unknown",
  ) {
    super(`No visible output or tool-call progress for ${windowMs}ms on model=${model} stage=${stage} (hidden reasoning does not count)`);
    this.name = "VisibleProgressTimeoutError";
  }
}

export class TurnDeadlineExceededError extends Error {
  constructor(readonly stage: string, readonly budgetMs: number) {
    super(`Total turn deadline (${budgetMs}ms) exceeded at stage=${stage}`);
    this.name = "TurnDeadlineExceededError";
  }
}

/** T1.1: per-stage stream budget exhausted (does not reset on cascade retry). */
export class StageDeadlineExceededError extends Error {
  constructor(readonly stage: string, readonly stageBudgetMs: number) {
    super(`Stage deadline exceeded (${stageBudgetMs}ms) on stage=${stage}`);
    this.name = "StageDeadlineExceededError";
  }
}

/** Two-tier stream liveness: transport (any delta) + visible (answer text / tool deltas). */
export function createStreamLivenessTracker(opts: {
  interTokenMs: number;
  visibleMs: number;
  onTransportStall: () => void;
  onVisibleStall: () => void;
  scheduler?: TimeoutScheduler;
}) {
  const transport = new ResettableWatchdog(
    opts.interTokenMs,
    opts.onTransportStall,
    opts.scheduler,
  );
  const visible = new ResettableWatchdog(
    opts.visibleMs,
    opts.onVisibleStall,
    opts.scheduler,
  );
  let started = false;
  const onTransportProgress = () => {
    if (!started) {
      started = true;
      transport.start();
      visible.start();
      return;
    }
    transport.touch();
  };
  return {
    onTransportProgress,
    onVisibleProgress() {
      onTransportProgress();
      visible.touch();
    },
    get started() {
      return started;
    },
    stop() {
      transport.stop();
      visible.stop();
    },
  };
}

export function startSseHeartbeat(
  sessionId: string,
  intervalMs: number,
  write: (frame: string) => Promise<boolean>,
  scheduler: IntervalScheduler = defaultIntervalScheduler,
): () => void {
  let active = true;
  let handle: unknown = null;
  const stop = () => {
    if (!active) return;
    active = false;
    if (handle !== null) scheduler.clearInterval(handle);
    handle = null;
  };
  handle = scheduler.setInterval(async () => {
    if (!active) return;
    const alive = await write(`data: ${JSON.stringify({ type: "heartbeat", session_id: sessionId })}\n\n`);
    if (!alive) stop();
  }, intervalMs);
  return stop;
}
