# Best-of-N Tool Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On calls that matter, generate several candidate tool calls, score them without executing, and proceed with the best one.

**Architecture:** A pure scorer rates a candidate tool call on static evidence only — schema validity, required arguments, argument plausibility. A sampler asks the model N times at varied seeds and returns the top-scoring candidate plus the full slate for telemetry. Scoring never executes anything, so a bad candidate costs tokens but never side effects. Gated behind config, off by default, and applied per stage.

**Tech Stack:** Bun, TypeScript, `bun:test`. No new dependencies.

**Why static scoring:** the existing `computeRunReward` grades a *completed run* — it needs changed paths and an executed check. That is the wrong instrument here: to pick between candidates before acting, the score must be computable from the call alone. This plan builds that cheap scorer and leaves the run-level reward untouched.

---

## File Structure

| File | Responsibility |
|---|---|
| `server-jarvis/src/orchestration/tool-call-score.ts` | Pure static scoring of a single candidate tool call. |
| `server-jarvis/src/orchestration/tool-call-score.test.ts` | Scorer tests. |
| `server-jarvis/src/orchestration/best-of-n.ts` | Sampling loop over `CallModelFn`, dedupe, selection. |
| `server-jarvis/src/orchestration/best-of-n.test.ts` | Sampler tests with a stub model. |
| `server-jarvis/src/config.ts` | `orchestrator.best_of_n` config block. |

---

### Task 1: Static candidate scorer

**Files:**
- Create: `server-jarvis/src/orchestration/tool-call-score.ts`
- Test: `server-jarvis/src/orchestration/tool-call-score.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server-jarvis/src/orchestration/tool-call-score.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { scoreToolCall } from "./tool-call-score";
import type { ToolDefinition } from "../tool-types";

const READ_FILE: ToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "number" } },
      required: ["path"],
    },
  },
};

const TOOLS = [READ_FILE];

describe("scoreToolCall", () => {
  test("a well-formed call scores above zero", () => {
    const s = scoreToolCall({ id: "1", name: "read_file", arguments: { path: "src/index.ts" } }, TOOLS);
    expect(s.score).toBeGreaterThan(0);
    expect(s.fatal).toBe(false);
  });

  test("an unknown tool is fatal", () => {
    const s = scoreToolCall({ id: "1", name: "nope", arguments: {} }, TOOLS);
    expect(s.fatal).toBe(true);
    expect(s.score).toBe(0);
    expect(s.reasons).toContain("unknown tool: nope");
  });

  test("a missing required argument is fatal", () => {
    const s = scoreToolCall({ id: "1", name: "read_file", arguments: {} }, TOOLS);
    expect(s.fatal).toBe(true);
    expect(s.reasons.some((r) => r.includes("missing required"))).toBe(true);
  });

  test("a wrong argument type is penalized but not fatal", () => {
    const good = scoreToolCall({ id: "1", name: "read_file", arguments: { path: "a.ts", limit: 10 } }, TOOLS);
    const bad = scoreToolCall({ id: "1", name: "read_file", arguments: { path: "a.ts", limit: "ten" } }, TOOLS);
    expect(bad.fatal).toBe(false);
    expect(bad.score).toBeLessThan(good.score);
  });

  test("an unknown extra argument is penalized", () => {
    const clean = scoreToolCall({ id: "1", name: "read_file", arguments: { path: "a.ts" } }, TOOLS);
    const noisy = scoreToolCall({ id: "1", name: "read_file", arguments: { path: "a.ts", nonsense: 1 } }, TOOLS);
    expect(noisy.score).toBeLessThan(clean.score);
  });

  test("a placeholder path is penalized", () => {
    const real = scoreToolCall({ id: "1", name: "read_file", arguments: { path: "src/index.ts" } }, TOOLS);
    const fake = scoreToolCall({ id: "1", name: "read_file", arguments: { path: "path/to/your/file.ts" } }, TOOLS);
    expect(fake.score).toBeLessThan(real.score);
    expect(fake.reasons.some((r) => r.includes("placeholder"))).toBe(true);
  });

  test("scores are deterministic", () => {
    const call = { id: "1", name: "read_file", arguments: { path: "src/a.ts" } };
    expect(scoreToolCall(call, TOOLS).score).toBe(scoreToolCall(call, TOOLS).score);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/tool-call-score.test.ts`
