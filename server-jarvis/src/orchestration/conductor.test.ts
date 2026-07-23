import { describe, test, expect } from "bun:test";
import { LiveConductor, shouldSuperviseStage } from "./conductor";
import { ConductorBus } from "./conductor-bus";
import { AgentPool, DEFAULT_ORCHESTRATOR_AGENTS } from "./agent-pool";
import type { SupervisionAttribution } from "./conductor";

function makeConductor(
  overrides?: Partial<{
    supervision_timeout_ms: number;
    max_tool_errors_before_reroute: number;
    supervise_low_complexity: boolean;
  }>,
  callModelFn?: (messages: any[], options?: any) => Promise<{ content: string }>,
  onAttributed?: (row: SupervisionAttribution) => void,
) {
  const bus = new ConductorBus();
  const pool = new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS);
  const callModel = callModelFn ?? (async () => ({ content: '{"directive":"continue"}' }));
  const conductor = new LiveConductor(
    callModel,
    bus,
    pool,
    {
      supervision_timeout_ms: overrides?.supervision_timeout_ms ?? 5000,
      max_tool_errors_before_reroute: overrides?.max_tool_errors_before_reroute ?? 2,
      supervise_low_complexity: overrides?.supervise_low_complexity ?? false,
    },
    callModel,
    onAttributed,
  );
  return { conductor, bus };
}

describe("shouldSuperviseStage (F7)", () => {
  test("clean completed planner is free (no inference)", () => {
    expect(shouldSuperviseStage({
      supervisionEnabled: true,
      outcome: "completed",
      stage: "planner",
      remainingQueue: ["executor", "synthesizer"],
      consecutiveToolErrors: 0,
      evidenceGap: false,
      supervisionCallsUsed: 0,
    })).toBe(false);
  });

  test("failed stage still supervises", () => {
    expect(shouldSuperviseStage({
      supervisionEnabled: true,
      outcome: "failed",
      stage: "planner",
      remainingQueue: ["executor"],
      consecutiveToolErrors: 0,
      evidenceGap: false,
      supervisionCallsUsed: 0,
    })).toBe(true);
  });

  test("executor evidence gap still supervises", () => {
    expect(shouldSuperviseStage({
      supervisionEnabled: true,
      outcome: "completed",
      stage: "executor",
      remainingQueue: ["synthesizer"],
      consecutiveToolErrors: 0,
      evidenceGap: true,
      supervisionCallsUsed: 0,
    })).toBe(true);
  });

  test("cap at 4 supervision calls per run", () => {
    expect(shouldSuperviseStage({
      supervisionEnabled: true,
      outcome: "failed",
      stage: "executor",
      remainingQueue: ["synthesizer"],
      consecutiveToolErrors: 0,
      evidenceGap: true,
      supervisionCallsUsed: 4,
    })).toBe(false);
  });
});

