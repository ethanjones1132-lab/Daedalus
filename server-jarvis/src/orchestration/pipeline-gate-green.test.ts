import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { BUILTIN_MODES } from "./modes";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import type { StageRun } from "../self-tuning/store";
import {
  PipelineExecutor,
  passingTargetCoversAllWrittenCode,
  runTargetCoverageOf,
  writtenCodeFilePaths,
  type StageRunRecorder,
} from "./pipeline";
import type { ToolCallRecord } from "./stage-output";

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
 * Build an executor whose deterministic gates and this-turn written files are
 * fully controlled by the test. The executor stage emits one write_file call
 * per `writtenFiles` path (so the loop has "written tool calls" to gate), then
 * reports done; the reviewer/synthesizer models are mocked. `reviewerCalls`
 * counts real reviewer model invocations so a test can assert the fast path
 * skipped (0) or ran (>=1).
 */
function makeGatedExecutor(opts: {
  syntaxIssues: any[];
  runGate: any;
  writtenFiles?: string[];
  config?: ReturnType<typeof defaultConfig>;
  rows?: StageRun[];
}) {
  const runtime = createToolRuntime();
  runtime.register(toolDefinition("write_file"), async () => "wrote file");
  const cfg = opts.config ?? defaultConfig();
  cfg.tools = { ...cfg.tools, require_approval: [], sandbox_mode: "permissive" };
  const ctx = makeExecutionContext("agent", cfg, { workspace_path: process.cwd() });
  const collector: StageRunRecorder = { recordStageRun: (row) => opts.rows?.push(row) };
  const writtenFiles = opts.writtenFiles ?? ["solution.py"];

  let reviewerCalls = 0;
  let executorTurns = 0;
  const synthCalls: Array<{ max_tokens?: number; systemPrompt?: string }> = [];
  const callModel = async (
    messages: Array<{ role?: string; content?: string }>,
    options: { stageLabel?: string; max_tokens?: number } = {},
  ) => {
    if (options.stageLabel === "executor") {
      if (executorTurns++ === 0) {
        return {
          content: "writing the solution",
          tool_calls: writtenFiles.map((path) => toolCallWithArgs("write_file", { path, content: "print('ok')" })),
        };
      }
      return { content: "done" };
    }
    if (options.stageLabel === "reviewer") {
      reviewerCalls++;
      return { content: "ACCEPT" };
    }
    if (options.stageLabel === "synthesizer") {
      synthCalls.push({
        max_tokens: options.max_tokens,
        systemPrompt: messages.find((m) => m.role === "system")?.content,
      });
      return { content: "final answer" };
    }
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
    synthCalls: () => synthCalls,
  };
}

