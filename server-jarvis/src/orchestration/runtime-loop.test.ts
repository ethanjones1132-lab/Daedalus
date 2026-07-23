import { describe, expect, test } from "bun:test";
import {
  applyInsufficientVerdict,
  applyReviewerAccept,
  applySufficientVerdict,
  attachOwnedPlanning,
  authorSimplePlanItems,
  buildAutomaticRepairChainStages,
  buildConductorPlanBrief,
  conductorValidatePlanItems,
  decideRepairChain,
  extractPlanItemsFromPlannerNarrative,
  gradeViaDirectDiff,
  mergeRepairChainIntoRemaining,
  planAuthorshipPath,
  reviewerFeedbackIsInsufficient,
  seedTaskPlanFromPlannerProposal,
  seedTaskPlanFromPlanning,
  shouldBackstopFromConsecutiveFailures,
  shouldEscalateToReviewer,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_REPAIR_CYCLES,
} from "./runtime-loop";
import {
  createTaskRun,
  getActivePlanItem,
  getPlanItem,
  listVerifiedPlanItems,
  type TaskRunContract,
} from "./task-run";

function baseContract(overrides: Partial<Parameters<typeof createTaskRun>[0]> = {}): TaskRunContract {
  return createTaskRun({
    taskRunId: "task_test",
    sessionId: "sess_test",
    objective: "implement the feature",
    requirement: "full_execution",
    estimatedComplexity: "low",
    ...overrides,
  });
}

describe("runtime-loop > plan authorship complexity gate", () => {
  test("low complexity → conductor_direct; medium/high → planner_mediated", () => {
    expect(planAuthorshipPath("low")).toBe("conductor_direct");
    expect(planAuthorshipPath("medium")).toBe("planner_mediated");
    expect(planAuthorshipPath("high")).toBe("planner_mediated");
  });

  test("simple plan path seeds ledger with conductor-authored item", () => {
    const planning = attachOwnedPlanning("add a README note about setup", "low", {
      taskType: "docs",
    });
    expect(planning.plan_authorship).toBe("conductor_direct");
    expect(planning.plan_items).toHaveLength(1);
    expect(planning.plan_items[0].title).toContain("README");
    expect(planning.plan_brief).toBeUndefined();

    const contract = baseContract({ estimatedComplexity: "low" });
    const seeded = seedTaskPlanFromPlanning(contract, planning);
    expect(seeded.plan?.items).toHaveLength(1);
    expect(seeded.plan?.activeItemId).toBeTruthy();
    expect(getActivePlanItem(seeded)?.status).toBe("active");
    expect(seeded.remainingWork.length).toBe(1);
  });

  test("complex path hands brief to planner (no ledger items yet)", () => {
    const planning = attachOwnedPlanning(
      "Refactor the auth module into a strategy pattern with tests",
      "high",
      {
        taskType: "refactor",
        memory: {
          relevant_memories: ["auth uses JWT today", "tests live under server-jarvis"],
          failure_patterns: ["empty planner completion"],
        },
      },
    );
    expect(planning.plan_authorship).toBe("planner_mediated");
    expect(planning.plan_items).toEqual([]);
    expect(planning.plan_brief).toBeDefined();
    expect(planning.plan_brief!.relevantMemory).toContain("auth uses JWT today");
    expect(planning.plan_brief!.failurePatterns).toContain("empty planner completion");

    const contract = baseContract({ estimatedComplexity: "high" });
    const unchanged = seedTaskPlanFromPlanning(contract, planning);
    expect(unchanged.plan?.items ?? []).toHaveLength(0);
  });

  test("planner proposal is validated and seeded after Conductor revise", () => {
    const brief = buildConductorPlanBrief("build multi-step adapter", "medium");
    const narrative = [
      "# Plan",
      "1. Scaffold adapter module",
      "2. Wire unit tests",
      "3. Document usage",
      "",
      "Notes: keep public API stable.",
    ].join("\n");

    const contract = baseContract({ estimatedComplexity: "medium" });
    const { contract: seeded, items, notes } = seedTaskPlanFromPlannerProposal(
      contract,
      narrative,
      brief,
    );
    expect(items.length).toBe(3);
    expect(seeded.plan?.activeItemId).toBe(items[0].id);
    expect(getPlanItem(seeded, items[1].id!)?.dependsOn).toEqual([items[0].id!]);
    expect(notes).toMatch(/revised|accepted/);
  });

  test("conductorValidatePlanItems drops empties and chains deps", () => {
    const result = conductorValidatePlanItems([
      { title: "  " },
      { title: "First real step" },
      { title: "Second real step" },
    ]);
    expect(result.revised).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[1].dependsOn).toEqual([result.items[0].id!]);
  });

  test("extractPlanItemsFromPlannerNarrative falls back to brief objective", () => {
    const items = extractPlanItemsFromPlannerNarrative(
      "We should carefully consider the design.",
      buildConductorPlanBrief("ship the cache layer", "medium"),
    );
    expect(items).toHaveLength(1);
    expect(items[0].title).toContain("cache");
  });
});

