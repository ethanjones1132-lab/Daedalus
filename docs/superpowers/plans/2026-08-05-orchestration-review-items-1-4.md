# Orchestration Review Items 1-4 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four correctness gaps found in the Phase A-C review: self-modifying reward, false missing-symbol conclusions, rejection of requested new symbols, and silent partial `multi_edit` execution.

**Architecture:** Keep the Phase B reward objective outside the Phase C orchestration policy vector so candidate policies cannot alter their own fitness. Make Phase A grounding evidence explicit and tri-state (`found`, `missing`, `indeterminate`), then carry task-authorized symbol introductions separately into the Phase A3 write preflight. Make `multi_edit` fail closed unless every requested edit is applicable, preserving the Tool runtime's completion-integrity contract.

**Tech Stack:** TypeScript, Bun test runner, Jarvis Bun server orchestration pipeline, canonical filesystem Tool bundle.

## Global Constraints

- This plan changes only the Bun server and orchestration documentation; it does not change the Rust/Tauri Native surface or React UI.
- Preserve the canonical Tool runtime and its existing `preflightWriteCall` dispatch boundary.
- Reward scoring must remain deterministic, offline-computable, and based only on stored objective evidence.
- A failed or unavailable grep must never become proof that a symbol is absent.
- A symbol may bypass the fabricated-symbol block only when the task explicitly asks Jarvis to introduce that exact symbol.
- `multi_edit` is atomic at preflight: all requested edits dispatch in original order, or none dispatch.
- Use test-first implementation and commit each task separately.

---

## File Structure

| File | Responsibility | Planned change |
|---|---|---|
| `server-jarvis/src/orchestration/orchestration-policy.ts` | Runtime-tunable orchestration policy θ | Remove all four reward-objective dimensions from `OrchestrationTheta`, `THETA_KEYS`, and `BASELINE_THETA`. |
| `server-jarvis/src/orchestration/orchestration-policy.test.ts` | Policy-vector contract | Prove reward terms cannot enter θ and legacy serialized reward keys are ignored. |
| `server-jarvis/src/orchestration/run-reward.ts` | Fixed Phase B fitness objective | Define immutable reward weights/penalty and remove per-run/snapshot weight overrides. |
| `server-jarvis/src/orchestration/run-reward.test.ts` | Reward composition and anti-gaming | Reproduce the original exploit and prove policy overlays cannot change reward. |
| `server-jarvis/src/orchestration/symbol-grounding.ts` | Identifier extraction and filesystem grounding evidence | Add explicit introduction classification and tri-state search outcomes. |
| `server-jarvis/src/orchestration/symbol-grounding.test.ts` | Grounding behavior | Cover search errors, exhausted search budgets, confirmed misses, and explicit new-symbol intent. |
| `server-jarvis/src/orchestration/pipeline.ts` | Orchestration-stage wiring | Pass only confirmed misses to preflight and carry task-authorized new symbols separately. |
| `server-jarvis/src/write-preflight.ts` | Pure write-effect validation | Exempt explicitly authorized new symbols and reject every partial `multi_edit`. |
| `server-jarvis/src/write-preflight.test.ts` | Write-contract regression tests | Cover requested symbol creation, unrequested fabrication, and atomic multi-edit behavior. |
| `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md` | Learned-orchestration phase contract | Record immutable reward ownership, tri-state grounding, introduction intent, and atomic multi-edit semantics. |
| `docs/PHASE_B_RUN_REWARD_ANTI_GAMING.md` | Reward design rationale | State that reward configuration is evaluator-owned and excluded from θ and stored snapshots. |

---

### Task 1: Remove the reward objective from the optimizable policy vector

**Why:** Phase D is intended to optimize θ against Phase B reward. If θ includes reward weights or the overclaim penalty, a candidate can improve its score without improving behavior.

**Files:**
- Modify: `server-jarvis/src/orchestration/orchestration-policy.ts`
- Modify: `server-jarvis/src/orchestration/orchestration-policy.test.ts`
- Modify: `server-jarvis/src/orchestration/run-reward.ts`
- Modify: `server-jarvis/src/orchestration/run-reward.test.ts`
- Modify: `docs/PHASE_B_RUN_REWARD_ANTI_GAMING.md`
- Modify: `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md`