Expected: FAIL — cannot resolve module `./tool-call-score`.

- [ ] **Step 3: Write the implementation**

Create `server-jarvis/src/orchestration/tool-call-score.ts`:

```typescript
// ═══════════════════════════════════════════════════════════════
// Static tool-call scoring — rate a candidate without running it
// ═══════════════════════════════════════════════════════════════
// Used by best-of-N sampling to choose between candidates before any side
// effect occurs. Deliberately separate from run-reward.ts: that grades a
// completed run from executed evidence, which is unavailable at choice time.
//
// Scoring is on [0, 1] and evidence-based only — no model call, no I/O.

import type { ToolCall, ToolDefinition } from "../tool-types";

export interface ToolCallScore {
  score: number;
  /** Structurally unusable — never select a fatal candidate. */
  fatal: boolean;
  reasons: string[];
}

/**
 * Strings models emit when inventing a path instead of using a real one.
 * Narrow on purpose: a broad pattern would penalize legitimate paths.
 */
const PLACEHOLDER_PATTERNS = [
  /path\/to\//i,
  /your[-_/]?(?:file|project|path)/i,
  /<[^>]+>/,
  /\{\{.+\}\}/,
  /\bexample\.(?:com|org)\b/i,
  /\bTODO\b/,
];

function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((p) => p.test(value));
}

function typeMatches(expected: unknown, value: unknown): boolean {
  switch (expected) {
    case "string": return typeof value === "string";
    case "number":
    case "integer": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    default: return true;
  }
}

export function scoreToolCall(call: ToolCall, tools: readonly ToolDefinition[]): ToolCallScore {
  const reasons: string[] = [];
  const def = tools.find((t) => t.function.name === call.name);

  if (!def) {
    return { score: 0, fatal: true, reasons: [`unknown tool: ${call.name}`] };
  }

  const params = def.function.parameters ?? { type: "object", properties: {}, required: [] };
  const properties = (params.properties ?? {}) as Record<string, { type?: unknown }>;
  const required: string[] = (params.required ?? []) as string[];
  const args = call.arguments ?? {};

  const missing = required.filter((k) => !(k in args) || args[k] === undefined);
  if (missing.length > 0) {
    return {
      score: 0,
      fatal: true,
      reasons: [`missing required argument(s): ${missing.join(", ")}`],
    };
  }

  // Start from a valid baseline and subtract for every specific defect. A
  // candidate with no defects lands at 1.0.
  let score = 1;

  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec) {
      score -= 0.15;
      reasons.push(`unknown argument: ${key}`);
      continue;
    }
    if (!typeMatches(spec.type, value)) {
      score -= 0.25;
      reasons.push(`argument "${key}" has the wrong type`);
    }
    if (typeof value === "string") {
      if (value.trim().length === 0) {
        score -= 0.2;
        reasons.push(`argument "${key}" is empty`);
      } else if (looksLikePlaceholder(value)) {
        score -= 0.3;
        reasons.push(`argument "${key}" looks like a placeholder`);
      }
    }
  }

  return { score: Math.max(0, Math.min(1, score)), fatal: false, reasons };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/tool-call-score.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/tool-call-score.ts server-jarvis/src/orchestration/tool-call-score.test.ts
git commit -m "feat(orchestration): static tool-call scoring for candidate selection"
```

---

### Task 2: The sampler