describe("runtime-loop > mark verified on sufficient", () => {
  test("conductor direct-diff grade accepts successful writes", () => {
    const grade = gradeViaDirectDiff({
      item: {
        title: "Write helper",
        acceptanceChecks: [{ id: "ac", description: "file written", kind: "diff_match" }],
      },
      output: "Applied edit to helper.ts",
      toolCalls: [
        {
          name: "write_file",
          arguments: { path: "helper.ts" },
          output: "ok",
          is_error: false,
          duration_ms: 10,
        },
      ],
      writeIntent: true,
    });
    expect(grade.sufficient).toBe(true);
    expect(grade.gradingMode).toBe("conductor_direct_diff");
  });

  test("write-intent with zero mutations is insufficient", () => {
    const grade = gradeViaDirectDiff({
      item: { title: "Edit", acceptanceChecks: [] },
      output: "I would edit the file",
      toolCalls: [],
      writeIntent: true,
    });
    expect(grade.sufficient).toBe(false);
    expect(grade.reason).toMatch(/zero successful mutations/);
  });

  test("applySufficientVerdict marks item verified and advances queue", () => {
    const planning = attachOwnedPlanning("do the work", "low");
    let contract = seedTaskPlanFromPlanning(baseContract(), planning);
    const active = getActivePlanItem(contract)!;
    contract = applySufficientVerdict(contract, {
      itemId: active.id,
      gradingMode: "conductor_direct_diff",
      evidence: { ref: "run_1:executor", summary: "diff clean" },
    });
    expect(getPlanItem(contract, active.id)?.status).toBe("verified");
    expect(getPlanItem(contract, active.id)?.gradingMode).toBe("conductor_direct_diff");
    expect(listVerifiedPlanItems(contract)).toHaveLength(1);
    expect(contract.status).toBe("completed");
  });

  test("reviewer accept uses reviewer_mediated grading", () => {
    const planning = attachOwnedPlanning("complex-ish single item", "low");
    // Force reviewer_pass check
    planning.plan_items[0].acceptanceChecks = [
      { id: "ac", description: "reviewer ok", kind: "reviewer_pass" },
    ];
    let contract = seedTaskPlanFromPlanning(baseContract(), planning);
    const active = getActivePlanItem(contract)!;
    contract = applyReviewerAccept(contract, active.id, {
      ref: "run_1:reviewer",
      summary: "ACCEPT — looks good",
    });
    expect(getPlanItem(contract, active.id)?.gradingMode).toBe("reviewer_mediated");
    expect(getPlanItem(contract, active.id)?.status).toBe("verified");
  });

  test("shouldEscalateToReviewer for medium+ and reviewer_pass checks", () => {
    expect(shouldEscalateToReviewer({ complexity: "medium" })).toBe(true);
    expect(shouldEscalateToReviewer({ complexity: "low" })).toBe(false);
    expect(
      shouldEscalateToReviewer({
        complexity: "low",
        item: {
          acceptanceChecks: [{ id: "a", description: "needs review", kind: "reviewer_pass" }],
        },
      }),
    ).toBe(true);
  });
});

