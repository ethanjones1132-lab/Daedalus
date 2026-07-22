import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import type { StageRun } from "../self-tuning/store";
import { PipelineExecutor, type StageRunRecorder } from "./pipeline";

// B1: gate-green fast path. When the deterministic syntax gate AND the
// deterministic run gate both positively confirm the written code (syntax
// clean AND run gate status "passed" — a real test actually executed and
// passed), the weak-model reviewer call is skipped for that loop iteration.
// The reviewer must still run when the run gate is "skipped" (absence of
// evidence), when it "failed", or when the config flag is off.
//
// These tests drive runReviewerRewriterLoop through the public execute() entry
// with a ["executor", "reviewer"] pipeline, using the documented protected
// test seams gateWrittenSyntax / gateWrittenRun to inject deterministic gate
// results without spawning a real compiler/interpreter.

function toolDefinition(name: string) {
  return {
    type: "function" as const,
    function: {
      name,
      description: `${name} test tool`,
      parameters: { type: "object" as const, properties: {}, required: [] },
    },
    requires_approval: false,
    dangerous: false,
  };
}

function toolCallWithArgs(name: string, args: Record<string, unknown>) {
  return {
    id: `call_${name}_${Math.random().toString(36).slice(2)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

/**
 * Build an executor whose deterministic gates are fully controlled by the
 * test. The executor stage always emits a single write_file call (so the loop
 * has "written tool calls" to gate), then reports done; the reviewer/
 * synthesizer models are mocked. `reviewerCalls` counts real reviewer model
 * invocations so a test can assert the fast path skipped (0) or ran (>=1).
 */
function makeGatedExecutor(opts: {
  syntaxIssues: any[];
  runGate: any;
  config?: ReturnType<typeof defaultConfig>;
  rows?: StageRun[];
}) {
  const runtime = createToolRuntime();
  runtime.register(toolDefinition("write_file"), async () => "wrote file");
  const cfg = opts.config ?? defaultConfig();
  cfg.tools = { ...cfg.tools, require_approval: [], sandbox_mode: "permissive" };
  const ctx = makeExecutionContext("agent", cfg, { workspace_path: process.cwd() });
  const collector: StageRunRecorder = { recordStageRun: (row) => opts.rows?.push(row) };

  let reviewerCalls = 0;
  let executorTurns = 0;
  const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
    if (options.stageLabel === "executor") {
      if (executorTurns++ === 0) {
        return {
          content: "writing the solution",
          tool_calls: [toolCallWithArgs("write_file", { path: "solution.py", content: "print('ok')" })],
        };
      }
      return { content: "done" };
    }
    if (options.stageLabel === "reviewer") {
      reviewerCalls++;
      return { content: "ACCEPT" };
    }
    if (options.stageLabel === "synthesizer") return { content: "final answer" };
    return { content: "plan" };
  };

  class GatedExecutor extends PipelineExecutor {
    protected async gateWrittenSyntax(): Promise<any[]> {
      return opts.syntaxIssues;
    }
    protected async gateWrittenRun(): Promise<any> {
      return opts.runGate;
    }
  }

  const executor = new GatedExecutor(callModel as any, runtime, ctx, collector);
  return {
    executor,
    reviewerCalls: () => reviewerCalls,
  };
}

const WRITE_REQUEST = "fix the bug in solution.py and write the change";

describe("B1 gate-green fast path", () => {
  test("skips the model reviewer when syntax is clean AND the run gate passed", async () => {
    const rows: StageRun[] = [];
    const { executor, reviewerCalls } = makeGatedExecutor({
      syntaxIssues: [],
      runGate: { status: "passed", target: "solution_t.py", issues: [] },
      rows,
    });

    const result = await executor.execute(
      WRITE_REQUEST,
      ["executor", "reviewer", "synthesizer"],
      "run-gate-green-skip",
      () => {},
      {
        executionProfile: "full",
        rawMessage: WRITE_REQUEST,
        maxReviewRepairRounds: 2,
        allowMidRunReplan: false,
      },
    );

    // The reviewer model was never called on this confirmed-clean turn.
    expect(reviewerCalls()).toBe(0);
    // A distinguishable skip row was recorded (not a canonical "reviewer" row).
    const skipRow = rows.find((r) => r.mode_id === "reviewer_gate_skip");
    expect(skipRow).toBeDefined();
    expect(skipRow?.output_tokens).toBe(0);
    expect(skipRow?.was_successful).toBe(1);
    expect(skipRow?.had_error).toBe(0);
    expect(rows.some((r) => r.mode_id === "reviewer")).toBe(false);
    // The turn still completed through synthesis.
    expect(result.answer).toBe("final answer");
  });

  test("still runs the model reviewer when the run gate is 'skipped' (no evidence)", async () => {
    const rows: StageRun[] = [];
    const { executor, reviewerCalls } = makeGatedExecutor({
      syntaxIssues: [],
      runGate: { status: "skipped", reason: "no runnable target", issues: [] },
      rows,
    });

    await executor.execute(
      WRITE_REQUEST,
      ["executor", "reviewer", "synthesizer"],
      "run-gate-skipped-still-reviews",
      () => {},
      {
        executionProfile: "full",
        rawMessage: WRITE_REQUEST,
        maxReviewRepairRounds: 2,
        allowMidRunReplan: false,
      },
    );

    // "skipped" is an absence of evidence, not a pass — reviewer must run.
    expect(reviewerCalls()).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.mode_id === "reviewer")).toBe(true);
    expect(rows.some((r) => r.mode_id === "reviewer_gate_skip")).toBe(false);
  });

  test("still runs the model reviewer when the flag is explicitly false, even with both gates green", async () => {
    const rows: StageRun[] = [];
    const cfg = defaultConfig();
    cfg.orchestrator.gate_green_skips_reviewer = false;
    const { executor, reviewerCalls } = makeGatedExecutor({
      syntaxIssues: [],
      runGate: { status: "passed", target: "solution_t.py", issues: [] },
      config: cfg,
      rows,
    });

    await executor.execute(
      WRITE_REQUEST,
      ["executor", "reviewer", "synthesizer"],
      "run-gate-green-flag-off",
      () => {},
      {
        executionProfile: "full",
        rawMessage: WRITE_REQUEST,
        maxReviewRepairRounds: 2,
        allowMidRunReplan: false,
      },
    );

    expect(reviewerCalls()).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.mode_id === "reviewer")).toBe(true);
    expect(rows.some((r) => r.mode_id === "reviewer_gate_skip")).toBe(false);
  });

  test("run-gate failure is unaffected: reviewer runs and the failure drives a repair", async () => {
    const rows: StageRun[] = [];
    const { executor, reviewerCalls } = makeGatedExecutor({
      syntaxIssues: [],
      runGate: {
        status: "failed",
        target: "solution_t.py",
        issues: [{ path: "solution.py", error: "AssertionError: expected 2" }],
      },
      rows,
    });

    await executor.execute(
      WRITE_REQUEST,
      ["executor", "reviewer", "synthesizer"],
      "run-gate-failed-unaffected",
      () => {},
      {
        executionProfile: "full",
        rawMessage: WRITE_REQUEST,
        maxReviewRepairRounds: 1,
        allowMidRunReplan: false,
      },
    );

    // A failed run gate never takes the fast path; the reviewer runs.
    expect(reviewerCalls()).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.mode_id === "reviewer")).toBe(true);
    expect(rows.some((r) => r.mode_id === "reviewer_gate_skip")).toBe(false);
  });
});
