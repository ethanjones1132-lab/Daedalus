// ── Eval / regression harness for the orchestration layer ──
//
// Runs the fixed suite in cases.ts against the REAL router + mode-gating logic
// (deterministic, model-free) and produces a scored report. A captured
// baseline (baseline.json) lets the test suite detect behavior regressions:
// any case flipping pass→fail, or the case set drifting, fails CI.
//
// CLI:
//   bun run src/eval/harness.ts                  # print the report
//   bun run src/eval/harness.ts --write-baseline # refresh baseline.json

import { PredictiveRouter } from "../orchestration/router";
import { Coordinator, CoordinatorError } from "../orchestration/coordinator";
import { AgentPool, DEFAULT_ORCHESTRATOR_AGENTS } from "../orchestration/agent-pool";
import { getToolsForMode } from "../orchestration/modes";
import type { ToolDefinition } from "../tool-types";
import {
  ROUTING_CASES,
  MODE_GATING_CASES,
  COORDINATOR_CASES,
  AGENT_POOL_CASES,
  type RoutingCase,
  type ModeGatingCase,
  type CoordinatorCase,
  type AgentPoolCase,
} from "./cases";

export interface EvalCaseResult {
  id: string;
  kind: string;
  pass: boolean;
  detail: string;
}

export interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  results: EvalCaseResult[];
}

function fakeTool(name: string): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: name,
      parameters: { type: "object", properties: {}, required: [] },
    },
    requires_approval: false,
    dangerous: false,
  };
}

async function runRoutingCase(c: RoutingCase): Promise<EvalCaseResult> {
  // Inject a deterministic "model" that always returns this case's output.
  const router = new PredictiveRouter(async () => ({ content: c.modelOutput }));
  const r = await router.route(c.request);

  const problems: string[] = [];
  if (r.task_type !== c.expect.task_type) {
    problems.push(`task_type=${r.task_type} expected=${c.expect.task_type}`);
  }
  if (JSON.stringify(r.pipeline) !== JSON.stringify(c.expect.pipeline)) {
    problems.push(`pipeline=${JSON.stringify(r.pipeline)} expected=${JSON.stringify(c.expect.pipeline)}`);
  }
  if (
    c.expect.estimated_complexity &&
    r.context.estimated_complexity !== c.expect.estimated_complexity
  ) {
    problems.push(
      `complexity=${r.context.estimated_complexity} expected=${c.expect.estimated_complexity}`,
    );
  }

  return {
    id: c.id,
    kind: c.kind,
    pass: problems.length === 0,
    detail: problems.length === 0 ? "ok" : problems.join("; "),
  };
}

function runModeGatingCase(c: ModeGatingCase): EvalCaseResult {
  const tools = c.toolNames.map(fakeTool);
  const allowed = getToolsForMode(c.modeId, tools)
    .map((t) => t.function.name)
    .sort();
  const expected = [...c.expectAllowed].sort();
  const pass = JSON.stringify(allowed) === JSON.stringify(expected);
  return {
    id: c.id,
    kind: c.kind,
    pass,
    detail: pass ? "ok" : `allowed=${JSON.stringify(allowed)} expected=${JSON.stringify(expected)}`,
  };
}

async function runCoordinatorCase(c: CoordinatorCase): Promise<EvalCaseResult> {
  const coordinator = new Coordinator(async () => ({ content: c.modelOutput }));

  if (c.expect.throws) {
    try {
      await coordinator.route(c.request, { sessionId: c.sessionId });
      return { id: c.id, kind: c.kind, pass: false, detail: "Expected CoordinatorError — none thrown" };
    } catch (e) {
      const pass = e instanceof CoordinatorError;
      return { id: c.id, kind: c.kind, pass, detail: pass ? "ok" : `wrong error type: ${String(e)}` };
    }
  }

  const r = await coordinator.route(c.request, { sessionId: c.sessionId });
  const problems: string[] = [];

  if (c.expect.task_type !== undefined && r.task_type !== c.expect.task_type) {
    problems.push(`task_type=${r.task_type} expected=${c.expect.task_type}`);
  }
  if (c.expect.topology !== undefined && r.topology !== c.expect.topology) {
    problems.push(`topology=${r.topology} expected=${c.expect.topology}`);
  }
  if (c.expect.estimated_complexity !== undefined && r.context.estimated_complexity !== c.expect.estimated_complexity) {
    problems.push(`complexity=${r.context.estimated_complexity} expected=${c.expect.estimated_complexity}`);
  }
  if (c.expect.executablePipeline !== undefined) {
    const ep = coordinator.executablePipeline(r);
    if (JSON.stringify(ep) !== JSON.stringify(c.expect.executablePipeline)) {
      problems.push(
        `executablePipeline=${JSON.stringify(ep)} expected=${JSON.stringify(c.expect.executablePipeline)}`,
      );
    }
  }

  return { id: c.id, kind: c.kind, pass: problems.length === 0, detail: problems.length === 0 ? "ok" : problems.join("; ") };
}