**Interfaces:**
- Produces: `RUN_REWARD_POLICY: Readonly<{ weights: Readonly<RunRewardWeights>; overclaimPenalty: number }>` in `run-reward.ts`.
- Preserves: `DEFAULT_RUN_REWARD_WEIGHTS` and `OVERCLAIM_PENALTY` as compatibility exports derived from `RUN_REWARD_POLICY`.
- Removes: `reward_weight_writes`, `reward_weight_check`, `reward_weight_plan`, and `overclaim_penalty` from `OrchestrationTheta` and every θ serialization/vector path.
- Removes: `weights` from `RunRewardInput`, `StoredRunRewardSnapshot`, `computeRunRewardFromEffects`, and `buildStoredRunRewardSnapshot` inputs. Older persisted JSON may contain an extra `weights` property; structural parsing ignores it and replay uses the fixed objective.

- [ ] **Step 1: Add policy-vector regression tests that describe the protected boundary**

Add these assertions to `orchestration-policy.test.ts`:

```ts
test("reward-objective keys are not optimizable theta dimensions", () => {
  expect(THETA_KEYS).not.toContain("reward_weight_writes" as never);
  expect(THETA_KEYS).not.toContain("reward_weight_check" as never);
  expect(THETA_KEYS).not.toContain("reward_weight_plan" as never);
  expect(THETA_KEYS).not.toContain("overclaim_penalty" as never);
});

test("legacy serialized reward keys do not enter theta", () => {
  const parsed = parseTheta(JSON.stringify({
    force_write_nudge_cap: 4,
    reward_weight_writes: 100,
    reward_weight_check: 0,
    reward_weight_plan: 0,
    overclaim_penalty: 0,
  }));
  expect(parsed.force_write_nudge_cap).toBe(4);
  expect(Object.prototype.hasOwnProperty.call(parsed, "reward_weight_writes")).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(parsed, "overclaim_penalty")).toBe(false);
});
```

- [ ] **Step 2: Add the reward-exploit regression test**

Import `runWithTheta` into `run-reward.test.ts`, define one failed-check/overclaim input, and prove unrelated θ overlays cannot alter the breakdown:

```ts
test("the orchestration policy cannot change its own reward objective", () => {
  const input = {
    writes: { changedPaths: ["src/a.ts"], writeRequired: true },
    check: { tier: "existing" as const, ran: true, passed: false },
    plan: { itemsTotal: 1, itemsVerified: 0 },
    declaredOutcome: "success" as const,
  };

  const baseline = computeRunReward(input);
  const underCandidate = runWithTheta(
    { force_write_nudge_cap: 99, policy_canary_traffic_fraction: 1 },
    () => computeRunReward(input),
  );

  expect(underCandidate).toEqual(baseline);
  expect(underCandidate.weights).toEqual({ writes: 1 / 3, check: 1 / 3, plan: 1 / 3 });
  expect(underCandidate.overclaimPenalty).toBe(OVERCLAIM_PENALTY);
});
```

- [ ] **Step 3: Run the focused tests and verify they fail for the original reason**

Run:

```powershell
cd server-jarvis
bun test src/orchestration/orchestration-policy.test.ts src/orchestration/run-reward.test.ts
```

Expected: the new vector-boundary assertions fail because the four reward keys are still in `THETA_KEYS`. Do not accept a failure caused by a syntax error or missing import.

- [ ] **Step 4: Define the immutable evaluator-owned reward policy**

Replace the dependency on `BASELINE_THETA`/`policy()` in `run-reward.ts` with fixed evaluator configuration:

```ts
export interface RunRewardPolicy {
  weights: Readonly<RunRewardWeights>;
  overclaimPenalty: number;
}

export const RUN_REWARD_POLICY: Readonly<RunRewardPolicy> = Object.freeze({
  weights: Object.freeze({ writes: 1, check: 1, plan: 1 }),
  overclaimPenalty: 0.5,
});

export const DEFAULT_RUN_REWARD_WEIGHTS: RunRewardWeights = {
  ...RUN_REWARD_POLICY.weights,
};
export const OVERCLAIM_PENALTY = RUN_REWARD_POLICY.overclaimPenalty;
```

In `computeRunReward`, replace the active-policy reads with the fixed values:

```ts
const baseWeights: RunRewardWeights = { ...RUN_REWARD_POLICY.weights };
// ...existing applicability and normalization logic...
const penalty = RUN_REWARD_POLICY.overclaimPenalty;
```

