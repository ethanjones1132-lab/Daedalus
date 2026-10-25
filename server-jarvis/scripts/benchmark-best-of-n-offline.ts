#!/usr/bin/env bun
// Offline measurement for the best-of-N executor wiring (DD-011 evidence run).
//
//   bun run scripts/benchmark-best-of-n-offline.ts [--json]
//
// NO NETWORK, NO MODEL CALLS. Each "model turn" is replayed from a synthetic
// fixture slate; the scorer, sampler, config gate and telemetry under test are
// the real modules (`src/orchestration/best-of-n.ts`, `tool-call-score.ts`).
//
// Fixture provenance and the full result table:
//   docs/benchmarks/2026-10-24-best-of-n-offline-measurement.md
//
// The fixture slates are AUTHORED, not recorded from a model. They encode the
// defect taxonomy the static scorer can see. See the report for why the defect
// rate is an assumption and how the sensitivity table bounds the conclusion.

import {
  callModelWithBestOfN,
  summarizeSampling,
  type SampleBestToolCallResult,
} from "../src/orchestration/best-of-n";
import { scoreToolCall, type ToolCallScore } from "../src/orchestration/tool-call-score";
import type { CallModelFn } from "../src/orchestration/coordinator";
import type { BestOfNConfig } from "../src/config";
import type { ToolCall, ToolDefinition } from "../src/tool-types";

// ═══════════════════════════════════════════════════════════════
// The executor tool surface the fixtures are scored against
// ═══════════════════════════════════════════════════════════════

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List a directory",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          include: { type: "string" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_check",
      description: "Run a verification command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, timeout_ms: { type: "number" } },
        required: ["command"],
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════════
// Fixture slates
// ═══════════════════════════════════════════════════════════════

type Defect =
  | "clean"
  | "clean_varied"
  | "placeholder"
  | "placeholder_alt"
  | "unknown_arg"
  | "placeholder_unknown"
  | "wrong_type"
  | "empty_string"
  | "missing_required"
  | "unknown_tool"
  | "no_call";

interface TurnSpec {
  defect: Defect;
  /** Two tool calls in one turn: the executor's multi-call shape. */
  multi?: boolean;
}

interface GroupSpec {
  id: string;
  note: string;
  count: number;
  turns: [TurnSpec, TurnSpec, TurnSpec];
  /** First N cases in the group carry a multi-call turn on these seeds. */
  multiCases?: { count: number; seeds: number[] };
}

// Prompt sizes cycle so the aggregate is exact and auditable: 20 cases each of
// 1_800 / 2_100 / 2_400 tokens (~2.1k for an executor preamble plus a transcript
// excerpt). They are authored sizes, not provider usage — see the report.
const PROMPT_TOKENS = [1_800, 2_100, 2_400];

