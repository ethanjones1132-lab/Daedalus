/**
 * Owned runtime-loop consolidation (Conductor-first).
 *
 * Consolidates planning ownership, per-item completion grading, automatic
 * Reviewer→Rewriter→Executor repair chaining, and consecutive-failure backstop
 * around the TaskPlan v2 ledger — without inventing a parallel orchestrator.
 *
 * Safety nets (budget boundaries, cancellation) remain infrastructure and are
 * intentionally out of scope here.
 */

import type { Complexity, SharedContextHints, StageName } from "./coordinator";
import type { ExecutionProfile } from "./route-normalization";
import {
  advancePlanQueue,
  getActivePlanItem,
  incrementPlanItemRepairCycle,
  makeEvidencePointer,
  markPlanItemBlocked,
  markPlanItemVerified,
  setTaskPlan,
  type CreateTaskPlanItemInput,
  type TaskPlanEvidencePointer,
  type TaskPlanGradingMode,
  type TaskPlanItem,
  type TaskRunContract,
} from "./task-run";
import { parseReviewerVerdict } from "./stage-output";
import type { ToolCallRecord } from "./stage-output";
import { WRITE_EFFECT_TOOLS } from "./effect-gate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Who authors the TaskPlan for a new request. */
export type PlanAuthorshipPath = "conductor_direct" | "planner_mediated";

/**
 * Conductor-authored brief handed to Planner on medium/high complexity.
 * Not a full transcript — request + relevant memory only.
 */
export interface ConductorPlanBrief {
  request: string;
  objective: string;
  estimatedComplexity: Complexity;
  relevantMemory: string[];
  failurePatterns: string[];
  constraints: string[];
}

export interface OwnedPlanningAttachment {
  plan_authorship: PlanAuthorshipPath;
  /** Seeded immediately for conductor_direct. Empty for planner_mediated until validate. */
  plan_items: CreateTaskPlanItemInput[];
  /** Present only on planner_mediated path. */
  plan_brief?: ConductorPlanBrief;
}

export interface DirectDiffGradeInput {
  item: Pick<TaskPlanItem, "title" | "description" | "acceptanceChecks">;
  /** Stage narrative / output summary. */
  output: string;
  toolCalls?: ToolCallRecord[];
  /** Optional precomputed write-effect count. */
  successfulWrites?: number;
  writeIntent?: boolean;
}

export interface DirectDiffGradeResult {
  sufficient: boolean;
  reason: string;
  /** When sufficient, preferred grading mode for mark-off. */
  gradingMode: TaskPlanGradingMode;
}

export interface RepairChainDecision {
  fire: boolean;
  backstop: boolean;
  reason: string;
  /** Stages to inject ahead of remaining synthesizer work. */
  stages: StageName[];
}

export interface ApplySufficientInput {
  itemId: string;
  evidence: TaskPlanEvidencePointer;
  gradingMode: TaskPlanGradingMode;
  advance?: boolean;
}

export interface ApplyInsufficientInput {
  itemId: string;
  flaggedIssues: string;
  /** Increment repair cycle before deciding whether to fire the chain. */
  maxRepairCycles?: number;
  consecutiveFailures?: number;
  maxConsecutiveFailures?: number;
}

/** Default max Reviewer→Rewriter→Executor cycles per plan item. */
export const DEFAULT_MAX_REPAIR_CYCLES = 2;

/**
 * Reuses LiveConductor's consecutive-failure spirit (tool-error threshold in
 * conductor.ts). Repair-chain backstop uses the same scale.
 */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

// ---------------------------------------------------------------------------
// 1. Plan — complexity gate + authorship
// ---------------------------------------------------------------------------

/**
 * Simple (low) tasks: Conductor authors the plan directly.
 * Medium/high: Conductor brief → Planner proposes → Conductor validates.
 */
export function planAuthorshipPath(complexity: Complexity): PlanAuthorshipPath {
  return complexity === "low" ? "conductor_direct" : "planner_mediated";
}

/**
 * Conductor-direct plan for a simple request: one ledger item covering the
 * whole objective, with a default acceptance check. Deterministic — no model.
 */
