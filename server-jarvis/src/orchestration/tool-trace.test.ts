import { describe, expect, test } from "bun:test";
import { createToolTraceObserver } from "./tool-trace";

const call = {
  id: "call-1",
  name: "read_file",
  arguments: { path: "notes.txt" },
};

describe("orchestrator tool trace observer", () => {
  test("serializes canonical use and result frames with session identity and deduplicates by call ID", () => {
    const frames: unknown[] = [];
    const observe = createToolTraceObserver("session-1", (frame) => frames.push(frame));
    const result = { call_id: call.id, name: call.name, output: "file contents", is_error: false, duration_ms: 4 };

    observe({ kind: "use", call });
    observe({ kind: "use", call });
    observe({ kind: "result", call, result });
    observe({ kind: "result", call, result });

    expect(frames).toEqual([
      { type: "tool_use", id: "call-1", name: "read_file", input: { path: "notes.txt" }, session_id: "session-1" },
      { type: "tool_result", call_id: "call-1", name: "read_file", output: "file contents", is_error: false, session_id: "session-1" },
    ]);
  });

  test("emits a use frame before a result that arrives without an earlier use", () => {
    const frames: unknown[] = [];
    const observe = createToolTraceObserver("session-2", (frame) => frames.push(frame));
    const result = { call_id: call.id, name: call.name, output: "denied", is_error: true, duration_ms: 0 };

    observe({ kind: "result", call, result });

    expect(frames).toEqual([
      { type: "tool_use", id: "call-1", name: "read_file", input: { path: "notes.txt" }, session_id: "session-2" },
      { type: "tool_result", call_id: "call-1", name: "read_file", output: "denied", is_error: true, session_id: "session-2" },
    ]);
  });

  test("swallows synchronous and asynchronous writer failures", async () => {
    const observeSync = createToolTraceObserver("session-3", () => {
      throw new Error("stream closed");
    });
    const observeAsync = createToolTraceObserver("session-3", async () => {
      throw new Error("writer rejected");
    });
    const result = { call_id: call.id, name: call.name, output: "ok", is_error: false, duration_ms: 1 };

    expect(() => observeSync({ kind: "use", call })).not.toThrow();
    expect(() => observeAsync({ kind: "result", call, result })).not.toThrow();
    await Promise.resolve();
  });
});
