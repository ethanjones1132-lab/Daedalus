// ── Eval cases — fixed regression suite for the orchestration layer ──
//
// Deterministic and model-free: routing cases drive the real PredictiveRouter
// with a mock CallModelFn that returns canned content, exercising the actual
// JSON extraction + normalization + fallback logic. Mode-gating cases exercise
// the pure getToolsForMode filter. Coordinator cases drive the Coordinator
// class directly (topology selection, executablePipeline, error surfacing).
// AgentPool cases verify the default pool coverage invariants.
// Add cases here, then refresh baseline.json via
// `bun run src/eval/harness.ts --write-baseline`.

import type { RoutingResult } from "../orchestration/router";
import type { StageName, Topology, TaskType } from "../orchestration/coordinator";
import type { SkillCandidate } from "../intelligence/skill-types";
import type { TurnRequirement } from "../orchestration/turn-requirements";

export const DEFAULT_PIPELINE: StageName[] = ["planner", "executor", "reviewer", "synthesizer"];

export interface RoutingCase {
  id: string;
  kind: "routing";
  request: string;
  /** What the (mock) inference backend returns for this case. */
  modelOutput: string;
  expect: {
    task_type: RoutingResult["task_type"];
    pipeline: string[];
    estimated_complexity?: RoutingResult["context"]["estimated_complexity"];
  };
}

export interface ModeGatingCase {
  id: string;
  kind: "mode_gating";
  modeId: string;
  toolNames: string[];
  expectAllowed: string[];
}

export interface TurnRequirementCase {
  id: string;
  kind: "turn_requirement";
  request: string;
  expect: {
    requirement: TurnRequirement;
    signals?: string[];
    excludedSignals?: string[];
  };
}

function routingJson(
  task_type: string,
  pipeline: string[],
  complexity = "medium",
): string {
  return JSON.stringify({
    task_type,
    pipeline,
    context: {
      needs_workspace_inspection: true,
      needs_memory: true,
      estimated_complexity: complexity,
    },
    routing_rationale: "fixture",
  });
}

export const ROUTING_CASES: RoutingCase[] = [
  {
    id: "routing/code-review-clean-json",
    kind: "routing",
    request: "review this PR for bugs",
    modelOutput: routingJson("code_review", ["reviewer", "synthesizer"], "low"),
    expect: { task_type: "code_review", pipeline: ["reviewer", "synthesizer"], estimated_complexity: "low" },
  },
  {
    id: "routing/debug-clean-json",
    kind: "routing",
    request: "the build crashes on startup",
    modelOutput: routingJson("debug", ["planner", "executor", "reviewer", "synthesizer"], "high"),
    expect: { task_type: "debug", pipeline: ["planner", "executor", "reviewer", "synthesizer"], estimated_complexity: "high" },
  },
  {
    id: "routing/refactor-clean-json",
    kind: "routing",
    request: "extract a shared hook",
    modelOutput: routingJson("refactor", ["planner", "rewriter", "reviewer", "synthesizer"]),
    expect: { task_type: "refactor", pipeline: ["planner", "rewriter", "reviewer", "synthesizer"] },
  },
  {
    id: "routing/docs-clean-json",
    kind: "routing",
    request: "write a README",
    modelOutput: routingJson("docs", ["executor", "synthesizer"]),
    expect: { task_type: "docs", pipeline: ["executor", "synthesizer"] },
  },
  {
    id: "routing/embedded-json-in-prose",
    kind: "routing",
    request: "plan the migration",
    modelOutput: `Sure — here's the routing decision:\n${routingJson("plan", ["planner", "synthesizer"])}\nHope that helps!`,
    expect: { task_type: "plan", pipeline: ["planner", "synthesizer"] },
  },
  {
    id: "routing/partial-json-normalizes-pipeline",
    kind: "routing",
    request: "research vector DBs",
    // Missing pipeline + context → router must backfill safe defaults.
    modelOutput: JSON.stringify({ task_type: "research" }),
    expect: { task_type: "research", pipeline: DEFAULT_PIPELINE, estimated_complexity: "medium" },
  },
  {
    id: "routing/garbage-falls-back-to-general",
    kind: "routing",
    request: "do the thing",
    modelOutput: "I cannot produce JSON right now.",
    expect: { task_type: "general", pipeline: DEFAULT_PIPELINE, estimated_complexity: "medium" },
  },
  {
    id: "routing/empty-output-falls-back",
    kind: "routing",
    request: "",
    modelOutput: "",
    expect: { task_type: "general", pipeline: DEFAULT_PIPELINE },
  },
  {
    id: "routing/test-task",
    kind: "routing",
    request: "add unit tests for the router",
    modelOutput: routingJson("test", ["executor", "reviewer", "synthesizer"], "medium"),
    expect: { task_type: "test", pipeline: ["executor", "reviewer", "synthesizer"], estimated_complexity: "medium" },
  },
  {
    id: "routing/plan-high-complexity",
    kind: "routing",
    request: "plan a large refactor of the entire system",
    modelOutput: routingJson("plan", ["planner", "executor", "reviewer", "synthesizer"], "high"),
    expect: { task_type: "plan", pipeline: ["planner", "executor", "reviewer", "synthesizer"], estimated_complexity: "high" },
  },
];