// Default synthesizer cap. B3 leaves this untouched on every non-gate-verified
// turn and drops to a smaller cap on gate-green turns.
const DEFAULT_SYNTH_MAX_TOKENS = BUILTIN_MODES.synthesizer.max_tokens; // 8192

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

  // Review follow-up (Important): a passing run gate proves ONE target exited 0,
  // not that the whole turn's written code was validated.
  test("still runs the model reviewer on a multi-file turn whose passing test covers only one file", async () => {
    const rows: StageRun[] = [];
    const { executor, reviewerCalls } = makeGatedExecutor({
      syntaxIssues: [],
      // The gate ran solution's test; helper.py was written this turn but never
      // exercised (only parse-checked by the syntax gate).
      runGate: { status: "passed", target: "solution_t.py", issues: [] },
      writtenFiles: ["solution.py", "helper.py"],
      rows,
    });

    await executor.execute(
      WRITE_REQUEST,
      ["executor", "reviewer", "synthesizer"],
      "run-gate-green-multifile",
      () => {},
      {
        executionProfile: "full",
        rawMessage: WRITE_REQUEST,
        maxReviewRepairRounds: 2,
        allowMidRunReplan: false,
      },
    );

    expect(reviewerCalls()).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.mode_id === "reviewer_gate_skip")).toBe(false);
  });

  test("still runs the model reviewer when the passing target is an unrelated adjacent test", async () => {
    const rows: StageRun[] = [];
    const { executor, reviewerCalls } = makeGatedExecutor({
      syntaxIssues: [],
      // utils.py written this turn; run gate picked a pre-existing, unrelated
      // test_app.py sibling (Priority B alphabetically-first) that exits 0 but
      // never imports utils.py.
      runGate: { status: "passed", target: "test_app.py", issues: [] },
      writtenFiles: ["utils.py"],
      rows,
    });

    await executor.execute(
      WRITE_REQUEST,
      ["executor", "reviewer", "synthesizer"],
      "run-gate-green-unrelated-adjacent",
      () => {},
      {
        executionProfile: "full",
        rawMessage: WRITE_REQUEST,
        maxReviewRepairRounds: 2,
        allowMidRunReplan: false,
      },
    );

    expect(reviewerCalls()).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.mode_id === "reviewer_gate_skip")).toBe(false);
  });

  test("still fast-paths a single-file turn whose bare `_t.py` oracle passed (benchmark shape)", async () => {
    // Regression guard: the measured benchmark case seeds a bare `_t.py` oracle
    // that genuinely exercises the sole written solution — it must still skip.
    const rows: StageRun[] = [];
    const { executor, reviewerCalls } = makeGatedExecutor({
      syntaxIssues: [],
      runGate: { status: "passed", target: "_t.py", issues: [] },
      writtenFiles: ["solution.py"],
      rows,
    });

    const result = await executor.execute(
      WRITE_REQUEST,
      ["executor", "reviewer", "synthesizer"],
      "run-gate-green-bare-oracle",
      () => {},
      {
        executionProfile: "full",
        rawMessage: WRITE_REQUEST,
        maxReviewRepairRounds: 2,
        allowMidRunReplan: false,
      },
    );

    expect(reviewerCalls()).toBe(0);
    expect(rows.some((r) => r.mode_id === "reviewer_gate_skip")).toBe(true);
    expect(result.answer).toBe("final answer");
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

// B3: the reviewer loop stamps ReviewerStageOutput.gateVerified true ONLY on the
// B1 gate-green fast-path exit (deterministic gates confirmed the turn), and
// false on every other exit — a model reviewer ACCEPT is a weaker signal. These
// tests read the typed carry-state directly via executeSegment (which returns
// PipelineStageState) rather than inferring it from stage_runs rows.
describe("B3 reviewer.gateVerified plumbing", () => {
  test("is true when the gate-green fast path skipped the model reviewer", async () => {
    const { executor, reviewerCalls } = makeGatedExecutor({
      syntaxIssues: [],
      runGate: { status: "passed", target: "solution_t.py", issues: [] },
      writtenFiles: ["solution.py"],
    });

    const segment = await executor.executeSegment(
      WRITE_REQUEST,
      ["executor", "reviewer"],
      "b3-gateverified-true",
      () => {},
      { executionProfile: "full", rawMessage: WRITE_REQUEST, maxReviewRepairRounds: 2, allowMidRunReplan: false },
    );

    expect(reviewerCalls()).toBe(0);
    expect(segment.state.reviewer?.gateVerified).toBe(true);
  });

  test("is false when the model reviewer actually ran (run gate 'skipped')", async () => {
    const { executor, reviewerCalls } = makeGatedExecutor({
      syntaxIssues: [],
      runGate: { status: "skipped", reason: "no runnable target", issues: [] },
      writtenFiles: ["solution.py"],
    });

    const segment = await executor.executeSegment(
      WRITE_REQUEST,
      ["executor", "reviewer"],
      "b3-gateverified-reviewer-ran",
      () => {},
      { executionProfile: "full", rawMessage: WRITE_REQUEST, maxReviewRepairRounds: 2, allowMidRunReplan: false },
    );

    expect(reviewerCalls()).toBeGreaterThanOrEqual(1);
    expect(segment.state.reviewer?.gateVerified).toBeFalsy();
  });

  test("is false on a multi-file turn whose passing test covers only one file (fast path declined)", async () => {
    const { executor, reviewerCalls } = makeGatedExecutor({
      syntaxIssues: [],
      runGate: { status: "passed", target: "solution_t.py", issues: [] },
      writtenFiles: ["solution.py", "helper.py"],
    });

    const segment = await executor.executeSegment(
      WRITE_REQUEST,
      ["executor", "reviewer"],
      "b3-gateverified-multifile",
      () => {},
      { executionProfile: "full", rawMessage: WRITE_REQUEST, maxReviewRepairRounds: 2, allowMidRunReplan: false },
    );

    expect(reviewerCalls()).toBeGreaterThanOrEqual(1);
    expect(segment.state.reviewer?.gateVerified).toBeFalsy();
  });
});

// B3: the synthesizer drops to a reduced max_tokens cap AND appends a concise
// directive to its system prompt ONLY on gate-verified turns. Every other turn
// keeps the full default cap and the unmodified prompt (default-path invariant).
describe("B3 concise synthesizer on gate-green turns", () => {
  test("gate-green turn: synthesizer runs at the reduced cap with the concise directive", async () => {
    const { executor, synthCalls } = makeGatedExecutor({
      syntaxIssues: [],
      runGate: { status: "passed", target: "solution_t.py", issues: [] },
      writtenFiles: ["solution.py"],
    });

    const result = await executor.execute(
      WRITE_REQUEST,
      ["executor", "reviewer", "synthesizer"],
      "b3-synth-concise",
      () => {},
      { executionProfile: "full", rawMessage: WRITE_REQUEST, maxReviewRepairRounds: 2, allowMidRunReplan: false },
    );

    expect(result.answer).toBe("final answer");
    const calls = synthCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // Reduced cap (1024), strictly below the default 8192.
    expect(calls[0]?.max_tokens).toBe(1024);
    expect(calls[0]?.max_tokens).toBeLessThan(DEFAULT_SYNTH_MAX_TOKENS);
    // Concise directive injected into the synthesizer system prompt.
    expect(calls[0]?.systemPrompt).toContain("Concise Verified-Turn Mode");
  });

  test("non-gate-verified turn (reviewer ran): synthesizer keeps the default cap and unmodified prompt", async () => {
    const { executor, synthCalls } = makeGatedExecutor({
      syntaxIssues: [],
      // "skipped" run gate ⇒ reviewer runs ⇒ gateVerified falsy ⇒ default path.
      runGate: { status: "skipped", reason: "no runnable target", issues: [] },
      writtenFiles: ["solution.py"],
    });

    await executor.execute(
      WRITE_REQUEST,
      ["executor", "reviewer", "synthesizer"],
      "b3-synth-default-path",
      () => {},
      { executionProfile: "full", rawMessage: WRITE_REQUEST, maxReviewRepairRounds: 2, allowMidRunReplan: false },
    );

    const calls = synthCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // Byte-for-byte default: full cap, no concise directive.
    expect(calls[0]?.max_tokens).toBe(DEFAULT_SYNTH_MAX_TOKENS);
    expect(calls[0]?.systemPrompt).not.toContain("Concise Verified-Turn Mode");
  });
});

function write(path: string): ToolCallRecord {
  return { name: "write_file", arguments: { path }, output: "wrote", is_error: false } as unknown as ToolCallRecord;
}

describe("B1 run-gate coverage guard (pure)", () => {
  test("writtenCodeFilePaths keeps distinct code files and drops non-code + errored writes", () => {
    const calls = [
      write("solution.py"),
      write("solution.py"), // duplicate collapses
      write("README.md"), // non-code ignored
      write("data.json"), // non-code ignored
      { name: "write_file", arguments: { path: "broken.py" }, output: "err", is_error: true } as unknown as ToolCallRecord,
      write("helper.ts"),
    ];
    expect(writtenCodeFilePaths(calls).sort()).toEqual(["helper.ts", "solution.py"]);
  });

  test("runTargetCoverageOf classifies direct / generic / none", () => {
    expect(runTargetCoverageOf("solution.py", "solution.py")).toBe("direct"); // standalone script
    expect(runTargetCoverageOf("solution_t.py", "solution.py")).toBe("direct"); // module-named oracle
    expect(runTargetCoverageOf("test_solution.py", "solution.py")).toBe("direct");
    expect(runTargetCoverageOf("solution_test.py", "solution.py")).toBe("direct");
    expect(runTargetCoverageOf("_t.py", "solution.py")).toBe("generic"); // bare oracle
    expect(runTargetCoverageOf("_t2.py", "solution.py")).toBe("generic");
    expect(runTargetCoverageOf("test_app.py", "utils.py")).toBe("none"); // different module
  });

  test("passingTargetCoversAllWrittenCode: single covered file passes", () => {
    expect(passingTargetCoversAllWrittenCode("solution_t.py", [write("solution.py")])).toBe(true);
  });

  test("passingTargetCoversAllWrittenCode: bare oracle trusted only for a sole code file", () => {
    expect(passingTargetCoversAllWrittenCode("_t.py", [write("solution.py")])).toBe(true);
    // Two files but a bare oracle cannot vouch for both.
    expect(passingTargetCoversAllWrittenCode("_t.py", [write("solution.py"), write("helper.py")])).toBe(false);
  });

  test("passingTargetCoversAllWrittenCode: uncovered second file fails", () => {
    expect(
      passingTargetCoversAllWrittenCode("solution_t.py", [write("solution.py"), write("helper.py")]),
    ).toBe(false);
  });

  test("passingTargetCoversAllWrittenCode: unrelated adjacent test fails", () => {
    expect(passingTargetCoversAllWrittenCode("test_app.py", [write("utils.py")])).toBe(false);
  });

  test("passingTargetCoversAllWrittenCode: no code written (only docs) does not fast-path", () => {
    expect(passingTargetCoversAllWrittenCode("_t.py", [write("README.md")])).toBe(false);
    expect(passingTargetCoversAllWrittenCode(undefined, [write("solution.py")])).toBe(false);
  });

  test("passingTargetCoversAllWrittenCode: executor writing solution + its own test still fast-paths", () => {
    // Both files are covered: the test ran, and it is named after the module.
    expect(
      passingTargetCoversAllWrittenCode("solution_t.py", [write("solution.py"), write("solution_t.py")]),
    ).toBe(true);
  });
});
