export type OrchestrationWorkClass = "interactive" | "background";

export interface AdmissionLease {
  queue_wait_ms: number;
  work_class: OrchestrationWorkClass;
  release(): void;
}

interface Waiter {
  workClass: OrchestrationWorkClass;
  queuedAt: number;
  signal?: AbortSignal;
  deadlineAt?: number;
  resolve: (lease: AdmissionLease) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

export class OrchestrationAdmissionController {
  private readonly active = { interactive: 0, background: 0 };
  private readonly queues: Record<OrchestrationWorkClass, Waiter[]> = {
    interactive: [],
    background: [],
  };

  constructor(private readonly limits = { interactive: 2, background: 1 }) {}

  acquire(input: {
    workClass: OrchestrationWorkClass;
    signal?: AbortSignal;
    deadlineAt?: number;
  }): Promise<AdmissionLease> {
    return new Promise<AdmissionLease>((resolve, reject) => {
      const waiter: Waiter = {
        workClass: input.workClass,
        queuedAt: Date.now(),
        signal: input.signal,
        deadlineAt: input.deadlineAt,
        resolve,
        reject,
      };
      if (input.signal?.aborted) {
        reject(new Error("orchestration admission aborted"));
        return;
      }
      if (input.signal) {
        waiter.onAbort = () => {
          this.removeWaiter(waiter);
          reject(new Error("orchestration admission aborted"));
        };
        input.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queues[input.workClass].push(waiter);
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
    // Background work is strictly lower priority: do not start it while any
    // interactive turn is active or waiting for capacity.
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
    const now = Date.now();
    if (waiter.signal?.aborted || (waiter.deadlineAt !== undefined && waiter.deadlineAt <= now)) {
      this.rejectWaiter(waiter, new Error("orchestration admission deadline expired"));
      return;
    }
    this.active[waiter.workClass]++;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
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

  private dropExpired(): void {
    const now = Date.now();
    for (const workClass of ["interactive", "background"] as const) {
      for (const waiter of [...this.queues[workClass]]) {
        if (waiter.signal?.aborted) this.rejectWaiter(waiter, new Error("orchestration admission aborted"));
        else if (waiter.deadlineAt !== undefined && waiter.deadlineAt <= now) {
          this.rejectWaiter(waiter, new Error("orchestration admission deadline expired"));
        }
      }
    }
  }

  private removeWaiter(waiter: Waiter): void {
    const queue = this.queues[waiter.workClass];
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
  }

  private rejectWaiter(waiter: Waiter, error: Error): void {
    this.removeWaiter(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.reject(error);
  }
}