const TOOL_UNIVERSE = [
  "read_file",
  "grep",
  "glob",
  "list_directory",
  "edit_file",
  "write_file",
  "multi_edit",
  "bash",
];

export const MODE_GATING_CASES: ModeGatingCase[] = [
  {
    id: "gating/reviewer-read-only",
    kind: "mode_gating",
    modeId: "reviewer",
    toolNames: TOOL_UNIVERSE,
    expectAllowed: ["read_file", "grep", "glob", "list_directory"],
  },
  {
    id: "gating/rewriter-write-plus-read",
    kind: "mode_gating",
    modeId: "rewriter",
    toolNames: TOOL_UNIVERSE,
    // Rewriter can inspect (read_file/grep/glob/list_directory) before
    // mutating; the write tools are still the primary capability.
    expectAllowed: ["edit_file", "write_file", "multi_edit", "read_file", "grep", "glob", "list_directory"],
  },
  {
    id: "gating/executor-gets-all",
    kind: "mode_gating",
    modeId: "executor",
    toolNames: TOOL_UNIVERSE,
    expectAllowed: TOOL_UNIVERSE,
  },
  {
    id: "gating/planner-gets-none",
    kind: "mode_gating",
    modeId: "planner",
    toolNames: TOOL_UNIVERSE,
    expectAllowed: [],
  },
  {
    id: "gating/synthesizer-gets-none",
    kind: "mode_gating",
    modeId: "synthesizer",
    toolNames: TOOL_UNIVERSE,
    expectAllowed: [],
  },
  {
    id: "gating/unknown-mode-gets-none",
    kind: "mode_gating",
    modeId: "frobnicate",
    toolNames: TOOL_UNIVERSE,
    expectAllowed: [],
  },
];

export const TURN_REQUIREMENT_CASES: TurnRequirementCase[] = [
  {
    id: "requirements/tool-json-analysis-only",
    kind: "turn_requirement",
    request: 'Analyze only; do not run: {"name":"read_file","arguments":{"path":"C:\\Projects\\demo\\README.md"}}',
    expect: {
      requirement: "answer_only",
      signals: ["tool_call_exemplar", "negated_mutation"],
      excludedSignals: ["mutation_verb", "path:quoted_path", "path:windows_drive"],
    },
  },
  {
    id: "requirements/negated-modify-readme",
    kind: "turn_requirement",
    request: "Do not modify any files; read README.md and report what it says.",
    expect: {
      requirement: "workspace_read",
      signals: ["negated_mutation"],
      excludedSignals: ["mutation_verb"],
    },
  },
  {
    id: "requirements/negated-run-answer-only",
    kind: "turn_requirement",
    request: "Do not run anything; explain TCP congestion control.",
    expect: {
      requirement: "answer_only",
      signals: ["negated_mutation"],
      excludedSignals: ["mutation_verb"],
    },
  },
  {
    id: "requirements/mixed-negated-and-positive-mutation",
    kind: "turn_requirement",
    request: "Do not edit README.md, but create CHANGELOG.md.",
    expect: {
      requirement: "full_execution",
      signals: ["negated_mutation", "mutation_verb"],
    },
  },
];

// ── Coordinator topology & validation cases ──────────────────────────────────