Remove all `weights` input forwarding from stored replay and effect helpers. Keep the normalized `weights` in `RunRewardBreakdown` and serialized `reward_json`; those fields explain the fixed objective actually applied to that run.

- [ ] **Step 5: Remove reward dimensions from θ**

Delete the four reward fields from `OrchestrationTheta`, `THETA_KEYS`, and `BASELINE_THETA`. Remove the existing assertion for `BASELINE_THETA.overclaim_penalty` from `orchestration-policy.test.ts`. Do not replace them with alternate optimizable aliases.

- [ ] **Step 6: Run the focused tests and typecheck**

Run:

```powershell
cd server-jarvis
bun test src/orchestration/orchestration-policy.test.ts src/orchestration/run-reward.test.ts
bun run typecheck
```

Expected: both test files pass and `tsc --noEmit` reports no errors. `THETA_DIM` decreases by four while staying inside the existing broad dimension-count assertion.

- [ ] **Step 7: Update the Phase B/C contracts**

In `PHASE_B_RUN_REWARD_ANTI_GAMING.md`, add an “Evaluator ownership” subsection stating:

```markdown
The scalar objective is evaluator-owned configuration, not agent policy. Its
three weights and overclaim penalty are fixed by `RUN_REWARD_POLICY`, excluded
from `OrchestrationTheta`, and not accepted from stored run snapshots. A policy
candidate can change behavior, but cannot change how that behavior is scored.
```

In `MASTER_PLAN_LEARNED_ORCHESTRATION.md`, remove reward terms from the Phase C θ inventory and record that Phase D treats Phase B reward as immutable fitness.

- [ ] **Step 8: Commit Task 1**

```powershell
git add server-jarvis/src/orchestration/orchestration-policy.ts server-jarvis/src/orchestration/orchestration-policy.test.ts server-jarvis/src/orchestration/run-reward.ts server-jarvis/src/orchestration/run-reward.test.ts docs/PHASE_B_RUN_REWARD_ANTI_GAMING.md docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md
git commit -m "fix(orchestration): isolate reward from policy theta"
```

---

### Task 2: Make symbol-grounding evidence tri-state and fail open on search errors

**Why:** The current search helper maps tool errors and thrown exceptions to an empty hit list. The pipeline then treats that empty list as proof of absence and blocks valid writes.

**Files:**
- Modify: `server-jarvis/src/orchestration/symbol-grounding.ts`
- Modify: `server-jarvis/src/orchestration/symbol-grounding.test.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts`
- Modify: `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md`

**Interfaces:**
- Produces: `type SymbolGroundingStatus = "found" | "missing" | "indeterminate"`.
- Changes: `SymbolGroundingResult.found: boolean` to `status: SymbolGroundingStatus` and optional `errors: string[]`.
- Extends: `SymbolGroundingSummary` with `symbols_indeterminate: number`.
- Guarantees: only `status === "missing"` enters `groundingMissingSymbols`; `indeterminate` is informative and never authorizes a fabricated-symbol block.

- [ ] **Step 1: Write failing unit tests for error and budget behavior**

Add to `symbol-grounding.test.ts`:

```ts
test("grep errors produce indeterminate evidence, not a confirmed miss", async () => {
  const { results, summary } = await collectSymbolGrounding({
    symbols: ["RealExistingApi"],
    searchRoot: "C:/workspace",
    rootEntries: [],
    grep: async () => ({ output: "permission denied", is_error: true }),
  });

  expect(results[0]?.status).toBe("indeterminate");
  expect(results[0]?.errors).toContain("permission denied");
  expect(summary.symbols_missing).toBe(0);
  expect(summary.symbols_indeterminate).toBe(1);
  expect(formatGroundingBlock(results)).toContain("SEARCH INDETERMINATE");
});

test("a successful exhaustive no-match is a confirmed miss", async () => {
  const { results, summary } = await collectSymbolGrounding({
    symbols: ["AbsentApi"],
    searchRoot: "C:/workspace",
    rootEntries: [],
    grep: async () => ({ output: "No matches found", is_error: false }),
  });

  expect(results[0]?.status).toBe("missing");
  expect(summary.symbols_missing).toBe(1);
  expect(summary.symbols_indeterminate).toBe(0);
});

test("search-budget exhaustion is indeterminate", async () => {
  const { results } = await collectSymbolGrounding({
    symbols: ["FirstApi", "SecondApi"],
    searchRoot: "C:/workspace",
    rootEntries: [],
    maxGreps: 1,
    grep: async () => ({ output: "No matches found", is_error: false }),
  });

  expect(results[0]?.status).toBe("missing");
  expect(results[1]?.status).toBe("indeterminate");
});
```

