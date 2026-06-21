import { describe, expect, test } from "bun:test";
import { ReasoningParser, stripReasoningFromText } from "./reasoning";

describe("ReasoningParser", () => {
  test("successfully parses  tags", () => {
    const parser = new ReasoningParser("session-1");
    const events1 = parser.processChunk("<think>Checking status...</think>I am here.");

    expect(events1).toEqual([
      {
        type: "reasoning_chunk",
        text: "Checking status...",
      },
      {
        type: "reasoning_step",
        step: {
          type: "thought",
          content: "Checking status...",
          timestamp: expect.any(Number),
        },
      },
      {
        type: "content",
        text: "I am here.",
      },
    ]);
  });

  test("handles Qwen style tags split across multiple chunks", () => {
    const parser = new ReasoningParser("session-2");

    const events1 = parser.processChunk("Hello! <think>Let me");
    expect(events1).toEqual([
      { type: "content", text: "Hello! " },
      { type: "reasoning_chunk", text: "Let me" },
    ]);

    const events2 = parser.processChunk(" think about this.</think>Done thinking.");
    expect(events2).toEqual([
      {
        type: "reasoning_chunk",
        text: " think about this.",
      },
      {
        type: "reasoning_step",
        step: {
          type: "thought",
          content: "Let me think about this.",
          timestamp: expect.any(Number),
        },
      },
      {
        type: "content",
        text: "Done thinking.",
      },
    ]);
  });

  test("stripReasoningFromText removes reasoning tags and leaves visible text", () => {
    const visible = stripReasoningFromText("Prefix <think>hidden</think>Visible");
    expect(visible).toBe("Prefix Visible");
  });

  test("finalize returns a complete trace", () => {
    const parser = new ReasoningParser("session-3");
    parser.processChunk("<think>First</think>");
    const trace = parser.finalize();

    expect(trace.session_id).toBe("session-3");
    expect(trace.steps).toHaveLength(1);
    expect(trace.is_complete).toBe(true);
  });
});
