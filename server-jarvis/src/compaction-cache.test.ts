import { describe, expect, test } from "bun:test";
import {
  applyCachedCompaction,
  getMessagesHash,
  type CompactionCacheEntry,
} from "./compaction-cache";

const summary = {
  role: "system",
  content: "[Previous conversation summary] The user asked about the build.",
};

function cachedEntry(originalHistory: Array<any>, originalLength: number): CompactionCacheEntry {
  return {
    originalLength,
    prefixHash: getMessagesHash(originalHistory.slice(0, originalLength)),
    summary,
  };
}

describe("applyCachedCompaction", () => {
  const originalHistory = [
    { role: "user", content: "turn one ask" },
    { role: "assistant", content: "turn one answer" },
    { role: "user", content: "turn two ask" },
    { role: "assistant", content: "turn two answer" },
  ];
  const cached = cachedEntry(originalHistory, 2);
  const firstIterationHistory = [
    summary,
    { role: "user", content: "turn two ask" },
    { role: "assistant", content: "turn two answer" },
  ];

  test("rebuilds from originalHistory on the first iteration of a user turn", () => {
    const result = applyCachedCompaction({
      activeHistory: [...originalHistory],
      originalHistory,
      cached,
      inTurnHistoryAppended: false,
    });

    expect(result.applied).toBe(true);
    expect(result.history).toEqual(firstIterationHistory);
  });

  test("keeps this turn's ask and tool results once the loop has appended them", () => {
    // Iteration 2 of the same turn: the ask, assistant tool call, and tool
    // result live only in activeHistory; none of them are in originalHistory.
    const activeHistory = [
      ...firstIterationHistory,
      { role: "user", content: "current ask" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "the tool result" },
    ];

    const result = applyCachedCompaction({
      activeHistory,
      originalHistory,
      cached,
      inTurnHistoryAppended: true,
    });

    expect(result.applied).toBe(false);
    // The live history is returned untouched.
    expect(result.history).toBe(activeHistory);
    expect(result.history).toContainEqual({ role: "user", content: "current ask" });
    expect(result.history).toContainEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "the tool result",
    });
    // The pre-turn rebuild would have replaced the in-turn tool history with
    // this slice and dropped both the ask and the tool result.
    expect(result.history).not.toEqual(firstIterationHistory);
  });

  test("does not rebuild when the cached prefix no longer matches", () => {
    const changedHistory = [
      { role: "user", content: "edited ask" },
      ...originalHistory.slice(1),
    ];

    const result = applyCachedCompaction({
      activeHistory: changedHistory,
      originalHistory: changedHistory,
      cached,
      inTurnHistoryAppended: false,
    });

    expect(result.applied).toBe(false);
    expect(result.history).toBe(changedHistory);
  });

  test("does not rebuild when history is shorter than the cached prefix", () => {
    const shortHistory = originalHistory.slice(0, 1);

    const result = applyCachedCompaction({
      activeHistory: shortHistory,
      originalHistory: shortHistory,
      cached,
      inTurnHistoryAppended: false,
    });

    expect(result.applied).toBe(false);
    expect(result.history).toBe(shortHistory);
  });

  test("hashes the role/content prefix stored with the cache entry", () => {
    expect(getMessagesHash(originalHistory.slice(0, 2))).toBe(cached.prefixHash);
    expect(getMessagesHash([{ role: "assistant", content: "" }])).toBe("assistant:");
  });
});
