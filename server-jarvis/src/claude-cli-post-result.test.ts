import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  claudeCliPostResultErrorAction,
  normalizeClaudeCliExit,
  streamSpawnedClaudeCli,
  type ClaudeCliSpawnedChild,
  type ClaudeStreamEvent,
} from "./claude-cli";
import { StreamSession } from "./stream-emitter";

/**
 * A `result` frame that has already reached the consumer is the authoritative
 * turn outcome. A signal kill during CLI teardown must not rewrite the stored
 * status, but it also must not vanish: exactly one warning names the
 * contradiction.
 *
 * `index.ts` binds a socket at import time, so these tests apply the direct-CLI
 * branch's ordering (`index.ts` error branch: warn, then `recordMemoryTerminal`
 * — first writer wins — then `session.noteOutcome()`) to real frames.
 */

/** Memory turn terminal status plus the stored error code, as index.ts keeps them. */
interface TurnStore {
  status: "completed" | "partial" | "failed" | null;
  errorCode: string | null;
}

function createStore(): TurnStore {
  return { status: null, errorCode: null };
}

/** `recordMemoryTerminal`: the first writer wins and later calls are no-ops. */
function recordTerminal(
  store: TurnStore,
  status: "completed" | "partial" | "failed",
  errorCode: string | null,
): void {
  if (store.status !== null) return;
  store.status = status;
  store.errorCode = errorCode;
}

function createSession(): StreamSession {
  return new StreamSession({
    sessionId: "sess",
    write: async () => true,
    isAborted: () => false,
  });
}

/** The `result` branch of the direct-CLI loop, in its existing order. */
function applyResultFrame(
  store: TurnStore,
  session: StreamSession,
  evt: ClaudeStreamEvent,
): ClaudeStreamEvent[] {
  const isError = evt.is_error === true
    || (typeof evt.subtype === "string" && evt.subtype.startsWith("error"));
  const isPartial = !isError
    && typeof evt.subtype === "string"
    && /partial|interrupt|length|max_turns|max_tokens/i.test(evt.subtype);
  recordTerminal(
    store,
    isError ? "failed" : isPartial ? "partial" : "completed",
    isError ? (evt.subtype ?? "claude_cli_result_error") : null,
  );
  return session.noteOutcome() ? [evt] : [];
}

/** The `error` branch, driven by the production helper. */
function applyErrorFrame(
  store: TurnStore,
  session: StreamSession,
  evt: ClaudeStreamEvent,
): { forwarded: ClaudeStreamEvent[]; warnings: string[] } {
  const warnings: string[] = [];
  const forwarded: ClaudeStreamEvent[] = [];
  const action = claudeCliPostResultErrorAction(store.status !== null, {
    code: evt.subtype ?? null,
  });
  if (action.warn) {
    warnings.push(
      `[Jarvis] Claude CLI error after the authoritative turn outcome was recorded - stored outcome kept session=sess code=${action.code}`,
    );
  }
  if (action.statusWrite) {
    recordTerminal(store, action.statusWrite, "claude_cli_error");
  }
  if (action.forward && session.noteOutcome()) forwarded.push(evt);
  return { forwarded, warnings };
}

/** A spawned child whose stdout/stderr are scripted and fully available. */
function scriptedChild(
  stdoutChunks: string[],
  exit: number | { code: number | null; signal: string | null },
): ClaudeCliSpawnedChild {
  const stream = (chunks: string[]): AsyncIterable<unknown> => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  });
  return {
    waitUntilSpawned: async () => undefined,
    stdout: stream(stdoutChunks),
    stderr: stream([]),
    kill() {},
    waitForExit: async () => exit,
  };
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

async function collectFrames(spawned: ClaudeCliSpawnedChild): Promise<ClaudeStreamEvent[]> {
  const seen: ClaudeStreamEvent[] = [];
  for await (const event of streamSpawnedClaudeCli(spawned, 5_000, "sess", undefined, () => {})) {
    seen.push(event);
  }
  return seen;
}

/** Apply the direct-CLI branch's ordering to a whole frame sequence. */
function recordSequence(events: ClaudeStreamEvent[]): {
  store: TurnStore;
  session: StreamSession;
  released: ClaudeStreamEvent[];
  warnings: string[];
} {
  const store = createStore();
  const session = createSession();
  const released: ClaudeStreamEvent[] = [];
  const warnings: string[] = [];
  for (const evt of events) {
    if (evt.type === "message_stop") {
      session.noteTerminal();
    } else if (evt.type === "error") {
      const applied = applyErrorFrame(store, session, evt);
      released.push(...applied.forwarded);
      warnings.push(...applied.warnings);
    } else if (evt.type === "result") {
      released.push(...applyResultFrame(store, session, evt));
    } else {
      released.push(evt);
    }
  }
  return { store, session, released, warnings };
}