- [ ] **Step 2: Run the grounding tests and verify the status assertions fail**

Run:

```powershell
cd server-jarvis
bun test src/orchestration/symbol-grounding.test.ts
```

Expected: the tests fail because `SymbolGroundingResult` still exposes `found` and error paths become misses.

- [ ] **Step 3: Introduce structured search attempts**

In `symbol-grounding.ts`, replace the empty-array error sentinel with an internal discriminated union:

```ts
type GroundingSearchAttempt =
  | { status: "ok"; hits: SymbolGroundingHit[] }
  | { status: "error"; reason: string }
  | { status: "budget_exhausted" };
```

Make `runGrep` return:

```ts
if (grepsUsed >= maxGreps) return { status: "budget_exhausted" };
grepsUsed += 1;
try {
  const res = await options.grep({
    pattern: buildGroundingGrepPattern(symbol),
    path,
    headLimit,
  });
  if (res.is_error) {
    return { status: "error", reason: res.output.trim() || `grep failed at ${path}` };
  }
  return {
    status: "ok",
    hits: parseGrepContentHits(res.output, path).slice(0, headLimit),
  };
} catch (error) {
  return {
    status: "error",
    reason: error instanceof Error ? error.message : String(error),
  };
}
```

Do not search dependency directories that are absent from a supplied `rootEntries` list. A known-present dependency directory that errors makes the symbol `indeterminate`; an absent directory is simply skipped.

- [ ] **Step 4: Replace boolean results with tri-state results**

Use these exported contracts:

```ts
export type SymbolGroundingStatus = "found" | "missing" | "indeterminate";

export interface SymbolGroundingResult {
  symbol: string;
  status: SymbolGroundingStatus;
  hits: SymbolGroundingHit[];
  errors?: string[];
}

export interface SymbolGroundingSummary {
  symbols_searched: number;
  symbols_found: number;
  symbols_missing: number;
  symbols_indeterminate: number;
  greps_used: number;
}
```

Resolution rules:

```ts
// Any hit wins.
{ symbol, status: "found", hits }

// Every scheduled search completed successfully with zero hits.
{ symbol, status: "missing", hits: [] }

// Root search, a known-present dependency search, or the required budget failed.
{ symbol, status: "indeterminate", hits: [], errors }
```

Update `formatGroundingBlock` so only confirmed misses render `NOT FOUND`. Render indeterminate results as:

```text
RealExistingApi: SEARCH INDETERMINATE — runtime grep failed; do not treat this as proof of absence. Read or search the relevant source before relying on it.
```

- [ ] **Step 5: Wire the pipeline to block only confirmed misses**

Replace the boolean condition in `pipeline.ts` with:

```ts
for (const result of results) {
  if (result.status === "missing") {
    this.groundingMissingSymbols.add(result.symbol);
  }
}
```

Include the indeterminate count in the state detail so live diagnostics distinguish absence from failed evidence collection:

```ts
detail:
  `symbol_grounding:${summary.symbols_found}/${summary.symbols_searched}`
  + `:indeterminate=${summary.symbols_indeterminate}`,
```

- [ ] **Step 6: Update existing test fixtures and run the focused gate**

Convert every `{ found: true }` fixture to `{ status: "found" }`, every confirmed miss to `{ status: "missing" }`, and boolean assertions to status assertions. Then run:

```powershell
cd server-jarvis
bun test src/orchestration/symbol-grounding.test.ts src/write-preflight.test.ts
bun run typecheck
```

Expected: all tests pass and no remaining `SymbolGroundingResult.found` references exist:

```powershell
rg -n "\.found|found:" src/orchestration/symbol-grounding.ts src/orchestration/symbol-grounding.test.ts src/orchestration/pipeline.ts
```

Expected search result: no grounding-result boolean usages. Unrelated domain objects named `found` elsewhere are out of scope.

- [ ] **Step 7: Document the evidence semantics**

Update `MASTER_PLAN_LEARNED_ORCHESTRATION.md` Phase A1/A3 language to say that `NOT FOUND` requires a successful search, while tool errors, exceptions, and budget exhaustion are `SEARCH INDETERMINATE` and cannot populate the preflight deny-set.

