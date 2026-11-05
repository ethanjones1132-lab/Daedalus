import { describe, expect, test } from "bun:test";
import {
  claudeCliStreamTimeoutEvent,
  createClaudeCliTurnDeadline,
  readClaudeCliStreamWithTimeout,
  streamSpawnedClaudeCli,
  type ClaudeCliClock,
  type ClaudeCliSpawnedChild,
  type ClaudeCliStreamEvent,
} from "./claude-cli";

/** A stream read that never settles, as when the CLI wedges mid-turn. */
const WEDGED_READ = new Promise<never>(() => {});

/**
 * Safety net for the suite itself: if the production deadline never fires we
 * want a clear test failure instead of a hung run.
 */
async function withSuiteDeadline<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`suite safety deadline: no outcome after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("Claude CLI stream deadline", () => {
  test("a wedged read is killed at timeout_ms and surfaces a structured timeout error", async () => {
    let kills = 0;
    const outcome = await withSuiteDeadline(
      readClaudeCliStreamWithTimeout(WEDGED_READ, 25, () => { kills += 1; }),
    );

    // The timeout path must tear down the child, not just give up on reading.
    expect(kills).toBe(1);
    if (!outcome.timedOut) throw new Error("expected the stream deadline to fire");

    // The caller must receive an event naming the timeout, not a bare stop.
    expect(outcome.error.type).toBe("error");
    expect(outcome.error.is_error).toBe(true);
    expect(outcome.error.error).toContain("timed out after 25ms");
    expect(outcome.error.content).toContain("timed out after 25ms");
  });

  test("a read that completes before the deadline passes through without killing the child", async () => {
    let kills = 0;
    const chunk = { done: false, value: new TextEncoder().encode('{"type":"result"}\n') };
    const outcome = await readClaudeCliStreamWithTimeout(
      Promise.resolve(chunk),
      5_000,
      () => { kills += 1; },
    );

    expect(kills).toBe(0);
    if (outcome.timedOut) throw new Error("did not expect the stream deadline to fire");
    expect(outcome.value).toBe(chunk);
  });

  test("a non-positive timeout leaves the read unbounded", async () => {
    let kills = 0;
    const outcome = await readClaudeCliStreamWithTimeout(
      Promise.resolve("ok"),
      0,
      () => { kills += 1; },
    );

    expect(kills).toBe(0);
    if (outcome.timedOut) throw new Error("a disabled deadline must not time out");
    expect(outcome.value).toBe("ok");
  });

  test("a kill that throws still surfaces the timeout error", async () => {
    const outcome = await withSuiteDeadline(
      readClaudeCliStreamWithTimeout(WEDGED_READ, 25, () => {
        throw new Error("process already exited");
      }),
    );

    if (!outcome.timedOut) throw new Error("expected the stream deadline to fire");
    expect(outcome.error.error).toContain("timed out after 25ms");
  });

  test("the timeout error names the configured deadline", () => {
    const event = claudeCliStreamTimeoutEvent(120_000);

    expect(event.type).toBe("error");
    expect(event.is_error).toBe(true);
    expect(event.error).toBe("Claude CLI stream timed out after 120000ms");
  });

  test("periodic chunks do not refresh one turn deadline", async () => {
    const clock = manualClock();
    let kills = 0;
    const deadline = createClaudeCliTurnDeadline(25, () => { kills += 1; }, clock);
    const pending: Array<(value: number) => void> = [];
    const nextRead = () => new Promise<number>((resolve) => { pending.push(resolve); });

    const run = (async () => {
      const seen: number[] = [];
      for (let i = 0; i < 6; i++) {
        const read = await readClaudeCliStreamWithTimeout(nextRead(), deadline);
        if (read.timedOut) return { seen, timedOut: true as const };
        seen.push(read.value);
      }
      return { seen, timedOut: false as const };
    })();

    try {
      await flush();
      for (let i = 0; i < 6; i++) {
        clock.advance(20);
        await flush();
        const early = await settledNow(run);
        if (early !== "pending") {
          // The shared deadline fired on the fake clock. A per-read reset would
          // still be waiting on a fresh budget, or would already have accepted
          // every chunk.
          expect(early.timedOut).toBe(true);
          expect(early.seen.length).toBeLessThan(6);
          expect(kills).toBe(1);
          return;
        }
        const resolve = pending.shift();
        if (!resolve) throw new Error("expected a pending read");
        resolve(i);
        await flush();
      }
      throw new Error("a 25ms turn accepted six 20ms chunks");
    } finally {
      deadline.dispose();
    }
  });
});

/** Clock whose timers fire only when the test advances it. */
function manualClock(): ClaudeCliClock & { advance: (ms: number) => void } {
  let now = 0;
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
  return {
    setTimeout(callback, ms) {
      const timer = { at: now + ms, callback, cancelled: false };
      timers.push(timer);
      return {
        cancel() {
          timer.cancelled = true;
        },
      };
    },
    advance(ms: number) {
      const target = now + ms;
      while (true) {
        let nextIndex = -1;
        for (let i = 0; i < timers.length; i++) {
          const timer = timers[i];
          if (timer.cancelled || timer.at > target) continue;
          if (nextIndex === -1 || timer.at < timers[nextIndex].at) nextIndex = i;
        }
        if (nextIndex === -1) break;
        const [timer] = timers.splice(nextIndex, 1);
        now = timer.at;
        if (!timer.cancelled) timer.callback();
      }
      now = target;
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Resolves immediately when `promise` does. A real timer reset stays "pending". */
async function settledNow<T>(promise: Promise<T>): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), 15);
  });
  try {
    return await Promise.race([promise, pending]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class ScriptedStream implements AsyncIterable<unknown> {
  private queue: Array<IteratorResult<unknown>> = [];
  private waiters: Array<(result: IteratorResult<unknown>) => void> = [];

  push(result: IteratorResult<unknown>): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(result);
    else this.queue.push(result);
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve(queued);
        return new Promise((resolve) => { this.waiters.push(resolve); });
      },
    };
  }
}

async function collect(child: ClaudeCliSpawnedChild, timeoutMs: number, clock: ClaudeCliClock, sessionId?: string): Promise<ClaudeCliStreamEvent[]> {
  const events: ClaudeCliStreamEvent[] = [];
  for await (const event of streamSpawnedClaudeCli(child, timeoutMs, sessionId, undefined, () => {}, clock)) {
    events.push(event);
  }
  return events;
}

describe("Claude CLI child lifetime", () => {
  test("a finished child yields its result without a timeout", async () => {
    const stdout = new ScriptedStream();
    const stderr = new ScriptedStream();
    stdout.push({ done: false, value: new TextEncoder().encode('{"type":"result","result":"hello"}\n') });
    stdout.push({ done: true, value: undefined });
    stderr.push({ done: true, value: undefined });
    const events = await withSuiteDeadline(collect({
      waitUntilSpawned: async () => undefined,
      stdout,
      stderr,
      kill() {},
      waitForExit: async () => 0,
    }, 5_000, manualClock(), "sess"));

    expect(events.some((event) => event.type === "result" && event.content === "hello")).toBe(true);
    expect(events.some((event) => event.type === "message_stop" && event.session_id === "sess")).toBe(true);
    expect(events.some((event) => event.error?.includes("timed out"))).toBe(false);
  });

  test("string stdout and stderr chunks match equivalent byte chunks", async () => {
    const stdoutText = '{"type":"result","result":"hello"}\n';
    const stderrText = "diagnostic text";
    const makeChild = (stdoutChunk: Uint8Array | string, stderrChunk: Uint8Array | string): ClaudeCliSpawnedChild => {
      const stdout = new ScriptedStream();
      const stderr = new ScriptedStream();
      stdout.push({ done: false, value: stdoutChunk });
      stdout.push({ done: true, value: undefined });
      stderr.push({ done: false, value: stderrChunk });
      stderr.push({ done: true, value: undefined });
      return {
        waitUntilSpawned: async () => undefined,
        stdout,
        stderr,
        kill() {},
        waitForExit: async () => 0,
      };
    };

    const byteEvents = await withSuiteDeadline(collect(
      makeChild(new TextEncoder().encode(stdoutText), new TextEncoder().encode(stderrText)),
      5_000,
      manualClock(),
      "sess",
    ));
    const stringEvents = await withSuiteDeadline(collect(
      makeChild(stdoutText, stderrText),
      5_000,
      manualClock(),
      "sess",
    ));

    expect(stringEvents).toEqual(byteEvents);
  });

  test("periodic stdout still dies on the original turn deadline", async () => {
    const clock = manualClock();
    const stdout = new ScriptedStream();
    const stderr = new ScriptedStream();
    let kills = 0;
    const consuming = collect({
      waitUntilSpawned: async () => undefined,
      stdout,
      stderr,
      kill() { kills += 1; },
      waitForExit: () => new Promise<number>(() => {}),
    }, 25, clock);

    try {
      await flush();
      clock.advance(20);
      await flush();
      stdout.push({ done: false, value: new TextEncoder().encode("0\n") });
      await flush();
      clock.advance(20);
      await flush();
      const events = await settledNow(consuming);
      if (events === "pending") {
        throw new Error("periodic stdout refreshed the 25ms turn deadline");
      }
      expect(events.some((event) => event.error?.includes("timed out after 25ms"))).toBe(true);
      expect(kills).toBeGreaterThan(0);
    } finally {
      stdout.push({ done: true, value: undefined });
      stderr.push({ done: true, value: undefined });
    }
  });

  test("stdout EOF does not grant a live child a new deadline", async () => {
    const clock = manualClock();
    const stdout = new ScriptedStream();
    const stderr = new ScriptedStream();
    let kills = 0;
    const consuming = collect({
      waitUntilSpawned: async () => undefined,
      stdout,
      stderr,
      kill() { kills += 1; },
      waitForExit: () => new Promise<number>(() => {}),
    }, 50, clock);

    try {
      await flush();
      clock.advance(40);
      stdout.push({ done: false, value: new TextEncoder().encode('{"type":"result","result":"partial"}\n') });
      stdout.push({ done: true, value: undefined });
      await flush();
      const duringStdout = await settledNow(consuming);
      expect(duringStdout).toBe("pending");
      // 10ms of the original 50ms budget remains. A fresh stderr deadline would still be waiting.
      clock.advance(10);
      await flush();
      const events = await settledNow(consuming);
      if (events === "pending") {
        throw new Error("stdout EOF started a new deadline for the live child");
      }
      expect(events.some((event) => event.error?.includes("timed out after 50ms"))).toBe(true);
      expect(kills).toBeGreaterThan(0);
    } finally {
      stderr.push({ done: true, value: undefined });
    }
  });

  test("a child that never exits still dies on the original deadline after both pipes EOF", async () => {
    const clock = manualClock();
    const stdout = new ScriptedStream();
    const stderr = new ScriptedStream();
    stdout.push({ done: true, value: undefined });
    stderr.push({ done: true, value: undefined });
    let kills = 0;
    const consuming = collect({
      waitUntilSpawned: async () => undefined,
      stdout,
      stderr,
      kill() { kills += 1; },
      waitForExit: () => new Promise<number>(() => {}),
    }, 30, clock);

    await flush();
    clock.advance(30);
    await flush();
    const events = await settledNow(consuming);
    if (events === "pending") {
      throw new Error("process exit was outside the turn deadline");
    }
    expect(events.some((event) => event.error?.includes("timed out after 30ms"))).toBe(true);
    expect(kills).toBeGreaterThan(0);
  });

  test("a spawn that never confirms dies on the turn deadline", async () => {
    const clock = manualClock();
    let kills = 0;
    const consuming = collect({
      waitUntilSpawned: () => new Promise(() => {}),
      stdout: new ScriptedStream(),
      stderr: new ScriptedStream(),
      kill() { kills += 1; },
      waitForExit: () => new Promise<number>(() => {}),
    }, 25, clock);

    await flush();
    clock.advance(25);
    await flush();
    const events = await settledNow(consuming);
    if (events === "pending") {
      throw new Error("spawn confirmation was outside the turn deadline");
    }
    expect(events.some((event) => event.error?.includes("timed out after 25ms"))).toBe(true);
    expect(kills).toBeGreaterThan(0);
  });
});