**Files:**
- Create: `server-jarvis/src/orchestration/best-of-n.ts`
- Test: `server-jarvis/src/orchestration/best-of-n.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server-jarvis/src/orchestration/best-of-n.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { sampleBestToolCall } from "./best-of-n";
import type { ToolDefinition } from "../tool-types";

const READ_FILE: ToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};

/** Returns a scripted tool call per invocation, recording the seeds it saw. */
function stubModel(scripted: Array<Record<string, unknown> | null>) {
  const seeds: Array<number | undefined> = [];
  let i = 0;
  const fn = (async (_messages: unknown, options: any) => {
    seeds.push(options?.seed);
    const args = scripted[Math.min(i++, scripted.length - 1)];
    return {
      content: "",
      tool_calls: args === null ? undefined : [{ id: `c${i}`, name: "read_file", arguments: args }],
    };
  }) as any;
  return { fn, seeds };
}

describe("sampleBestToolCall", () => {
  test("picks the highest-scoring candidate", async () => {
    const { fn } = stubModel([
      { path: "path/to/your/file.ts" },
      { path: "src/index.ts" },
      {},
    ]);
    const result = await sampleBestToolCall({
      callModel: fn,
      messages: [{ role: "user", content: "read the entry point" }],
      tools: [READ_FILE],
      n: 3,
      seedBase: 100,
    });
    expect(result.selected?.arguments.path).toBe("src/index.ts");
    expect(result.candidates).toHaveLength(3);
  });

  test("varies the seed per sample so candidates can differ", async () => {
    const { fn, seeds } = stubModel([{ path: "a.ts" }]);
    await sampleBestToolCall({
      callModel: fn,
      messages: [],
      tools: [READ_FILE],
      n: 3,
      seedBase: 100,
    });
    expect(new Set(seeds).size).toBe(3);
  });

  test("never selects a fatal candidate", async () => {
    const { fn } = stubModel([{}, {}, {}]);
    const result = await sampleBestToolCall({
      callModel: fn,
      messages: [],
      tools: [READ_FILE],
      n: 3,
      seedBase: 1,
    });
    expect(result.selected).toBeUndefined();
    expect(result.candidates.every((c) => c.score.fatal)).toBe(true);
  });

  test("stops early on a perfect candidate to save tokens", async () => {
    let calls = 0;
    const fn = (async () => {
      calls++;
      return { content: "", tool_calls: [{ id: "c", name: "read_file", arguments: { path: "src/a.ts" } }] };
    }) as any;
    await sampleBestToolCall({
      callModel: fn,
      messages: [],
      tools: [READ_FILE],
      n: 5,
      seedBase: 1,
    });
    expect(calls).toBe(1);
  });

  test("a turn with no tool call is recorded but not selected", async () => {
    const { fn } = stubModel([null, { path: "src/a.ts" }]);
    const result = await sampleBestToolCall({
      callModel: fn,
      messages: [],
      tools: [READ_FILE],
      n: 2,
      seedBase: 1,
    });
    expect(result.selected?.arguments.path).toBe("src/a.ts");
    expect(result.emptyTurns).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/best-of-n.test.ts`
Expected: FAIL — cannot resolve module `./best-of-n`.

- [ ] **Step 3: Write the implementation**

Create `server-jarvis/src/orchestration/best-of-n.ts`:

