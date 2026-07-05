import { describe, expect, test } from "bun:test";
import { countTokens } from "../tokens";
import { buildBoundedHistoryBlock } from "./context-budget";

describe("buildBoundedHistoryBlock", () => {
  test("respects the history-line token budget", () => {
    const history = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index} ${"x".repeat(60)}`,
    }));
    const output = buildBoundedHistoryBlock(history, 45, 1_000);
    const selectedLines = output.split("\n").filter((line) => /^\[(USER|ASSISTANT)\]:/.test(line));
    expect(countTokens(selectedLines.join("\n"))).toBeLessThanOrEqual(45);
  });

  test("keeps newest messages and includes an omission marker", () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      role: "user",
      content: `history-message-${index} ${"z".repeat(80)}`,
    }));
    const output = buildBoundedHistoryBlock(history, 40, 1_000);
    expect(output).toContain("history-message-9");
    expect(output).not.toContain("history-message-0");
    expect(output).toContain("earlier message(s) omitted for context budget");
  });

  test("leaves small histories untouched", () => {
    const history = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    expect(buildBoundedHistoryBlock(history)).toBe("[USER]: hello\n[ASSISTANT]: hi");
  });
});