const GROUPS: GroupSpec[] = [
  {
    id: "A_clean_first_all_clean",
    note: "first sample already perfect; all three samples clean and identical",
    count: 26,
    turns: [{ defect: "clean" }, { defect: "clean" }, { defect: "clean" }],
    multiCases: { count: 3, seeds: [0, 1, 2] },
  },
  {
    id: "B_clean_first_valid_tie",
    note: "all three samples are valid but choose different real paths (1.0 tie)",
    count: 8,
    turns: [{ defect: "clean_varied" }, { defect: "clean_varied" }, { defect: "clean_varied" }],
  },
  {
    id: "C_clean_first_later_defective",
    note: "first clean, later samples worse; pure cost, nothing to win",
    count: 8,
    turns: [{ defect: "clean" }, { defect: "placeholder" }, { defect: "unknown_arg" }],
    multiCases: { count: 1, seeds: [1] },
  },
  {
    id: "D_placeholder_then_clean",
    note: "placeholder path repaired by a later clean sample",
    count: 8,
    turns: [{ defect: "placeholder" }, { defect: "clean" }, { defect: "clean" }],
    multiCases: { count: 1, seeds: [0] },
  },
  {
    id: "E_fatal_missing_required_then_clean",
    note: "fatal first sample (missing required argument) rescued by a clean one",
    count: 4,
    turns: [{ defect: "missing_required" }, { defect: "clean" }, { defect: "wrong_type" }],
    multiCases: { count: 1, seeds: [1] },
  },
  {
    id: "F_empty_turn_then_clean",
    note: "first sample emitted no tool call at all; a later sample did",
    count: 2,
    turns: [{ defect: "no_call" }, { defect: "clean" }, { defect: "clean" }],
  },
  {
    id: "G_all_defective_marginal_gain",
    note: "every sample defective but a later one is strictly less defective",
    count: 2,
    turns: [{ defect: "placeholder_unknown" }, { defect: "placeholder" }, { defect: "placeholder" }],
  },
  {
    id: "H_all_defective_first_still_best",
    note: "first is the least defective; sampling pays and selects the first anyway",
    count: 1,
    turns: [{ defect: "empty_string" }, { defect: "wrong_type" }, { defect: "placeholder" }],
  },
  {
    id: "I_defective_tie_with_different_call",
    note: "equal top score across seeds, different payloads; tie-break keeps seed 0",
    count: 1,
    turns: [{ defect: "placeholder" }, { defect: "placeholder_alt" }, { defect: "placeholder_unknown" }],
  },
];

// The two later-fatal cases in group C (keeps fatalCandidates at a countable 6:
// 2 here + the 4 fatal first samples in E).
const C_FATAL_SEED1_FROM = 0;
const C_FATAL_SEED1_COUNT = 2;

interface FixtureCase {
  id: string;
  task: string;
  path: string;
  group: string;
  promptTokens: number;
  turns: TurnSpec[];
}

function buildCases(): FixtureCase[] {
  const cases: FixtureCase[] = [];
  let global = 0;
  for (const group of GROUPS) {
    for (let i = 0; i < group.count; i++) {
      const turns: TurnSpec[] = group.turns.map((turn) => ({ ...turn }));
      const multiSpec = group.multiCases;
      if (multiSpec && i < multiSpec.count) {
        for (const seed of multiSpec.seeds) turns[seed] = { ...turns[seed]!, multi: true };
      }
      if (group.id === "C_clean_first_later_defective") {
        if (i >= C_FATAL_SEED1_FROM && i < C_FATAL_SEED1_FROM + C_FATAL_SEED1_COUNT) {
          // One missing-required sample and one hallucinated tool name, so both
          // fatal classes the scorer knows about appear in the fixture set.
          turns[1] = { ...turns[1]!, defect: i === C_FATAL_SEED1_FROM ? "missing_required" : "unknown_tool" };
        }
      }
      const path = `src/orchestration/module-${global}.ts`;
      cases.push({
        id: `${String(global + 1).padStart(2, "0")}_${group.id}`,
        task: `inspect ${path} and report the executor-stage wiring`,
        path,
        group: group.id,
        promptTokens: PROMPT_TOKENS[global % PROMPT_TOKENS.length]!,
        turns,
      });
      global++;
    }
  }
  return cases;
}

const CASES = buildCases();

// ═══════════════════════════════════════════════════════════════
// Provider wire shape
// ═══════════════════════════════════════════════════════════════

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface WireTurn {
  content: string;
  tool_calls?: WireToolCall[];
}

function primaryCall(defect: Defect, seed: number, casePath: string): { name: string; args: Record<string, unknown> } {
  switch (defect) {
    case "clean":
      return { name: "read_file", args: { path: casePath } };
    case "clean_varied":
      return {
        name: "read_file",
        args: { path: seed === 0 ? casePath : casePath.replace(/\.ts$/, `.s${seed}.ts`) },
      };
    case "placeholder":
      return { name: "read_file", args: { path: "path/to/your/file.ts" } };
    case "placeholder_alt":
      return { name: "read_file", args: { path: "path/to/other/module.ts" } };
    case "unknown_arg":
      return { name: "read_file", args: { path: casePath, nonsense: seed } };
    case "placeholder_unknown":
      return { name: "read_file", args: { path: "path/to/mod.ts", nonsense: 1 } };
    case "wrong_type":
      return { name: "read_file", args: { path: casePath, limit: "ten" } };
    case "empty_string":
      return { name: "read_file", args: { path: "   " } };
    case "missing_required":
      return { name: "read_file", args: {} };
    case "unknown_tool":
      return { name: "ghost_tool", args: { path: casePath } };
    case "no_call":
      throw new Error("no_call has no tool call");
  }
}

