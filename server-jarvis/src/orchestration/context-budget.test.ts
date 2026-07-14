import { describe, expect, test } from "bun:test";
import { countTokens } from "../tokens";
import {
  buildBoundedHistoryBlock,
  enforceTranscriptBudget,
  truncateToTokenBudget,
} from "./context-budget";

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

  test("zero history budget returns no transcript", () => {
    expect(buildBoundedHistoryBlock([{ role: "user", content: "do not replay" }], 0)).toBe("");
  });

  test("truncates dynamic payloads while retaining both ends", () => {
    const value = `latest request ${"a".repeat(4_000)} final write_file success`;
    const output = truncateToTokenBudget(value, 80);
    expect(countTokens(output)).toBeLessThanOrEqual(80);
    expect(output).toContain("latest request");
    expect(output).toContain("write_file success");
  });
});

describe("enforceTranscriptBudget", () => {
  test("evicts oldest eligible runtime payloads and preserves the newest result", () => {
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "request" },
      { role: "assistant", content: "turn one" },
      { role: "tool", name: "read_file", tool_call_id: "old", content: "a".repeat(4_000) },
      { role: "assistant", content: "turn two" },
      { role: "tool", name: "read_file", tool_call_id: "new", content: "b".repeat(4_000) },
    ];

    const result = enforceTranscriptBudget(messages, 500);

    expect(result.evicted).toBe(1);
    expect(messages[3].content).toContain("earlier read_file result");
    expect(messages[5].content).toBe("b".repeat(4_000));
    expect(messages[3].tool_call_id).toBe("old");
    expect(result.inputTokens).toBe(countTokens(JSON.stringify(messages)));
  });

  test("evicts tagged preflight carriers, but not ordinary user nudges", () => {
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "request" },
      { role: "user", content: `[Runtime preflight: list_directory]\n${"x".repeat(4_000)}` },
      { role: "user", content: `Remember this: ${"y".repeat(4_000)}` },
      { role: "assistant", content: "done" },
    ];

    const result = enforceTranscriptBudget(messages, 500);

    expect(result.evicted).toBe(1);
    expect(messages[2].content).toContain("elided to fit context budget");
    expect(messages[3].content).toContain("Remember this:");
  });

  test("is idempotent and never evicts the turn-one seed", () => {
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "request" },
      { role: "user", content: `[Runtime preflight: list_directory]\n${"x".repeat(4_000)}` },
    ];

    const first = enforceTranscriptBudget(messages, 1);
    const second = enforceTranscriptBudget(messages, 1);

    expect(first.evicted).toBe(0);
    expect(second.evicted).toBe(0);
    expect(messages[2].content).toContain("Runtime preflight");
  });
});