function coordinatorJson(
  task_type: string,
  pipeline: (string | null)[],
  topology: string,
  complexity = "medium",
): string {
  return JSON.stringify({
    task_type,
    pipeline,
    topology,
    context: {
      needs_workspace_inspection: false,
      needs_memory: true,
      estimated_complexity: complexity,
    },
    coordinator_rationale: "eval fixture",
  });
}

export interface CoordinatorCase {
  id: string;
  kind: "coordinator";
  request: string;
  sessionId: string;
  modelOutput: string;
  expect: {
    task_type?: TaskType;
    topology?: Topology;
    executablePipeline?: StageName[];
    estimated_complexity?: "low" | "medium" | "high";
    throws?: boolean;
  };
}

export const COORDINATOR_CASES: CoordinatorCase[] = [
  {
    id: "coordinator/linear-topology-explicit",
    kind: "coordinator",
    request: "extract a shared hook",
    sessionId: "eval-coord-linear",
    modelOutput: coordinatorJson("refactor", ["planner", "executor", "reviewer", "synthesizer"], "linear"),
    expect: {
      task_type: "refactor",
      topology: "linear",
      executablePipeline: ["planner", "executor", "reviewer", "synthesizer"],
    },
  },
  {
    id: "coordinator/speculative-parallel-topology",
    kind: "coordinator",
    request: "review this PR for bugs",
    sessionId: "eval-coord-spec-par",
    modelOutput: coordinatorJson("code_review", ["planner", "reviewer"], "speculative_parallel", "low"),
    expect: { task_type: "code_review", topology: "speculative_parallel", estimated_complexity: "low" },
  },
  {
    id: "coordinator/speculative-cascade-topology",
    kind: "coordinator",
    request: "the build crashes on startup",
    sessionId: "eval-coord-spec-cas",
    modelOutput: coordinatorJson("debug", ["executor", "synthesizer"], "speculative_cascade", "high"),
    expect: { task_type: "debug", topology: "speculative_cascade", estimated_complexity: "high" },
  },
  {
    id: "coordinator/recursive-topology-with-reenter",
    kind: "coordinator",
    request: "redesign the memory subsystem",
    sessionId: "eval-coord-recursive",
    modelOutput: coordinatorJson(
      "plan",
      ["planner", "executor", "re-enter:planner", "synthesizer"],
      "recursive",
      "high",
    ),
    expect: {
      task_type: "plan",
      topology: "recursive",
      executablePipeline: ["planner", "executor", "planner", "synthesizer"],
      estimated_complexity: "high",
    },
  },
  {
    id: "coordinator/invalid-topology-defaults-linear",
    kind: "coordinator",
    request: "write a README",
    sessionId: "eval-coord-bad-topology",
    modelOutput: coordinatorJson("docs", ["executor", "synthesizer"], "magic_parallel"),
    expect: { task_type: "docs", topology: "linear" },
  },
  {
    id: "coordinator/missing-topology-defaults-linear",
    kind: "coordinator",
    request: "research vector DBs",
    sessionId: "eval-coord-no-topology",
    modelOutput: JSON.stringify({
      task_type: "research",
      pipeline: ["planner", "synthesizer"],
      context: { needs_workspace_inspection: false, needs_memory: true, estimated_complexity: "medium" },
      coordinator_rationale: "eval fixture",
    }),
    expect: { task_type: "research", topology: "linear" },
  },
  {
    id: "coordinator/executable-pipeline-strips-nulls",
    kind: "coordinator",
    request: "fix the failing test",
    sessionId: "eval-coord-strip-nulls",
    modelOutput: coordinatorJson("debug", ["planner", null, "executor", null, "synthesizer"], "linear"),
    expect: { executablePipeline: ["planner", "executor", "synthesizer"] },
  },
  {
    id: "coordinator/executable-pipeline-empty-returns-synthesizer",
    kind: "coordinator",
    request: "do the thing",
    sessionId: "eval-coord-all-null",
    modelOutput: coordinatorJson("general", [null, null], "linear"),
    expect: { executablePipeline: ["synthesizer"] },
  },
  {
    // Unparseable output → resilient default route (NOT a thrown error), so a
    // misbehaving coordinator model can never kill the turn. The default
    // route is derived from the request's deterministic requirement so a
    // malformed coordinator response cannot silently discard workspace or
    // execution capability.
    id: "coordinator/invalid-json-defaults",
    kind: "coordinator",
    request: "add unit tests",
    sessionId: "eval-coord-bad-json",
    modelOutput: "I cannot produce JSON for this request.",
    expect: { task_type: "general", topology: "linear", executablePipeline: DEFAULT_PIPELINE },
  },
  {
    // Invalid task_type → deterministic requirement-aware route recovery.
    id: "coordinator/invalid-task-type-defaults",
    kind: "coordinator",
    request: "summarize the codebase",
    sessionId: "eval-coord-bad-task-type",
    modelOutput: JSON.stringify({
      task_type: "summarize",
      pipeline: ["synthesizer"],
      topology: "linear",
      context: { needs_workspace_inspection: false, needs_memory: false, estimated_complexity: "low" },
      coordinator_rationale: "eval fixture",
    }),
    expect: { task_type: "research", topology: "linear", executablePipeline: ["executor", "synthesizer"] },
  },
  {
    id: "coordinator/complexity-low-parsed",
    kind: "coordinator",
    request: "add one test for the health endpoint",
    sessionId: "eval-coord-low-complexity",
    modelOutput: coordinatorJson("test", ["executor", "reviewer", "synthesizer"], "linear", "low"),
    expect: { task_type: "test", topology: "linear", estimated_complexity: "low" },
  },
];

