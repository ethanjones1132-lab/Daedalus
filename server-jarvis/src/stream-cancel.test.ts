import { describe, expect, test } from "bun:test";
import { StreamSession } from "./stream-emitter";

/** Mirrors the cancel contract in streamJarvis (index.ts). */
class StreamCancelledError extends Error {
  constructor() {
    super("stream cancelled");
    this.name = "StreamCancelledError";
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

describe("streamJarvis cancel contract", () => {
  test("cancelled stream emits one cancelled frame and no trailing message_stop", async () => {
    const rec = recorder();
    const session = new StreamSession({
      sessionId: "sess-1",
      write: rec.write,
      isAborted: () => true,
    });

    const emitCancelled = async (): Promise<never> => {
      if (!session.hasOutcome()) {
        session.noteOutcome();
        session.noteTerminal();
        await rec.write(`data: ${JSON.stringify({ type: "cancelled", session_id: "sess-1" })}\n\n`);
      }
      throw new StreamCancelledError();
    };

    let caught: StreamCancelledError | null = null;
    try {
      await emitCancelled();
    } catch (e) {
      caught = e as StreamCancelledError;
    }
    expect(caught?.name).toBe("StreamCancelledError");

    await session.ensureTerminal();

    const events = rec.events();
    expect(events.filter((e) => e.type === "cancelled").length).toBe(1);
    expect(events.filter((e) => e.type === "message_stop").length).toBe(0);
  });

  test("error path still gets a single message_stop from ensureTerminal", async () => {
    const rec = recorder();
    const session = new StreamSession({
      sessionId: "sess-2",
      write: rec.write,
      isAborted: () => false,
    });

    await session.error("boom");
    await session.ensureTerminal();

    const events = rec.events();
    expect(events.filter((e) => e.type === "error").length).toBe(1);
    expect(events.filter((e) => e.type === "message_stop").length).toBe(1);
  });
});
