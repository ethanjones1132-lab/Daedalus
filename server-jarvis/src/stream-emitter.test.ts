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

  // ── Defense-in-depth: bare-JSON tool lines (P0-A follow-up) ──
  // VisibleTextPipe is the single source of truth for user-visible text in
  // the direct chat path. It must strip BOTH tagged tool markup AND bare
  // tool-JSON lines, so a model which hallucinates either form does not
  // leak it into the visible chat bubble. These three tests pin the
  // post-VisibleAnswerStreamSanitizer behavior in this class.

  test("VisibleTextPipe strips bare JSON tool lines, not just tags", async () => {
    const rec = recorder();
    const pipe = new VisibleTextPipe({ sessionId: "s5", reasoningEnabled: false, write: rec.write });
    await pipe.push('{"name":"read_file","arguments":{"path":"README.md"}}\n');
    await pipe.push("Here is the summary.");
    await pipe.finish();

    expect(visibleText(rec.events())).toBe("Here is the summary.");
  });

  test("VisibleTextPipe strips tool JSON embedded after mixed prose", async () => {
    const rec = recorder();
    const pipe = new VisibleTextPipe({ sessionId: "s6", reasoningEnabled: false, write: rec.write });
    await pipe.push('Result: {"name":"read_file","arguments":{"path":"README.md"}}\n');
    await pipe.finish();

    expect(visibleText(rec.events())).toBe("Result:\n");
  });

  test("VisibleTextPipe keeps fenced JSON tool examples intact", async () => {
    const rec = recorder();
    const pipe = new VisibleTextPipe({ sessionId: "s7", reasoningEnabled: false, write: rec.write });
    const fenced = "```json\n{\"name\":\"read_file\",\"arguments\":{\"path\":\".\"}}\n```\n";
    await pipe.push(fenced);
    await pipe.finish();

    expect(visibleText(rec.events())).toBe(fenced);
  });
});

describe("StreamSession terminal guarantee", () => {
  test("terminal no-write pipeline failure emits a typed SSE error without stale answer text", async () => {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const response = new Response(readable, {
      headers: { "Content-Type": "text/event-stream" },
    });
    const pipelineResult = {
      answer: "### Task 1: stale planner prose that must never reach the client",
      error_code: "effect_gate_no_write_effect",
    };
    const session = new StreamSession({
      sessionId: "s-effect-gate",
      write: async (frame) => {
        await writer.write(encoder.encode(frame));
        return true;
      },
      isAborted: () => false,
    });

    const emission = (async () => {
      await session.finish(pipelineResult.answer, {
        isError: true,
        code: pipelineResult.error_code,
      });
      await session.ensureTerminal();
      await writer.close();
    })();
    const body = await response.text();
    await emission;
    const events = body
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice("data: ".length)) as Record<string, any>);

    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        type: "error",
        code: "effect_gate_no_write_effect",
        session_id: "s-effect-gate",
      }),
    ]);
    expect(events.some((event) => event.type === "result")).toBe(false);
    expect(body).not.toContain(pipelineResult.answer);
    expect(events.filter((event) => event.type === "message_stop")).toHaveLength(1);
  });

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

  // ── DD-205: `is_error` is derived from the subtype in one place ──
  // A caller that only supplies `{ subtype: "error" }` must still produce a
  // frame the Rust relay can surface as `jarvis://error`; an explicit
  // `isError` always wins; and the plain success frame is unchanged.

  test("an error subtype with no explicit isError emits is_error true", async () => {
    const rec = recorder();
    const session = new StreamSession({ sessionId: "s-dd205-error", write: rec.write, isAborted: () => false });

    await session.finish("execution failed mid-turn", { subtype: "error", code: "error_during_execution" });

    const results = rec.events().filter((e) => e.type === "result");
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({
      type: "result",
      subtype: "error",
      is_error: true,
      code: "error_during_execution",
      result: "execution failed mid-turn",
      session_id: "s-dd205-error",
    });
  });

  test("an explicit isError false with a success subtype still emits is_error false", async () => {
    const rec = recorder();
    const session = new StreamSession({ sessionId: "s-dd205-explicit", write: rec.write, isAborted: () => false });

    await session.finish("the answer", { isError: false, subtype: "success" });

    const results = rec.events().filter((e) => e.type === "result");
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({ subtype: "success", is_error: false, result: "the answer" });
  });

  test("a default frame (no subtype, no isError) still emits is_error false and subtype success", async () => {
    const rec = recorder();
    const session = new StreamSession({ sessionId: "s-dd205-default", write: rec.write, isAborted: () => false });

    await session.finish("the answer");

    const results = rec.events().filter((e) => e.type === "result");
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "the answer",
      session_id: "s-dd205-default",
    });
  });

  test("an explicit isError true without a subtype emits subtype error and is_error true", async () => {
    const rec = recorder();
    const session = new StreamSession({ sessionId: "s-dd205-flag", write: rec.write, isAborted: () => false });

    await session.finish("failed", { isError: true });

    const results = rec.events().filter((e) => e.type === "result");
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({ subtype: "error", is_error: true, result: "failed" });
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

  test("ensureTerminal emits an error outcome when a path ends without any outcome", async () => {
    const rec = recorder();
    const session = new StreamSession({ sessionId: "s6-missing", write: rec.write, isAborted: () => false });

    await session.ensureTerminal();

    const events = rec.events();
    const outcomes = events.filter((e) => ["result", "error", "cancelled"].includes(e.type));
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]).toMatchObject({
      type: "error",
      code: "stream_ended_without_outcome",
      session_id: "s6-missing",
    });
    expect(events.filter((e) => e.type === "message_stop").length).toBe(1);
  });

  test("late outcome attempts cannot create a second terminal outcome", async () => {
    const rec = recorder();
    const session = new StreamSession({ sessionId: "s6-dedupe", write: rec.write, isAborted: () => false });

    await session.finish("the answer");
    await session.error("too late");
    await session.ensureTerminal();

    const outcomes = rec.events().filter((e) => ["result", "error", "cancelled"].includes(e.type));
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]).toMatchObject({ type: "result", result: "the answer" });
  });
  test("ensureTerminal is a no-op once finish has terminated the stream", async () => {
    const rec = recorder();
    const session = new StreamSession({ sessionId: "s7", write: rec.write, isAborted: () => false });
    await session.finish("done");
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

  test("an external message_stop does not suppress the missing-outcome error", async () => {
    const rec = recorder();
    const session = new StreamSession({ sessionId: "s9", write: rec.write, isAborted: () => false });
    session.noteTerminal(); // e.g. a forwarded CLI message_stop, which is transport-only
    await session.ensureTerminal();
    const events = rec.events();
    expect(events.filter((e) => e.type === "message_stop").length).toBe(0);
    expect(events.filter((e) => e.type === "error").length).toBe(1);
  });
});
