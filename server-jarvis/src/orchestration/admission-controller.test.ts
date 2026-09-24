import { describe, expect, test } from "bun:test";
import {
  OrchestrationAdmissionAbortedError,
  OrchestrationAdmissionController,
  OrchestrationAdmissionDeadlineExceededError,
  type AdmissionTimeoutScheduler,
} from "./admission-controller";

class FakeAdmissionScheduler implements AdmissionTimeoutScheduler {
  currentTime = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { callback: () => void; dueAt: number }>();
  private readonly callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    this.tasks.set(id, { callback, dueAt: this.currentTime + Math.max(0, delayMs) });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(Number(handle));
  }

  get pending(): number {
    return this.tasks.size;
  }

  get handles(): number[] {
    return [...this.callbacks.keys()];
  }

  runNext(): void {
    const entry = this.tasks.entries().next().value as [number, { callback: () => void }] | undefined;
    if (!entry) return;
    this.tasks.delete(entry[0]);
    entry[1].callback();
  }

  runDue(): void {
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= this.currentTime)
        .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
      if (!next) return;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
  }

  advance(ms: number): void {
    this.currentTime += ms;
    this.runDue();
  }

  fireCleared(handle: number): void {
    this.callbacks.get(handle)?.();
  }
}

async function captureRejection(
  promise: Promise<unknown>,
  ErrorType: typeof Error,
): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ErrorType);
    return error as Error;
  }
  throw new Error("expected promise to reject");
}

