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
import { classifyTurnRequirements } from "../orchestration/turn-requirements";
import type { ToolDefinition } from "../tool-types";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveSkillCandidate } from "../intelligence/skill-store";
import { resolveSkillsForTurn } from "../intelligence/skill-resolver";
import { buildGroundingRubric, runGroundingJudge } from "../intelligence/skill-promotion";
import { defaultConfig } from "../config";
import type { CallModelFn } from "../orchestration/coordinator";
import {
  ROUTING_CASES,
  MODE_GATING_CASES,
  TURN_REQUIREMENT_CASES,
  COORDINATOR_CASES,
  AGENT_POOL_CASES,
  SKILL_CASES,
  SKILL_GROUNDING_CASES,
  type RoutingCase,
  type ModeGatingCase,
  type TurnRequirementCase,
  type CoordinatorCase,
  type AgentPoolCase,
  type SkillCase,
  type SkillGroundingCase,
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

function runTurnRequirementCase(c: TurnRequirementCase): EvalCaseResult {
  const result = classifyTurnRequirements(c.request);
  const problems: string[] = [];
  if (result.requirement !== c.expect.requirement) {
    problems.push(`requirement=${result.requirement} expected=${c.expect.requirement}`);
  }
  for (const signal of c.expect.signals ?? []) {
    if (!result.signals.includes(signal)) problems.push(`missing signal=${signal}`);
  }
  for (const signal of c.expect.excludedSignals ?? []) {
    if (result.signals.includes(signal)) problems.push(`unexpected signal=${signal}`);
  }
  return {
    id: c.id,
    kind: c.kind,
    pass: problems.length === 0,
    detail: problems.length === 0 ? "ok" : problems.join("; "),
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

function runSkillCase(c: SkillCase): EvalCaseResult {
  const tempRoot = mkdtempSync(join(tmpdir(), "jarvis-eval-skill-"));
  const g = globalThis as { __skillCandidatesDirOverride?: string };
  const prev = g.__skillCandidatesDirOverride;
  g.__skillCandidatesDirOverride = tempRoot;

  try {
    saveSkillCandidate(c.fixture);
    const resolved = resolveSkillsForTurn(c.message, c.taskType);
    const problems: string[] = [];

    if (c.expect.matchedMin !== undefined && resolved.matched.length < c.expect.matchedMin) {
      problems.push(`matched=${resolved.matched.length} expected>=${c.expect.matchedMin}`);
    }
    if (c.expect.matchedMax !== undefined && resolved.matched.length > c.expect.matchedMax) {
      problems.push(`matched=${resolved.matched.length} expected<=${c.expect.matchedMax}`);
    }
    if (c.expect.promptContains && !resolved.promptBlock.includes(c.expect.promptContains)) {
      problems.push(`prompt missing "${c.expect.promptContains}"`);
    }

    return {
      id: c.id,
      kind: c.kind,
      pass: problems.length === 0,
      detail: problems.length === 0 ? "ok" : problems.join("; "),
    };
  } finally {
    if (prev === undefined) delete g.__skillCandidatesDirOverride;
    else g.__skillCandidatesDirOverride = prev;
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** Rubric-agnostic mock: echoes every rubric item in the judge prompt back
 *  as either covered (score 1.0) or missed (score 0), so the case doesn't
 *  need to hardcode `buildGroundingRubric`'s exact wording. */
function mockGroundingCallModel(outcome: "pass" | "fail"): CallModelFn {
  return async (messages) => {
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    const rubricLines = userMsg.split("Rubric items")[1] ?? "";
    const items = [...rubricLines.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
    return outcome === "pass"
      ? { content: JSON.stringify({ covered: items, missed: [] }) }
      : { content: JSON.stringify({ covered: [], missed: items }) };
  };
}

async function runSkillGroundingCase(c: SkillGroundingCase): Promise<EvalCaseResult> {
  const rubric = buildGroundingRubric(c.fixture, c.snapshot);
  const problems: string[] = [];

  if (c.expect.minRubricItems !== undefined && rubric.length < c.expect.minRubricItems) {
    problems.push(`rubric.length=${rubric.length} expected>=${c.expect.minRubricItems}`);
  }
  if (c.expect.rubricContains && !rubric.some((r) => r.includes(c.expect.rubricContains!))) {
    problems.push(`rubric missing item containing "${c.expect.rubricContains}"`);
  }

  const grounding = await runGroundingJudge(
    c.fixture,
    mockGroundingCallModel(c.judgeOutcome),
    () => c.snapshot,
  );
  const minJudgeScore = defaultConfig().orchestrator.skill_distillation.min_judge_score ?? 0.75;
  const passes = grounding.ok && grounding.verdict.score >= minJudgeScore;

  if (passes !== c.expect.groundingPasses) {
    problems.push(`groundingPasses=${passes} expected=${c.expect.groundingPasses}`);
  }

  return {
    id: c.id,
    kind: c.kind,
    pass: problems.length === 0,
    detail: problems.length === 0 ? "ok" : problems.join("; "),
  };
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
  for (const c of TURN_REQUIREMENT_CASES) results.push(runTurnRequirementCase(c));
  for (const c of COORDINATOR_CASES) results.push(await runCoordinatorCase(c));
  for (const c of AGENT_POOL_CASES) results.push(runAgentPoolCase(c));
  for (const c of SKILL_CASES) results.push(runSkillCase(c));
  for (const c of SKILL_GROUNDING_CASES) results.push(await runSkillGroundingCase(c));

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
  /** id -> outcome, preserving the existing on-disk string schema. */
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
  const liveOutcomes = live.outcomes as Record<string, unknown>;
  const baseOutcomes = baseline.outcomes as Record<string, unknown>;

  if (live.total !== baseline.total) {
    diffs.push(`case count changed: ${baseline.total} -> ${live.total} (update baseline.json)`);
  }
  for (const [id, outcome] of Object.entries(baseOutcomes)) {
    const now = liveOutcomes[id];
    if (now === undefined) diffs.push(`case removed: ${id}`);
    else if (now !== outcome) diffs.push(`case ${id}: ${outcome} -> ${now}`);
  }
  for (const id of Object.keys(liveOutcomes)) {
    if (!(id in baseOutcomes)) diffs.push(`case added: ${id} (update baseline.json)`);
  }
  return diffs;
}

// ── CLI gate ─────────────────────────────────────────────────────
/**
 * Decide the CLI regression gate's exit code and output lines from a report
 * and a baseline path. Kept separate from the `import.meta.main` entrypoint so
 * it can be exercised with isolated fixtures (temp baselines) without touching
 * the repo's `baseline.json`.
 *
 * Fail-closed rule: a missing or malformed baseline is a gate FAILURE, not a
 * warning. Without a readable snapshot we cannot prove the suite has not
 * regressed, so the only way to (re)create a baseline is an explicit
 * `--write-baseline`.
 */
/**
 * Decide whether a parsed value is a structurally trustworthy Baseline.
 *
 * Fail-closed rule, tightened: a baseline only counts as readable when
 *   - `total` is a non-negative integer,
 *   - `outcomes` is a plain (non-array, non-null) object whose every value is
 *     "pass" or "fail",
 *   - `total` equals the number of entries in `outcomes`.
 *
 * Without all three we cannot prove the suite has not regressed, so the only
 * way to (re)create a baseline is an explicit `--write-baseline`.
 */
export function validateBaseline(parsed: unknown): { ok: true; baseline: Baseline } | { ok: false; reason: string } {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "baseline is not a valid Baseline object" };
  }
  const rec = parsed as Partial<Baseline>;
  if (rec.version !== 1) return { ok: false, reason: "baseline.version must be 1" };
  if (typeof rec.passed !== "number" || !Number.isInteger(rec.passed) || rec.passed < 0) {
    return { ok: false, reason: "baseline.passed is not a non-negative integer" };
  }

  if (typeof rec.total !== "number" || !Number.isInteger(rec.total) || rec.total < 0) {
    return { ok: false, reason: "baseline.total is not a non-negative integer" };
  }
  if (rec.outcomes === null || typeof rec.outcomes !== "object" || Array.isArray(rec.outcomes)) {
    return { ok: false, reason: "baseline.outcomes is not an object" };
  }

  const entries = Object.entries(rec.outcomes as Record<string, unknown>);
  if (entries.length !== rec.total) {
    return {
      ok: false,
      reason: `baseline.total=${rec.total} does not match ${entries.length} outcomes entries`,
    };
  }
  for (const [id, value] of entries) {
    if (value === "pass" || value === "fail") continue;
    return { ok: false, reason: `baseline.outcomes["${id}"] is ${JSON.stringify(value)}, not a pass/fail outcome` };
  }

  if (rec.passed !== entries.filter(([, value]) => value === "pass").length) {
    return { ok: false, reason: "baseline.passed does not match passing outcomes" };
  }
  return { ok: true, baseline: rec as Baseline };
}

export function runCliGate(opts: {
  report: EvalReport;
  baselinePath: string;
  writeBaseline: boolean;
}): { exitCode: number; output: string[] } {
  const { report, baselinePath, writeBaseline } = opts;
  const output: string[] = [];

  if (writeBaseline) {
    writeFileSync(baselinePath, JSON.stringify(toBaseline(report), null, 2) + "\n");
    output.push(`Wrote baseline (${report.passed}/${report.total} passing) to ${baselinePath}`);
    return { exitCode: 0, output };
  }

  for (const r of report.results) {
    output.push(`${r.pass ? "PASS" : "FAIL"}  ${r.id}${r.pass ? "" : "  — " + r.detail}`);
  }
  output.push(`\n${report.passed}/${report.total} passed, ${report.failed} failed`);

  // Read + validate the baseline. A missing file, invalid JSON, or a
  // structurally untrustworthy object all mean the gate cannot be evaluated
  // honestly.
  let baseline: Baseline | null = null;
  let readError: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, "utf8")) as unknown;
    const verdict = validateBaseline(parsed);
    if (verdict.ok) baseline = verdict.baseline;
    else readError = verdict.reason;
  } catch (e) {
    readError = String(e);
  }

  if (readError !== null || baseline === null) {
    output.push(`\nBaseline unreadable at ${baselinePath}: ${readError}`);
    output.push("Failing closed — no readable baseline to regress against.");
    output.push("Re-run with --write-baseline to create one explicitly.");
    return { exitCode: 1, output };
  }

  // Gate on baseline DRIFT too (not just hard failures), so the CLI is a
  // complete regression gate matching harness.test.ts.
  const drift = diffBaseline(report, baseline);
  if (drift.length) {
    output.push("\nBaseline drift detected:");
    for (const d of drift) output.push(`  - ${d}`);
    output.push("If intended, re-run with --write-baseline to update the snapshot.");
  }

  return { exitCode: report.failed > 0 || drift.length > 0 ? 1 : 0, output };
}

// ── CLI ──────────────────────────────────────────────────────────
if (import.meta.main) {
  const report = await runEval();
  const baselinePath = join(import.meta.dir, "baseline.json");
  const writeBaseline = process.argv.includes("--write-baseline");
  const { exitCode, output } = runCliGate({ report, baselinePath, writeBaseline });
  for (const line of output) console.log(line);
  process.exit(exitCode);
}