export function authorSimplePlanItems(
  request: string,
  opts: { taskType?: string; id?: string } = {},
): CreateTaskPlanItemInput[] {
  const objective = request.trim() || "Complete the request";
  const title = objective.length > 120 ? `${objective.slice(0, 117)}...` : objective;
  return [
    {
      id: opts.id ?? "pi_main",
      title,
      description: objective,
      acceptanceChecks: [
        {
          id: "ac_main",
          description: opts.taskType
            ? `Objective met for ${opts.taskType} task`
            : "Objective met (conductor direct diff or reviewer accept)",
          kind: "diff_match",
        },
      ],
    },
  ];
}

/**
 * Build the Conductor brief for planner-mediated planning. Memory is sliced —
 * never a full transcript dump.
 */
export function buildConductorPlanBrief(
  request: string,
  complexity: Complexity,
  memory?: SharedContextHints,
  constraints: string[] = [],
): ConductorPlanBrief {
  return {
    request: request.trim(),
    objective: request.trim().slice(0, 800),
    estimatedComplexity: complexity,
    relevantMemory: (memory?.relevant_memories ?? []).slice(-8).map((m) => m.slice(0, 600)),
    failurePatterns: (memory?.failure_patterns ?? []).slice(-6).map((p) => p.slice(0, 400)),
    constraints: constraints.map((c) => c.trim()).filter(Boolean).slice(0, 12),
  };
}

/**
 * Attach owned-planning metadata to a routing decision. Call at intake after
 * complexity is known (Coordinator.route). Does not touch the TaskPlan ledger —
 * {@link seedTaskPlanFromPlanning} does that.
 */
export function attachOwnedPlanning(
  request: string,
  complexity: Complexity,
  opts: {
    taskType?: string;
    memory?: SharedContextHints;
    constraints?: string[];
  } = {},
): OwnedPlanningAttachment {
  const path = planAuthorshipPath(complexity);
  if (path === "conductor_direct") {
    return {
      plan_authorship: "conductor_direct",
      plan_items: authorSimplePlanItems(request, { taskType: opts.taskType }),
    };
  }
  return {
    plan_authorship: "planner_mediated",
    plan_items: [],
    plan_brief: buildConductorPlanBrief(
      request,
      complexity,
      opts.memory,
      opts.constraints,
    ),
  };
}

/**
 * Heuristic extraction of ordered plan items from planner narrative.
 * Used so the complex path can unit-test without a live planner model.
 * Prefers numbered/bulleted lists; falls back to a single item from the brief.
 */
