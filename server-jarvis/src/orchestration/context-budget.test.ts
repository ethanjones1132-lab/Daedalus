import { describe, expect, test } from "bun:test";
import { countTokens } from "../tokens";
import {
  buildBoundedHistoryBlock,
  compactCompletedExecutorCycles,
  enforceTranscriptBudget,
  stableTranscriptHeadEnd,
  stableTranscriptHeadPrefix,
  truncateToTokenBudget,
  type TranscriptMessage,
} from "./context-budget";
import type { ToolCallRecord } from "./stage-output";

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

describe("compactCompletedExecutorCycles", () => {
  const writePressure =
    "This turn is a CHANGE request. You have write tools available " +
    "(write_file, edit_file, multi_edit, apply_patch). Apply the requested change.";

  function tool(
    name: string,
    path: string,
    is_error = false,
  ): ToolCallRecord {
    return {
      name,
      arguments: { path },
      output: is_error ? "failed" : "ok",
      is_error,
      duration_ms: 1,
    };
  }

  test("compacts older completed cycles into an evidence checkpoint and keeps the newest pair", () => {
    const messages: TranscriptMessage[] = [
      { role: "system", content: "You are the executor." },
      { role: "user", content: "Implement the filter change in src/a.cpp" },
      // completed cycle 1
      {
        role: "assistant",
        content: "Reading a.cpp first.",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/a.cpp\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "c1", content: "file a content ".repeat(80) },
      // completed cycle 2
      {
        role: "assistant",
        content: "Now reading b.cpp for context.",
        tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/b.cpp\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "c2", content: "file b content ".repeat(80) },
      // completed cycle 3
      {
        role: "assistant",
        content: "Writing the filter change.",
        tool_calls: [{ id: "c3", type: "function", function: { name: "write_file", arguments: "{\"path\":\"src/a.cpp\"}" } }],
      },
      { role: "tool", name: "write_file", tool_call_id: "c3", content: "written ".repeat(40) },
      // duplicate write-pressure user messages
      { role: "user", content: writePressure },
      { role: "user", content: writePressure },
      // current tool-call pair (newest assistant + matching tool results)
      {
        role: "assistant",
        content: "Reading back the write target.",
        tool_calls: [{ id: "c4", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/a.cpp\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "c4", content: "post-write a.cpp body ".repeat(60) },
    ];

    const toolCalls: ToolCallRecord[] = [
      tool("read_file", "src/a.cpp"),
      tool("read_file", "src/b.cpp"),
      tool("write_file", "src/a.cpp"),
      tool("read_file", "src/a.cpp"),
    ];

    const result = compactCompletedExecutorCycles(messages, toolCalls, 2_000);

    expect(result.compactedCycles).toBeGreaterThanOrEqual(1);
    expect(messages[0].content).toBe("You are the executor.");
    expect(messages[1].content).toBe("Implement the filter change in src/a.cpp");
    expect(messages.some((message) => message.content ===
      "[Evidence checkpoint]\nreads: src/a.cpp, src/b.cpp\nwrites: src/a.cpp\nfailed: none"
    )).toBe(true);

    // Superseded early assistant prose is gone
    expect(messages.some((m) => m.role === "assistant" && m.content === "Reading a.cpp first.")).toBe(false);
    expect(messages.some((m) => m.role === "assistant" && m.content === "Now reading b.cpp for context.")).toBe(false);

    // Newest assistant + matching tool result unchanged
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toBe("Reading back the write target.");
    const lastTool = messages[messages.length - 1];
    expect(lastTool.role).toBe("tool");
    expect(lastTool.content).toBe("post-write a.cpp body ".repeat(60));
    expect(lastTool.tool_call_id).toBe("c4");

    // Duplicate pressure collapsed to at most one
    const pressureCount = messages.filter(
      (m) => m.role === "user" && m.content.includes("CHANGE request") && m.content.includes("write tools"),
    ).length;
    expect(pressureCount).toBeLessThanOrEqual(1);

    expect(result.inputTokens).toBeLessThanOrEqual(2_000);
    expect(result.inputTokens).toBe(countTokens(JSON.stringify(messages)));
  });

  test("does not split a retained assistant tool_calls from its tool results", () => {
    const messages: TranscriptMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "do work" },
      {
        role: "assistant",
        content: "old",
        tool_calls: [{ id: "old", type: "function", function: { name: "read_file", arguments: "{\"path\":\"x\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "old", content: "x".repeat(500) },
      {
        role: "assistant",
        content: "mid",
        tool_calls: [{ id: "mid", type: "function", function: { name: "read_file", arguments: "{\"path\":\"y\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "mid", content: "y".repeat(500) },
      {
        role: "assistant",
        content: "new",
        tool_calls: [{ id: "new", type: "function", function: { name: "read_file", arguments: "{\"path\":\"z\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "new", content: "z".repeat(500) },
    ];
    const toolCalls = [
      tool("read_file", "x"),
      tool("read_file", "y"),
      tool("read_file", "z"),
    ];

    compactCompletedExecutorCycles(messages, toolCalls, 3_000);

    const assistantIdx = messages.findIndex((m) => m.role === "assistant" && m.content === "new");
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(messages[assistantIdx + 1]?.role).toBe("tool");
    expect(messages[assistantIdx + 1]?.tool_call_id).toBe("new");
  });

  // pipeline.ts write contract uses write_file list / "file-writing tool", not
  // the phrase "write tools" — was silently dropped by compaction.
  test("preserves [Runtime write contract] as write-pressure across compaction", () => {
    const writeContract =
      "[Runtime write contract] This is a CHANGE request. The stage is complete only after at least one successful write_file / edit_file / multi_edit / apply_patch call. Read what you need first, then APPLY the change with a tool call and read the file back to verify — code or diffs written as prose do not modify any file.";
    const messages: TranscriptMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "edit src/a.cpp" },
      { role: "user", content: writeContract },
      {
        role: "assistant",
        content: "old",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/a.cpp\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "c1", content: "a".repeat(400) },
      {
        role: "assistant",
        content: "mid",
        tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/b.cpp\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "c2", content: "b".repeat(400) },
      {
        role: "assistant",
        content: "new",
        tool_calls: [{ id: "c3", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/c.cpp\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "c3", content: "c".repeat(400) },
    ];
    const toolCalls = [
      tool("read_file", "src/a.cpp"),
      tool("read_file", "src/b.cpp"),
      tool("read_file", "src/c.cpp"),
    ];

    compactCompletedExecutorCycles(messages, toolCalls, 4_000);

    const contracts = messages.filter(
      (m) => m.role === "user" && m.content.includes("[Runtime write contract]"),
    );
    expect(contracts.length).toBe(1);
    expect(contracts[0].content).toContain("write_file");
  });

  // M2: compaction must only rewrite the TAIL. The stable head prefix
  // (system + original user request) must remain byte-identical so provider
  // prompt-cache prefixes stay valid across mid-loop turns.
  test("preserves a byte-identical stable head prefix after compact", () => {
    const messages: TranscriptMessage[] = [
      { role: "system", content: "You are the executor.\nStable stage prompt v1." },
      { role: "user", content: "Implement the filter change in src/a.cpp" },
      {
        role: "assistant",
        content: "old-cycle",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/a.cpp\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "c1", content: "a".repeat(800) },
      {
        role: "assistant",
        content: "mid-cycle",
        tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/b.cpp\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "c2", content: "b".repeat(800) },
      {
        role: "assistant",
        content: "new-cycle",
        tool_calls: [{ id: "c3", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/c.cpp\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "c3", content: "c".repeat(800) },
    ];
    const toolCalls = [
      tool("read_file", "src/a.cpp"),
      tool("read_file", "src/b.cpp"),
      tool("read_file", "src/c.cpp"),
    ];

    const headEnd = stableTranscriptHeadEnd(messages);
    expect(headEnd).toBe(2);
    const headPrefixBefore = stableTranscriptHeadPrefix(messages);
    // Prefix length N for the byte-identity check (full head serialization).
    const prefixLenN = headPrefixBefore.length;
    expect(prefixLenN).toBeGreaterThan(20);

    const result = compactCompletedExecutorCycles(messages, toolCalls, 2_000);

    expect(result.compactedCycles).toBeGreaterThanOrEqual(1);
    const headPrefixAfter = stableTranscriptHeadPrefix(messages);
    expect(headPrefixAfter).toBe(headPrefixBefore);
    expect(headPrefixAfter.slice(0, prefixLenN)).toBe(headPrefixBefore.slice(0, prefixLenN));
    // Head message objects themselves are the original contents.
    expect(messages[0].content).toBe("You are the executor.\nStable stage prompt v1.");
    expect(messages[1].content).toBe("Implement the filter change in src/a.cpp");
    // Tail was rewritten (checkpoint present; early assistant prose gone).
    expect(messages.some((m) => m.content.includes("[Evidence checkpoint]"))).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.content === "old-cycle")).toBe(false);
  });

  // Carried evidence sits after the seed (index 2) and was discarded once
  // compaction rewrote the gap to checkpoint-only.
  test("preserves [Runtime carried evidence] across compaction", () => {
    const carried =
      "[Runtime carried evidence] These results came from an earlier executor segment. " +
      "Reuse them; do not rediscover the same targets.\n- read_file {\"path\":\"src/a.ts\"}\nfile a";
    const messages: TranscriptMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "continue the edit" },
      { role: "user", content: carried },
      {
        role: "assistant",
        content: "old",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/b.ts\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "c1", content: "b".repeat(400) },
      {
        role: "assistant",
        content: "mid",
        tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/c.ts\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "c2", content: "c".repeat(400) },
      {
        role: "assistant",
        content: "new",
        tool_calls: [{ id: "c3", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/d.ts\"}" } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "c3", content: "d".repeat(400) },
    ];
    const toolCalls = [
      tool("read_file", "src/b.ts"),
      tool("read_file", "src/c.ts"),
      tool("read_file", "src/d.ts"),
    ];

    compactCompletedExecutorCycles(messages, toolCalls, 4_000);

    const survivors = messages.filter(
      (m) => m.role === "user" && m.content.includes("[Runtime carried evidence]"),
    );
    expect(survivors.length).toBe(1);
    expect(survivors[0].content).toContain("src/a.ts");
  });
});