function wireTurn(spec: TurnSpec, seed: number, casePath: string): WireTurn {
  if (spec.defect === "no_call") return { content: "I will describe the plan instead." };
  const primary = primaryCall(spec.defect, seed, casePath);
  const calls: WireToolCall[] = [
    {
      id: `call-${seed}-a`,
      type: "function",
      function: { name: primary.name, arguments: JSON.stringify(primary.args) },
    },
  ];
  if (spec.multi) {
    // A second, clean call. `pattern` must avoid the scorer's placeholder
    // patterns, so no "TODO"/"example.com"/angle brackets here.
    calls.push({
      id: `call-${seed}-b`,
      type: "function",
      function: {
        name: "grep",
        arguments: JSON.stringify({ pattern: "registerStageAbort", path: "src/orchestration" }),
      },
    });
  }
  return { content: "", tool_calls: calls };
}

/** Completion tokens for one turn, fixed by shape. Authored estimate, not usage. */
function completionTokens(spec: TurnSpec): number {
  if (spec.defect === "no_call") return 6;
  return spec.multi ? 130 : 48;
}

// ═══════════════════════════════════════════════════════════════
// normalization — copied verbatim from the held patch (b985c87)
// ═══════════════════════════════════════════════════════════════
// The base branch scores `{ id, name, arguments }`. The provider boundary emits
// `{ id, type, function: { name, arguments } }`. The held patch adds this exact
// mapping inside the sampler; it is NOT in the base branch this harness runs
// on, so it is applied here, at the stub boundary, and the "raw" control run
// below measures what happens without it.

function normalizeSampledCall(candidate: any, fallbackId: string): ToolCall {
  const name = candidate?.name ?? candidate?.function?.name;
  const rawArguments = candidate?.arguments ?? candidate?.function?.arguments;
  let parsed: Record<string, unknown> = {};
  if (typeof rawArguments === "string") {
    try {
      const decoded = JSON.parse(rawArguments);
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
        parsed = decoded as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  } else if (rawArguments && typeof rawArguments === "object") {
    parsed = rawArguments as Record<string, unknown>;
  }
  return { id: candidate?.id ?? fallbackId, name, arguments: parsed };
}

// ═══════════════════════════════════════════════════════════════
// Replay model
// ═══════════════════════════════════════════════════════════════

type ReplayMode = "normalized" | "raw";

function makeReplay(fixture: FixtureCase, mode: ReplayMode) {
  let index = 0;
  const seedsSeen: Array<number | undefined> = [];
  const fn = (async (_messages: unknown, options: any = {}) => {
    const spec = fixture.turns[Math.min(index, fixture.turns.length - 1)]!;
    const seed = typeof options?.seed === "number" ? options.seed : 0;
    index++;
    seedsSeen.push(options?.seed);
    const wire = wireTurn(spec, seed, fixture.path);
    if (mode === "raw") return wire;
    return {
      ...wire,
      tool_calls: wire.tool_calls?.map((call, callIndex) =>
        normalizeSampledCall(call, `bon-${seed}-${callIndex}`),
      ),
    };
  }) as CallModelFn;
  return { fn, seedsSeen };
}

function scoreTurn(turn: any): ToolCallScore | null {
  const calls: any[] = turn?.tool_calls ?? [];
  if (calls.length === 0) return null;
  const scores = calls.map((call) =>
    scoreToolCall({ id: call.id, name: call.name, arguments: call.arguments ?? {} }, TOOLS),
  );
  return {
    score: Math.min(...scores.map((score) => score.score)),
    fatal: scores.some((score) => score.fatal),
    reasons: scores.flatMap((score) => score.reasons),
  };
}

function sameCall(a: ToolCall | undefined, b: ToolCall | undefined): boolean {
  if (!a || !b) return a === b;
  return a.name === b.name && JSON.stringify(a.arguments) === JSON.stringify(b.arguments);
}

// ═══════════════════════════════════════════════════════════════
// Measurement
// ═══════════════════════════════════════════════════════════════

interface CaseResult {
  id: string;
  group: string;
  promptTokens: number;
  baseline: { calls: number; promptTokens: number; completionTokens: number; score: number; fatal: boolean; dispatched: boolean };
  enabled: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    firstScore: number;
    selectedScore: number;
    improved: boolean;
    fatalCandidates: number;
    emptyTurns: number;
    selectedSeed?: number;
    disagreement: boolean;
    tieWithDifferentCall: boolean;
    allFatal: boolean;
  };
}

