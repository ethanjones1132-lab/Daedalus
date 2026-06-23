// ── Eval cases — fixed regression suite for the orchestration layer ──
//
// Deterministic and model-free: routing cases drive the real PredictiveRouter
// with a mock CallModelFn that returns canned content, exercising the actual
// JSON extraction + normalization + fallback logic. Mode-gating cases exercise
// the pure getToolsForMode filter. Add cases here, then refresh baseline.json
// via `bun run src/eval/harness.ts --write-baseline`.

import type { RoutingResult } from "../orchestration/router";

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