describe("runtime-loop > automatic repair chain (no Conductor re-decision)", () => {
  test("buildAutomaticRepairChainStages is Rewriter → Executor → Reviewer", () => {
    expect(buildAutomaticRepairChainStages()).toEqual(["rewriter", "executor", "reviewer"]);
  });

  test("mergeRepairChainIntoRemaining preserves synthesizer tail", () => {
    expect(mergeRepairChainIntoRemaining(["synthesizer"])).toEqual([
      "rewriter",
      "executor",
      "reviewer",
      "synthesizer",
    ]);
    expect(mergeRepairChainIntoRemaining(["planner", "synthesizer"], ["executor", "reviewer"])).toEqual([
      "executor",
      "reviewer",
      "planner",
      "synthesizer",
    ]);
  });

  test("decideRepairChain fires without requiring a Conductor decision", () => {
    const decision = decideRepairChain({
      reviewerHasIssues: true,
      writeIntent: true,
      profile: "full",
      repairCycleCount: 0,
      maxRepairCycles: 2,
    });
    expect(decision.fire).toBe(true);
    expect(decision.backstop).toBe(false);
    expect(decision.stages).toEqual(["rewriter", "executor", "reviewer"]);
    expect(decision.reason).toMatch(/automatic/i);
  });

  test("repair chain does not fire on non-write turns", () => {
    const decision = decideRepairChain({
      reviewerHasIssues: true,
      writeIntent: false,
      profile: "full",
      repairCycleCount: 0,
    });
    expect(decision.fire).toBe(false);
    expect(decision.reason).toMatch(/non-write/);
  });

  test("applyInsufficientVerdict increments repair cycle and can fire chain", () => {
    const planning = attachOwnedPlanning("fix the bug", "low");
    let contract = seedTaskPlanFromPlanning(baseContract(), planning);
    const active = getActivePlanItem(contract)!;
    const { contract: next, decision } = applyInsufficientVerdict(contract, {
      itemId: active.id,
      flaggedIssues: "REJECT — missing error handling",
      maxRepairCycles: 2,
      consecutiveFailures: 0,
    });
    expect(getPlanItem(next, active.id)?.repairCycleCount).toBe(1);
    expect(decision.fire).toBe(true);
    expect(decision.stages).toEqual(["rewriter", "executor", "reviewer"]);
  });

  test("reviewerFeedbackIsInsufficient parses ACCEPT/REJECT", () => {
    expect(reviewerFeedbackIsInsufficient("ACCEPT — looks good")).toBe(false);
    expect(reviewerFeedbackIsInsufficient("REJECT — missing tests")).toBe(true);
    expect(reviewerFeedbackIsInsufficient("Still PARTIAL coverage")).toBe(true);
  });
});

describe("runtime-loop > consecutive-failure backstop", () => {
  test("shouldBackstopFromConsecutiveFailures reuses threshold semantics", () => {
    expect(shouldBackstopFromConsecutiveFailures(0)).toBe(false);
    expect(shouldBackstopFromConsecutiveFailures(DEFAULT_MAX_CONSECUTIVE_FAILURES - 1)).toBe(false);
    expect(shouldBackstopFromConsecutiveFailures(DEFAULT_MAX_CONSECUTIVE_FAILURES)).toBe(true);
    expect(shouldBackstopFromConsecutiveFailures(10, 5)).toBe(true);
  });

  test("repair-cycle backstop blocks item instead of firing chain", () => {
    const planning = attachOwnedPlanning("fix repeatedly", "low");
    let contract = seedTaskPlanFromPlanning(baseContract(), planning);
    const active = getActivePlanItem(contract)!;
    // Exhaust repair cycles
    for (let i = 0; i < DEFAULT_MAX_REPAIR_CYCLES; i++) {
      const applied = applyInsufficientVerdict(contract, {
        itemId: active.id,
        flaggedIssues: `reject ${i}`,
        maxRepairCycles: DEFAULT_MAX_REPAIR_CYCLES,
      });
      contract = applied.contract;
    }
    const final = applyInsufficientVerdict(contract, {
      itemId: active.id,
      flaggedIssues: "still broken",
      maxRepairCycles: DEFAULT_MAX_REPAIR_CYCLES,
    });
    expect(final.decision.fire).toBe(false);
    expect(final.decision.backstop).toBe(true);
    expect(getPlanItem(final.contract, active.id)?.status).toBe("blocked");
  });

  test("consecutive tool-error backstop trips decideRepairChain", () => {
    const decision = decideRepairChain({
      reviewerHasIssues: true,
      writeIntent: true,
      profile: "full",
      repairCycleCount: 0,
      consecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
      maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
    });
    expect(decision.fire).toBe(false);
    expect(decision.backstop).toBe(true);
    expect(decision.reason).toMatch(/consecutive-failure/);
  });
});

describe("runtime-loop > authorSimplePlanItems", () => {
  test("truncates long titles and always includes acceptance check", () => {
    const long = "x".repeat(200);
    const items = authorSimplePlanItems(long, { taskType: "general", id: "pi_fixed" });
    expect(items[0].id).toBe("pi_fixed");
    expect(items[0].title!.length).toBeLessThanOrEqual(120);
    expect(items[0].acceptanceChecks?.length).toBe(1);
  });
});