const DISABLED: BestOfNConfig = { enabled: false, n: 3, stages: ["executor"] };
const ENABLED: BestOfNConfig = { enabled: true, n: 3, stages: ["executor"] };
const MESSAGES = (task: string) => [{ role: "user", content: task }];

async function measureCase(fixture: FixtureCase): Promise<CaseResult> {
  const baselineReplay = makeReplay(fixture, "normalized");
  const baseline = await callModelWithBestOfN({
    config: DISABLED,
    stage: "executor",
    callModel: baselineReplay.fn,
    messages: MESSAGES(fixture.task),
    tools: TOOLS,
    seedBase: 0,
  });
  if (baselineReplay.seedsSeen.length !== 1 || baselineReplay.seedsSeen[0] !== undefined) {
    throw new Error(
      `${fixture.id}: disabled path must make exactly one UNSEEDED call, saw ${JSON.stringify(baselineReplay.seedsSeen)}`,
    );
  }
  const baselineTurn = baseline.response as any;
  const baselineScore = scoreTurn(baselineTurn);
  const baselineDispatch = (baselineTurn?.tool_calls?.length ?? 0) > 0 && baselineScore !== null && !baselineScore.fatal;

  const enabledReplay = makeReplay(fixture, "normalized");
  const enabled = await callModelWithBestOfN({
    config: ENABLED,
    stage: "executor",
    callModel: enabledReplay.fn,
    messages: MESSAGES(fixture.task),
    tools: TOOLS,
    seedBase: 0,
  });
  const sampling: SampleBestToolCallResult = enabled.sampling!;
  const summary = summarizeSampling(sampling);

  const first = sampling.candidates.slice().sort((a, b) => a.seed - b.seed)[0];
  const topScore = sampling.candidates
    .filter((candidate) => !candidate.score.fatal)
    .reduce((best, candidate) => Math.max(best, candidate.score.score), 0);
  const tieWithDifferentCall =
    first !== undefined
    && sampling.candidates.some(
      (candidate) =>
        candidate.seed !== 0
        && candidate.score.score === topScore
        && candidate.score.score === summary.firstScore
        && !sameCall(candidate.call, first.call),
    );

  return {
    id: fixture.id,
    group: fixture.group,
    promptTokens: fixture.promptTokens,
    baseline: {
      calls: baselineReplay.seedsSeen.length,
      promptTokens: fixture.promptTokens,
      completionTokens: completionTokens(fixture.turns[0]!),
      score: baselineScore && !baselineScore.fatal ? baselineScore.score : 0,
      fatal: baselineScore ? baselineScore.fatal : false,
      dispatched: baselineDispatch,
    },
    enabled: {
      calls: summary.samples,
      promptTokens: fixture.promptTokens * summary.samples,
      completionTokens: fixture.turns.slice(0, summary.samples).reduce((sum, turn) => sum + completionTokens(turn), 0),
      firstScore: summary.firstScore,
      selectedScore: summary.selectedScore,
      improved: summary.improvedOverFirst,
      fatalCandidates: summary.fatalCandidates,
      emptyTurns: summary.emptyTurns,
      selectedSeed: sampling.selectedCandidate?.seed,
      disagreement: sampling.selectedCandidate !== undefined && sampling.selectedCandidate.seed !== 0,
      tieWithDifferentCall,
      allFatal: sampling.selected === undefined,
    },
  };
}