describe("OrchestrationAdmissionController", () => {
  test("queues background work while interactive capacity is active", async () => {
    const controller = new OrchestrationAdmissionController({ interactive: 2, background: 1 });
    const chat = await controller.acquire({ workClass: "interactive" });
    let cronStarted = false;
    const cronPromise = controller.acquire({ workClass: "background" }).then((lease) => {
      cronStarted = true;
      return lease;
    });

    await Promise.resolve();
    expect(cronStarted).toBe(false);
    chat.release();
    const cron = await cronPromise;
    expect(cronStarted).toBe(true);
    cron.release();
  });

  test("interactive work preempts queued background work", async () => {
    const controller = new OrchestrationAdmissionController({ interactive: 1, background: 1 });
    const first = await controller.acquire({ workClass: "interactive" });
    let backgroundStarted = false;
    const backgroundPromise = controller.acquire({ workClass: "background" }).then((lease) => {
      backgroundStarted = true;
      return lease;
    });
    const interactivePromise = controller.acquire({ workClass: "interactive" });
    first.release();
    const second = await interactivePromise;
    expect(backgroundStarted).toBe(false);
    second.release();
    const background = await backgroundPromise;
    background.release();
  });

  test("aborted waiters are removed without consuming capacity", async () => {
    const controller = new OrchestrationAdmissionController({ interactive: 1, background: 1 });
    const first = await controller.acquire({ workClass: "interactive" });
    const abort = new AbortController();
    const waiting = controller.acquire({ workClass: "interactive", signal: abort.signal });
    abort.abort();
    await expect(waiting).rejects.toBeInstanceOf(OrchestrationAdmissionAbortedError);
    expect(controller.snapshot().queued_interactive).toBe(0);
    first.release();
  });

  test("expires a queued waiter at its deadline without another admission pump", async () => {
    const scheduler = new FakeAdmissionScheduler();
    const controller = new OrchestrationAdmissionController(
      { interactive: 1, background: 1 },
      () => scheduler.currentTime,
      scheduler,
    );
    const first = await controller.acquire({ workClass: "interactive" });
    let granted = false;
    const waiting = controller.acquire({ workClass: "interactive", deadlineAt: 100 }).then((lease) => {
      granted = true;
      return lease;
    });

    scheduler.advance(100);
    await captureRejection(waiting, OrchestrationAdmissionDeadlineExceededError);

    expect(granted).toBe(false);
    expect(controller.snapshot()).toEqual({
      active_interactive: 1,
      active_background: 0,
      queued_interactive: 0,
      queued_background: 0,
    });
    first.release();
  });

  test("rejects an already expired waiter without queueing or consuming capacity", async () => {
    const scheduler = new FakeAdmissionScheduler();
    const controller = new OrchestrationAdmissionController(
      { interactive: 1, background: 1 },
      () => scheduler.currentTime,
      scheduler,
    );
    const first = await controller.acquire({ workClass: "interactive" });
    const waiting = controller.acquire({ workClass: "interactive", deadlineAt: 0 });

    await expect(waiting).rejects.toBeInstanceOf(OrchestrationAdmissionDeadlineExceededError);
    expect(scheduler.pending).toBe(0);
    expect(controller.snapshot().queued_interactive).toBe(0);
    first.release();
  });

  test("a lease granted before the deadline disarms its expiry timer", async () => {
    const scheduler = new FakeAdmissionScheduler();
    const controller = new OrchestrationAdmissionController(
      { interactive: 1, background: 1 },
      () => scheduler.currentTime,
      scheduler,
    );
    const first = await controller.acquire({ workClass: "interactive" });
    const waiting = controller.acquire({ workClass: "interactive", deadlineAt: 100 });

    first.release();
    const second = await waiting;
    scheduler.advance(100);

    expect(second.work_class).toBe("interactive");
    expect(controller.snapshot().queued_interactive).toBe(0);
    second.release();
  });

  test("a stale deadline callback cannot affect a granted lease", async () => {
    const scheduler = new FakeAdmissionScheduler();
    const controller = new OrchestrationAdmissionController(
      { interactive: 1, background: 1 },
      () => scheduler.currentTime,
      scheduler,
    );
    const first = await controller.acquire({ workClass: "interactive" });
    const waiting = controller.acquire({ workClass: "interactive", deadlineAt: 100 });
    const timerHandle = scheduler.handles[0];

    first.release();
    const second = await waiting;
    scheduler.fireCleared(timerHandle);
    scheduler.advance(100);

    expect(second.work_class).toBe("interactive");
    expect(controller.snapshot().active_interactive).toBe(1);
    second.release();
  });

  test("deadline and abort settle a waiter exactly once", async () => {
    const scheduler = new FakeAdmissionScheduler();
    const controller = new OrchestrationAdmissionController(
      { interactive: 1, background: 1 },
      () => scheduler.currentTime,
      scheduler,
    );
    const first = await controller.acquire({ workClass: "interactive" });
    const abort = new AbortController();
    const waiting = controller.acquire({
      workClass: "interactive",
      signal: abort.signal,
      deadlineAt: 100,
    });

    scheduler.advance(100);
    abort.abort();
    scheduler.advance(100);
    await captureRejection(waiting, OrchestrationAdmissionDeadlineExceededError);

    expect(controller.snapshot().queued_interactive).toBe(0);
    first.release();
  });

  test("abort wins when it is observed before an equal deadline", async () => {
    const scheduler = new FakeAdmissionScheduler();
    const controller = new OrchestrationAdmissionController(
      { interactive: 1, background: 1 },
      () => scheduler.currentTime,
      scheduler,
    );
    const first = await controller.acquire({ workClass: "interactive" });
    const abort = new AbortController();
    const waiting = controller.acquire({
      workClass: "interactive",
      signal: abort.signal,
      deadlineAt: 100,
    });

    abort.abort();
    scheduler.advance(100);
    await captureRejection(waiting, OrchestrationAdmissionAbortedError);
    first.release();
  });

  test("an early timer callback cannot expire a waiter that is released in time", async () => {
    const scheduler = new FakeAdmissionScheduler();
    const controller = new OrchestrationAdmissionController(
      { interactive: 1, background: 1 },
      () => scheduler.currentTime,
      scheduler,
    );
    const first = await controller.acquire({ workClass: "interactive" });
    const waiting = controller.acquire({ workClass: "interactive", deadlineAt: 100 });

    scheduler.runNext();
    first.release();
    const second = await waiting;
    second.release();
    expect(controller.snapshot().active_interactive).toBe(0);
  });

  test("an expired head does not prevent the next waiter from being granted", async () => {
    const scheduler = new FakeAdmissionScheduler();
    const controller = new OrchestrationAdmissionController(
      { interactive: 1, background: 1 },
      () => scheduler.currentTime,
      scheduler,
    );
    const first = await controller.acquire({ workClass: "interactive" });
    const expired = controller.acquire({ workClass: "interactive", deadlineAt: 10 });
    const next = controller.acquire({ workClass: "interactive" });
    const expiredExpectation = captureRejection(
      expired,
      OrchestrationAdmissionDeadlineExceededError,
    );

    scheduler.advance(10);
    await expiredExpectation;
    first.release();
    const granted = await next;
    granted.release();
    expect(controller.snapshot().queued_interactive).toBe(0);
  });

  test("waiters without deadlines do not arm a timer", async () => {
    const scheduler = new FakeAdmissionScheduler();
    const controller = new OrchestrationAdmissionController(
      { interactive: 1, background: 1 },
      () => scheduler.currentTime,
      scheduler,
    );
    const first = await controller.acquire({ workClass: "interactive" });
    const waiting = controller.acquire({ workClass: "interactive" });

    expect(scheduler.pending).toBe(0);
    first.release();
    (await waiting).release();
  });
});