```typescript
// ═══════════════════════════════════════════════════════════════
// Best-of-N tool call sampling
// ═══════════════════════════════════════════════════════════════
// Ask the model for the same tool call several times at different seeds,
// score each candidate statically, and return the best. Nothing is executed
// during sampling, so a bad candidate costs tokens and nothing else.
//
// Early exit on a perfect score keeps the common case at exactly one call:
// when the model gets it right first time, this costs nothing extra.

import type { CallModelFn, ChatMessage } from "./coordinator";
import type { ToolCall, ToolDefinition } from "../tool-types";
import { scoreToolCall, type ToolCallScore } from "./tool-call-score";

export interface ScoredCandidate {
  call: ToolCall;
  score: ToolCallScore;
  /** Seed used for the sample that produced this candidate. */
  seed: number;
}

export interface SampleBestToolCallInput {
  callModel: CallModelFn;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** Number of samples to draw. Values below 2 make this a passthrough. */
  n: number;
  /** First seed; subsequent samples use seedBase + i. */
  seedBase: number;
  stageLabel?: string;
  temperature?: number;
  stageAbort?: AbortSignal;
}

export interface SampleBestToolCallResult {
  /** Highest-scoring non-fatal candidate, if any. */
  selected?: ToolCall;
  candidates: ScoredCandidate[];
  /** Samples that returned no tool call at all. */
  emptyTurns: number;
}

export async function sampleBestToolCall(
  input: SampleBestToolCallInput,
): Promise<SampleBestToolCallResult> {
  const samples = Math.max(1, input.n);
  const candidates: ScoredCandidate[] = [];
  let emptyTurns = 0;

  for (let i = 0; i < samples; i++) {
    if (input.stageAbort?.aborted) break;
    const seed = input.seedBase + i;

    const turn = await input.callModel(input.messages, {
      tools: input.tools,
      seed,
      stageLabel: input.stageLabel,
      temperature: input.temperature,
      stageAbort: input.stageAbort,
    });

    const first = turn.tool_calls?.[0];
    if (!first) {
      emptyTurns++;
      continue;
    }

    const call: ToolCall = {
      id: first.id ?? `bon-${seed}`,
      name: first.name,
      arguments: (first.arguments ?? {}) as Record<string, unknown>,
    };
    const score = scoreToolCall(call, input.tools);
    candidates.push({ call, score, seed });

    // A clean candidate cannot be beaten. Stop paying for more samples.
    if (!score.fatal && score.score >= 1) break;
  }

  const viable = candidates.filter((c) => !c.score.fatal);
  viable.sort((a, b) => (b.score.score - a.score.score) || (a.seed - b.seed));

  return {
    selected: viable[0]?.call,
    candidates,
    emptyTurns,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/best-of-n.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/best-of-n.ts server-jarvis/src/orchestration/best-of-n.test.ts
git commit -m "feat(orchestration): best-of-N tool call sampling with early exit"
```

---

### Task 3: Config gate

**Files:**
- Modify: `server-jarvis/src/config.ts` (`OrchestratorConfig` interface + defaults ~line 614)
- Test: `server-jarvis/src/orchestration/best-of-n.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server-jarvis/src/orchestration/best-of-n.test.ts`:

```typescript
import { loadConfig } from "../config";
import { bestOfNForStage } from "./best-of-n";

describe("best-of-n config gate", () => {
  test("ships disabled by default", () => {
    const cfg = loadConfig();
    expect(cfg.orchestrator.best_of_n.enabled).toBe(false);
    expect(cfg.orchestrator.best_of_n.n).toBe(3);
    expect(cfg.orchestrator.best_of_n.stages).toEqual(["executor"]);
  });

  test("returns 1 when disabled, so callers make a single call", () => {
    expect(bestOfNForStage({ enabled: false, n: 3, stages: ["executor"] }, "executor")).toBe(1);
  });

  test("returns n only for listed stages", () => {
    const c = { enabled: true, n: 4, stages: ["executor"] };
    expect(bestOfNForStage(c, "executor")).toBe(4);
    expect(bestOfNForStage(c, "planner")).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/best-of-n.test.ts`
Expected: FAIL — `bestOfNForStage is not a function`.

- [ ] **Step 3: Add the config block and helper**

In `server-jarvis/src/config.ts`, add the interface:

```typescript
/**
 * Best-of-N tool call sampling. OFF by default: it multiplies token spend on
 * every gated stage, so switching it on is an explicit cost decision.
 */
export interface BestOfNConfig {
  enabled: boolean;
  /** Samples per gated call. 1 disables sampling for that stage. */
  n: number;
  /** Stage labels this applies to. Empty means none. */
  stages: string[];
}
```

Add `best_of_n: BestOfNConfig;` to `OrchestratorConfig`, and to the orchestrator defaults:

```typescript
      best_of_n: {
        enabled: false,
        n: 3,
        stages: ["executor"],
      },
```

In `server-jarvis/src/orchestration/best-of-n.ts`, add:

```typescript
import type { BestOfNConfig } from "../config";

/**
 * Samples to draw for a stage. Always returns at least 1, so a caller can use
 * this unconditionally: `n === 1` is an ordinary single model call.
 */
export function bestOfNForStage(cfg: BestOfNConfig | undefined, stage: string): number {
  if (!cfg?.enabled) return 1;
  if (!cfg.stages.includes(stage)) return 1;
  return Math.max(1, cfg.n);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/best-of-n.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/config.ts server-jarvis/src/orchestration/best-of-n.ts server-jarvis/src/orchestration/best-of-n.test.ts
git commit -m "feat(config): stage-gated best-of-N sampling, off by default"
```