/**
 * Control: the same wire-shape slate with NO normalization, i.e. exactly what
 * the base branch would score if the sampler were wired without the held
 * patch's mapping. Proves the mapping is necessary.
 */
async function rawControl(fixture: FixtureCase) {
  const replay = makeReplay(fixture, "raw");
  const result = await callModelWithBestOfN({
    config: ENABLED,
    stage: "executor",
    callModel: replay.fn,
    messages: MESSAGES(fixture.task),
    tools: TOOLS,
    seedBase: 0,
  });
  const sampling = result.sampling!;
  return {
    candidates: sampling.candidates.length,
    fatalCandidates: sampling.candidates.filter((candidate) => candidate.score.fatal).length,
    selected: sampling.selected !== undefined,
    dispatchable: ((result.response as any)?.tool_calls?.length ?? 0) > 0,
  };
}

// Analytic bounds, independent of the authored fixtures.
function analyticRows(meanExtraPerTurn: number, meanTokensPerCall: number) {
  const rates = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];
  return rates.map((d) => {
    const p3 = d * (1 - d * d);
    const p2 = d;
    return {
      defectRate: d,
      p3,
      tokensPerImprovementN3: p3 > 0 ? meanExtraPerTurn / p3 : Number.POSITIVE_INFINITY,
      p2,
      tokensPerImprovementN2: p2 > 0 ? meanTokensPerCall / p2 : Number.POSITIVE_INFINITY,
    };
  });
}

// ═══════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════

const results: CaseResult[] = [];
for (const fixture of CASES) results.push(await measureCase(fixture));