function runAgentPoolCase(c: AgentPoolCase): EvalCaseResult {
  const pool = new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS);
  const coverage = pool.coverage();

  switch (c.check) {
    case "default_pool_size_gte_12": {
      const pass = coverage.total >= 12;
      return { id: c.id, kind: c.kind, pass, detail: pass ? "ok" : `pool total=${coverage.total} expected>=12` };
    }
    case "no_critical_stage_gaps": {
      const critical = ["coordinator", "planner", "executor", "reviewer", "synthesizer"];
      const gaps = critical.filter((s) => coverage.stage_gaps.includes(s));
      const pass = gaps.length === 0;
      return { id: c.id, kind: c.kind, pass, detail: pass ? "ok" : `critical stage gaps: ${gaps.join(", ")}` };
    }
    case "coordinator_stage_covered": {
      const agent = pool.pickFor("coordinator", "general");
      const pass = agent !== undefined;
      return { id: c.id, kind: c.kind, pass, detail: pass ? "ok" : "no agent for coordinator stage" };
    }
    case "executor_stage_covered": {
      const agent = pool.pickFor("executor", "code_review");
      const pass = agent !== undefined;
      return { id: c.id, kind: c.kind, pass, detail: pass ? "ok" : "no agent for executor stage" };
    }
    case "code_strong_diversity_gte_3": {
      const pass = coverage.diversity.code_strong >= 3;
      return { id: c.id, kind: c.kind, pass, detail: pass ? "ok" : `code_strong=${coverage.diversity.code_strong} expected>=3` };
    }
    case "reasoning_strong_diversity_gte_3": {
      const pass = coverage.diversity.reasoning_strong >= 3;
      return { id: c.id, kind: c.kind, pass, detail: pass ? "ok" : `reasoning_strong=${coverage.diversity.reasoning_strong} expected>=3` };
    }
  }
}

export async function runEval(): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  for (const c of ROUTING_CASES) results.push(await runRoutingCase(c));
  for (const c of MODE_GATING_CASES) results.push(runModeGatingCase(c));
  for (const c of COORDINATOR_CASES) results.push(await runCoordinatorCase(c));
  for (const c of AGENT_POOL_CASES) results.push(runAgentPoolCase(c));

  const passed = results.filter((r) => r.pass).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

export interface Baseline {
  version: number;
  total: number;
  passed: number;
  /** id -> "pass" | "fail" */
  outcomes: Record<string, "pass" | "fail">;
}

export function toBaseline(report: EvalReport): Baseline {
  const outcomes: Record<string, "pass" | "fail"> = {};
  for (const r of report.results) outcomes[r.id] = r.pass ? "pass" : "fail";
  return { version: 1, total: report.total, passed: report.passed, outcomes };
}

/**
 * Compare a live report to a stored baseline. Returns the human-readable diffs;
 * an empty array means no regression.
 */
export function diffBaseline(report: EvalReport, baseline: Baseline): string[] {
  const diffs: string[] = [];
  const live = toBaseline(report);

  if (live.total !== baseline.total) {
    diffs.push(`case count changed: ${baseline.total} -> ${live.total} (update baseline.json)`);
  }
  for (const [id, outcome] of Object.entries(baseline.outcomes)) {
    const now = live.outcomes[id];
    if (now === undefined) diffs.push(`case removed: ${id}`);
    else if (now !== outcome) diffs.push(`case ${id}: ${outcome} -> ${now}`);
  }
  for (const id of Object.keys(live.outcomes)) {
    if (!(id in baseline.outcomes)) diffs.push(`case added: ${id} (update baseline.json)`);
  }
  return diffs;
}

// ── CLI ──────────────────────────────────────────────────────────
if (import.meta.main) {
  const { writeFileSync } = await import("fs");
  const { join } = await import("path");
  const report = await runEval();
  const baselinePath = join(import.meta.dir, "baseline.json");

  if (process.argv.includes("--write-baseline")) {
    writeFileSync(baselinePath, JSON.stringify(toBaseline(report), null, 2) + "\n");
    console.log(`Wrote baseline (${report.passed}/${report.total} passing) to ${baselinePath}`);
  } else {
    for (const r of report.results) {
      console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}${r.pass ? "" : "  — " + r.detail}`);
    }
    console.log(`\n${report.passed}/${report.total} passed, ${report.failed} failed`);

    // Gate on baseline DRIFT too (not just hard failures), so the CLI is a
    // complete regression gate matching harness.test.ts.
    const { readFileSync } = await import("fs");
    let drift: string[] = [];
    try {
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
      drift = diffBaseline(report, baseline);
      if (drift.length) {
        console.log("\nBaseline drift detected:");
        for (const d of drift) console.log(`  - ${d}`);
        console.log("If intended, re-run with --write-baseline to update the snapshot.");
      }
    } catch (e) {
      console.log(`\n(could not read baseline: ${e})`);
    }

    if (report.failed > 0 || drift.length > 0) process.exit(1);
  }
}