- [ ] **Step 8: Commit Task 2**

```powershell
git add server-jarvis/src/orchestration/symbol-grounding.ts server-jarvis/src/orchestration/symbol-grounding.test.ts server-jarvis/src/orchestration/pipeline.ts docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md
git commit -m "fix(orchestration): preserve indeterminate grounding evidence"
```

---

### Task 3: Distinguish requested new symbols from fabricated dependencies

**Why:** A task that explicitly asks to create `BrandNewWidget` currently grounds the name, confirms it is absent, and then blocks the declaration that would satisfy the task.

**Files:**
- Modify: `server-jarvis/src/orchestration/symbol-grounding.ts`
- Modify: `server-jarvis/src/orchestration/symbol-grounding.test.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts`
- Modify: `server-jarvis/src/write-preflight.ts`
- Modify: `server-jarvis/src/write-preflight.test.ts`
- Modify: `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md`

**Interfaces:**
- Produces: `GroundingIdentifierRequirement` with `expectation: "must_exist" | "may_create"`.
- Produces: `extractGroundingRequirements(text: string): GroundingIdentifierRequirement[]`.
- Preserves: `extractGroundingIdentifiers(text: string): string[]` as a projection for callers that need names only.
- Extends: `WritePreflightContext.allowedNewSymbols?: Iterable<string>`.
- Adds pipeline state: `groundingAllowedNewSymbols: Set<string>`, reset at the same turn boundary as `groundingMissingSymbols`.

- [ ] **Step 1: Write failing intent-classification tests**

Add to `symbol-grounding.test.ts`:

```ts
test("classifies an explicitly requested declaration as may_create", () => {
  const requirements = extractGroundingRequirements(
    "Create `BrandNewWidget` and connect it to ExistingRenderApi.",
  );
  const bySymbol = Object.fromEntries(
    requirements.map((requirement) => [requirement.symbol, requirement.expectation]),
  );

  expect(bySymbol.BrandNewWidget).toBe("may_create");
  expect(bySymbol.ExistingRenderApi).toBe("must_exist");
});

test("ordinary API references remain must_exist", () => {
  const requirements = extractGroundingRequirements(
    "Use `StateVariableTPTFilterType::notch` in processBlock.",
  );
  expect(requirements).toContainEqual({
    symbol: "StateVariableTPTFilterType::notch",
    expectation: "must_exist",
  });
});
```

The explicit-introduction vocabulary is intentionally narrow: `create`, `add`, `introduce`, `define`, and `declare`, optionally followed by `class`, `interface`, `type`, `function`, `component`, `module`, `enum`, `struct`, `constant`, `helper`, `hook`, or `service`. Do not classify “use”, “call”, “connect”, “extend”, or constructor syntax as permission to invent a symbol.

- [ ] **Step 2: Write failing write-preflight tests**

Add to `write-preflight.test.ts`:

```ts
test("allows a missing symbol the task explicitly requests to create", () => {
  const result = preflightWriteTool(
    "write_file",
    {
      path: "src/BrandNewWidget.ts",
      content: "export class BrandNewWidget {}\n",
    },
    {
      pathInScope: true,
      missingSymbols: ["BrandNewWidget"],
      allowedNewSymbols: ["BrandNewWidget"],
    },
  );

  expect(result.allow).toBe(true);
  expect(result.code).toBe("ok");
});

test("does not exempt an unrequested fabricated dependency", () => {
  const result = preflightWriteTool(
    "write_file",
    {
      path: "src/BrandNewWidget.ts",
      content: "export class BrandNewWidget extends ImaginaryFrameworkBase {}\n",
    },
    {
      pathInScope: true,
      missingSymbols: ["BrandNewWidget", "ImaginaryFrameworkBase"],
      allowedNewSymbols: ["BrandNewWidget"],
    },
  );

  expect(result.allow).toBe(false);
  expect(result.code).toBe("fabricated_symbol");
  expect(result.fabricated).toEqual(["ImaginaryFrameworkBase"]);
});
```

- [ ] **Step 3: Run focused tests and verify they fail at the missing interface**

Run:

```powershell
cd server-jarvis
bun test src/orchestration/symbol-grounding.test.ts src/write-preflight.test.ts
```

Expected: the tests fail because `extractGroundingRequirements` and `allowedNewSymbols` do not exist yet.

