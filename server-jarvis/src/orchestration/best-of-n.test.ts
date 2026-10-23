import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config";
import { bestOfNForStage, sampleBestToolCall } from "./best-of-n";
import type { ToolDefinition } from "../tool-types";

const READ_FILE: ToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};

/** Returns a scripted tool call per invocation, recording the seeds it saw. */
function stubModel(scripted: Array<Record<string, unknown> | null>) {
  const seeds: Array<number | undefined> = [];
  let i = 0;
  const fn = (async (_messages: unknown, options: any) => {
    seeds.push(options?.seed);
    const args = scripted[Math.min(i++, scripted.length - 1)];
    return {
      content: "",
      tool_calls: args === null ? undefined : [{ id: `c${i}`, name: "read_file", arguments: args }],
    };
  }) as any;
  return { fn, seeds };
}

describe("sampleBestToolCall", () => {
  test("picks the highest-scoring candidate", async () => {
    const { fn } = stubModel([
      { path: "path/to/your/file.ts" },
      { path: "src/index.ts" },
      {},
    ]);
    const result = await sampleBestToolCall({
      callModel: fn,
      messages: [{ role: "user", content: "read the entry point" }],
      tools: [READ_FILE],
      n: 3,
      seedBase: 100,
    });
    expect(result.selected?.arguments.path).toBe("src/index.ts");
    expect(result.candidates).toHaveLength(3);
  });

  test("varies the seed per sample so candidates can differ", async () => {
    const { fn, seeds } = stubModel([{ path: "a.ts" }]);
    await sampleBestToolCall({
      callModel: fn,
      messages: [],
      tools: [READ_FILE],
      n: 3,
      seedBase: 100,
    });
    expect(new Set(seeds).size).toBe(3);
  });

  test("never selects a fatal candidate", async () => {
    const { fn } = stubModel([{}, {}, {}]);
    const result = await sampleBestToolCall({
      callModel: fn,
      messages: [],
      tools: [READ_FILE],
      n: 3,
      seedBase: 1,
    });
    expect(result.selected).toBeUndefined();
    expect(result.candidates.every((c) => c.score.fatal)).toBe(true);
  });

  test("stops early on a perfect candidate to save tokens", async () => {
    let calls = 0;
    const fn = (async () => {
      calls++;
      return { content: "", tool_calls: [{ id: "c", name: "read_file", arguments: { path: "src/a.ts" } }] };
    }) as any;
    await sampleBestToolCall({
      callModel: fn,
      messages: [],
      tools: [READ_FILE],
      n: 5,
      seedBase: 1,
    });
    expect(calls).toBe(1);
  });

  test("a turn with no tool call is recorded but not selected", async () => {
    const { fn } = stubModel([null, { path: "src/a.ts" }]);
    const result = await sampleBestToolCall({
      callModel: fn,
      messages: [],
      tools: [READ_FILE],
      n: 2,
      seedBase: 1,
    });
    expect(result.selected?.arguments.path).toBe("src/a.ts");
    expect(result.emptyTurns).toBe(1);
  });
});

describe("best-of-n config gate", () => {
  test("ships disabled by default", () => {
    const cfg = loadConfig();
    expect(cfg.orchestrator.best_of_n.enabled).toBe(false);
    expect(cfg.orchestrator.best_of_n.n).toBe(3);
    expect(cfg.orchestrator.best_of_n.stages).toEqual(["executor"]);
  });

  test("returns 1 when disabled, so callers make a single call", () => {
    expect(bestOfNForStage({ enabled: false, n: 3, stages: ["executor"] }, "executor")).toBe(1);
    expect(bestOfNForStage(undefined, "executor")).toBe(1);
  });

  test("returns n only for listed stages", () => {
    const c = { enabled: true, n: 4, stages: ["executor"] };
    expect(bestOfNForStage(c, "executor")).toBe(4);
    expect(bestOfNForStage(c, "planner")).toBe(1);
  });
});