describe("LiveConductor", () => {
  test("supervisor message includes evidence-rich executor digest", async () => {
    const supervisorMessages: any[][] = [];
    const { conductor } = makeConductor({}, async (messages) => {
      supervisorMessages.push(messages);
      return { content: '{"directive":"continue"}' };
    });
    conductor.setContext("general", "high", "run-evidence-digest");

    // Deep-read with only one source read → evidence gap → supervise (F7).
    // First deep-read insufficient completion is consumed by the deterministic
    // re-enter:executor guard; second call is the supervision path.
    const longRequest = `Comprehensively audit this repository architecture ${"x".repeat(400)}`;
    const evidence = {
      request: longRequest,
      workerInstruction: "Read package metadata and report the version.",
      toolCalls: [
        {
          name: "read_file",
          arguments: { path: "src/main.ts" },
          output: "export const main = 1;",
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
    };
    // Deterministic deep-read top-up (no model).
    await conductor.afterStage("executor", "completed", "first pass", ["synthesizer"], evidence);
    const directive = await conductor.afterStage("executor", "completed", "executor narrative", ["synthesizer"], evidence);

    expect(directive).toEqual({ type: "continue" });
    expect(supervisorMessages).toHaveLength(1);
    const userContent = supervisorMessages[0][1].content;
    expect(userContent).toContain("Tool call counts: grep=1, read_file=2");
    expect(userContent).toContain("Tool error count: 1");
    expect(userContent).toContain("Recent tool errors: grep: Error: no matches");
    expect(userContent).toContain('"sufficient":false');
    expect(userContent).toContain('"deepRead":true');
    expect(userContent).toContain("Request (300 chars): Comprehensively audit this repository architecture");
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

  test("uses the supplied workspace root when assessing deep-read evidence", async () => {
    const { conductor } = makeConductor();
    conductor.setContext("general", "high", "run-root-aware-evidence");

    const directive = await conductor.afterStage(
      "executor",
      "completed",
      "read two files",
      ["synthesizer"],
      {
        request: "comprehensively audit this repo",
        workspaceRoot: "C:/repo",
        toolCalls: [
          {
            name: "read_file",
            arguments: { path: "src/a.ts" },
            output: "a",
            is_error: false,
            duration_ms: 1,
          },
          {
            name: "read_file",
            arguments: { path: "C:/repo/src/b.ts" },
            output: "b",
            is_error: false,
            duration_ms: 1,
          },
          {
            name: "read_file",
            arguments: { path: "src/c.ts" },
            output: "c",
            is_error: false,
            duration_ms: 1,
          },
        ],
      },
    );

    expect(directive).toEqual({ type: "continue" });
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

  test("F7: clean completed planner skips supervisor inference", async () => {
    let modelCalled = false;
    const { conductor } = makeConductor({}, async () => {
      modelCalled = true;
      return { content: '{"directive":"continue"}' };
    });
    conductor.setContext("general", "high", "run-healthy-stage");

    const dir = await conductor.afterStage("planner", "completed", "plan output", ["executor"]);

    expect(dir).toEqual({ type: "continue" });
    expect(modelCalled).toBe(false);
  });

  test("failed planner still supervises and omits workspace evidence rubric", async () => {
    const supervisorMessages: any[][] = [];
    const { conductor } = makeConductor({}, async (messages) => {
      supervisorMessages.push(messages);
      return { content: '{"directive":"continue"}' };
    });
    conductor.setContext("general", "high", "run-planner-digest");

    await conductor.afterStage(
      "planner",
      "failed",
      "empty_completion",
      ["executor", "reviewer", "synthesizer"],
      {
        request: "Identify all remaining gaps in the repo",
        workspaceRoot: "C:\\Projects\\Versutus",
      },
    );

    expect(supervisorMessages).toHaveLength(1);
    const userContent = supervisorMessages[0][1].content as string;
    expect(userContent).toContain(
      "Evidence assessment: not applicable — the planner stage produces no tool calls by design",
    );
    expect(userContent).not.toContain('"sufficient":false');
    expect(userContent).not.toContain('"sufficient":true');
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

    // Failed stage triggers diet (clean planner would skip entirely).
    const directive = await conductor.afterStage("planner", "failed", "plan error", ["executor"]);

    expect(directive).toEqual({ type: "continue" });
    expect(supervisorCalls).toBe(1);
    expect(workerCalls).toBe(0);
  });

  test("F7: 5th supervision request in one run is free (cap 4)", async () => {
    let modelCalls = 0;
    const { conductor } = makeConductor({}, async () => {
      modelCalls += 1;
      return { content: '{"directive":"continue"}' };
    });
    conductor.setContext("general", "high", "run-cap");

    for (let i = 0; i < 4; i++) {
      await conductor.afterStage("executor", "failed", `fail ${i}`, ["synthesizer"]);
    }
    expect(modelCalls).toBe(4);
    const fifth = await conductor.afterStage("executor", "failed", "fail 4", ["synthesizer"]);
    expect(fifth).toEqual({ type: "continue" });
    expect(modelCalls).toBe(4);
  });

  test("F7: attributes successful supervision calls", async () => {
    const attrs: SupervisionAttribution[] = [];
    const { conductor } = makeConductor(
      {},
      async () => ({ content: '{"directive":"continue"}' }),
      (row) => attrs.push(row),
    );
    conductor.setContext("general", "high", "run_attr");
    await conductor.afterStage("planner", "failed", "boom", ["executor"]);
    expect(attrs).toHaveLength(1);
    expect(attrs[0].agentRunId).toBe("run_attr");
    expect(attrs[0].wasSuccessful).toBe(true);
    expect(attrs[0].hadError).toBe(false);
    expect(attrs[0].durationMs).toBeGreaterThanOrEqual(0);
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
    // Failed stage forces supervision so the timeout path is exercised.
    const dir = await conductor.afterStage("executor", "failed", "done", ["synthesizer"]);
    expect(dir.type).toBe("continue");
  }, 2000);

  test("model error returns continue (never throws)", async () => {
    const { conductor } = makeConductor({}, async () => {
      throw new Error("model unavailable");
    });
    conductor.setContext("general", "high", "run-5");
    const dir = await conductor.afterStage("planner", "failed", "plan", ["executor"]);
    expect(dir).toEqual({ type: "continue" });
  });

  test("malformed supervisor response returns continue", async () => {
    const { conductor } = makeConductor({}, async () => ({ content: "not-json" }));
    conductor.setContext("general", "high", "run-parse-failure");
    const dir = await conductor.afterStage("planner", "failed", "plan", ["executor"]);
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

// ── 2026-07-18: write-effect supervision ──
// The conductor was WRITE-BLIND: a change-request executor stage that
// completed with zero mutations had no failure, no tool errors, and no
// read-evidence gap, so every directive in the incident DB was "continue".
describe("LiveConductor write-effect fence", () => {
  const readOnlyCall = {
    name: "read_file",
    arguments: { path: "src/main.ts" },
    output: "export const main = 1;",
    is_error: false,
    duration_ms: 10,
  };
  const writeCall = {
    name: "edit_file",
    arguments: { path: "src/main.ts" },
    output: "Edited src/main.ts",
    is_error: false,
    duration_ms: 20,
  };

  test("write-intent executor with zero mutations reroutes re-enter:executor once", async () => {
    const { conductor } = makeConductor();
    conductor.setContext("general", "high", "run-write-fence-1");
    const evidence = {
      request: "Apply the smoothing changes to PluginProcessor.cpp",
      toolCalls: [readOnlyCall],
      writeIntent: true,
    };
    const first = await conductor.afterStage("executor", "completed", "read the file, described the edit", ["reviewer", "synthesizer"], evidence);
    expect(first.type).toBe("reroute");
    if (first.type === "reroute") {
      expect(first.newRemaining[0]).toBe("re-enter:executor");
      expect(first.reason).toContain("zero successful mutations");
    }
  });

  test("the fence fires at most once per run", async () => {
    const supervisorCalls: any[][] = [];
    const { conductor } = makeConductor({}, async (messages) => {
      supervisorCalls.push(messages);
      return { content: '{"directive":"continue"}' };
    });
    conductor.setContext("general", "high", "run-write-fence-2");
    const evidence = {
      request: "Apply the smoothing changes to PluginProcessor.cpp",
      toolCalls: [readOnlyCall],
      writeIntent: true,
    };
    const first = await conductor.afterStage("executor", "completed", "no writes", ["synthesizer"], evidence);
    expect(first.type).toBe("reroute");
    // Second write-less completion: fence used up — the WRITE GAP now counts
    // as an evidence gap, so model supervision runs instead of a free pass.
    const second = await conductor.afterStage("executor", "completed", "still no writes", ["synthesizer"], evidence);
    expect(second.type).toBe("continue");
    expect(supervisorCalls.length).toBe(1);
    expect(supervisorCalls[0][1].content).toContain("Write intent: TRUE");
    expect(supervisorCalls[0][1].content).toContain("successful mutations so far: 0");
  });

  test("a successful mutation satisfies the fence", async () => {
    const supervisorCalls: any[][] = [];
    const { conductor } = makeConductor({}, async (messages) => {
      supervisorCalls.push(messages);
      return { content: '{"directive":"continue"}' };
    });
    conductor.setContext("general", "high", "run-write-fence-3");
    const directive = await conductor.afterStage("executor", "completed", "applied the edit", ["synthesizer"], {
      request: "Apply the smoothing changes to PluginProcessor.cpp",
      toolCalls: [readOnlyCall, writeCall],
      writeIntent: true,
    });
    expect(directive).toEqual({ type: "continue" });
    expect(supervisorCalls.length).toBe(0); // clean write turn — no inference spent
  });

  test("read turns are unaffected by the fence", async () => {
    const { conductor } = makeConductor();
    conductor.setContext("general", "high", "run-write-fence-4");
    const directive = await conductor.afterStage("executor", "completed", "summarized files", ["synthesizer"], {
      request: "summarize src/main.ts",
      toolCalls: [readOnlyCall],
      writeIntent: false,
    });
    expect(directive).toEqual({ type: "continue" });
  });
});

describe("LiveConductor owned-runtime-loop directives (Task 5)", () => {
  test("low-complexity executor with write evidence emits mark_verified", async () => {
    const supervisorCalls: unknown[] = [];
    const { conductor } = makeConductor({}, async (messages) => {
      supervisorCalls.push(messages);
      return { content: '{"directive":"continue"}' };
    });
    conductor.setContext("general", "low", "run-mark-verified");
    const planItem = {
      id: "pi_main",
      title: "Write helper",
      dependsOn: [] as string[],
      acceptanceChecks: [
        { id: "ac", description: "file written", kind: "diff_match" as const },
      ],
      status: "active" as const,
      repairCycleCount: 0,
    };
    const directive = await conductor.afterStage(
      "executor",
      "completed",
      "Applied write to helper.ts",
      ["synthesizer"],
      {
        planItem,
        writeIntent: true,
        toolCalls: [
          {
            name: "write_file",
            arguments: { path: "helper.ts" },
            output: "ok",
            is_error: false,
            duration_ms: 5,
          },
        ],
      },
    );
    expect(directive.type).toBe("mark_verified");
    if (directive.type === "mark_verified") {
      expect(directive.itemId).toBe("pi_main");
      expect(directive.gradingMode).toBe("conductor_direct_diff");
    }
    // Deterministic grade — no supervisory model call.
    expect(supervisorCalls.length).toBe(0);
  });

  test("reviewer REJECT fires start_repair_chain without Conductor re-decision", async () => {
    const supervisorCalls: unknown[] = [];
    const { conductor } = makeConductor({}, async (messages) => {
      supervisorCalls.push(messages);
      return { content: '{"directive":"continue"}' };
    });
    conductor.setContext("general", "medium", "run-repair-chain");
    const planItem = {
      id: "pi_fix",
      title: "Fix bug",
      dependsOn: [] as string[],
      acceptanceChecks: [] as Array<{ id: string; description: string }>,
      status: "active" as const,
      repairCycleCount: 0,
    };
    const directive = await conductor.afterStage(
      "reviewer",
      "completed",
      "REJECT — missing error handling on the write path",
      ["synthesizer"],
      { planItem, writeIntent: true },
    );
    expect(directive.type).toBe("start_repair_chain");
    if (directive.type === "start_repair_chain") {
      expect(directive.newRemaining).toEqual([
        "rewriter",
        "executor",
        "reviewer",
        "synthesizer",
      ]);
      expect(directive.reason).toMatch(/automatic/i);
    }
    expect(supervisorCalls.length).toBe(0);
  });

  test("reviewer ACCEPT emits mark_verified with reviewer_mediated", async () => {
    const { conductor } = makeConductor();
    conductor.setContext("general", "medium", "run-reviewer-accept");
    const planItem = {
      id: "pi_ok",
      title: "Done item",
      dependsOn: [] as string[],
      acceptanceChecks: [] as Array<{ id: string; description: string }>,
      status: "active" as const,
      repairCycleCount: 1,
    };
    const directive = await conductor.afterStage(
      "reviewer",
      "completed",
      "ACCEPT — all acceptance checks met",
      ["synthesizer"],
      { planItem },
    );
    expect(directive.type).toBe("mark_verified");
    if (directive.type === "mark_verified") {
      expect(directive.gradingMode).toBe("reviewer_mediated");
      expect(directive.itemId).toBe("pi_ok");
    }
  });

  test("repair-cycle backstop emits block_item", async () => {
    const { conductor } = makeConductor({ max_tool_errors_before_reroute: 3 }, async () => ({
      content: '{"directive":"continue"}',
    }));
    // max_repair_cycles is on cfg — set via constructor override by recreating
    const bus = (await import("./conductor-bus")).ConductorBus;
    const { AgentPool, DEFAULT_ORCHESTRATOR_AGENTS } = await import("./agent-pool");
    const { LiveConductor } = await import("./conductor");
    const limited = new LiveConductor(
      async () => ({ content: '{"directive":"continue"}' }),
      new bus(),
      new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS),
      {
        supervision_timeout_ms: 1000,
        max_tool_errors_before_reroute: 3,
        supervise_low_complexity: true,
        max_repair_cycles: 1,
      },
    );
    limited.setContext("general", "high", "run-backstop");
    const planItem = {
      id: "pi_stuck",
      title: "Stuck item",
      dependsOn: [] as string[],
      acceptanceChecks: [] as Array<{ id: string; description: string }>,
      status: "active" as const,
      repairCycleCount: 1, // already at max
    };
    const directive = await limited.afterStage(
      "reviewer",
      "completed",
      "REJECT — still broken",
      ["synthesizer"],
      { planItem, writeIntent: true },
    );
    expect(directive.type).toBe("block_item");
    if (directive.type === "block_item") {
      expect(directive.itemId).toBe("pi_stuck");
      expect(directive.reason).toMatch(/backstop/);
    }
  });

  test("medium complexity executor without reviewer in queue escalates", async () => {
    const { conductor } = makeConductor();
    conductor.setContext("general", "medium", "run-escalate");
    const planItem = {
      id: "pi_complex",
      title: "Complex change",
      dependsOn: [] as string[],
      acceptanceChecks: [] as Array<{ id: string; description: string }>,
      status: "active" as const,
      repairCycleCount: 0,
    };
    const directive = await conductor.afterStage(
      "executor",
      "completed",
      "made changes",
      ["synthesizer"],
      {
        planItem,
        writeIntent: true,
        toolCalls: [
          {
            name: "write_file",
            arguments: { path: "x.ts" },
            output: "ok",
            is_error: false,
            duration_ms: 3,
          },
        ],
      },
    );
    expect(directive.type).toBe("escalate_reviewer");
    if (directive.type === "escalate_reviewer") {
      expect(directive.newRemaining?.[0]).toBe("reviewer");
    }
  });
});
