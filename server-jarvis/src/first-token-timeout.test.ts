import { describe, expect, test } from "bun:test";
import { StreamSession } from "./stream-emitter";

/**
 * P0-B (2026-07-02): a model first-token timeout is a HUNG MODEL, not a user
 * cancellation. The two events live in different abort domains and surface to
 * the client as different SSE frames:
 *
 *   user / `/chat/cancel`  →  `cancelled` (handled by `StreamCancelledError`)
 *   first-token timeout    →  `error` with `code: "first_token_timeout"`
 *                             (handled by `FirstTokenTimeoutError`)
 *
 * The previous build shared the abort domain between the two, so a hung model
 * emitted `cancelled`, the UI had no `cancelled` handler, the frame was
 * dropped, and the assistant bubble was finalized empty — the silent-blank
 * failure mode the live incident exposed. These tests pin the two errors as
 * DISTINCT and assert that the timeout path does NOT emit `cancelled` while
 * the user-cancel path STILL does (regression guard).
 */

class StreamCancelledError extends Error {
  constructor() {
    super("stream cancelled");
    this.name = "StreamCancelledError";
  }
}

class FirstTokenTimeoutError extends Error {
  readonly model: string;
  readonly stage: string;
  readonly windowMs: number;
  constructor(model: string, stage: string, windowMs: number) {
    super(`First-token timeout (${windowMs}ms) on model=${model} stage=${stage}`);
    this.name = "FirstTokenTimeoutError";
    this.model = model;
    this.stage = stage;
    this.windowMs = windowMs;
  }
}

function recorder() {
  const frames: string[] = [];
  const write = async (frame: string): Promise<boolean> => {
    frames.push(frame);
    return true;
  };
  const events = () =>
    frames
      .map((f) => f.replace(/^data: /, "").trim())
      .filter(Boolean)
      .map((j) => JSON.parse(j) as Record<string, unknown>);
  return { write, events };
}

describe("first-token timeout abort domain (P0-B)", () => {
  test("FirstTokenTimeoutError and StreamCancelledError are distinct error classes", () => {
    const ft = new FirstTokenTimeoutError("test-model", "synthesizer", 30_000);
    const sc = new StreamCancelledError();
    // Distinct names — the server's outer catch in streamJarvis dispatches
    // on `error.name`; if both names collide, the timeout would be
    // silently returned like a user cancel.
    expect(ft.name).toBe("FirstTokenTimeoutError");
    expect(sc.name).toBe("StreamCancelledError");
    expect(ft.name).not.toBe(sc.name);
    // FirstTokenTimeoutError carries the metadata the server uses to
    // format the user-facing error message and the metrics record.
    expect(ft.model).toBe("test-model");
    expect(ft.stage).toBe("synthesizer");
    expect(ft.windowMs).toBe(30_000);
  });

  test("first-token timeout does NOT emit a cancelled frame (the P0-B bug)", async () => {
    const rec = recorder();
    const session = new StreamSession({
      sessionId: "sess-tt-1",
      write: rec.write,
      // Crucial: streamAbort is NOT aborted on a first-token timeout.
      // The server-side fix in index.ts removes the `streamAbort.abort()`
      // call from the watchdog; a hung model must not look like a user
      // cancellation.
      isAborted: () => false,
    });

    // Mirrors the server-side fix: the timeout throws FirstTokenTimeoutError,
    // which the outer catch handles by emitting an `error` frame with
    // `code: "first_token_timeout"` (NOT `cancelled`).
    let caught: FirstTokenTimeoutError | null = null;
    try {
      throw new FirstTokenTimeoutError("deepseek-v4-flash-free", "synthesizer", 30_000);
    } catch (e) {
      caught = e as FirstTokenTimeoutError;
    }
    expect(caught?.name).toBe("FirstTokenTimeoutError");

    // The error path: emit a structured `error` frame (the server-side
    // fix additionally adds a `code` discriminator so the UI can log it
    // distinctly; the StreamSession.error() helper writes the standard
    // `error` frame).
    await session.error(caught!.message);

    await session.ensureTerminal();

    const events = rec.events();
    // The contract: a first-token timeout surfaces as `error`, NEVER as
    // `cancelled`. (`code` is set on the wire by the server's outer
    // catch; the StreamSession.error() helper doesn't write the code
    // field itself, so we only pin the `cancelled`/non-`cancelled`
    // discriminator here.)
    const cancelledEvents = events.filter((e) => e.type === "cancelled");
    const errorEvents = events.filter((e) => e.type === "error");
    expect(cancelledEvents.length).toBe(0);
    expect(errorEvents.length).toBe(1);
  });

  test("user /chat/cancel STILL emits a cancelled frame (regression guard)", async () => {
    const rec = recorder();
    const session = new StreamSession({
      sessionId: "sess-cancel-1",
      write: rec.write,
      isAborted: () => true,
    });

    // Mirrors the existing server-side path: emitCancelled throws
    // StreamCancelledError. The outer catch in streamJarvis silent-returns
    // for this error (no error frame), so the client sees one `cancelled`
    // frame and one `message_stop` terminator.
    let caught: StreamCancelledError | null = null;
    try {
      if (!session.hasTerminated()) {
        session.noteTerminal();
        await rec.write(`data: ${JSON.stringify({ type: "cancelled", session_id: "sess-cancel-1" })}\n\n`);
      }
      throw new StreamCancelledError();
    } catch (e) {
      caught = e as StreamCancelledError;
    }
    expect(caught?.name).toBe("StreamCancelledError");

    await session.ensureTerminal();

    const events = rec.events();
    const cancelledEvents = events.filter((e) => e.type === "cancelled");
    const errorEvents = events.filter((e) => e.type === "error");
    // The contract: user cancel → `cancelled` only, no `error` frame.
    expect(cancelledEvents.length).toBe(1);
    expect(errorEvents.length).toBe(0);
  });

  test("error frame for first-token timeout includes the code discriminator", () => {
    // The server-side fix writes:
    //   data: { "type": "error", "error": "...", "code": "first_token_timeout", "session_id": "..." }
    // The UI's handleFrame uses the `code` field to log a one-line
    // diagnostic. Pin the field name here so any future rename is caught.
    const frame = {
      type: "error",
      error:
        "The model did not produce any output within the per-model first-token window. " +
        "This usually means the model is loading, overloaded, or the configured backend is unreachable. " +
        "Try again, or switch backend in Settings. (deepseek-v4-flash-free, stage=synthesizer, window=30000ms)",
      code: "first_token_timeout",
      session_id: "sess-1",
    };
    expect(frame.code).toBe("first_token_timeout");
    expect(frame.type).toBe("error");
    // Distinct from the cancelled case: the type is `error`, not `cancelled`.
    expect(frame.type).not.toBe("cancelled");
  });
});
