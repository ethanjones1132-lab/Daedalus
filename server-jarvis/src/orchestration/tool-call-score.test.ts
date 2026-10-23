import { describe, expect, test } from "bun:test";
import { scoreToolCall } from "./tool-call-score";
import type { ToolDefinition } from "../tool-types";

const READ_FILE: ToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "number" } },
      required: ["path"],
    },
  },
};

const TOOLS = [READ_FILE];

describe("scoreToolCall", () => {
  test("a well-formed call scores above zero", () => {
    const s = scoreToolCall({ id: "1", name: "read_file", arguments: { path: "src/index.ts" } }, TOOLS);
    expect(s.score).toBeGreaterThan(0);
    expect(s.fatal).toBe(false);
  });

  test("an unknown tool is fatal", () => {
    const s = scoreToolCall({ id: "1", name: "nope", arguments: {} }, TOOLS);
    expect(s.fatal).toBe(true);
    expect(s.score).toBe(0);
    expect(s.reasons).toContain("unknown tool: nope");
  });

  test("a missing required argument is fatal", () => {
    const s = scoreToolCall({ id: "1", name: "read_file", arguments: {} }, TOOLS);
    expect(s.fatal).toBe(true);
    expect(s.reasons.some((r) => r.includes("missing required"))).toBe(true);
  });

  test("a wrong argument type is penalized but not fatal", () => {
    const good = scoreToolCall({ id: "1", name: "read_file", arguments: { path: "a.ts", limit: 10 } }, TOOLS);
    const bad = scoreToolCall({ id: "1", name: "read_file", arguments: { path: "a.ts", limit: "ten" } }, TOOLS);
    expect(bad.fatal).toBe(false);
    expect(bad.score).toBeLessThan(good.score);
  });

  test("an unknown extra argument is penalized", () => {
    const clean = scoreToolCall({ id: "1", name: "read_file", arguments: { path: "a.ts" } }, TOOLS);
    const noisy = scoreToolCall({ id: "1", name: "read_file", arguments: { path: "a.ts", nonsense: 1 } }, TOOLS);
    expect(noisy.score).toBeLessThan(clean.score);
  });

  test("a placeholder path is penalized", () => {
    const real = scoreToolCall({ id: "1", name: "read_file", arguments: { path: "src/index.ts" } }, TOOLS);
    const fake = scoreToolCall({ id: "1", name: "read_file", arguments: { path: "path/to/your/file.ts" } }, TOOLS);
    expect(fake.score).toBeLessThan(real.score);
    expect(fake.reasons.some((r) => r.includes("placeholder"))).toBe(true);
  });

  test("scores are deterministic", () => {
    const call = { id: "1", name: "read_file", arguments: { path: "src/a.ts" } };
    expect(scoreToolCall(call, TOOLS).score).toBe(scoreToolCall(call, TOOLS).score);
  });
});
