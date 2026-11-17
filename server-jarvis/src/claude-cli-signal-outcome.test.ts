import { describe, expect, test } from "bun:test";
import {
  streamSpawnedClaudeCli,
  type ClaudeCliSpawnedChild,
  type ClaudeCliStreamEvent,
} from "./claude-cli";
import { StreamSession } from "./stream-emitter";

/**
 * DD-100: a Claude CLI turn that emitted a `result` record and is then killed
 * by a signal must be recorded as failed, with the kill named.
 *
 * `index.ts` cannot be imported (it binds a socket at import time), so these
 * tests pin the frame sequence the direct-CLI branch consumes and then apply
 * that branch's outcome accounting to it. The branch's memory turn record
 * (`recordMemoryTerminal`, index.ts:1991) is first-writer-wins, and its SSE
 * outcome is released by the first `noteOutcome()` (index.ts:2320-2359).
 * Therefore a success `result` frame reaching the consumer is what records a
 * killed turn as `completed`; the later `error` frame loses both races.
 */

/** A stream read that never settles, as when the CLI wedges mid-turn. */
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

/** Safety net so a stream bug fails the suite instead of hanging it. */
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

function child(
  stdoutLines: string[],
  exit: number | { code: number | null; signal: string | null },
): ClaudeCliSpawnedChild {
  const stdout = new ScriptedStream();
  const stderr = new ScriptedStream();
  for (const line of stdoutLines) {
    stdout.push({ done: false, value: line });
  }
  stdout.push({ done: true, value: undefined });
  stderr.push({ done: true, value: undefined });
  return {
    waitUntilSpawned: async () => undefined,
    stdout,
    stderr,
    kill() {},
    waitForExit: async () => exit,
  };
}

async function collect(spawned: ClaudeCliSpawnedChild): Promise<ClaudeCliStreamEvent[]> {
  const seen: ClaudeCliStreamEvent[] = [];
  for await (const event of streamSpawnedClaudeCli(spawned, 5_000, "sess", undefined, () => {})) {
    seen.push(event);
  }
  return seen;
}

/**
 * What the direct-CLI branch in `index.ts` records for these frames: the
 * memory turn terminal status (first writer wins) and the one outcome frame
 * the client is allowed to see.
 */
async function recordTurnOutcome(events: ClaudeCliStreamEvent[]): Promise<{
  record: "completed" | "partial" | "failed" | null;
  released: ClaudeCliStreamEvent[];
  terminated: boolean;
}> {
  let record: "completed" | "partial" | "failed" | null = null;
  const note = (status: "completed" | "partial" | "failed"): void => {
    if (record === null) record = status;
  };
  const released: ClaudeCliStreamEvent[] = [];
  const session = new StreamSession({
    sessionId: "sess",
    write: async () => true,
    isAborted: () => false,
  });
  for (const evt of events) {
    if (evt.type === "message_stop") {
      session.noteTerminal();
    } else if (evt.type === "error") {
      note("failed");
      if (session.noteOutcome()) released.push(evt);
    } else if (evt.type === "result") {
      const isError = evt.is_error === true
        || (typeof evt.subtype === "string" && evt.subtype.startsWith("error"));
      const isPartial = !isError
        && typeof evt.subtype === "string"
        && /partial|interrupt|length|max_turns|max_tokens/i.test(evt.subtype);
      note(isError ? "failed" : isPartial ? "partial" : "completed");
      if (session.noteOutcome()) released.push(evt);
    }
  }
  return { record, released, terminated: session.hasTerminated() };
}

describe("Claude CLI result frame followed by a signal kill", () => {
  test("the killed turn is recorded as failed with the kill named, not completed", async () => {
    const events = await withSuiteDeadline(collect(child(
      // The CLI wrote its authoritative result, then the OS killed it before it
      // could exit. The output can look complete and still be truncated.
      ['{"type":"result","subtype":"success","is_error":false,"result":"partial work"}\n'],
      { code: null, signal: "SIGKILL" },
    )));

    const { record, released, terminated } = await recordTurnOutcome(events);

    // The defect: the result frame won the record race and the error frame was
    // dropped, so the killed turn was stored and shown as completed.
    expect(record).toBe("failed");
    expect(released).toHaveLength(1);
    expect(released[0].type).toBe("error");
    expect(released[0].error).toContain("SIGKILL");
    expect(events.some((event) => event.type === "result")).toBe(false);
    expect(terminated).toBe(false);
  });

  test("a clean exit still records the result frame as completed", async () => {
    const events = await withSuiteDeadline(collect(child(
      [
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}}\n',
        // No `result` text: the stream still backfills it from the deltas.
        '{"type":"result","subtype":"success","is_error":false}\n',
      ],
      0,
    )));

    const { record, released, terminated } = await recordTurnOutcome(events);

    expect(record).toBe("completed");
    expect(released).toHaveLength(1);
    expect(released[0].type).toBe("result");
    expect(released[0].content).toBe("hello");
    expect(terminated).toBe(true);
    // The clean-exit frame order is unchanged: result, then the terminator.
    expect(events.map((event) => event.type).slice(-2)).toEqual(["result", "message_stop"]);
  });

  test("a non-zero exit after a result frame also records a failure", async () => {
    const events = await withSuiteDeadline(collect(child(
      ['{"type":"result","subtype":"success","is_error":false,"result":"partial work"}\n'],
      3,
    )));

    const { record, released } = await recordTurnOutcome(events);

    expect(record).toBe("failed");
    expect(released).toHaveLength(1);
    expect(released[0].type).toBe("error");
    expect(released[0].error).toContain("code 3");
    expect(events.some((event) => event.type === "result")).toBe(false);
  });
});
