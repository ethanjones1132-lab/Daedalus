import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../config";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import { PipelineExecutor } from "./pipeline";
import {
  createTaskRun,
  getActivePlanItem,
  getPlanItem,
  markPlanItemVerified,
} from "./task-run";
import { evaluateTaskPlanAcceptance, buildTaskPlanGrounding } from "./task-plan-evidence";

const GROUP_A_PLAN_MARKDOWN = `
# Execution Plan
## Group A
### A1 — Add the bypass invariant
- [ ] Implement the invariant
### A2 — Replace volatility depth
- [ ] Update the calculation
### A3 — Add regression coverage
- [ ] Run the focused suite
### A4 — Verify the full group
- [ ] Build and smoke
## Group B
### B1 — Later work
`;

/**
 * The TaskPlan ledger has exactly one correct home in pipeline.ts, and one
 * place it must never go back to.
 *
 * IT BELONGS in the `buildMidLoopSignal` `base` object: that signal feeds
 * `decideMidLoopIntervention`, whose remaining-work reflex injects the
 * "N items still unverified" push that holds the executor open, and whose
 * budget guard converts an unfinishable remainder into a named partial.
 *
 * IT MUST NOT go into the Slice D `assessCorrectnessFloor(` gate. That gate
 * asks "is correctness met so the quality push can unlock?" — a `false` there
 * REMOVES supervision. Feeding it the ledger (2026-07-29, Tasks C1/C2)
 * inverted the intent: a partially-drained ledger disabled the only pressure
 * still active after the first write. Live run_da68c50b (5 of 6 items
 * outstanding) issued zero quality pushes where pre-change run_7e6b590f
 * issued two. Task C3 moved the ledger out of the floor and into its own
 * reflex.
 *
 * The pure-function tests in mid-loop-intervention.test.ts prove the reflex
 * behaves correctly given a hand-built signal; they say nothing about whether
 * production code populates that signal, or about where it must not be
 * populated. This crude source tripwire covers both directions.
 */
describe("TaskPlan ledger stays wired to the mid-loop signal, not the correctness floor", () => {
  const source = readFileSync(join(import.meta.dir, "pipeline.ts"), "utf8");
  const lines = source.split("\n");

  test("the mid-loop base signal still forwards plan and read-loop counters", () => {
    const baseSignalIdx = lines.findIndex((line) =>
      line.includes("const base: MidLoopSignal = {"),
    );
    expect(baseSignalIdx).toBeGreaterThan(-1);

    // The object literal runs for a few dozen lines after its opening.
    const window = lines.slice(baseSignalIdx, baseSignalIdx + 40).join("\n");
    expect(window).toContain("planItemsTotal");
    expect(window).toContain("planItemsRemaining");
    expect(window).toContain("totalSuccessfulReads");
  });

  test("no assessCorrectnessFloor( call site forwards the ledger", () => {
    const callSiteLines: number[] = [];
    lines.forEach((line, i) => {
      if (line.includes("assessCorrectnessFloor(")) callSiteLines.push(i);
    });
    expect(callSiteLines.length).toBeGreaterThanOrEqual(1);

    for (const lineIdx of callSiteLines) {
      // Only look FORWARD: an inline object literal passed to the floor starts
      // on the call line. Looking backward would pick up the unrelated `base`
      // literal above and produce a false failure.
      const literal = lines.slice(lineIdx, lineIdx + 20).join("\n");
      // A bare `assessCorrectnessFloor(base)`-style call passes a variable and
      // has no literal of its own to inspect; the check below is a no-op for
      // those, and meaningful for the inline-literal sites.
      expect(literal).not.toContain("planItemsTotal:");
      expect(literal).not.toContain("planItemsRemaining:");
    }
  });
});

