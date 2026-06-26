import { describe, test, expect } from "bun:test";
import { LiveConductor } from "./conductor";
import { ConductorBus } from "./conductor-bus";
import { AgentPool, DEFAULT_ORCHESTRATOR_AGENTS } from "./agent-pool";

function makeConductor(overrides?: Partial<{
  supervision_timeout_ms: number;
  max_tool_errors_before_reroute: number;
  supervise_low_complexity: boolean;
}>, callModelFn?: (messages: any[], options?: any) => Promise<{content: string}>) {
  const bus = new ConductorBus();
  const pool = new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS);
  const callModel = callModelFn ?? (async () => ({ content: '{"directive":"continue"}' }));
  const conductor = new LiveConductor(callModel, bus, pool, {
    supervision_timeout_ms: overrides?.supervision_timeout_ms ?? 5000,
    max_tool_errors_before_reroute: overrides?.max_tool_errors_before_reroute ?? 2,
    supervise_low_complexity: overrides?.supervise_low_complexity ?? false,
  });
  return { conductor, bus };
}

describe("LiveConductor", () => {
  test("returns continue by default", async () => {
    const { conductor } = makeConductor();
    conductor.setContext("general", "medium", "run-1");
    const dir = await conductor.afterStage("planner", "completed", "plan output", ["executor", "synthesizer"]);
    expect(dir.type).toBe("continue");
  });

  test("returns continue for low-complexity when supervise_low_complexity=false", async () => {
    let modelCalled = false;
    const { conductor } = makeConductor({ supervise_low_complexity: false }, async () => {
      modelCalled = true;
      return { content: '{"directive":"continue"}' };
    });
    conductor.setContext("general", "low", "run-2");
    const dir = await conductor.afterStage("planner", "completed", "plan", ["synthesizer"]);
    expect(dir.type).toBe("continue");
    expect(modelCalled).toBe(false); // no model call for low complexity
  });

  test("returns reroute after N consecutive tool errors via heuristic (no model call)", async () => {
    let modelCalled = false;
    const { conductor } = makeConductor({ max_tool_errors_before_reroute: 2 }, async () => {
      modelCalled = true;
      return { content: '{"directive":"continue"}' };
    });
    conductor.setContext("general", "medium", "run-3");
    conductor.onToolResult("executor", "read_file", true, "Error: not found");
    conductor.onToolResult("executor", "read_file", true, "Error: not found");
    const dir = await conductor.afterStage("executor", "failed", "error", ["synthesizer"]);
    expect(dir.type).toBe("reroute");
    expect(modelCalled).toBe(false); // heuristic fires before model call
  });

  test("supervision timeout returns continue", async () => {
    const { conductor } = makeConductor(
      { supervision_timeout_ms: 100 },
      async () => {
        await new Promise(r => setTimeout(r, 500)); // exceed timeout
        return { content: '{"directive":"continue"}' };
      }
    );
    conductor.setContext("general", "high", "run-4");
    const dir = await conductor.afterStage("executor", "completed", "done", ["synthesizer"]);
    expect(dir.type).toBe("continue");
  }, 2000);

  test("model error returns continue (never throws)", async () => {
    const { conductor } = makeConductor({}, async () => {
      throw new Error("model unavailable");
    });
    conductor.setContext("general", "high", "run-5");
    const dir = await conductor.afterStage("planner", "completed", "plan", ["executor"]);
    expect(dir).toEqual({ type: "continue" });
  });

  test("parses reroute directive from model output", async () => {
    const { conductor } = makeConductor({}, async () => ({
      content: JSON.stringify({
        directive: "reroute",
        newRemaining: ["executor", "synthesizer"],
        reason: "planner output was unclear",
      }),
    }));
    conductor.setContext("general", "high", "run-6");
    const dir = await conductor.afterStage("planner", "failed", "error", ["executor", "synthesizer"]);
    expect(dir.type).toBe("reroute");
    if (dir.type === "reroute") {
      expect(dir.newRemaining).toContain("synthesizer");
    }
  });
});
