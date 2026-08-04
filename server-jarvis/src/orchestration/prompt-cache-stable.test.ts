import { describe, expect, test } from "bun:test";
import {
  assembleCacheStableMessages,
  extractCachedTokensFromUsage,
  logCachedTokensProbe,
} from "./prompt-cache-stable";
import { AGENT_SYSTEM_PROMPT_HEADER } from "./agent-system-prompt";

describe("assembleCacheStableMessages", () => {
  test("orders runtime facts → text tools → stage system → history → turn", () => {
    const messages = assembleCacheStableMessages({
      runtimeFacts: "Runtime facts: backend is openrouter",
      textToolInstructions: "You may call tools as JSON blocks.",
      stageMessages: [
        { role: "system", content: "You are the executor." },
        { role: "user", content: "User Request: fix the bug" },
        { role: "assistant", content: "Reading the file." },
        { role: "tool", content: "file body", name: "read_file", tool_call_id: "c1" },
        { role: "user", content: "continue" },
      ],
    });

    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(messages[0].content).toBe("Runtime facts: backend is openrouter");
    expect(messages[1].content).toBe("You may call tools as JSON blocks.");
    expect(messages[2].content).toBe("You are the executor.");
    expect(messages[3].content).toBe("User Request: fix the bug");
    expect(messages[messages.length - 1].content).toBe("continue");
  });

  test("omits empty text tools and still places stage system after runtime facts", () => {
    const messages = assembleCacheStableMessages({
      runtimeFacts: "Runtime facts: ollama",
      textToolInstructions: "  ",
      stageMessages: [
        { role: "system", content: "planner prompt" },
        { role: "user", content: "plan this" },
      ],
    });
    expect(messages).toEqual([
      { role: "system", content: "Runtime facts: ollama" },
      { role: "system", content: "planner prompt" },
      { role: "user", content: "plan this" },
    ]);
  });

  test("appends agent directives onto the stage system block, not runtime facts", () => {
    const block = `${AGENT_SYSTEM_PROMPT_HEADER}\nPrefer terse tool calls.`;
    const messages = assembleCacheStableMessages({
      runtimeFacts: "Runtime facts: openrouter",
      textToolInstructions: "tools here",
      agentSystemPromptBlock: block,
      stageMessages: [
        { role: "system", content: "executor" },
        { role: "user", content: "go" },
      ],
    });
    expect(messages[0].content).toBe("Runtime facts: openrouter");
    expect(messages[1].content).toBe("tools here");
    expect(messages[2].content).toContain("executor");
    expect(messages[2].content).toContain(AGENT_SYSTEM_PROMPT_HEADER);
    expect(messages[2].content).toContain("Prefer terse tool calls.");
  });

  test("does not mutate stage message objects", () => {
    const stage = [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
    ];
    const before = JSON.stringify(stage);
    assembleCacheStableMessages({
      runtimeFacts: "facts",
      stageMessages: stage,
    });
    expect(JSON.stringify(stage)).toBe(before);
  });
});

describe("extractCachedTokensFromUsage", () => {
  test("reads OpenAI-style prompt_tokens_details.cached_tokens", () => {
    expect(extractCachedTokensFromUsage({
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 800 },
    })).toBe(800);
  });

  test("reads Anthropic-style cache_read_input_tokens", () => {
    expect(extractCachedTokensFromUsage({
      input_tokens: 500,
      cache_read_input_tokens: 400,
    })).toBe(400);
  });

  test("returns undefined when no cache signal is present", () => {
    expect(extractCachedTokensFromUsage({ prompt_tokens: 10, completion_tokens: 2 })).toBeUndefined();
    expect(extractCachedTokensFromUsage(null)).toBeUndefined();
    expect(extractCachedTokensFromUsage(undefined)).toBeUndefined();
  });

  test("logCachedTokensProbe returns the count without throwing", () => {
    const n = logCachedTokensProbe({
      usage: { cached_tokens: 12 },
      stage: "executor",
      model: "test-model",
      provider: "openrouter",
    });
    expect(n).toBe(12);
    expect(logCachedTokensProbe({ usage: {} })).toBeUndefined();
  });
});