// ── AgentPool default coverage cases ─────────────────────────────────────────

export type AgentPoolCheck =
  | "default_pool_size_gte_12"
  | "no_critical_stage_gaps"
  | "coordinator_stage_covered"
  | "executor_stage_covered"
  | "code_strong_diversity_gte_3"
  | "reasoning_strong_diversity_gte_3";

export interface AgentPoolCase {
  id: string;
  kind: "agent_pool";
  check: AgentPoolCheck;
}

export const AGENT_POOL_CASES: AgentPoolCase[] = [
  { id: "pool/default-pool-size-gte-12", kind: "agent_pool", check: "default_pool_size_gte_12" },
  { id: "pool/no-critical-stage-gaps", kind: "agent_pool", check: "no_critical_stage_gaps" },
  { id: "pool/coordinator-stage-covered", kind: "agent_pool", check: "coordinator_stage_covered" },
  { id: "pool/executor-stage-covered", kind: "agent_pool", check: "executor_stage_covered" },
  { id: "pool/code-strong-diversity-gte-3", kind: "agent_pool", check: "code_strong_diversity_gte_3" },
  { id: "pool/reasoning-strong-diversity-gte-3", kind: "agent_pool", check: "reasoning_strong_diversity_gte_3" },
];

// ── Skill distillation trigger / regression cases (Track C) ───────────────────

export interface SkillCase {
  id: string;
  kind: "skill_trigger" | "skill_regression";
  message: string;
  taskType: TaskType;
  fixture: SkillCandidate;
  expect: {
    matchedMin?: number;
    matchedMax?: number;
    promptContains?: string;
  };
}

const nowIso = "2026-06-28T00:00:00.000Z";

export const SKILL_CASES: SkillCase[] = [
  {
    id: "skill/trigger-debug-promoted",
    kind: "skill_trigger",
    message: "fix the auth bug in src/auth.ts",
    taskType: "debug",
    fixture: {
      id: "eval_skill_debug",
      name: "eval-distilled-debug",
      description: "eval fixture",
      trigger: {
        task_types: ["debug"],
        requirements: ["full_execution"],
        signals: ["mutation_verb"],
      },
      body: "# Debug pattern\nAlways read failing tests first.",
      source_run_ids: ["eval_run"],
      confidence: 0.85,
      status: "promoted",
      created_at: nowIso,
      updated_at: nowIso,
    },
    expect: { matchedMin: 1, promptContains: "eval-distilled-debug" },
  },
  {
    id: "skill/regression-candidate-not-injected",
    kind: "skill_regression",
    message: "refactor the login handler",
    taskType: "refactor",
    fixture: {
      id: "eval_skill_candidate_only",
      name: "eval-distilled-refactor-candidate",
      description: "eval fixture",
      trigger: {
        task_types: ["refactor"],
        requirements: ["full_execution"],
        signals: [],
      },
      body: "Candidate-only body — must not inject.",
      source_run_ids: ["eval_run"],
      confidence: 0.9,
      status: "candidate",
      created_at: nowIso,
      updated_at: nowIso,
    },
    expect: { matchedMax: 0 },
  },
];