- [ ] **Step 4: Implement narrow explicit-introduction classification**

Add the new public type and function in `symbol-grounding.ts`:

```ts
export type GroundingExpectation = "must_exist" | "may_create";

export interface GroundingIdentifierRequirement {
  symbol: string;
  expectation: GroundingExpectation;
}

const INTRODUCED_SYMBOL_PATTERN =
  /\b(?:create|add|introduce|define|declare)\s+(?:a\s+|an\s+|the\s+|new\s+)?(?:(?:class|interface|type|function|component|module|enum|struct|constant|helper|hook|service)\s+)?`?([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)*)`?/gi;

export function extractGroundingRequirements(text: string): GroundingIdentifierRequirement[] {
  const identifiers = extractGroundingIdentifiersRaw(text);
  const introduced = new Set<string>();
  for (const match of text.matchAll(INTRODUCED_SYMBOL_PATTERN)) {
    const symbol = match[1];
    if (symbol && identifiers.includes(symbol)) introduced.add(symbol);
  }
  return identifiers.map((symbol) => ({
    symbol,
    expectation: introduced.has(symbol) ? "may_create" : "must_exist",
  }));
}

export function extractGroundingIdentifiers(text: string): string[] {
  return extractGroundingRequirements(text).map((requirement) => requirement.symbol);
}
```

Rename the current extraction body to the private `extractGroundingIdentifiersRaw` helper so the two public functions do not recurse. Apply the existing `max_grounding_symbols` cap once, inside the raw helper.

- [ ] **Step 5: Make allowed-new-symbol filtering explicit in preflight**

Extend `WritePreflightContext` and the helper signature:

```ts
export interface WritePreflightContext {
  // existing fields...
  missingSymbols?: Iterable<string>;
  allowedNewSymbols?: Iterable<string>;
  allowFabricatedSymbols?: boolean;
}

export function findFabricatedSymbolsInText(
  text: string,
  missingSymbols: Iterable<string>,
  allowedNewSymbols: Iterable<string> = [],
): string[] {
  const allowed = new Set(allowedNewSymbols);
  // Keep the existing boundary-aware occurrence check, but skip exact allowed names.
  // `if (allowed.has(symbol)) continue;`
}
```

Pass `ctx.allowedNewSymbols` from `preflightWriteTool`. Do not use fuzzy, case-insensitive, substring, or namespace-segment matching: permission applies only to the exact extracted symbol.

- [ ] **Step 6: Wire introduction intent through the pipeline**

Add and reset the second set beside `groundingMissingSymbols`:

```ts
private groundingMissingSymbols = new Set<string>();
private groundingAllowedNewSymbols = new Set<string>();
```

Build both collections before grounding:

```ts
const requirements = extractGroundingRequirements(`${intentText}\n${planSummary}`);
const symbols = requirements.map((requirement) => requirement.symbol);
this.groundingAllowedNewSymbols = new Set(
  requirements
    .filter((requirement) => requirement.expectation === "may_create")
    .map((requirement) => requirement.symbol),
);
```

Then pass the allow-set into preflight:

```ts
const verdict = preflightWriteTool(call.name, call.arguments, {
  pathInScope,
  fileContent,
  hasBeenRead,
  missingSymbols: this.groundingMissingSymbols,
  allowedNewSymbols: this.groundingAllowedNewSymbols,
});
```

Do not remove explicitly introduced symbols from the grounding results: finding an existing definition is still useful evidence and may reveal that the requested “new” symbol already exists. The separate allow-set affects only the fabricated-symbol deny decision.

- [ ] **Step 7: Run the focused and pipeline-adjacent gate**

Run:

```powershell
cd server-jarvis
bun test src/orchestration/symbol-grounding.test.ts src/write-preflight.test.ts src/orchestration/pipeline-preflight.test.ts
bun run typecheck
```

Expected: requested declarations pass, unrequested missing dependencies remain blocked, and all existing write-preflight behavior stays green.

- [ ] **Step 8: Update the Phase A contract and commit**

Document `must_exist` versus `may_create` in `MASTER_PLAN_LEARNED_ORCHESTRATION.md`. State that only narrow, explicit introduction verbs produce `may_create`, and that the exemption is exact-name only.

```powershell
git add server-jarvis/src/orchestration/symbol-grounding.ts server-jarvis/src/orchestration/symbol-grounding.test.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/write-preflight.ts server-jarvis/src/write-preflight.test.ts docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md
git commit -m "fix(orchestration): allow task-requested symbol creation"
```

