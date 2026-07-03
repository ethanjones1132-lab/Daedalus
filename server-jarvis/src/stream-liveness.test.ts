import { describe, expect, mock, test } from "bun:test";
import {
  createDisconnectAwareWrite,
  ResettableWatchdog,
  StreamIdleTimeoutError,
  startSseHeartbeat,
  type IntervalScheduler,
  type TimeoutScheduler,
} from "./stream-liveness";

class FakeTimeoutScheduler implements TimeoutScheduler {
  private nextId = 1;
  private tasks = new Map<number, () => void>();

  setTimeout(callback: () => void): unknown {
    const id = this.nextId++;
    this.tasks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(Number(handle));
  }

  get pending(): number {
    return this.tasks.size;
  }

  runNext(): void {
    const entry = this.tasks.entries().next().value as [number, () => void] | undefined;
    if (!entry) return;
    this.tasks.delete(entry[0]);
    entry[1]();
  }
}

class FakeIntervalScheduler implements IntervalScheduler {
  callback: (() => void | Promise<void>) | null = null;
  cleared = false;

  setInterval(callback: () => void | Promise<void>): unknown {
    this.callback = callback;
    return 1;
  }

  clearInterval(): void {
    this.cleared = true;
    this.callback = null;
  }

  async tick(): Promise<void> {
    await this.callback?.();
  }
}

describe("ResettableWatchdog", () => {
  test("touch replaces the timer and the timeout fires only once", () => {
    const scheduler = new FakeTimeoutScheduler();
    const onTimeout = mock(() => {});
    const watchdog = new ResettableWatchdog(60_000, onTimeout, scheduler);

    watchdog.start();
    expect(scheduler.pending).toBe(1);
    watchdog.touch();
    expect(scheduler.pending).toBe(1);

    scheduler.runNext();
    scheduler.runNext();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test("stop disarms a pending timeout", () => {
    const scheduler = new FakeTimeoutScheduler();
    const onTimeout = mock(() => {});
    const watchdog = new ResettableWatchdog(60_000, onTimeout, scheduler);

    watchdog.start();
    watchdog.stop();
    scheduler.runNext();

    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe("SSE heartbeat", () => {
  test("writes heartbeat frames until stopped", async () => {
    const scheduler = new FakeIntervalScheduler();
    const write = mock(async () => true);
    const stop = startSseHeartbeat("session-1", 15_000, write, scheduler);

    await scheduler.tick();
    expect(write).toHaveBeenCalledWith('data: {"type":"heartbeat","session_id":"session-1"}\n\n');

    stop();
    expect(scheduler.cleared).toBe(true);
  });

  test("stops when the client write fails", async () => {
    const scheduler = new FakeIntervalScheduler();
    startSseHeartbeat("session-2", 15_000, async () => false, scheduler);

    await scheduler.tick();

    expect(scheduler.cleared).toBe(true);
  });
});

test("disconnect-aware writes abort upstream and preserve the write error", async () => {
  const failure = new Error("client gone");
  const onDisconnect = mock(() => {});
  const write = createDisconnectAwareWrite(async () => {
    throw failure;
  }, onDisconnect);

  expect(write(new Uint8Array([1, 2, 3]))).rejects.toBe(failure);
  await Bun.sleep(0);
  expect(onDisconnect).toHaveBeenCalledTimes(1);
});

test("StreamIdleTimeoutError preserves model, stage, and window metadata", () => {
  const error = new StreamIdleTimeoutError("test-model", "synthesizer", 60_000);
  expect(error.name).toBe("StreamIdleTimeoutError");
  expect(error.model).toBe("test-model");
  expect(error.stage).toBe("synthesizer");
  expect(error.windowMs).toBe(60_000);
});
