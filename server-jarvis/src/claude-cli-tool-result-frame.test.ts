import { describe, expect, it } from "bun:test";
import { buildCliToolResultFrame } from "./cli-tool-result-frame";

const TOOL_USE_ID = "toolu_01AbCdEfGhIjKlMnOpQrStUv";

describe("buildCliToolResultFrame", () => {
  it("names the call the tool card opened: call_id equals the tool use id", () => {
    const frame = buildCliToolResultFrame({
      toolUseId: TOOL_USE_ID,
      output: "42 files changed",
      isError: false,
      sessionId: "sess-1",
    });

    expect(frame.type).toBe("tool_result");
    expect(frame.id).toBe(TOOL_USE_ID);
    expect(frame.call_id).toBe(TOOL_USE_ID);
    expect(frame.call_id).toBe(frame.id);
  });

  it("keeps output, is_error, and session_id", () => {
    const frame = buildCliToolResultFrame({
      toolUseId: TOOL_USE_ID,
      output: "ENOENT: no such file",
      isError: true,
      sessionId: "sess-1",
    });

    expect(frame.output).toBe("ENOENT: no such file");
    expect(frame.is_error).toBe(true);
    expect(frame.session_id).toBe("sess-1");
  });

  it("survives the SSE serialization the server writes (call_id reaches the wire)", () => {
    const frame = buildCliToolResultFrame({
      toolUseId: TOOL_USE_ID,
      output: "ok",
      isError: false,
      sessionId: "sess-1",
    });
    const wire = JSON.parse(JSON.stringify(frame));

    expect(wire.call_id).toBe(TOOL_USE_ID);
    expect(wire.id).toBe(TOOL_USE_ID);
    expect(wire.type).toBe("tool_result");
  });

  it("does not invent a tool use id when the CLI omits one", () => {
    const frame = buildCliToolResultFrame({
      toolUseId: undefined,
      output: "ok",
      isError: false,
      sessionId: "sess-1",
    });

    expect(frame.id).toBeUndefined();
    expect(frame.call_id).toBeUndefined();
    expect(Object.keys(frame)).not.toContain("id");
    expect(Object.keys(frame)).not.toContain("call_id");
    expect(JSON.parse(JSON.stringify(frame)).call_id).toBeUndefined();
  });

  it("treats null and blank tool use ids as missing rather than fabricating one", () => {
    for (const toolUseId of [null, "", "   "]) {
      const frame = buildCliToolResultFrame({
        toolUseId,
        output: "ok",
        sessionId: "sess-1",
      });
      expect(frame.id).toBeUndefined();
      expect(frame.call_id).toBeUndefined();
    }
  });

  it("passes a non-string output through unchanged", () => {
    const output = { content: [{ type: "text", text: "done" }] };
    const frame = buildCliToolResultFrame({
      toolUseId: TOOL_USE_ID,
      output,
      sessionId: "sess-1",
    });

    expect(frame.output).toBe(output);
  });
});