// ── Skill grounding cases (D6, organism loop v1) ───────────────────────────
//
// Deterministic tests of `buildGroundingRubric` + the `runGroundingJudge`
// wiring, using a MOCKED callModel that echoes a canned verdict rather than
// calling a real model — live semantic judging (does the judge actually
// notice a hallucinated path?) stays in `semantic-harness.ts` only, per the
// organism-loop-v1 implementation spec. These cases pin the deterministic
// plumbing: rubric shape, and that a judge-reported pass/fail (or a missing
// grounding source) correctly flows into a promote/reject decision.

export interface SkillGroundingCase {
  id: string;
  kind: "skill_grounding";
  fixture: SkillCandidate;
  /** Fixture trajectory snapshot the candidate is grounded against, or null
   *  to exercise the "no grounding source available" path. */
  snapshot: { worker_instructions?: Record<string, string>; user_request?: string } | null;
  /** Canned judge behavior: "pass" echoes every rubric item back as covered
   *  (score 1.0); "fail" reports every item as missed (score 0). Ignored
   *  when `snapshot` is null — the judge is never called in that case. */
  judgeOutcome: "pass" | "fail";
  expect: {
    minRubricItems?: number;
    rubricContains?: string;
    groundingPasses: boolean;
  };
}

export const SKILL_GROUNDING_CASES: SkillGroundingCase[] = [
  {
    id: "skill/grounding-clean-promotes",
    kind: "skill_grounding",
    fixture: {
      id: "eval_skill_grounding_clean",
      name: "eval-distilled-grounding-clean",
      description: "eval fixture — clean grounding",
      trigger: { task_types: ["debug"], requirements: ["workspace_read"], signals: ["mutation_verb"] },
      body: "## Conductor worker guidance\nRead src/auth.ts before editing. Verify tests pass.",
      source_run_ids: ["eval_run_grounding_clean"],
      confidence: 0.85,
      status: "candidate",
      created_at: nowIso,
      updated_at: nowIso,
    },
    snapshot: {
      worker_instructions: { executor: "Read src/auth.ts before editing." },
      user_request: "fix the auth bug in src/auth.ts",
    },
    judgeOutcome: "pass",
    expect: { minRubricItems: 2, rubricContains: "debug", groundingPasses: true },
  },
  {
    id: "skill/grounding-invented-path-fails",
    kind: "skill_grounding",
    fixture: {
      id: "eval_skill_grounding_bad_path",
      name: "eval-distilled-grounding-bad-path",
      description: "eval fixture — invented absolute path not in the source run",
      trigger: { task_types: ["debug"], requirements: ["workspace_read"], signals: ["mutation_verb"] },
      body: "## Conductor worker guidance\nEdit C:\\fake\\path\\that\\does\\not\\exist\\config.json before proceeding.",
      source_run_ids: ["eval_run_grounding_bad_path"],
      confidence: 0.85,
      status: "candidate",
      created_at: nowIso,
      updated_at: nowIso,
    },
    snapshot: {
      worker_instructions: { executor: "Read src/auth.ts before editing." },
      user_request: "fix the auth bug in src/auth.ts",
    },
    // A real judge should notice the invented path isn't grounded in the
    // source run and report it missed; this pins what happens when it does.
    judgeOutcome: "fail",
    expect: { groundingPasses: false },
  },
  {
    id: "skill/grounding-no-snapshot-cannot-ground",
    kind: "skill_grounding",
    fixture: {
      id: "eval_skill_grounding_no_snapshot",
      name: "eval-distilled-grounding-no-snapshot",
      description: "eval fixture — no source trajectory available",
      trigger: { task_types: ["debug"], requirements: ["workspace_read"], signals: ["mutation_verb"] },
      body: "## Conductor worker guidance\nRead src/auth.ts before editing.",
      source_run_ids: ["eval_run_grounding_missing"],
      confidence: 0.85,
      status: "candidate",
      created_at: nowIso,
      updated_at: nowIso,
    },
    snapshot: null,
    judgeOutcome: "pass", // irrelevant — the judge is never reached without a snapshot
    expect: { groundingPasses: false },
  },
];
