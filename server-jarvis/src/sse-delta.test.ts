import { describe, expect, test } from "bun:test";
import { extractDeltaText } from "./sse-delta";

describe("extractDeltaText", () => {
  test("visible content only", () => {
    expect(extractDeltaText({ delta: { content: "hi" } }))
      .toEqual({ visible: "hi", reasoning: "" });
  });

  test("deepseek-style reasoning_content", () => {
    expect(extractDeltaText({ delta: { reasoning_content: "thinking..." } }))
      .toEqual({ visible: "", reasoning: "thinking..." });
  });

  test("openrouter-style reasoning field", () => {
    expect(extractDeltaText({ delta: { reasoning: "hmm" } }))
      .toEqual({ visible: "", reasoning: "hmm" });
  });

  test("both present", () => {
    expect(extractDeltaText({ delta: { content: "a", reasoning_content: "b" } }))
      .toEqual({ visible: "a", reasoning: "b" });
  });

  test("missing delta", () => {
    expect(extractDeltaText({})).toEqual({ visible: "", reasoning: "" });
    expect(extractDeltaText(undefined)).toEqual({ visible: "", reasoning: "" });
  });
});
