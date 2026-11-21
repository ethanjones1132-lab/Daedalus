import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  claudeCliPostResultErrorAction,
  normalizeClaudeCliExit,
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