---

### Task 4: Telemetry

**Files:**
- Modify: `server-jarvis/src/orchestration/best-of-n.ts`
- Test: `server-jarvis/src/orchestration/best-of-n.test.ts`

Without a record of what sampling bought, there is no way to decide whether to keep paying for it.

- [ ] **Step 1: Write the failing test**

Append to `server-jarvis/src/orchestration/best-of-n.test.ts`:

```typescript
import { summarizeSampling } from "./best-of-n";

describe("sampling telemetry", () => {
  test("reports the gain the extra samples bought", async () => {
    const { fn } = stubModel([
      { path: "path/to/your/file.ts" },
      { path: "src/index.ts" },
    ]);
    const result = await sampleBestToolCall({
      callModel: fn, messages: [], tools: [READ_FILE], n: 2, seedBase: 1,
    });
    const summary = summarizeSampling(result);
    expect(summary.samples).toBe(2);
    expect(summary.selectedScore).toBeGreaterThan(summary.firstScore);
    expect(summary.improvedOverFirst).toBe(true);
  });

  test("reports no gain when the first sample already won", async () => {
    const { fn } = stubModel([{ path: "src/a.ts" }]);
    const result = await sampleBestToolCall({
      callModel: fn, messages: [], tools: [READ_FILE], n: 3, seedBase: 1,
    });
    expect(summarizeSampling(result).improvedOverFirst).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/best-of-n.test.ts`
Expected: FAIL — `summarizeSampling is not a function`.

- [ ] **Step 3: Add the summary**

Append to `server-jarvis/src/orchestration/best-of-n.ts`:

```typescript
export interface SamplingSummary {
  samples: number;
  emptyTurns: number;
  fatalCandidates: number;
  /** Score of the first sample — what a single call would have produced. */
  firstScore: number;
  selectedScore: number;
  /** True when sampling produced a better call than the first attempt. */
  improvedOverFirst: boolean;
}

/**
 * Condense a sampling result for logging. `improvedOverFirst` is the number
 * that justifies the token spend — if it is rarely true, turn sampling off
 * for that stage.
 */
export function summarizeSampling(result: SampleBestToolCallResult): SamplingSummary {
  const first = result.candidates[0];
  const firstScore = first && !first.score.fatal ? first.score.score : 0;
  const selected = result.candidates
    .filter((c) => !c.score.fatal)
    .reduce<number>((best, c) => Math.max(best, c.score.score), 0);
  return {
    samples: result.candidates.length + result.emptyTurns,
    emptyTurns: result.emptyTurns,
    fatalCandidates: result.candidates.filter((c) => c.score.fatal).length,
    firstScore,
    selectedScore: selected,
    improvedOverFirst: selected > firstScore,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/best-of-n.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/best-of-n.ts server-jarvis/src/orchestration/best-of-n.test.ts
git commit -m "feat(orchestration): sampling telemetry to justify the token spend"
```

---

### Task 5: Full suite

- [ ] **Step 1: Run the whole suite**

Run: `cd server-jarvis && bun test`
Expected: PASS. Nothing calls the sampler yet, so no behavior change is possible — the config default is `enabled: false`.

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "test: full suite green with best-of-N modules"
```

---

## Self-Review

**Spec coverage:** scorer (T1), sampler with seed variation and early exit (T2), config gate (T3), telemetry (T4), regression sweep (T5).

**Types:** `ToolCallScore` defined in T1, consumed by `ScoredCandidate` in T2 and `summarizeSampling` in T4. `BestOfNConfig` defined in T3, consumed by `bestOfNForStage` in the same task. `SampleBestToolCallResult` defined in T2, consumed in T4.

**Deliberately deferred — read before executing:** this plan does not wire the sampler into a live stage. Every module is tested and inert. Call-site integration is a separate change with its own risk (latency multiplication on a local 9B, interaction with the stage watchdog and the first-token affordability cap), and it should be made only after a measurement run shows `improvedOverFirst` is true often enough to be worth the tokens. Run the sampler offline against fixture tasks first.
