import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  CONTEXT_TOO_SMALL,
  ContextTooSmallError,
  optimizeContextWindow,
  type ContextWindowMessage,
} from "./context-window";

// DD-102 / DD-T2: a context budget too small for history must still send the
// turn being answered. These cases pin the fitter directly (it lives in
// ./context-window because index.ts binds a socket at import time) plus the
// entrypoint wiring, so reverting either half fails here.

const system = (content: string): ContextWindowMessage => ({ role: "system", content });
const user = (content: string): ContextWindowMessage => ({ role: "user", content });
const assistant = (content: string): ContextWindowMessage => ({ role: "assistant", content });

describe("optimizeContextWindow: minimal-history path (DD-102)", () => {
  test("budget <= 500 still returns the current turn and drops only prior turns", () => {
    const history: ContextWindowMessage[] = [
      system("compaction summary"),
      user("old question"),
      assistant("old answer"),
    ];

    // num_ctx 500 -> generation reserve 100 -> 400 available; the pinned system
    // message, the stage system prompt, and the current turn fit, leaving a
    // history budget well under the 500-token floor.
    const result = optimizeContextWindow(history, "stage prompt", "What is in the workspace?", 500);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.minimalHistory).toBe(true);
    expect(result.historyBudgetTokens).toBeLessThanOrEqual(500);

    // The turn being answered survives — exactly once, as the final message.
    const currentTurns = result.messages.filter(
      (message) => message.role === "user" && message.content === "What is in the workspace?",
    );
    expect(currentTurns).toHaveLength(1);
    expect(result.messages.at(-1)).toEqual({ role: "user", content: "What is in the workspace?" });

    // Prior turns are gone; the pinned system message still leads.
    expect(result.messages.some((message) => message.content === "old question")).toBe(false);
    expect(result.messages.some((message) => message.content === "old answer")).toBe(false);
    expect(result.messages[0]).toEqual(system("compaction summary"));
    expect(result.droppedHistoryGroups).toBe(2);
  });

  test("fails closed with context_too_small when even system + current turn cannot fit", () => {
    const history: ContextWindowMessage[] = [system("compaction summary"), user("old question")];
    const hugePrompt = "x".repeat(2000); // ~500 tokens

    const result = optimizeContextWindow(history, "stage prompt", hugePrompt, 100);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe(CONTEXT_TOO_SMALL);
    expect(result.reason).toBe("context_too_small");
    expect(result.requiredTokens).toBeGreaterThan(result.availableTokens);

    // No silent empty history, and no fabricated user turn to make it look valid.
    expect(result.messages).toEqual([]);
    expect(result.messages.some((message) => message.role === "user")).toBe(false);

    // The caller surfaces the documented code, not a generic error.
    const error = new ContextTooSmallError(result);
    expect(error.name).toBe("ContextTooSmallError");
    expect(error.reason).toBe("context_too_small");
    expect(error.message).toContain("context_too_small");
  });

  test("pinned system text is truncated (not the current turn) when it alone overflows", () => {
    const history: ContextWindowMessage[] = [system("x".repeat(4000))]; // ~1000 tokens

    // num_ctx 600 -> reserve 120 -> 480 available for system prompt + system +
    // current turn. The huge pinned system message cannot survive intact.
    const result = optimizeContextWindow(history, "stage prompt", "keep me", 600);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.systemMessagesTruncated).toBe(1);
    const first = result.messages[0];
    expect(first.role).toBe("system");
    expect(String(first.content)).toContain("[elided to fit context budget");
    expect(String(first.content).length).toBeLessThan(4000);

    // The current turn is still the last message and is never dropped for
    // system text.
    expect(result.messages.at(-1)).toEqual({ role: "user", content: "keep me" });
  });

  test("without a current prompt, a history that cannot fit fails closed instead of sending system-only", () => {
    // The native tool loop folds its prompt into history, so currentPrompt is
    // empty and the newest group is the turn being answered. Here that group
    // alone overshoots the history budget.
    const history: ContextWindowMessage[] = [
      user("q"),
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "x".repeat(4000) } }],
      },
    ];

    // num_ctx 900 -> reserve 180 -> 720 available; the group needs ~1000.
    const result = optimizeContextWindow(history, "stage prompt", "", 900);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(CONTEXT_TOO_SMALL);
    expect(result.messages).toEqual([]);
    expect(result.messages.some((message) => message.role === "user")).toBe(false);
  });
});

describe("optimizeContextWindow: normal budget path unchanged", () => {
  test("pins leading system messages, drops oldest groups first, never splits a tool group", () => {
    const oldestGroup: ContextWindowMessage[] = [user("q1"), assistant(`a1 ${"x".repeat(4000)}`)];
    const middleGroup: ContextWindowMessage[] = [user("q2"), assistant(`a2 ${"x".repeat(2000)}`)];
    const newestGroup: ContextWindowMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "x".repeat(2000) }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "x".repeat(2000) },
    ];
    const history: ContextWindowMessage[] = [
      system("S1"),
      system("S2"),
      ...oldestGroup,
      ...middleGroup,
      ...newestGroup,
    ];

    // num_ctx 2600 -> reserve 520 -> 2080 available -> ~2074 history budget.
    // Newest group (~1024) + middle (~502) fit; the oldest (~1002) does not.
    const result = optimizeContextWindow(history, "stage prompt", "now", 2600);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.minimalHistory).toBe(false);
    // This fitter treats each ordinary user/assistant message as its own
    // history group; both messages in the oldest exchange are evicted.
    expect(result.droppedHistoryGroups).toBe(2);
    expect(result.droppedHistoryMessages).toBe(oldestGroup.length);

    // Leading system messages stay pinned, in order.
    expect(result.messages.slice(0, 2)).toEqual([system("S1"), system("S2")]);

    // Oldest turn dropped, newest prior turn kept, current turn last.
    expect(result.messages.some((message) => message.content === "q1")).toBe(false);
    expect(result.messages.some((message) => message.content === "q2")).toBe(true);
    expect(result.messages.at(-1)).toEqual({ role: "user", content: "now" });

    // The tool-call assistant message and its tool result stay adjacent.
    const callIndex = result.messages.findIndex(
      (message) => message.role === "assistant" && Array.isArray(message.tool_calls),
    );
    expect(callIndex).toBeGreaterThan(-1);
    expect(result.messages[callIndex + 1]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(
      result.messages.filter((message) => message.role === "tool" && message.tool_call_id === "c1"),
    ).toHaveLength(1);
  });
});

describe("index.ts context-window wiring", () => {
  // index.ts binds a real socket at import time, so the wiring is pinned from
  // source: reverting the entrypoint half must fail here even though the pure
  // fitter's own behaviour tests still pass.
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

  test("the entrypoint delegates fitting to ./context-window and still exports it", () => {
    expect(source).toContain('from "./context-window"');
    expect(source).toMatch(/export \{ CONTEXT_TOO_SMALL, optimizeContextWindow \};/);
    expect(source).not.toMatch(/function optimizeContextWindow\(/);
  });

  test("the call site passes the prompt actually being sent and fails closed", () => {
    expect(source).toContain(
      "optimizeContextWindow(activeHistory, effectiveSystemPrompt, currentPrompt, num_ctx)",
    );
    expect(source).toContain("new ContextTooSmallError(fitted)");
    // The current turn is carried by the fit; appending it again would duplicate
    // it, and the old fallback sent a request with no user turn at all.
    expect(source).not.toMatch(/if \(currentPrompt\) \{\s*messages\.push\(\{ role: "user", content: currentPrompt \}\);/);
  });
});
