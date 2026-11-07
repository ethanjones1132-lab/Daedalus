import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import { createToolTraceObserver } from "./tool-trace";
import { PipelineExecutor } from "./pipeline";

function toolDefinition(name: string) {
  return {
    type: "function" as const,
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  };
}

function createExecutor(onToolTrace: (event: any) => void, onToolResult: (call: any, result: any) => void) {
  const runtime = createToolRuntime();
  const ctx = makeExecutionContext("agent", defaultConfig(), {
    session_id: "trace-session",
    workspace_path: process.cwd(),
    onToolTrace,
    onToolResult,
  });
  return new PipelineExecutor(async () => ({ content: "unused" }) as any, runtime, ctx, { recordStageRun: () => {} });
}

describe("PipelineExecutor tool trace coverage", () => {
  test("publishes a real Tool runtime read exactly once across batch and runToolCall", async () => {
    const frames: any[] = [];
    const nativeResults: any[] = [];
    const observer = createToolTraceObserver("trace-session", (frame) => frames.push(frame));
    const executor = createExecutor(observer, (call, result) => nativeResults.push({ call, result }));
    (executor as any).runtime.register(toolDefinition("read_file"), async () => "fixture bytes");

    await (executor as any).dispatchToolCalls(
      "executor",
      [{ id: "read-1", function: { name: "read_file", arguments: JSON.stringify({ path: "fixture.txt" }) } }],
      {},
      async () => {},
    );

    expect(frames).toEqual([
      { type: "tool_use", id: "read-1", name: "read_file", input: { path: "fixture.txt" }, session_id: "trace-session" },
      { type: "tool_result", call_id: "read-1", name: "read_file", output: "fixture bytes", is_error: false, session_id: "trace-session" },
    ]);
    expect(nativeResults).toHaveLength(1);
    expect(nativeResults[0].result.output).toBe("fixture bytes");
  });

  test("preserves a synthesized call ID across batch tracing and runtime execution", async () => {
    const frames: any[] = [];
    const nativeResults: any[] = [];
    const observer = createToolTraceObserver("trace-session", (frame) => frames.push(frame));
    const executor = createExecutor(observer, (call, result) => nativeResults.push({ call, result }));
    (executor as any).runtime.register(toolDefinition("read_file"), async () => "fixture bytes");

    await (executor as any).dispatchToolCalls(
      "executor",
      [{ function: { name: "read_file", arguments: JSON.stringify({ path: "fixture.txt" }) } }],
      {},
      async () => {},
    );

    expect(frames).toHaveLength(2);
    expect(frames[0].type).toBe("tool_use");
    expect(frames[0].id).toMatch(/^call_/);
    expect(frames[1]).toMatchObject({ type: "tool_result", call_id: frames[0].id, output: "fixture bytes" });
    expect(nativeResults).toHaveLength(1);
    expect(nativeResults[0].call.id).toBe(frames[0].id);
    expect(nativeResults[0].result.call_id).toBe(frames[0].id);
  });

  test("traces session-memory cache results without changing native runtime-only evidence", async () => {
    const frames: any[] = [];
    const nativeResults: any[] = [];
    const observer = createToolTraceObserver("trace-session", (frame) => frames.push(frame));
    const executor = createExecutor(observer, (call, result) => nativeResults.push({ call, result }));
    const call = { id: "cached-1", name: "read_file", arguments: { path: "cached.txt" } };
    const sessionMemory = {
      lookupCachedToolResult: () => "cached file contents",
      recordToolResult: () => { throw new Error("cache hit must not be recorded as a fresh runtime result"); },
    };

    const result = await (executor as any).runToolCall(call, { sessionMemory });

    expect(result.output).toBe("cached file contents");
    expect(frames.map((frame) => frame.type)).toEqual(["tool_use", "tool_result"]);
    expect(frames[1]).toMatchObject({ call_id: "cached-1", output: "cached file contents", is_error: false });
    expect(nativeResults).toEqual([]);
  });

  test("traces denied network and out-of-scope file calls as failed results", async () => {
    const frames: any[] = [];
    const observer = createToolTraceObserver("trace-session", (frame) => frames.push(frame));
    const executor = createExecutor(observer, () => {});
    const scope = {
      workspaceRoot: process.cwd(),
      allowedPaths: ["README.md"],
      allowRootListing: false,
      denyShell: true,
      denyNetwork: true,
    };

    const deniedWeb = await (executor as any).runToolCall(
      { id: "web-1", name: "web_fetch", arguments: { url: "https://example.invalid" } },
      { workspaceReadScope: scope },
    );
    const deniedPath = await (executor as any).runToolCall(
      { id: "path-1", name: "read_file", arguments: { path: "outside.txt" } },
      { workspaceReadScope: scope },
    );

    expect(deniedWeb.is_error).toBe(true);
    expect(deniedPath.is_error).toBe(true);
    expect(frames.map((frame) => [frame.type, frame.call_id ?? frame.id, frame.is_error])).toEqual([
      ["tool_use", "web-1", undefined],
      ["tool_result", "web-1", true],
      ["tool_use", "path-1", undefined],
      ["tool_result", "path-1", true],
    ]);
  });

  test("traces suppressed batch calls even though the Tool runtime is skipped", async () => {
    const frames: any[] = [];
    const observer = createToolTraceObserver("trace-session", (frame) => frames.push(frame));
    const executor = createExecutor(observer, () => {});
    (executor as any).conductor = {
      live: {
        toolIsSuppressed: () => true,
        toolRedirectNote: () => "use an available tool",
      },
    };

    await (executor as any).dispatchToolCalls(
      "executor",
      [{ id: "suppressed-1", function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://example.invalid" }) } }],
      {},
      async () => {},
    );

    expect(frames.map((frame) => [frame.type, frame.call_id ?? frame.id, frame.is_error])).toEqual([
      ["tool_use", "suppressed-1", undefined],
      ["tool_result", "suppressed-1", true],
    ]);
  });
});
