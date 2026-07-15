// ═══════════════════════════════════════════════════════════════
// ── Route Normalization — runtime route invariants ──
// ═══════════════════════════════════════════════════════════════
// The coordinator MODEL chooses a route, but its output is advisory. This pure
// layer is AUTHORITATIVE: it takes the (model or fallback) coordinator decision
// plus the deterministic turn-requirement class and produces an executable stage
// plan + least-authority execution profile that always satisfies these
// invariants:
//
//   • The pipeline always ends with exactly one synthesizer.
//   • A `workspace_read` turn ALWAYS includes the executor with a read-only
//     profile — never collapses to synthesizer-only (the exact bug that made
//     "read this file" return "the orchestrator produced no output").
//   • A `full_execution` turn includes a reviewed executor route with full tools.
//   • A `conversational` turn is stripped to synthesizer-only with no tools.
//   • An all-null / empty pipeline is rebuilt from the capability class, NOT
//     defaulted unconditionally to synthesizer-only.
//   • `workspace_read` / `full_execution` force `linear` topology (tool
//     execution + side-effect safety).
//
// Misclassification always errs toward LESS authority: a read turn that the
// model wrongly marked as an edit is capped to read-only tools.

import type { CoordinatorResult, StageName, Topology } from "./coordinator";
import type { TurnRequirement } from "./turn-requirements";

/**
 * Canonical Coordinator-shaped decision for a turn whose deterministic
 * requirement is sufficient to bypass model-backed routing. Keeping the same
 * shape lets telemetry, normalization, and the PipelineExecutor remain on the
 * normal path even though no Coordinator inference call was spent.
 */
export function buildShortCircuitRoute(
  requirement: Extract<TurnRequirement, "conversational" | "answer_only">,
): CoordinatorResult {
  return {
    task_type: "general",
    pipeline: ["synthesizer"],
    topology: "linear",
    context: {
      needs_workspace_inspection: false,
      needs_memory: requirement === "answer_only",
      estimated_complexity: "low",
    },
    coordinator_rationale: "Deterministic simple-turn short circuit: direct synthesizer answer.",
    conductor_source: "trivial",
  };
}

/**
 * T1.2: sibling of buildShortCircuitRoute for requirements where the API
 * coordinator is advisory-only (workspace_read) and we skip a known-bad or
 * unavailable coordinator path. normalizeRoute will still enforce invariants.
 */
export function buildDeterministicRoute(
  requirement: TurnRequirement,
): CoordinatorResult {
  if (requirement === "conversational" || requirement === "answer_only") {
    return {
      task_type: "general",
      pipeline: ["synthesizer"],
      topology: "linear",
      context: {
        needs_workspace_inspection: false,
        needs_memory: requirement === "answer_only",
        estimated_complexity: "low",
      },
      coordinator_rationale: `Deterministic ${requirement} route: coordinator skipped.`,
      conductor_source: "deterministic",
    };
  }
  if (requirement === "workspace_read") {
    return {
      task_type: "research",
      pipeline: ["executor", "synthesizer"],
      topology: "linear",
      context: {
        needs_workspace_inspection: true,
        needs_memory: false,
        estimated_complexity: "medium",
      },
      coordinator_rationale: "Deterministic workspace_read route: local conductor unavailable + advisory coordinator skipped.",
      conductor_source: "deterministic",
    };
  }
  return {
    task_type: "general",
    pipeline: ["planner", "executor", "reviewer", "synthesizer"],
    topology: "linear",
    context: {
      needs_workspace_inspection: true,
      needs_memory: false,
      estimated_complexity: "high",
    },
    coordinator_rationale: "Deterministic full_execution route: coordinator skipped.",
    conductor_source: "deterministic",
  };
}

/**
 * Drop advisory stages when the routed pipeline cannot fit the time left in
 * the turn. Executor and synthesizer are the irreducible answer-producing
 * pair; planner/reviewer/rewriter are shed in that order of value to the
 * user's requested result.
 */
const STAGE_FLOOR_MS: Record<string, number> = {
  planner: 12_000,
  executor: 15_000,
  reviewer: 12_000,
  rewriter: 8_000,
  synthesizer: 20_000,
};
const BUDGET_DROP_ORDER = ["rewriter", "reviewer", "planner"] as const;

