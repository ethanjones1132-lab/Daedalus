import { describe, expect, test } from "bun:test";
import { ReasoningParser, stripReasoningFromText } from "./reasoning";

describe("ReasoningParser", () => {
  test("successfully parses <think>...</think> tags", () => {
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