---

### Task 4: Make `multi_edit` preflight atomic

**Why:** The current preflight allows a request when at least one edit applies, then rewrites the tool arguments to contain only successful edits. The Tool runtime loses evidence that other requested edits failed.

**Files:**
- Modify: `server-jarvis/src/write-preflight.ts`
- Modify: `server-jarvis/src/write-preflight.test.ts`
- Modify: `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md`

**Interfaces:**
- Adds: `"multi_edit_partial"` to `WritePreflightCode`.
- Guarantees: `multi_edit` returns `allow: true` only when `applied === edits.length`.
- Preserves: repaired edit order and the existing rolling-content behavior from `repairMultiEditPairs`.
- Produces: a deterministic denial reason listing each skipped one-based edit index and its repair reason.

- [ ] **Step 1: Add the partial-edit regression test**

Add to `write-preflight.test.ts`:

```ts
test("denies a partial multi_edit instead of dropping failed operations", () => {
  const result = preflightWriteTool(
    "multi_edit",
    {
      path: "a.ts",
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "missing", new_string: "SHOULD_NOT_DISAPPEAR" },
      ],
    },
    {
      pathInScope: true,
      hasBeenRead: true,
      fileContent: "alpha\nbeta\n",
    },
  );

  expect(result.allow).toBe(false);
  expect(result.code).toBe("multi_edit_partial");
  expect(result.reason).toContain("edit 2: not_found");
  expect(result.repair).toBeUndefined();
});

test("an entirely applicable multi_edit preserves count and order", () => {
  const result = preflightWriteTool(
    "multi_edit",
    {
      path: "a.ts",
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "beta", new_string: "BETA" },
      ],
    },
    {
      pathInScope: true,
      hasBeenRead: true,
      fileContent: "alpha\nbeta\n",
    },
  );

  expect(result.allow).toBe(true);
  expect(result.repair?.arguments.edits).toEqual([
    { old_string: "alpha", new_string: "ALPHA" },
    { old_string: "beta", new_string: "BETA" },
  ]);
});
```

- [ ] **Step 2: Run the write-preflight tests and verify the partial request is currently allowed**

Run:

```powershell
cd server-jarvis
bun test src/write-preflight.test.ts
```

Expected: the partial-edit regression fails because the current result is `allow: true` with a shortened `edits` array.

- [ ] **Step 3: Reject every incomplete repaired edit list**

Add `multi_edit_partial` to `WritePreflightCode`. Immediately after `repairMultiEditPairs`, reject a mixed success/failure result before building repaired arguments:

```ts
const { items, applied } = repairMultiEditPairs(ctx.fileContent, edits);

if (applied > 0 && applied < edits.length) {
  const skipped = items
    .map((item, index) => item.skipped ? `edit ${index + 1}: ${item.skipped}` : null)
    .filter((item): item is string => item !== null);
  return {
    allow: false,
    code: "multi_edit_partial",
    reason:
      `multi_edit is atomic; ${applied}/${edits.length} edits apply on ${path}. `
      + `No edits were dispatched. Fix and retry: ${skipped.join(", ")}`,
  };
}
```

Keep the existing all-failed classifications for compatibility: all ambiguous/missing edits still return `old_string_ambiguous` or `multi_edit_empty`. Only the mixed case uses `multi_edit_partial`.

- [ ] **Step 4: Preserve full-list repairs without silent filtering**

Once `applied === edits.length`, every item must lack `skipped`. Build `repairedEdits` with `items.map`, not `items.filter(...).map(...)`:

```ts
const repairedEdits = items.map((item) => {
  if (item.repaired && item.matchKind) {
    notes.push(`repaired old_string (${item.matchKind})`);
  }
  return { old_string: item.old_string, new_string: item.new_string };
});
```

Add an invariant guard before mapping so a future change cannot silently reintroduce filtering:

```ts
if (items.some((item) => item.skipped)) {
  return {
    allow: false,
    code: "multi_edit_partial",
    reason: `multi_edit repair invariant failed on ${path}; no edits were dispatched.`,
  };
}
```

- [ ] **Step 5: Run write-contract tests and typecheck**

Run:

```powershell
cd server-jarvis
bun test src/edit-contract.test.ts src/write-preflight.test.ts src/filesystem-bundle.test.ts
bun run typecheck
```