export function reconcileRouteWithBudget(
  pipeline: string[],
  turnMs: number,
  finalizationReserveMs: number,
  alreadySpentMs: number,
): { pipeline: string[]; dropped: string[] } {
  const available = turnMs - finalizationReserveMs - Math.max(0, alreadySpentMs);
  const cost = (stages: string[]) => stages.reduce(
    (sum, stage) => sum + (STAGE_FLOOR_MS[stage] ?? 10_000),
    0,
  );
  const result = [...pipeline];
  const dropped: string[] = [];

  for (const candidate of BUDGET_DROP_ORDER) {
    if (cost(result) <= available) break;
    const index = result.indexOf(candidate);
    if (index >= 0) {
      result.splice(index, 1);
      dropped.push(candidate);
    }
  }

  return { pipeline: result, dropped };
}

/**
 * Least-authority tool profile handed to the executor/rewriter stages.
 *   none      — no tools (conversational / pure-answer turns).
 *   read_only — read_file, list_directory, glob, grep only.
 *   full      — the executor's full tool set (mutations, shell, agents).
 */
export type ExecutionProfile = "none" | "read_only" | "full";

export type RouteSource =
  | "model"
  | "parse_fallback"
  | "invariant_override"
  | "trivial_short_circuit"
  | "deterministic";

export interface NormalizedRoute {
  pipeline: StageName[];
  topology: Topology;
  profile: ExecutionProfile;
  requirement: TurnRequirement;
  route_source: RouteSource;
  /** The raw model/fallback pipeline before normalization (for telemetry). */
  original_pipeline: Array<StageName | null | string>;
  /** Set when normalization had to correct the model's route. */
  override_reason?: string;
}

// Canonical stage order. Reconstructed pipelines always follow this order so an
// out-of-order model decision can't produce e.g. synthesizer-before-executor.
const CANONICAL_ORDER: StageName[] = ["planner", "executor", "reviewer", "rewriter", "synthesizer"];

/** Stages permitted for each capability class (synthesizer always implied). */
const ALLOWED_STAGES: Record<TurnRequirement, ReadonlySet<StageName>> = {
  conversational: new Set<StageName>(["synthesizer"]),
  answer_only: new Set<StageName>(["planner", "executor", "reviewer", "synthesizer"]),
  // Minimal deterministic read route: one bounded executor, then synthesis.
  workspace_read: new Set<StageName>(["executor", "synthesizer"]),
  full_execution: new Set<StageName>(["planner", "executor", "reviewer", "rewriter", "synthesizer"]),
};

/** Stages that MUST be present for each class. */
const REQUIRED_STAGES: Record<TurnRequirement, StageName[]> = {
  conversational: ["synthesizer"],
  answer_only: ["synthesizer"],
  workspace_read: ["executor", "synthesizer"],
  full_execution: ["executor", "reviewer", "synthesizer"],
};

const VALID_STAGE_SET = new Set<StageName>(["planner", "executor", "reviewer", "rewriter", "synthesizer"]);

/**
 * T2.2: pure normalizer for mid-run reroute directives.
 * Non-escalation (workspace_read never gains rewriter), keep unrun REQUIRED_STAGES
 * after currentStage, strip conductor_replan, map re-enter:X→X, exactly one trailing
 * synthesizer. Empty input ⇒ null (rejected).
 */
export function normalizeRemainingStages(
  newRemaining: Array<StageName | string | null | undefined>,
  requirement: TurnRequirement,
  currentStage: StageName,
): StageName[] | null {
  if (!newRemaining || newRemaining.length === 0) return null;

  const allowed = ALLOWED_STAGES[requirement];
  const seen = new Set<StageName>();
  const collected: StageName[] = [];

  for (const step of newRemaining) {
    if (!step) continue;
    if (step === "conductor_replan") continue;
    const raw = String(step);
    const isExplicitReentry = raw.startsWith("re-enter:");
    const stage = (raw.startsWith("re-enter:") ? raw.slice("re-enter:".length) : raw) as StageName;
    if (!VALID_STAGE_SET.has(stage)) continue;
    if (!allowed.has(stage)) continue;
    if (stage === currentStage && !isExplicitReentry) continue;
    if (seen.has(stage)) continue;
    seen.add(stage);
    collected.push(stage);
  }

  const currentIdx = CANONICAL_ORDER.indexOf(currentStage);
  for (const req of REQUIRED_STAGES[requirement]) {
    if (seen.has(req)) continue;
    const reqIdx = CANONICAL_ORDER.indexOf(req);
    if (reqIdx > currentIdx) {
      collected.push(req);
      seen.add(req);
    }
  }

  collected.sort((a, b) => CANONICAL_ORDER.indexOf(a) - CANONICAL_ORDER.indexOf(b));
  const withoutSynth = collected.filter((s) => s !== "synthesizer");
  const ordered: StageName[] = [...withoutSynth, "synthesizer"];
  return ordered.length > 0 ? ordered : null;
}