describe("Claude CLI error after an authoritative result frame", () => {
  test("the late error is not forwarded, keeps the stored outcome, and warns once with its code", () => {
    const store = createStore();
    const session = createSession();
    const result: ClaudeStreamEvent = {
      type: "result",
      subtype: "success",
      is_error: false,
      content: "done",
    };
    expect(applyResultFrame(store, session, result)).toHaveLength(1);
    expect(store.status).toBe("completed");

    const lateError: ClaudeStreamEvent = {
      type: "error",
      error: "boom",
      content: "boom",
      is_error: true,
      subtype: "error_during_execution",
    };
    const { forwarded, warnings } = applyErrorFrame(store, session, lateError);

    // The stored turn outcome is exactly what the result frame said.
    expect(store.status).toBe("completed");
    expect(store.errorCode).toBeNull();
    // Nothing new crosses the stream boundary.
    expect(forwarded).toHaveLength(0);
    // Exactly one observable warning, naming the code and the session.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("stored outcome kept session=sess");
    expect(warnings[0]).toContain("code=error_during_execution");
  });

  test("the helper itself suppresses a late error even if no outcome frame was released yet", () => {
    const store = createStore();
    store.status = "completed";
    const { forwarded, warnings } = applyErrorFrame(store, createSession(), {
      type: "error",
      error: "killed",
      is_error: true,
    });

    expect(forwarded).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    // No code-like field on the frame: the stored error code is the fallback.
    expect(warnings[0]).toContain("code=claude_cli_error");
    expect(store.status).toBe("completed");

    expect(claudeCliPostResultErrorAction(true, { code: null })).toEqual({
      forward: false,
      statusWrite: null,
      warn: true,
      code: "claude_cli_error",
    });
  });

  test("before the outcome is recorded a mid-turn error still forwards and records failed (DD-092)", () => {
    const store = createStore();
    const session = createSession();
    const midTurnError: ClaudeStreamEvent = {
      type: "error",
      error: "stream broke",
      content: "stream broke",
      is_error: true,
    };

    const { forwarded, warnings } = applyErrorFrame(store, session, midTurnError);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toBe(midTurnError);
    expect(store.status).toBe("failed");
    expect(store.errorCode).toBe("claude_cli_error");
    expect(warnings).toHaveLength(0);

    expect(claudeCliPostResultErrorAction(false, { code: null })).toEqual({
      forward: true,
      statusWrite: "failed",
      warn: false,
      code: "claude_cli_error",
    });
  });

  test("a delivered result followed by a SIGTERM kill keeps completed and warns", () => {
    // The same exit shape the CLI path normalises when the OS kills the child.
    const exit = normalizeClaudeCliExit({ code: null, signal: "SIGTERM" });
    expect(exit).toEqual({ code: null, signal: "SIGTERM" });

    const store = createStore();
    const session = createSession();
    const result: ClaudeStreamEvent = {
      type: "result",
      subtype: "success",
      is_error: false,
      content: "the answer",
    };
    const released = applyResultFrame(store, session, result);
    expect(released).toHaveLength(1);
    expect(store.status).toBe("completed");

    const killEvent: ClaudeStreamEvent = {
      type: "error",
      error: `Claude CLI was killed by signal ${exit.signal}`,
      content: `Claude CLI was killed by signal ${exit.signal}`,
      is_error: true,
    };
    const { forwarded, warnings } = applyErrorFrame(store, session, killEvent);

    expect(store.status).toBe("completed");
    expect(forwarded).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      "[Jarvis] Claude CLI error after the authoritative turn outcome was recorded - stored outcome kept session=sess code=claude_cli_error",
    );
    // The released frame sequence is unchanged: only the result frame.
    expect(released.map((frame) => frame.type)).toEqual(["result"]);
  });

  test("index.ts's error branch asks the helper instead of writing failed unconditionally", () => {
    // index.ts binds a socket at import time, so pin the wiring at the source: a
    // revert to the bare `recordMemoryTerminal("failed", "claude_cli_error")`
    // followed by `if (session.noteOutcome())` fails both assertions.
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
    expect(source).toContain("claudeCliPostResultErrorAction(memoryTerminalRecorded,");
    expect(source).toContain(
      "[Jarvis] Claude CLI error after the authoritative turn outcome was recorded",
    );
  });
});

/**
 * DD-170: a turn's last record can arrive without its trailing newline. When
 * the stream is done and the child exited cleanly, that leftover is a complete
 * line and must be decoded through the same path; after a kill it is a
 * half-written line and stays discarded.
 */
describe("DD-170: the final record and the clean-exit/abort split", () => {
  test("clean exit: a result record without its trailing newline still ends the turn with the answer", async () => {
    const events = await withSuiteDeadline(collectFrames(scriptedChild(
      [
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"the answer"}}}\n',
        // The CLI's last write never got its newline.
        '{"type":"result","subtype":"success","is_error":false}',
      ],
      0,
    )));

    const { store, session, released, warnings } = recordSequence(events);

    // Without the leftover parse there is no result frame, so the direct-CLI
    // branch records nothing and `ensureTerminal()` emits
    // `stream_ended_without_outcome` instead of the answer.
    expect(store.status).toBe("completed");
    expect(store.errorCode).toBeNull();
    expect(session.hasOutcome()).toBe(true);
    expect(warnings).toHaveLength(0);

    const results = released.filter((frame) => frame.type === "result");
    expect(results).toHaveLength(1);
    // The answer is the stream's text, backfilled exactly like a full line.
    expect(results[0].content).toBe("the answer");

    // The clean-exit frame order matches a newline-terminated record.
    expect(events.map((event) => event.type).slice(-2)).toEqual(["result", "message_stop"]);
  });

  test("abort/kill: the same unterminated record is still discarded, and the kill names the failure", async () => {
    const events = await withSuiteDeadline(collectFrames(scriptedChild(
      [
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"half a line"}}}\n',
        '{"type":"result","subtype":"success","is_error":false}',
      ],
      { code: null, signal: "SIGKILL" },
    )));

    const { store, released } = recordSequence(events);

    // A half-written line is not an answer: the leftover never becomes a frame.
    expect(events.some((event) => event.type === "result")).toBe(false);
    expect(released.some((frame) => frame.type === "result")).toBe(false);
    expect(store.status).toBe("failed");

    const errors = released.filter((frame) => frame.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain("SIGKILL");
  });
});