describe("pipeline reviewer ACCEPT requires grounded evidence", () => {
  test("ACCEPT + only read_file leaves item active and segment partial", async () => {
    const runtime = createToolRuntime();
    runtime.register(
      {
        type: "function",
        function: {
          name: "read_file",
          description: "read",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
        requires_approval: false,
        dangerous: false,
      } as any,
      async () => "file contents",
    );
    const config = defaultConfig();
    config.tools.require_approval = [];
    const ctx = makeExecutionContext("agent", config, { workspace_path: process.cwd() });

    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        executorTurns++;
        // First turn: only a read (no write). Subsequent turns (repair) still no write.
        return {
          content: "I inspected the file.",
          tool_calls: [
            {
              id: `call_read_${executorTurns}`,
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "src/main.ts" }),
              },
            },
          ],
        };
      }
      if (options.stageLabel === "reviewer") {
        return { content: "ACCEPT — looks complete" };
      }
      if (options.stageLabel === "synthesizer") {
        return { content: "should not be treated as successful verification" };
      }
      if (options.stageLabel === "rewriter") {
        return { content: "rewrite guidance" };
      }
      return { content: "ok" };
    };

    let contract = createTaskRun({
      taskRunId: "task_ungrounded_accept",
      sessionId: "sess_ungrounded_accept",
      objective: "implement the write path",
      requirement: "full_execution",
      estimatedComplexity: "medium",
      planItems: [
        {
          id: "pi_write",
          title: "Implement the write path",
          acceptanceChecks: [
            { id: "ac_write", description: "reviewer accepts grounded write", kind: "reviewer_pass" },
          ],
        },
      ],
    });
    expect(getActivePlanItem(contract)?.id).toBe("pi_write");

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, {
      recordStageRun: () => {},
    });

    const segment = await executor.executeSegment(
      "implement the write path in src/main.ts",
      ["executor", "reviewer", "synthesizer"],
      "run_ungrounded_accept",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "implement the write path in src/main.ts",
        taskRunWriteIntent: true,
        taskRunContract: contract,
        maxReviewRepairRounds: 0,
        allowMidRunReplan: false,
        onTaskPlanUpdate: (next) => {
          contract = next;
        },
      },
    );

    const item = getPlanItem(contract, "pi_write");
    expect(item?.status).toBe("active");
    expect(segment.partialStage?.errorCode).toBe("plan_item_acceptance_unmet");
  });

  test("ACCEPT without write then write+ACCEPT recovers: item verified and partialStage cleared", async () => {
    const runtime = createToolRuntime();
    runtime.register(
      {
        type: "function",
        function: {
          name: "read_file",
          description: "read",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
        requires_approval: false,
        dangerous: false,
      } as any,
      async () => "file contents",
    );
    runtime.register(
      {
        type: "function",
        function: {
          name: "write_file",
          description: "write",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
        requires_approval: false,
        dangerous: false,
      } as any,
      async () => "File written",
    );
    const config = defaultConfig();
    config.tools.require_approval = [];
    const ctx = makeExecutionContext("agent", config, { workspace_path: process.cwd() });

    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        executorTurns++;
        // First pass: only a read (triggers plan_item_acceptance_unmet + repair).
        // Repair re-entry: successful write so grounded ACCEPT can verify.
        if (executorTurns === 1) {
          return {
            content: "I inspected the file.",
            tool_calls: [
              {
                id: "call_read_1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "src/main.ts" }),
                },
              },
            ],
          };
        }
        return {
          content: "I implemented the write path.",
          tool_calls: [
            {
              id: `call_write_${executorTurns}`,
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "src/main.ts",
                  content: "export function main() { return 1; }\n",
                }),
              },
            },
          ],
        };
      }
      if (options.stageLabel === "reviewer") {
        return { content: "ACCEPT — looks complete" };
      }
      if (options.stageLabel === "synthesizer") {
        return { content: "Implemented the write path in src/main.ts." };
      }
      if (options.stageLabel === "rewriter") {
        return { content: "Apply the write that was missing on the first pass." };
      }
      return { content: "ok" };
    };

    let contract = createTaskRun({
      taskRunId: "task_accept_recovery",
      sessionId: "sess_accept_recovery",
      objective: "implement the write path",
      requirement: "full_execution",
      estimatedComplexity: "medium",
      planItems: [
        {
          id: "pi_write",
          title: "Implement the write path",
          acceptanceChecks: [
            { id: "ac_write", description: "reviewer accepts grounded write", kind: "reviewer_pass" },
          ],
        },
      ],
    });
    expect(getActivePlanItem(contract)?.id).toBe("pi_write");

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, {
      recordStageRun: () => {},
    });

    const segment = await executor.executeSegment(
      "implement the write path in src/main.ts",
      ["executor", "reviewer", "synthesizer"],
      "run_accept_recovery",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "implement the write path in src/main.ts",
        taskRunWriteIntent: true,
        taskRunContract: contract,
        // Allow one repair cycle so unmet ACCEPT can re-enter executor with a write.
        maxReviewRepairRounds: 1,
        allowMidRunReplan: false,
        onTaskPlanUpdate: (next) => {
          contract = next;
        },
      },
    );

    const item = getPlanItem(contract, "pi_write");
    expect(item?.status).toBe("verified");
    // Sticky unmet must not survive grounded recovery.
    expect(segment.partialStage?.errorCode).not.toBe("plan_item_acceptance_unmet");
    expect(segment.partialStage).toBeUndefined();
    expect(executorTurns).toBeGreaterThanOrEqual(2);
  });
});

