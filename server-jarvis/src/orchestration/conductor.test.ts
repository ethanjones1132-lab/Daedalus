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
  test("supervisor message includes evidence-rich executor digest", async () => {
    const supervisorMessages: any[][] = [];
    const { conductor } = makeConductor({}, async (messages) => {
      supervisorMessages.push(messages);
      return { content: '{"directive":"continue"}' };
    });
    conductor.setContext("general", "high", "run-evidence-digest");

    const longRequest = `What version is in package.json? ${"x".repeat(400)}`;
    const directive = await conductor.afterStage("executor", "completed", "executor narrative", ["synthesizer"], {
      request: longRequest,
      workerInstruction: "Read package metadata and report the version.",
      toolCalls: [
        {
          name: "read_file",
          arguments: { path: "package.json" },
          output: '{"version":"1.2.3"}',
          is_error: false,
          duration_ms: 12,
        },
        {
          name: "read_file",
          arguments: { path: "README.md" },
          output: "# Readme",
          is_error: false,
          duration_ms: 8,
        },
        {
          name: "grep",
          arguments: { pattern: "missing" },
          output: "Error: no matches",
          is_error: true,
          duration_ms: 4,
        },
      ],
    });

    expect(directive).toEqual({ type: "continue" });
    expect(supervisorMessages).toHaveLength(1);
    const userContent = supervisorMessages[0][1].content;
    expect(userContent).toContain("Tool call counts: grep=1, read_file=2");
    expect(userContent).toContain("Tool error count: 1");
    expect(userContent).toContain("Recent tool errors: grep: Error: no matches");
    expect(userContent).toContain('"sufficient":true');
    expect(userContent).toContain('"deepRead":false');
    expect(userContent).toContain("Request (300 chars): What version is in package.json?");
    expect(userContent).not.toContain("x".repeat(320));
    expect(userContent).toContain("Worker instruction: Read package metadata and report the version.");
  });

  test("deterministically re-enters executor once for completed deep-read stages with insufficient evidence", async () => {
    let modelCalls = 0;
    const { conductor } = makeConductor({}, async () => {
      modelCalls += 1;
      return { content: '{"directive":"continue"}' };
    });
    conductor.setContext("general", "high", "run-deep-read-reroute");

    const insufficientEvidence = {
      request: "Comprehensively audit this repository architecture.",
      workerInstruction: "Read enough source files before summarizing.",
      toolCalls: [
        {
          name: "list_directory",
          arguments: { path: "." },
          output: "src\npackage.json\nREADME.md",
          is_error: false,
          duration_ms: 10,
        },
      ],
    };

    const first = await conductor.afterStage(
      "executor",
      "completed",
      "I looked at the repo.",
      ["reviewer", "synthesizer"],
      insufficientEvidence,
    );

    expect(modelCalls).toBe(0);
    expect(first.type).toBe("reroute");
    if (first.type === "reroute") {
      expect(first.newRemaining).toEqual(["re-enter:executor", "reviewer", "synthesizer"]);
      expect(first.reason).toContain("deep-read evidence insufficient");
    }

    const second = await conductor.afterStage(
      "executor",
      "completed",
      "Still not enough.",
      ["reviewer", "synthesizer"],
      insufficientEvidence,
    );

    expect(second).toEqual({ type: "continue" });
    expect(modelCalls).toBe(1);

    conductor.setContext("general", "high", "run-deep-read-reroute-reset");
    const afterReset = await conductor.afterStage(
      "executor",
      "completed",
      "Still not enough.",
      ["synthesizer"],
      insufficientEvidence,
    );
    expect(modelCalls).toBe(1);
    expect(afterReset.type).toBe("reroute");
  });

  test("current clean evidence does not inherit stale tool errors", async () => {
    const supervisorMessages: any[][] = [];
    const { conductor } = makeConductor({}, async (messages) => {
      supervisorMessages.push(messages);
      return { content: '{"directive":"continue"}' };
    });
    conductor.setContext("general", "high", "run-fresh-digest");
    conductor.onToolResult("executor", "read_file", true, "stale failure");

    await conductor.afterStage("executor", "completed", "current stage", ["synthesizer"], {
      request: "read the source",
      toolCalls: [{
        name: "read_file",
        arguments: { path: "src/a.ts" },
        output: "ok",
        is_error: false,
        duration_ms: 1,
      }],
    });

    const userContent = supervisorMessages[0][1].content;
    expect(userContent).toContain("Tool error count: 0");
    expect(userContent).toContain("Recent tool errors: none");
    expect(userContent).not.toContain("stale failure");
  });

  test("actively supervises a healthy medium/high-complexity stage when work remains", async () => {
    let modelCalled = false;
    const { conductor } = makeConductor({}, async () => {
      modelCalled = true;
      return { content: '{"directive":"continue"}' };
    });
    conductor.setContext("general", "high", "run-healthy-stage");

    const dir = await conductor.afterStage("planner", "completed", "plan output", ["executor"]);

    expect(dir).toEqual({ type: "continue" });
    expect(modelCalled).toBe(true);
  });

  test("uses the dedicated supervisor path instead of the worker model", async () => {
    const bus = new ConductorBus();
    const pool = new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS);
    let workerCalls = 0;
    let supervisorCalls = 0;
    const conductor = new LiveConductor(
      async () => {
        workerCalls += 1;
        return { content: '{"directive":"reroute"}' };
      },
      bus,
      pool,
      {
        supervision_timeout_ms: 5_000,
        max_tool_errors_before_reroute: 2,
        supervise_low_complexity: false,
      },
      async () => {
        supervisorCalls += 1;
        return { content: '{"directive":"continue"}' };
      },
    );
    conductor.setContext("general", "high", "run-local-supervisor");

    const directive = await conductor.afterStage("planner", "completed", "plan", ["executor"]);

    expect(directive).toEqual({ type: "continue" });
    expect(supervisorCalls).toBe(1);
    expect(workerCalls).toBe(0);
  });

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

  test("malformed supervisor response returns continue", async () => {
    const { conductor } = makeConductor({}, async () => ({ content: "not-json" }));
    conductor.setContext("general", "high", "run-parse-failure");
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