let rawFatalCandidates = 0;
let rawSelected = 0;
let rawDispatchable = 0;
for (const fixture of CASES) {
  const control = await rawControl(fixture);
  rawFatalCandidates += control.fatalCandidates;
  if (control.selected) rawSelected++;
  if (control.dispatchable) rawDispatchable++;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

const totals = {
  cases: results.length,
  improved: results.filter((r) => r.enabled.improved).length,
  baselineCalls: sum(results.map((r) => r.baseline.calls)),
  enabledCalls: sum(results.map((r) => r.enabled.calls)),
  baselinePrompt: sum(results.map((r) => r.baseline.promptTokens)),
  enabledPrompt: sum(results.map((r) => r.enabled.promptTokens)),
  baselineCompletion: sum(results.map((r) => r.baseline.completionTokens)),
  enabledCompletion: sum(results.map((r) => r.enabled.completionTokens)),
  fatalCandidates: sum(results.map((r) => r.enabled.fatalCandidates)),
  emptyTurns: sum(results.map((r) => r.enabled.emptyTurns)),
  disagreements: results.filter((r) => r.enabled.disagreement).length,
  tiesWithDifferentCall: results.filter((r) => r.enabled.tieWithDifferentCall).length,
  allFatal: results.filter((r) => r.enabled.allFatal).length,
  defectiveFirst: results.filter((r) => r.enabled.firstScore < 1).length,
  baselineFailures: results.filter((r) => r.baseline.fatal).length,
  baselineNoDispatch: results.filter((r) => !r.baseline.dispatched).length,
};

const extraTokens = totals.enabledPrompt + totals.enabledCompletion - (totals.baselinePrompt + totals.baselineCompletion);
const baselineTokens = totals.baselinePrompt + totals.baselineCompletion;
const enabledTokens = totals.enabledPrompt + totals.enabledCompletion;
const meanExtraPerTurn = extraTokens / totals.cases;
const meanTokensPerCall = baselineTokens / totals.cases;
const improvedCases = results.filter((r) => r.enabled.improved);
const extraOnImproved = sum(
  improvedCases.map(
    (r) =>
      r.enabled.promptTokens
      + r.enabled.completionTokens
      - (r.baseline.promptTokens + r.baseline.completionTokens),
  ),
);

// Self-check: the report quotes these exact numbers. A mismatch means the
// fixtures drifted away from the documented measurement, not that the run
// passed.
const EXPECTED = {
  cases: 60,
  improved: 16,
  baselineCalls: 60,
  enabledCalls: 180,
  baselinePrompt: 126_000,
  enabledPrompt: 378_000,
  baselineCompletion: 3_124,
  enabledCompletion: 9_540,
  fatalCandidates: 6,
  emptyTurns: 2,
  disagreements: 16,
  tiesWithDifferentCall: 9,
  allFatal: 0,
  rawFatalCandidates: 178,
  rawSelected: 0,
  rawDispatchable: 0,
};

const actual: Record<string, number> = {
  cases: totals.cases,
  improved: totals.improved,
  baselineCalls: totals.baselineCalls,
  enabledCalls: totals.enabledCalls,
  baselinePrompt: totals.baselinePrompt,
  enabledPrompt: totals.enabledPrompt,
  baselineCompletion: totals.baselineCompletion,
  enabledCompletion: totals.enabledCompletion,
  fatalCandidates: totals.fatalCandidates,
  emptyTurns: totals.emptyTurns,
  disagreements: totals.disagreements,
  tiesWithDifferentCall: totals.tiesWithDifferentCall,
  allFatal: totals.allFatal,
  rawFatalCandidates,
  rawSelected,
  rawDispatchable,
};

const mismatches: Array<{ key: string; expected: number; got: number | undefined }> = Object.entries(EXPECTED)
  .map(([key, expected]) => ({ key, expected, got: actual[key] }))
  .filter((mismatch) => mismatch.got !== mismatch.expected);

// Per-group improved counts drive the §5 dimension breakdown, so pin them too.
const EXPECTED_IMPROVED_BY_GROUP: Record<string, number> = {
  A_clean_first_all_clean: 0,
  B_clean_first_valid_tie: 0,
  C_clean_first_later_defective: 0,
  D_placeholder_then_clean: 8,
  E_fatal_missing_required_then_clean: 4,
  F_empty_turn_then_clean: 2,
  G_all_defective_marginal_gain: 2,
  H_all_defective_first_still_best: 0,
  I_defective_tie_with_different_call: 0,
};
for (const [group, expected] of Object.entries(EXPECTED_IMPROVED_BY_GROUP)) {
  const got = results.filter((r) => r.group === group && r.enabled.improved).length;
  if (got !== expected) mismatches.push({ key: `improved:${group}`, expected, got });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ totals, actual, extraTokens, baselineTokens, enabledTokens, results }, null, 2));
} else {
  const pad = (value: string | number, width: number) => String(value).padStart(width);
  console.log("best-of-N offline measurement — synthetic executor slates, no model calls\n");
  console.log("total (mode: baseline=1 unseeded call, enabled=3 seeded calls)");
  console.log(`  cases                 ${pad(totals.cases, 8)}`);
  console.log(`  model calls           ${pad(totals.baselineCalls, 8)} -> ${pad(totals.enabledCalls, 6)}  (${(totals.enabledCalls / totals.baselineCalls).toFixed(2)}x)`);
  console.log(`  prompt tokens         ${pad(totals.baselinePrompt, 8)} -> ${pad(totals.enabledPrompt, 6)}`);
  console.log(`  completion tokens     ${pad(totals.baselineCompletion, 8)} -> ${pad(totals.enabledCompletion, 6)}`);
  console.log(`  total tokens          ${pad(baselineTokens, 8)} -> ${pad(enabledTokens, 6)}  (${(enabledTokens / baselineTokens).toFixed(4)}x, +${extraTokens})`);
  console.log(`  improvedOverFirst     ${pad(totals.improved, 8)} / ${totals.cases}  (${((100 * totals.improved) / totals.cases).toFixed(1)}%)`);
  console.log(`  tokens per improved   ${pad(Math.round(extraTokens / totals.improved), 8)}`);
  console.log(`  extra calls/improved  ${pad(((totals.enabledCalls - totals.baselineCalls) / totals.improved).toFixed(1), 8)}`);
  console.log(`  extra spend on the ${totals.cases - totals.improved} non-improving turns: ${extraTokens - extraOnImproved} tokens`);

  console.log("\nper group");
  const header = ["group", "n", "improved", "extra calls", "extra tokens", "fatal", "empty", "ties*"].map(
    (label, i) => (i === 0 ? label.padEnd(36) : label.padStart(13)),
  );
  console.log("  " + header.join(" "));
  for (const group of GROUPS) {
    const rows = results.filter((r) => r.group === group.id);
    const groupExtra =
      sum(rows.map((r) => r.enabled.promptTokens + r.enabled.completionTokens - r.baseline.promptTokens - r.baseline.completionTokens));
    console.log(
      "  "
        + group.id.padEnd(36)
        + pad(rows.length, 13)
        + pad(rows.filter((r) => r.enabled.improved).length, 13)
        + pad(rows.length * 2, 13)
        + pad(groupExtra, 13)
        + pad(sum(rows.map((r) => r.enabled.fatalCandidates)), 13)
        + pad(sum(rows.map((r) => r.enabled.emptyTurns)), 13)
        + pad(rows.filter((r) => r.enabled.tieWithDifferentCall).length, 13),
    );
  }
  console.log("  * ties at the top score with a different (equally valid) call");

  console.log("\nfailure modes");
  console.log(`  defective first samples      ${pad(totals.defectiveFirst, 6)} / ${totals.cases}`);
  console.log(`  fatal candidates             ${pad(totals.fatalCandidates, 6)} / ${totals.enabledCalls}`);
  console.log(`  empty turns (no tool call)   ${pad(totals.emptyTurns, 6)}`);
  console.log(`  seed disagreements           ${pad(totals.disagreements, 6)} (selected seed != 0)`);
  console.log(`  ties, different call         ${pad(totals.tiesWithDifferentCall, 6)}`);
  console.log(`  slates with no viable sample ${pad(totals.allFatal, 6)}`);
  console.log(`  watchdog timeouts            ${pad(0, 6)} (not simulated offline)`);

  console.log("\ncontrol: provider wire shape WITHOUT the held patch's normalization");
  console.log(`  fatal candidates             ${pad(rawFatalCandidates, 6)} / ${totals.enabledCalls}`);
  console.log(`  slates with a selection      ${pad(rawSelected, 6)} / ${totals.cases}`);
  console.log(`  turns that dispatch a tool   ${pad(rawDispatchable, 6)} / ${totals.cases}`);

  console.log("\nanalytic sensitivity (fixture-independent): P(improve) = d for n=2, d(1-d^2) for n=3");
  console.log("  " + ["defect rate d", "P(n=2)", "tok/improve n=2", "P(n=3)", "tok/improve n=3"].map((label, i) => (i === 0 ? label.padEnd(14) : label.padStart(17))).join(" "));
  for (const row of analyticRows(meanExtraPerTurn, meanTokensPerCall)) {
    console.log(
      "  "
        + row.defectRate.toFixed(2).padEnd(14)
        + `${(100 * row.p2).toFixed(1)}%`.padStart(17)
        + pad(Math.round(row.tokensPerImprovementN2), 17)
        + `${(100 * row.p3).toFixed(1)}%`.padStart(17)
        + pad(Math.round(row.tokensPerImprovementN3), 17),
    );
  }
}

if (mismatches.length > 0) {
  console.error("\nDOCUMENTED NUMBERS MISMATCH");
  for (const mismatch of mismatches) {
    console.error(`  ${mismatch.key}: expected ${mismatch.expected}, got ${mismatch.got}`);
  }
  process.exit(1);
}
if (!process.argv.includes("--json")) {
  console.log("\nnumbers match docs/benchmarks/2026-10-24-best-of-n-offline-measurement.md");
}