Expected: all tests pass. `repairMultiEditPairs` may continue reporting per-item skips for diagnostics; `preflightWriteTool` is the atomic dispatch gate.

- [ ] **Step 6: Document atomicity and commit**

Update the Phase A3 section of `MASTER_PLAN_LEARNED_ORCHESTRATION.md` to say that `multi_edit` preflight never reduces the requested operation set: full applicability dispatches the repaired full list, while partial applicability returns an error and dispatches nothing.

```powershell
git add server-jarvis/src/write-preflight.ts server-jarvis/src/write-preflight.test.ts docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md
git commit -m "fix(tool-runtime): make multi-edit preflight atomic"
```

---

### Task 5: Run the integrated completion-integrity gate

**Why:** Items 2-4 share the grounding-to-preflight path, and Item 1 changes the serialization contract used by future Phase D work. Focused tests are necessary but not sufficient.

**Files:**
- Verify only: all files changed in Tasks 1-4

**Interfaces:**
- Consumes: fixed `RUN_REWARD_POLICY`, tri-state `SymbolGroundingResult`, exact `allowedNewSymbols`, and atomic `multi_edit` preflight.
- Produces: fresh evidence that the complete Bun server suite and TypeScript contract remain healthy.

- [ ] **Step 1: Scan for forbidden legacy wiring**

Run:

```powershell
rg -n "reward_weight_writes|reward_weight_check|reward_weight_plan|overclaim_penalty" server-jarvis/src/orchestration
rg -n "\.found|found:" server-jarvis/src/orchestration/symbol-grounding.ts server-jarvis/src/orchestration/symbol-grounding.test.ts server-jarvis/src/orchestration/pipeline.ts
rg -n "filter\(\(i\) => !i\.skipped\)" server-jarvis/src/write-preflight.ts
```

Expected:

- Reward-key search finds no `OrchestrationTheta`, `THETA_KEYS`, `BASELINE_THETA`, or active `policy()` usage. Fixed documentation strings or legacy-compatibility tests are acceptable.
- Grounding boolean search finds no `SymbolGroundingResult.found` usage.
- Silent multi-edit filtering search returns no matches.

- [ ] **Step 2: Run all focused regression tests together**

```powershell
cd server-jarvis
bun test src/orchestration/orchestration-policy.test.ts src/orchestration/run-reward.test.ts src/orchestration/symbol-grounding.test.ts src/edit-contract.test.ts src/write-preflight.test.ts src/orchestration/pipeline-preflight.test.ts src/filesystem-bundle.test.ts
```

Expected: zero failures.

- [ ] **Step 3: Run the complete Bun server test suite**

```powershell
cd server-jarvis
bun test src
```

Expected: zero failures across the complete current server baseline. Record the fresh pass count in the implementation handoff; do not reuse the pre-plan count.

- [ ] **Step 4: Run the complete Bun server typecheck**

```powershell
cd server-jarvis
bun run typecheck
```

Expected: `tsc --noEmit` exits successfully with no diagnostics.

- [ ] **Step 5: Check patch hygiene**

Run from the repository root:

```powershell
git diff --check
git status --short
git log -5 --oneline
```

Expected: no whitespace errors. Status contains only intended Task 1-4 changes plus the user-owned pre-existing files documented before execution. The log shows one focused commit per implementation task.

- [ ] **Step 6: Stop at the Phase C boundary**

Do not begin Phase D optimization, build/deploy Jarvis, or claim live-runtime completion as part of this plan. Hand off the fresh unit/typecheck evidence and separately identify the still-required Phase A live fixture measurement.

---

## Self-Review Coverage

| Review finding | Covered by | Proof gate |
|---|---|---|
| 1. Policy can manipulate its reward | Task 1 | Reward keys absent from θ; fixed reward is identical under `runWithTheta`. |
| 2. Grep failures become false misses | Task 2 | Error and budget cases are `indeterminate`; only confirmed misses enter the deny-set. |
| 3. Requested new symbols are blocked | Task 3 | `BrandNewWidget` is `may_create`; unrelated `ImaginaryFrameworkBase` remains blocked. |
| 4. Partial multi-edit silently drops work | Task 4 | Mixed applicability returns `multi_edit_partial` and no repaired arguments. |

The plan contains no Phase D implementation, deployment mutation, or unrelated architecture work.