export function extractPlanItemsFromPlannerNarrative(
  narrative: string,
  brief?: ConductorPlanBrief,
): CreateTaskPlanItemInput[] {
  const lines = narrative
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const items: CreateTaskPlanItemInput[] = [];
  for (const line of lines) {
    const match = line.match(/^(?:#{1,3}\s+|\d+[\.)]\s+|[-*•]\s+)(.+)$/);
    if (!match) continue;
    const title = match[1].replace(/\*+/g, "").trim();
    if (title.length < 3 || title.length > 200) continue;
    // Skip headings that are clearly meta, not work items.
    if (/^(plan|overview|summary|approach|steps?|notes?)\b/i.test(title)) continue;
    items.push({
      id: `pi_${items.length + 1}`,
      title,
      acceptanceChecks: [
        {
          id: `ac_${items.length + 1}`,
          description: `Done: ${title}`,
          kind: "reviewer_pass",
        },
      ],
    });
    if (items.length >= 12) break;
  }

  if (items.length > 0) return items;

  const fallback = brief?.objective?.trim() || narrative.trim().slice(0, 160) || "Execute plan";
  return [
    {
      id: "pi_1",
      title: fallback.length > 120 ? `${fallback.slice(0, 117)}...` : fallback,
      description: brief?.request ?? narrative.slice(0, 800),
      acceptanceChecks: [
        {
          id: "ac_1",
          description: "Planner decomposition accepted by Conductor",
          kind: "reviewer_pass",
        },
      ],
    },
  ];
}

/**
 * Conductor validates / lightly revises a Planner proposal before ledger persist.
 * Pure: drops empty titles, caps count, ensures sequential deps when multi-item.
 */
export function conductorValidatePlanItems(
  proposed: CreateTaskPlanItemInput[],
  brief?: ConductorPlanBrief,
): { items: CreateTaskPlanItemInput[]; revised: boolean; notes: string } {
  const cleaned: CreateTaskPlanItemInput[] = [];
  let revised = false;

  for (const entry of proposed) {
    const title = (entry.title ?? "").trim();
    if (!title) {
      revised = true;
      continue;
    }
    let finalTitle = title;
    if (title.length > 160) {
      revised = true;
      finalTitle = `${title.slice(0, 157)}...`;
    }
    cleaned.push({
      id: entry.id?.trim() || `pi_${cleaned.length + 1}`,
      title: finalTitle,
      ...(entry.description?.trim() ? { description: entry.description.trim() } : {}),
      dependsOn: entry.dependsOn ? [...entry.dependsOn] : undefined,
      acceptanceChecks: entry.acceptanceChecks?.length
        ? entry.acceptanceChecks
        : [{ id: `ac_${cleaned.length + 1}`, description: `Done: ${title}`, kind: "reviewer_pass" as const }],
    });
  }

  if (cleaned.length === 0) {
    return {
      items: extractPlanItemsFromPlannerNarrative(brief?.request ?? "Complete the request", brief),
      revised: true,
      notes: "empty planner proposal — conductor seeded fallback item from brief",
    };
  }

  // If multi-item and no deps declared, chain them in order so advancePlanQueue works.
  const anyDeps = cleaned.some((item) => (item.dependsOn?.length ?? 0) > 0);
  if (!anyDeps && cleaned.length > 1) {
    revised = true;
    for (let i = 1; i < cleaned.length; i++) {
      cleaned[i] = {
        ...cleaned[i],
        dependsOn: [cleaned[i - 1].id!],
      };
    }
  }

  return {
    items: cleaned.slice(0, 12),
    revised,
    notes: revised ? "conductor revised planner proposal" : "conductor accepted planner proposal",
  };
}

/**
 * Whether intake should (re)seed the TaskPlan ledger.
 *
 * Seed only when:
 * - no usable v2 plan (missing schema, reconstruction_required, empty items), OR
 * - caller forces reseed (new task run / material objective change)
 *
 * Never clobber a live v2 plan on multi-turn continuation — that wipes
 * verified / blocked / repairCycleCount progress.
 */
export function shouldSeedTaskPlan(
  contract: TaskRunContract,
  opts: { force?: boolean } = {},
): boolean {
  if (opts.force === true) return true;
  if (contract.reconstruction === "reconstruction_required") return true;
  if (contract.schemaVersion !== 2) return true;
  const items = contract.plan?.items ?? [];
  return items.length === 0;
}

/**
 * Normalize objective text for coarse continuity comparison.
 */
function normalizeObjectiveKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/**
 * True when the new planning objective is materially different from the live
 * task-run objective (fresh work, not a terse continuation cue).
 */
export function isMaterialObjectiveChange(
  contract: TaskRunContract,
  planning: OwnedPlanningAttachment,
): boolean {
  if (planning.plan_authorship !== "conductor_direct" || planning.plan_items.length === 0) {
    return false;
  }
  const prior = normalizeObjectiveKey(contract.objective ?? "");
  const next = normalizeObjectiveKey(
    planning.plan_items[0]?.description
      || planning.plan_items[0]?.title
      || "",
  );
  if (!prior || !next) return false;
  if (prior === next) return false;
  // Terse follow-ups ("continue", "now fix the tests") still re-author a
  // simple plan from the message — only treat as material when both sides
  // look like real objectives and share little lexical overlap.
  if (next.length < 24 || prior.length < 24) return false;
  const priorTokens = new Set(prior.split(" ").filter((t) => t.length > 2));
  const nextTokens = next.split(" ").filter((t) => t.length > 2);
  if (nextTokens.length === 0) return false;
  const overlap = nextTokens.filter((t) => priorTokens.has(t)).length;
  return overlap / nextTokens.length < 0.35;
}

/**
 * Persist planning into the TaskPlan ledger (v2).
 * - conductor_direct: seeds from plan_items when ledger is empty/unusable, or
 *   when force / material objective change demands a new plan
 * - planner_mediated: only after validate; pass validated items
 *
 * Multi-turn: does NOT wipe verified/blocked state on continuation.
 */
export function seedTaskPlanFromPlanning(
  contract: TaskRunContract,
  planning: OwnedPlanningAttachment,
  opts: { activateFirst?: boolean; force?: boolean } = {},
): TaskRunContract {
  if (planning.plan_authorship === "conductor_direct") {
    if (planning.plan_items.length === 0) {
      return contract;
    }
    const force =
      opts.force === true || isMaterialObjectiveChange(contract, planning);
    if (!shouldSeedTaskPlan(contract, { force })) {
      return contract;
    }
    return setTaskPlan(contract, planning.plan_items, {
      activateFirst: opts.activateFirst !== false,
    });
  }
  // Complex path: ledger stays empty until planner proposal is validated.
  return contract;
}

/**
 * Format Conductor plan brief for injection into Planner model messages
 * (planner_mediated path). Structured, not a full transcript dump.
 */
export function formatConductorPlanBrief(brief: ConductorPlanBrief): string {
  const lines: string[] = [
    "## Conductor plan brief",
    `Objective: ${brief.objective}`,
    `Estimated complexity: ${brief.estimatedComplexity}`,
  ];
  if (brief.constraints.length > 0) {
    lines.push("Constraints:");
    for (const c of brief.constraints) lines.push(`- ${c}`);
  }
  if (brief.relevantMemory.length > 0) {
    lines.push("Relevant memory:");
    for (const m of brief.relevantMemory) lines.push(`- ${m}`);
  }
  if (brief.failurePatterns.length > 0) {
    lines.push("Failure patterns to avoid:");
    for (const p of brief.failurePatterns) lines.push(`- ${p}`);
  }
  lines.push("", `User request: ${brief.request}`);
  return lines.join("\n");
}

/**
 * After planner stage on planner_mediated path: validate proposal and persist.
 */
export function seedTaskPlanFromPlannerProposal(
  contract: TaskRunContract,
  plannerNarrative: string,
  brief?: ConductorPlanBrief,
  opts: { activateFirst?: boolean } = {},
): { contract: TaskRunContract; items: CreateTaskPlanItemInput[]; notes: string } {
  const proposed = extractPlanItemsFromPlannerNarrative(plannerNarrative, brief);
  const validated = conductorValidatePlanItems(proposed, brief);
  const next = setTaskPlan(contract, validated.items, {
    activateFirst: opts.activateFirst !== false,
  });
  return { contract: next, items: validated.items, notes: validated.notes };
}

// ---------------------------------------------------------------------------
// 2–3. Direct completion check + mark-off
// ---------------------------------------------------------------------------

/**
 * Conductor local grade via tool/diff evidence against the active item's
 * acceptance checks. Intentionally cheap and deterministic — escalate to
 * Reviewer when this cannot confidently accept.
 */
export function gradeViaDirectDiff(input: DirectDiffGradeInput): DirectDiffGradeResult {
  const output = (input.output ?? "").trim();
  const toolCalls = input.toolCalls ?? [];
  const successfulWrites =
    input.successfulWrites ??
    toolCalls.filter((call) => !call.is_error && WRITE_EFFECT_TOOLS.has(call.name)).length;
  const successfulReads = toolCalls.filter(
    (call) =>
      !call.is_error &&
      (call.name === "read_file" || call.name === "list_directory" || call.name === "glob" || call.name === "grep"),
  ).length;
  const errorCount = toolCalls.filter((call) => call.is_error).length;

  if (errorCount > 0 && successfulWrites === 0 && successfulReads === 0) {
    return {
      sufficient: false,
      reason: `tool errors without successful evidence (${errorCount})`,
      gradingMode: "conductor_direct_diff",
    };
  }

  if (input.writeIntent && successfulWrites === 0) {
    return {
      sufficient: false,
      reason: "write-intent item has zero successful mutations",
      gradingMode: "conductor_direct_diff",
    };
  }

  // Acceptance-check keyword soft match against narrative/tool names.
  const haystack = [
    output,
    ...toolCalls.map((c) => `${c.name} ${c.output.slice(0, 200)}`),
  ]
    .join("\n")
    .toLowerCase();

  const checks = input.item.acceptanceChecks ?? [];
  if (checks.length > 0) {
    const unmet = checks.filter((check) => {
      if (check.kind === "reviewer_pass") return true; // always escalate kind
      if (check.kind === "test_pass") {
        return !/\b(pass|passed|ok|green|0 fail)\b/i.test(haystack);
      }
      if (check.kind === "diff_match") {
        // Any successful write or substantive output counts as diff evidence.
        return successfulWrites === 0 && output.length < 40;
      }
      // manual / unknown: require non-empty output
      return output.length < 20 && successfulWrites === 0 && successfulReads === 0;
    });
    if (unmet.some((c) => c.kind === "reviewer_pass")) {
      return {
        sufficient: false,
        reason: "acceptance requires reviewer_pass — escalate",
        gradingMode: "reviewer_mediated",
      };
    }
    if (unmet.length > 0) {
      return {
        sufficient: false,
        reason: `acceptance checks unmet: ${unmet.map((c) => c.description).join("; ")}`,
        gradingMode: "conductor_direct_diff",
      };
    }
  }

  if (output.length === 0 && toolCalls.length === 0) {
    return {
      sufficient: false,
      reason: "empty stage output with no tool evidence",
      gradingMode: "conductor_direct_diff",
    };
  }

  return {
    sufficient: true,
    reason: "conductor direct-diff grade: evidence meets acceptance",
    gradingMode: "conductor_direct_diff",
  };
}

/** Mark item verified + optional advance. Pure ledger mutation. */
export function applySufficientVerdict(
  contract: TaskRunContract,
  input: ApplySufficientInput,
): TaskRunContract {
  return markPlanItemVerified(contract, input.itemId, {
    gradingMode: input.gradingMode,
    evidence: makeEvidencePointer(
      input.evidence.ref,
      input.evidence.summary,
      input.evidence.recordedAt,
    ),
    advance: input.advance,
  });
}

/**
 * Whether local Conductor capacity is enough to grade this item, or we must
 * escalate to Reviewer. Medium/high complexity and reviewer_pass checks escalate.
 */
export function shouldEscalateToReviewer(args: {
  complexity: Complexity;
  item?: Pick<TaskPlanItem, "acceptanceChecks">;
  localGrade?: DirectDiffGradeResult;
}): boolean {
  if (args.complexity !== "low") return true;
  if (args.item?.acceptanceChecks?.some((c) => c.kind === "reviewer_pass")) return true;
  if (args.localGrade && !args.localGrade.sufficient) {
    // Local insufficient on low complexity still escalates when write/evidence
    // gaps are present — repair may need reviewer mediation later.
    return args.localGrade.reason.includes("reviewer_pass");
  }
  return false;
}

// ---------------------------------------------------------------------------
// 5–6. Automatic Reviewer→Rewriter→Executor repair chain
// ---------------------------------------------------------------------------

/**
 * Deterministic repair-chain stage list. Once Reviewer returns insufficient,
 * these stages fire without another Conductor decision in between.
 *
 * Order: rewriter (apply fix direction) → executor (re-apply / complete) →
 * reviewer (re-grade). Caller appends synthesizer / remaining queue tail.
 */
export function buildAutomaticRepairChainStages(): StageName[] {
  return ["rewriter", "executor", "reviewer"];
}

/**
 * Merge repair chain ahead of the post-review remaining queue, deduping and
 * preserving a single trailing synthesizer when present.
 */
export function mergeRepairChainIntoRemaining(
  remainingQueue: readonly StageName[],
  chain: readonly StageName[] = buildAutomaticRepairChainStages(),
): StageName[] {
  const hasSynth = remainingQueue.includes("synthesizer");
  const tail = remainingQueue.filter(
    (stage) =>
      stage !== "synthesizer" &&
      stage !== "rewriter" &&
      stage !== "executor" &&
      stage !== "reviewer",
  );
  const out: StageName[] = [...chain, ...tail];
  if (hasSynth) out.push("synthesizer");
  return out;
}

/**
 * Decide whether the automatic repair chain fires, or the consecutive-failure
 * / repair-cycle backstop blocks further repair.
 *
 * Reuses the consecutive-failure counting spirit from LiveConductor
 * (conductor.ts onToolResult / max_tool_errors_before_reroute) rather than a
 * parallel signal.
 */
export function decideRepairChain(args: {
  reviewerHasIssues: boolean;
  writeIntent: boolean;
  profile?: ExecutionProfile;
  repairCycleCount: number;
  maxRepairCycles?: number;
  consecutiveFailures?: number;
  maxConsecutiveFailures?: number;
  /** When false, read-intent turns skip automatic repair (existing write gate). */
  allowOnReadIntent?: boolean;
}): RepairChainDecision {
  const maxCycles = args.maxRepairCycles ?? DEFAULT_MAX_REPAIR_CYCLES;
  const maxFails = args.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const consecutive = args.consecutiveFailures ?? 0;
  const stages = buildAutomaticRepairChainStages();

  if (!args.reviewerHasIssues) {
    return { fire: false, backstop: false, reason: "reviewer accepted", stages: [] };
  }
  if (args.profile && args.profile !== "full") {
    return {
      fire: false,
      backstop: false,
      reason: "repair chain only runs on full execution profile",
      stages: [],
    };
  }
  if (!args.writeIntent && args.allowOnReadIntent !== true) {
    return {
      fire: false,
      backstop: false,
      reason: "repair chain suppressed on non-write turn",
      stages: [],
    };
  }
  if (consecutive >= maxFails) {
    return {
      fire: false,
      backstop: true,
      reason: `consecutive-failure backstop (${consecutive} >= ${maxFails})`,
      stages: [],
    };
  }
  if (args.repairCycleCount >= maxCycles) {
    return {
      fire: false,
      backstop: true,
      reason: `repair-cycle backstop (${args.repairCycleCount} >= ${maxCycles})`,
      stages: [],
    };
  }
  return {
    fire: true,
    backstop: false,
    reason: "reviewer insufficient — automatic Reviewer→Rewriter→Executor chain",
    stages,
  };
}

/**
 * On insufficient Reviewer verdict: increment repair cycle and optionally
 * block the item when the backstop trips. Does NOT decide the stage queue —
 * pair with {@link decideRepairChain} + {@link mergeRepairChainIntoRemaining}.
 */
export function applyInsufficientVerdict(
  contract: TaskRunContract,
  input: ApplyInsufficientInput,
): {
  contract: TaskRunContract;
  decision: RepairChainDecision;
} {
  const active = getActivePlanItem(contract);
  const itemId = input.itemId || active?.id;
  if (!itemId) {
    return {
      contract,
      decision: {
        fire: false,
        backstop: true,
        reason: "no active plan item for insufficient verdict",
        stages: [],
      },
    };
  }

  let next = incrementPlanItemRepairCycle(contract, itemId, 1);
  const item = getActivePlanItem(next) ?? next.plan?.items.find((i) => i.id === itemId);
  const decision = decideRepairChain({
    reviewerHasIssues: true,
    writeIntent: true,
    repairCycleCount: item?.repairCycleCount ?? 1,
    maxRepairCycles: input.maxRepairCycles,
    consecutiveFailures: input.consecutiveFailures,
    maxConsecutiveFailures: input.maxConsecutiveFailures,
  });

  if (decision.backstop) {
    next = markPlanItemBlocked(
      next,
      itemId,
      `${decision.reason}; flagged: ${input.flaggedIssues.slice(0, 300)}`,
    );
  }

  return { contract: next, decision };
}

/**
 * Reviewer accept → mark verified with reviewer_mediated grading.
 */
export function applyReviewerAccept(
  contract: TaskRunContract,
  itemId: string,
  evidence: TaskPlanEvidencePointer,
): TaskRunContract {
  return applySufficientVerdict(contract, {
    itemId,
    evidence,
    gradingMode: "reviewer_mediated",
  });
}

/** Parse reviewer feedback into accept/reject for runtime-loop consumers. */
export function reviewerFeedbackIsInsufficient(feedback: string): boolean {
  const verdict = parseReviewerVerdict(feedback);
  if (verdict === "reject") return true;
  if (verdict === "accept") return false;
  const normalized = feedback.toUpperCase();
  return normalized.includes("PARTIAL") || normalized.includes("MISSING");
}

/**
 * After mark-off: ensure the next ready item is active. Thin wrapper so call
 * sites speak "context flush / advance" without importing ledger ops directly.
 */
export function flushItemAndAdvance(contract: TaskRunContract): TaskRunContract {
  return advancePlanQueue(contract);
}

// ---------------------------------------------------------------------------
// 9. Backstop helpers (consecutive-failure counting reuse)
// ---------------------------------------------------------------------------

/**
 * Map LiveConductor consecutiveToolErrors into a backstop boolean.
 * Same threshold semantics as afterStage's max_tool_errors_before_reroute path.
 */
export function shouldBackstopFromConsecutiveFailures(
  consecutiveFailures: number,
  threshold: number = DEFAULT_MAX_CONSECUTIVE_FAILURES,
): boolean {
  if (threshold <= 0) return false;
  return consecutiveFailures >= threshold;
}
