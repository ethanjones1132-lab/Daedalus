import type { OrchestratorAgent } from "./agent-pool";
import { validateOrchestratorAgents, type AgentValidationIssue } from "./agent-validation";

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

/**
 * DD-015: an agent the run could route to has at least one error-level
 * validation issue, so the run is refused instead of silently admitting it.
 * Warning-level issues never produce this error.
 */
export class OrchestrationAdmissionAgentInvalidError extends Error {
  readonly code = "agent_validation_failed";

  constructor(
    readonly agentId: string,
    readonly issues: AgentValidationIssue[],
  ) {
    super(
      `orchestration admission refused for agent "${agentId}": ` +
        issues.map((issue) => `${issue.field}: ${issue.message}`).join("; "),
    );
    this.name = "OrchestrationAdmissionAgentInvalidError";
  }

  /** Failing field paths, deduplicated, in issue order. */
  get fields(): string[] {
    return [...new Set(this.issues.map((issue) => issue.field))];
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

/**
 * First agent in the pool with error-level validation issues, grouped so the
 * refusal names every failing field for that agent.
 */
function validateAgentPoolForAdmission(
  agents: OrchestratorAgent[],
): { agentId: string; issues: AgentValidationIssue[] } | undefined {
  const byAgent = new Map<string, AgentValidationIssue[]>();
  for (const issue of validateOrchestratorAgents(agents)) {
    if (issue.level !== "error") continue;
    const existing = byAgent.get(issue.agentId);
    if (existing) existing.push(issue);
    else byAgent.set(issue.agentId, [issue]);
  }
  const first = byAgent.entries().next().value as [string, AgentValidationIssue[]] | undefined;
  return first ? { agentId: first[0], issues: first[1] } : undefined;
}

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
    /**
     * DD-015: the agent pool this run may route to. Any error-level validation
     * issue refuses admission; warning-level issues do not block.
     */
    agents?: OrchestratorAgent[];
    /** Capacity admission is shared by ordinary turns; validate only an active orchestration route. */
    validateAgents?: boolean;
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
      if (input.agents && input.validateAgents !== false) {
        const invalid = validateAgentPoolForAdmission(input.agents);
        if (invalid) {
          reject(new OrchestrationAdmissionAgentInvalidError(invalid.agentId, invalid.issues));
          return;
        }
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
