export type OrchestrationWorkClass = "interactive" | "background";

export interface AdmissionLease {
  queue_wait_ms: number;
  work_class: OrchestrationWorkClass;
  release(): void;
}

export interface AdmissionTimeoutScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class OrchestrationAdmissionDeadlineExceededError extends Error {
  readonly code = "turn_deadline_exceeded";

  constructor(readonly deadlineAt: number) {
    super("orchestration admission deadline expired");
    this.name = "OrchestrationAdmissionDeadlineExceededError";
  }
}

export class OrchestrationAdmissionAbortedError extends Error {
  readonly code = "admission_aborted";

  constructor() {
    super("orchestration admission aborted");
    this.name = "OrchestrationAdmissionAbortedError";
  }
}

interface Waiter {
  workClass: OrchestrationWorkClass;
  queuedAt: number;
  signal?: AbortSignal;
  deadlineAt?: number;
  deadlineTimer: unknown | null;
  deadlineGeneration: number;
  settled: boolean;
  resolve: (lease: AdmissionLease) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

const defaultScheduler: AdmissionTimeoutScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class OrchestrationAdmissionController {
  private readonly active = { interactive: 0, background: 0 };
  private readonly queues: Record<OrchestrationWorkClass, Waiter[]> = {
    interactive: [],
    background: [],
  };

  constructor(
    private readonly limits = { interactive: 2, background: 1 },
    private readonly now: () => number = Date.now,
    private readonly scheduler: AdmissionTimeoutScheduler = defaultScheduler,
  ) {}

  acquire(input: {
    workClass: OrchestrationWorkClass;
    signal?: AbortSignal;
    deadlineAt?: number;
  }): Promise<AdmissionLease> {
    return new Promise<AdmissionLease>((resolve, reject) => {
      const queuedAt = this.now();
      if (input.signal?.aborted) {
        reject(new OrchestrationAdmissionAbortedError());
        return;
      }
      if (input.deadlineAt !== undefined && input.deadlineAt <= queuedAt) {
        reject(new OrchestrationAdmissionDeadlineExceededError(input.deadlineAt));
        return;
      }

      const waiter: Waiter = {
        workClass: input.workClass,
        queuedAt,
        signal: input.signal,
        deadlineAt: input.deadlineAt,
        deadlineTimer: null,
        deadlineGeneration: 0,
        settled: false,
        resolve,
        reject,
      };

      if (input.signal) {
        waiter.onAbort = () => {
          this.rejectWaiter(waiter, new OrchestrationAdmissionAbortedError());
        };
        input.signal.addEventListener("abort", waiter.onAbort, { once: true });
        if (input.signal.aborted) {
          waiter.onAbort();
          return;
        }
      }

      this.queues[input.workClass].push(waiter);
      if (input.deadlineAt !== undefined && Number.isFinite(input.deadlineAt)) {
        this.scheduleDeadline(waiter, input.deadlineAt - queuedAt);
      }
      this.pump();
    });
  }

  snapshot(): { active_interactive: number; active_background: number; queued_interactive: number; queued_background: number } {
    return {
      active_interactive: this.active.interactive,
      active_background: this.active.background,
      queued_interactive: this.queues.interactive.length,
      queued_background: this.queues.background.length,
    };
  }

  private pump(): void {
    this.dropExpired();
    while (this.active.interactive < this.limits.interactive && this.queues.interactive.length > 0) {
      this.grant(this.queues.interactive.shift()!);
    }
    if (
      this.active.interactive === 0 &&
      this.queues.interactive.length === 0 &&
      this.active.background < this.limits.background
    ) {
      while (this.active.background < this.limits.background && this.queues.background.length > 0) {
        this.grant(this.queues.background.shift()!);
      }
    }
  }

  private grant(waiter: Waiter): void {
    if (waiter.settled) return;
    const now = this.now();
    if (waiter.signal?.aborted) {
      this.rejectWaiter(waiter, new OrchestrationAdmissionAbortedError());
      return;
    }
    if (waiter.deadlineAt !== undefined && waiter.deadlineAt <= now) {
      this.rejectWaiter(waiter, new OrchestrationAdmissionDeadlineExceededError(waiter.deadlineAt));
      return;
    }

    waiter.settled = true;
    this.clearDeadlineTimer(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    this.active[waiter.workClass]++;
    let released = false;
    waiter.resolve({
      queue_wait_ms: Math.max(0, now - waiter.queuedAt),
      work_class: waiter.workClass,
      release: () => {
        if (released) return;
        released = true;
        this.active[waiter.workClass] = Math.max(0, this.active[waiter.workClass] - 1);
        this.pump();
      },
    });
  }

  private expireWaiter(waiter: Waiter): void {
    waiter.deadlineTimer = null;
    if (waiter.settled) return;
    if (waiter.signal?.aborted) {
      this.rejectWaiter(waiter, new OrchestrationAdmissionAbortedError());
      return;
    }
    if (waiter.deadlineAt === undefined) return;
    const remaining = waiter.deadlineAt - this.now();
    if (remaining <= 0) {
      this.rejectWaiter(waiter, new OrchestrationAdmissionDeadlineExceededError(waiter.deadlineAt));
      return;
    }
    this.scheduleDeadline(waiter, remaining);
  }

  private scheduleDeadline(waiter: Waiter, delayMs: number): void {
    const generation = ++waiter.deadlineGeneration;
    const handle = this.scheduler.setTimeout(() => {
      if (waiter.settled || generation !== waiter.deadlineGeneration) return;
      waiter.deadlineTimer = null;
      this.expireWaiter(waiter);
    }, Math.max(0, delayMs));
    waiter.deadlineTimer = handle;
  }

  private dropExpired(): void {
    const now = this.now();
    for (const workClass of ["interactive", "background"] as const) {
      for (const waiter of [...this.queues[workClass]]) {
        if (waiter.signal?.aborted) {
          this.rejectWaiter(waiter, new OrchestrationAdmissionAbortedError());
        } else if (waiter.deadlineAt !== undefined && waiter.deadlineAt <= now) {
          this.rejectWaiter(waiter, new OrchestrationAdmissionDeadlineExceededError(waiter.deadlineAt));
        }
      }
    }
  }

  private removeWaiter(waiter: Waiter): void {
    const queue = this.queues[waiter.workClass];
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
  }

  private clearDeadlineTimer(waiter: Waiter): void {
    waiter.deadlineGeneration++;
    if (waiter.deadlineTimer === null) return;
    this.scheduler.clearTimeout(waiter.deadlineTimer);
    waiter.deadlineTimer = null;
  }

  private rejectWaiter(waiter: Waiter, error: Error): void {
    if (waiter.settled) return;
    waiter.settled = true;
    this.removeWaiter(waiter);
    this.clearDeadlineTimer(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.reject(error);
  }
}
