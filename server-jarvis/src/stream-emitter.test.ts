import { describe, expect, test } from "bun:test";
import { StreamSession, VisibleTextPipe } from "./stream-emitter";

/** Collects SSE frames and exposes parsed payloads for assertions. */
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
      .map((j) => JSON.parse(j) as Record<string, any>);
  return { write, events };
}

/** Concatenates the visible text from every stream_event frame. */
function visibleText(events: Record<string, any>[]): string {
  return events
    .filter((e) => e.type === "stream_event")
    .map((e) => e.delta?.text ?? "")
    .join("");
}

describe("VisibleTextPipe", () => {
  test("strips <think> reasoning from visible text even when reasoning is disabled", async () => {
    const rec = recorder();
    const pipe = new VisibleTextPipe({ sessionId: "s1", reasoningEnabled: false, write: rec.write });
    await pipe.push("<think>secret planning</think>Hello world");
    await pipe.finish();

    const events = rec.events();
    expect(visibleText(events)).toBe("Hello world");
    // No reasoning events leak to the client when disabled.
    expect(events.some((e) => e.type.startsWith("reasoning"))).toBe(false);
  });

  test("forwards reasoning events when enabled, still keeping them out of visible text", async () => {
    const rec = recorder();
    const pipe = new VisibleTextPipe({ sessionId: "s2", reasoningEnabled: true, write: rec.write });
    await pipe.push("<think>secret planning</think>Hello world");
    await pipe.finish();

    const events = rec.events();
    expect(visibleText(events)).toBe("Hello world");
    expect(events.some((e) => e.type === "reasoning_step")).toBe(true);
    expect(events.some((e) => e.type === "reasoning_complete")).toBe(true);
  });

  test("never leaks <tool_call> markup into visible text", async () => {
    const rec = recorder();
    const pipe = new VisibleTextPipe({ sessionId: "s3", reasoningEnabled: false, write: rec.write });
    await pipe.push('Sure. <tool_call>{"name":"web_search","arguments":{}}</tool_call>Done.');
    await pipe.finish();

    expect(visibleText(rec.events())).toBe("Sure. Done.");
  });

  test("strips reasoning even when split across chunk boundaries", async () => {
    const rec = recorder();
    const pipe = new VisibleTextPipe({ sessionId: "s4", reasoningEnabled: false, write: rec.write });
    await pipe.push("<thi");
    await pipe.push("nk>hidden</thi");
    await pipe.push("nk>visible");
    await pipe.finish();

    expect(visibleText(rec.events())).toBe("visible");
  });
});

describe("StreamSession terminal guarantee", () => {
  test("finish emits exactly one message_stop plus result and is idempotent", async () => {
    const rec = recorder();
    const session = new StreamSession({ sessionId: "s5", write: rec.write, isAborted: () => false });
    await session.finish("the answer");
    await session.finish("ignored second call");
    await session.ensureTerminal();

    const stops = rec.events().filter((e) => e.type === "message_stop");
    const results = rec.events().filter((e) => e.type === "result");
    expect(stops.length).toBe(1);
    expect(results.length).toBe(1);
    expect(results[0].result).toBe("the answer");
  });

  test("ensureTerminal emits a terminator when nothing else did (the decode-error fix)", async () => {
    const rec = recorder();
    const session = new StreamSession({ sessionId: "s6", write: rec.write, isAborted: () => false });
    // Simulate a path that errored before sending message_stop.
    await session.error("boom");
    await session.ensureTerminal();

    const events = rec.events();
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.filter((e) => e.type === "message_stop").length).toBe(1);
  });

  test("ensureTerminal is a no-op once finish has terminated the stream", async () => {
    const rec = recorder();
    const session = new StreamSession({ sessionId: "s7", write: rec.write, isAborted: () => false });
    await session.finish();
    await session.ensureTerminal();
    expect(rec.events().filter((e) => e.type === "message_stop").length).toBe(1);
  });

  test("ensureTerminal writes nothing when the client has disconnected", async () => {
    const rec = recorder();
    const session = new StreamSession({ sessionId: "s8", write: rec.write, isAborted: () => true });
    await session.ensureTerminal();
    expect(rec.events().length).toBe(0);
    expect(session.hasTerminated()).toBe(true);
  });

  test("noteTerminal prevents a duplicate terminator for externally-emitted stops", async () => {
    const rec = recorder();
    const session = new StreamSession({ sessionId: "s9", write: rec.write, isAborted: () => false });
    session.noteTerminal(); // e.g. a forwarded CLI message_stop
    await session.ensureTerminal();
    expect(rec.events().length).toBe(0);
  });
});