const PROFILE_FOR: Record<TurnRequirement, ExecutionProfile> = {
  conversational: "none",
  answer_only: "read_only",
  workspace_read: "read_only",
  full_execution: "full",
};

/** Strip `re-enter:` prefixes and nulls down to a concrete stage list. */
function toStageList(pipeline: CoordinatorResult["pipeline"]): StageName[] {
  const out: StageName[] = [];
  for (const step of pipeline) {
    if (!step) continue;
    // B-01 (Track B, Conductor Recursive Self-Selection): `conductor_replan`
    // is a META decision. It is preserved in `original_pipeline` (see below)
    // for telemetry + B-02 interception, but it is NEVER a concrete stage in
    // the executable pipeline — it is a signal to re-invoke the local
    // persistent conductor, not a worker to schedule.
    if (step === "conductor_replan") continue;
    const stage = step as string;
    out.push((stage.startsWith("re-enter:") ? stage.slice("re-enter:".length) : stage) as StageName);
  }
  return out;
}

export function normalizeRoute(
  decision: CoordinatorResult,
  requirement: TurnRequirement,
  routeSource: RouteSource,
): NormalizedRoute {
  const original = [...decision.pipeline];
  const modelStages = new Set(toStageList(decision.pipeline));

  const allowed = ALLOWED_STAGES[requirement];
  const required = REQUIRED_STAGES[requirement];
  const profile = PROFILE_FOR[requirement];

  // Union of (model stages ∩ allowed) with the required stages, ordered
  // canonically. Synthesizer is appended exactly once at the end below.
  const include = new Set<StageName>();
  for (const stage of CANONICAL_ORDER) {
    if (stage === "synthesizer") continue;
    if (allowed.has(stage) && (modelStages.has(stage) || required.includes(stage))) {
      include.add(stage);
    }
  }
  for (const stage of required) {
    if (stage !== "synthesizer") include.add(stage);
  }

  const pipeline = CANONICAL_ORDER.filter((s) => s !== "synthesizer" && include.has(s));
  pipeline.push("synthesizer"); // exactly one, always last

  // Topology: read/exec turns are forced linear (tools + side-effect safety).
  // Conversational/answer turns keep the model's topology unless the pipeline is
  // synthesizer-only (then linear is the only meaningful choice).
  let topology: Topology = decision.topology;
  if (requirement === "workspace_read" || requirement === "full_execution") {
    topology = "linear";
  } else if (pipeline.length === 1) {
    topology = "linear";
  }

  // Did we change the model's intended route? Compare the executable form.
  const modelExecutable = toStageList(decision.pipeline);
  const changed =
    modelExecutable.length !== pipeline.length ||
    modelExecutable.some((s, i) => s !== pipeline[i]) ||
    topology !== decision.topology;

  let route_source = routeSource;
  let override_reason: string | undefined;
  if (changed && routeSource === "model") {
    route_source = "invariant_override";
    override_reason =
      `Model route ${JSON.stringify(modelExecutable)}/${decision.topology} did not satisfy ` +
      `${requirement} invariants; normalized to ${JSON.stringify(pipeline)}/${topology} (profile=${profile}).`;
  } else if (changed) {
    override_reason =
      `Normalized ${routeSource} route to ${JSON.stringify(pipeline)}/${topology} for ${requirement} (profile=${profile}).`;
  }

  return {
    pipeline,
    topology,
    profile,
    requirement,
    route_source,
    original_pipeline: original,
    override_reason,
  };
}
