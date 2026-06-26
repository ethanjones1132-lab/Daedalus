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

export const DEFAULT_PIPELINE = ["planner", "executor", "reviewer", "synthesizer"];

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
    id: "gating/rewriter-write-only",
    kind: "mode_gating",
    modeId: "rewriter",
    toolNames: TOOL_UNIVERSE,
    expectAllowed: ["edit_file", "write_file", "multi_edit"],
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
    // route goes straight to the synthesizer (no planner/executor) per the
    // 2026-06-26 live diagnosis: the planner/executor stages were the ones
    // also failing on the fallback path, and routing through them leaked
    // internal planner task text into the user-visible stream.
    id: "coordinator/invalid-json-defaults",
    kind: "coordinator",
    request: "add unit tests",
    sessionId: "eval-coord-bad-json",
    modelOutput: "I cannot produce JSON for this request.",
    expect: { task_type: "general", topology: "linear", executablePipeline: ["synthesizer"] },
  },
  {
    // Invalid task_type → same default-route recovery (synthesizer-only).
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
    expect: { task_type: "general", topology: "linear", executablePipeline: ["synthesizer"] },
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
