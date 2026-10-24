import { describe, expect, test } from "bun:test";
import { loadConfig, type BestOfNConfig } from "../config";
import { bestOfNForStage, callModelWithBestOfN, sampleBestToolCall, summarizeSampling } from "./best-of-n";
import { scoreToolCall } from "./tool-call-score";
import type { CallModelFn } from "./coordinator";
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

describe("callModelWithBestOfN", () => {
  test("makes exactly one model call when sampling is disabled with n=3", async () => {
    const response = {
      content: "single response",
      tool_calls: [{ id: "single", name: "read_file", arguments: { path: "src/index.ts" } }],
    };
    let calls = 0;
    const callModel: CallModelFn = async () => {
      calls++;
      return response;
    };

    const result = await callModelWithBestOfN({
      config: { enabled: false, n: 3, stages: ["executor"] },
      stage: "executor",
      callModel,
      messages: [],
      tools: [READ_FILE],
      seedBase: 100,
    });

    expect(calls).toBe(1);
    expect(result.response).toEqual(response);
  });

  test("returns the response for the statically highest-scoring candidate", async () => {
    const responses = [
      {
        content: "candidate-0",
        model: "candidate-0",
        tool_calls: [{ id: "candidate-0", name: "read_file", arguments: { path: "src/index.ts", typo: true } }],
      },
      {
        content: "candidate-1",
        model: "candidate-1",
        tool_calls: [{ id: "candidate-1", name: "read_file", arguments: { path: "src/index.ts" } }],
      },
      {
        content: "candidate-2",
        model: "candidate-2",
        tool_calls: [{ id: "candidate-2", name: "read_file", arguments: { path: "path/to/your/file.ts" } }],
      },
    ];
    let calls = 0;
    const callModel: CallModelFn = async () => responses[Math.min(calls++, responses.length - 1)]!;
    const config: BestOfNConfig = { enabled: true, n: 3, stages: ["executor"] };

    const result = await callModelWithBestOfN({
      config,
      stage: "executor",
      callModel,
      messages: [],
      tools: [READ_FILE],
      seedBase: 100,
    });

    const candidateScores = responses.map((response) => scoreToolCall(response.tool_calls[0], [READ_FILE]));
    const selectedCandidate = result.selectedCandidate!;
    expect(calls).toBe(3);
    expect(candidateScores[1]!.score).toBeGreaterThan(candidateScores[0]!.score);
    expect(candidateScores[1]!.score).toBeGreaterThan(candidateScores[2]!.score);
    expect(result.response).toEqual(responses[1]);
    expect(result.response.tool_calls?.[0]).toEqual(selectedCandidate.call);
    expect(selectedCandidate.score).toEqual(scoreToolCall(selectedCandidate.call, [READ_FILE]));
    expect(selectedCandidate.score).toEqual(candidateScores[1]);
  });

  test("scores every tool call in a candidate response before selecting it", async () => {
    const responses = [
      {
        content: "candidate with an invalid second call",
        tool_calls: [
          { id: "first", name: "read_file", arguments: { path: "src/index.ts" } },
          { id: "second", name: "read_file", arguments: {} },
        ],
      },
      {
        content: "candidate with one valid call",
        tool_calls: [{ id: "valid", name: "read_file", arguments: { path: "src/index.ts" } }],
      },
    ];
    let calls = 0;
    const result = await callModelWithBestOfN({
      config: { enabled: true, n: 2, stages: ["executor"] },
      stage: "executor",
      callModel: async () => responses[calls++]!,
      messages: [],
      tools: [READ_FILE],
      seedBase: 200,
    });

    expect(result.response).toEqual(responses[1]);
    expect(result.selectedCandidate?.score.fatal).toBe(false);
    expect(result.sampling?.candidates[0]?.score.fatal).toBe(true);
  });
});

describe("sampling telemetry", () => {
  test("reports the gain the extra samples bought", async () => {
    const { fn } = stubModel([
      { path: "path/to/your/file.ts" },
      { path: "src/index.ts" },
    ]);
    const result = await sampleBestToolCall({
      callModel: fn, messages: [], tools: [READ_FILE], n: 2, seedBase: 1,
    });
    const summary = summarizeSampling(result);
    expect(summary.samples).toBe(2);
    expect(summary.selectedScore).toBeGreaterThan(summary.firstScore);
    expect(summary.improvedOverFirst).toBe(true);
  });

  test("reports no gain when the first sample already won", async () => {
    const { fn } = stubModel([{ path: "src/a.ts" }]);
    const result = await sampleBestToolCall({
      callModel: fn, messages: [], tools: [READ_FILE], n: 3, seedBase: 1,
    });
    expect(summarizeSampling(result).improvedOverFirst).toBe(false);
  });

  test("counts a no-tool first sample as a zero-score baseline", async () => {
    const { fn } = stubModel([null, { path: "src/index.ts" }]);
    const result = await sampleBestToolCall({
      callModel: fn, messages: [], tools: [READ_FILE], n: 2, seedBase: 20,
    });
    const summary = summarizeSampling(result);

    expect(summary.firstScore).toBe(0);
    expect(summary.selectedScore).toBeGreaterThan(0);
    expect(summary.improvedOverFirst).toBe(true);
  });
});