describe("pipeline expands explicit workspace plans on read_file", () => {
  test("reading GROUP_A_EXECUTION.md expands broad active item; one A2 write cannot verify parent", async () => {
    const runtime = createToolRuntime();
    runtime.register(
      {
        type: "function",
        function: {
          name: "read_file",
          description: "read",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
        requires_approval: false,
        dangerous: false,
      } as any,
      async (args: { path?: string }) => {
        if (String(args.path ?? "").includes("GROUP_A_EXECUTION")) {
          return GROUP_A_PLAN_MARKDOWN;
        }
        return "file contents";
      },
    );
    runtime.register(
      {
        type: "function",
        function: {
          name: "write_file",
          description: "write",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
        requires_approval: false,
        dangerous: false,
      } as any,
      async () => "File written",
    );
    const config = defaultConfig();
    config.tools.require_approval = [];
    const ctx = makeExecutionContext("agent", config, { workspace_path: process.cwd() });

    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        executorTurns++;
        if (executorTurns === 1) {
          return {
            content: "Reading the Group A plan.",
            tool_calls: [
              {
                id: "call_read_plan",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "GROUP_A_EXECUTION.md" }),
                },
              },
            ],
          };
        }
        // Only A2 mutation — must not verify the whole Group A parent.
        return {
          content: "Implemented A2 volatility depth only.",
          tool_calls: [
            {
              id: "call_write_a2",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "src/volatility_depth.ts",
                  content: "export const depth = 2;\n",
                }),
              },
            },
          ],
        };
      }
      if (options.stageLabel === "reviewer") {
        return { content: "ACCEPT — A2 looks fine" };
      }
      if (options.stageLabel === "synthesizer") {
        return { content: "Group A partially done (only A2 written)." };
      }
      return { content: "ok" };
    };

    let contract = createTaskRun({
      taskRunId: "task_group_a_expand",
      sessionId: "sess_group_a_expand",
      objective: "Execute Group A from GROUP_A_EXECUTION.md",
      requirement: "full_execution",
      estimatedComplexity: "medium",
      planItems: [
        {
          id: "pi_group_a",
          title: "Execute Group A tasks",
          acceptanceChecks: [
            { id: "ac_group", description: "Group A complete", kind: "reviewer_pass" },
          ],
        },
      ],
    });
    expect(getActivePlanItem(contract)?.id).toBe("pi_group_a");

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, {
      recordStageRun: () => {},
    });

    await executor.executeSegment(
      "Execute Group A from GROUP_A_EXECUTION.md",
      ["executor", "reviewer", "synthesizer"],
      "run_group_a_expand",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Execute Group A from GROUP_A_EXECUTION.md",
        taskRunWriteIntent: true,
        taskRunContract: contract,
        maxReviewRepairRounds: 0,
        allowMidRunReplan: false,
        onTaskPlanUpdate: (next) => {
          contract = next;
        },
      },
    );

    // After reading the plan, the broad parent is replaced by A1–A4.
    expect(contract.plan?.items.map((item) => [item.id, item.status])).toEqual([
      ["pi_a1", "active"],
      ["pi_a2", "pending"],
      ["pi_a3", "pending"],
      ["pi_a4", "pending"],
    ]);
    expect(contract.status).toBe("active");
    expect(getPlanItem(contract, "pi_group_a")).toBeUndefined();

    // One A2-style mutation cannot verify A1 (still active) or the vanished parent.
    const a1 = getPlanItem(contract, "pi_a1")!;
    const a2WriteGrounding = buildTaskPlanGrounding({
      writeIntent: true,
      reviewerAccepted: true,
      toolCalls: [
        {
          name: "write_file",
          arguments: { path: "src/volatility_depth.ts" },
          output: "File written",
          is_error: false,
          duration_ms: 1,
        },
      ],
    });
    expect(evaluateTaskPlanAcceptance(a1, a2WriteGrounding).accepted).toBe(false);

    // Even forcing A2 verification still leaves the ledger open.
    try {
      contract = markPlanItemVerified(contract, "pi_a2", {
        gradingMode: "conductor_direct_diff",
        evidence: {
          ref: "ev_a2_only",
          grounding: {
            requiredEffect: "write",
            reviewerAccepted: false,
            successfulWrites: ["src/volatility_depth.ts"],
            successfulReads: [],
            check: {
              tier: "builtin",
              ran: true,
              passed: true,
              command: "test",
              detail: "ok",
            },
          },
        },
        advance: false,
      });
    } catch {
      // A2 is pending (depends on A1); verification may reject — still open either way.
    }
    expect(contract.status).toBe("active");
    expect(contract.plan?.items.some((item) => item.status !== "verified")).toBe(true);
  });
});
