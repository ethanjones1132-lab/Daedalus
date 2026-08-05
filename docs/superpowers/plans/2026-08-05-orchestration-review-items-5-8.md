# Orchestration Review Items 5-8 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Phase C policy boundary, make every candidate θ safe and genuinely active, prove deterministic fixture trajectories, and persist cryptographic write-effect evidence on the live reward path.

**Architecture:** Separate optimizable runtime behavior from evaluator and rollout-governance rules. Every eligible θ dimension receives one constrained schema entry and at least one audited live decision site; staging and reward governance remain fixed outside θ. A model-free policy-rollout runner executes recorded deterministic inputs under a seeded runtime, while the live pipeline carries native and delegate write fingerprints through replans into the stored Phase B reward snapshot.

**Tech Stack:** TypeScript, Bun test runner, AsyncLocalStorage, Jarvis orchestration pipeline, canonical filesystem Tool runtime, existing Phase B reward and policy-staging modules.

## Global Constraints

- Start from local `master` at or after `b53a8d0`, where review items 1-4 are already committed.
- Do not reintroduce Phase B reward weights or the overclaim penalty into `OrchestrationTheta`.
- Canary traffic, promotion floors, and minimum rollout counts are evaluator/governance policy; candidates cannot tune the rules that admit or promote them.
- Every θ value must be finite, in domain, and integer-projected when its decision site consumes a count, byte/token budget, or millisecond duration.
- Invalid staged/manual θ input is rejected with an actionable reason. Optimizer vectors are deterministically projected into their declared domains before execution.
- Deterministic rollout proof is model-free: fixtures provide recorded decision inputs. Live inference remains stochastic and must not be described as byte-for-byte reproducible.
- A successful write tool call is not reward evidence. The live reward path credits only before/after content fingerprints with `changed === true`.
- Replans and repair segments share one logical-turn write-effect ledger and expose a defensive copy on `PipelineResult`.
- Preserve the canonical Tool runtime, Bun server architecture, and all unrelated working-tree changes.
- Stop before Phase D CMA-ES optimization, build/deploy, or live canary promotion.

---

## File Structure

| File | Responsibility | Planned change |
|---|---|---|
| `server-jarvis/src/orchestration/orchestration-policy.ts` | Active θ, serialization, ALS overlays | Add complete live dimensions, constrained normalization, and seeded rollout runtime. |
| `server-jarvis/src/orchestration/orchestration-policy-schema.ts` | **New:** θ metadata and ownership | Define baseline, domain, integer semantics, and audited decision-owner files for every eligible dimension. |
| `server-jarvis/src/orchestration/orchestration-policy.test.ts` | θ unit contract | Cover projection, rejection, cross-field constraints, legacy parsing, and rollout runtime. |
| `server-jarvis/src/orchestration/orchestration-policy-coverage.test.ts` | **New:** source-level coverage gate | Fail when a θ key lacks a declared live `policy().key` decision site or governance keys re-enter θ. |
| `server-jarvis/src/orchestration/turn-budget.ts` | Turn/stage budget decisions | Route reviewed budget constants through active θ. |
| `server-jarvis/src/orchestration/model-scorecard.ts` | Rolling model fitness | Route scorecard window/error threshold through active θ. |
| `server-jarvis/src/orchestration/runtime-loop.ts` | Review/repair-cycle bound | Route repair-cycle default through active θ. |
| `server-jarvis/src/orchestration/dead-tool-suppression.ts` | Structural-failure suppression | Route suppression threshold through active θ. |
| Existing orchestration decision modules listed in Task 1 | Live policy consumers | Replace baseline aliases/hard-coded defaults with request-scoped `policy()` reads. |
| `server-jarvis/src/self-tuning/policy-staging.ts` | Candidate/shadow/canary governance | Remove governance values from θ and reject invalid θ patches at proposal/load boundaries. |
| `server-jarvis/src/self-tuning/conductor-learning.ts` | Epsilon exploration | Consume seeded rollout randomness when executed inside a rollout. |
| `server-jarvis/src/eval/policy-rollout.ts` | **New:** deterministic policy trajectory runner | Execute recorded policy-decision steps and return canonical trajectory + digest. |
| `server-jarvis/src/eval/policy-rollout-fixtures.ts` | **New:** model-free fixtures | Store stable inputs that exercise seed-sensitive and θ-sensitive decisions. |
| `server-jarvis/src/eval/policy-rollout.test.ts` | **New:** C3 exit proof | Prove same θ/seed/fixture gives identical events, decisions, and digest. |
| `server-jarvis/src/orchestration/stage-output.ts` | Typed stage evidence | Carry delegate write effects on `ExecutorStageOutput`. |
| `server-jarvis/src/orchestration/claude-delegate.ts` | Delegate snapshot verification | Convert changed snapshot identities into `WriteEffectObservation[]`. |
| `server-jarvis/src/orchestration/pipeline.ts` | Logical-turn orchestration | Reset, accumulate, and surface write effects on every result path. |
| `server-jarvis/src/orchestration/replan-loop.ts` | Production pipeline wrapper | Preserve write effects through finalization/cancellation/replan paths. |
| `server-jarvis/src/orchestration/run-reward.ts` | Stored Phase B reward evidence | Distinguish fingerprint evidence from legacy tool-call fallback and never fall back when an empty effect ledger was explicitly supplied. |
| `server-jarvis/src/orchestration/live-reward-evidence.ts` | **New:** live reward snapshot boundary | Require a write-effect ledger and expose no tool-call fallback input. |
| `server-jarvis/src/orchestration/live-reward-evidence.test.ts` | **New:** live reward persistence contract | Prove live snapshots credit only changed fingerprint paths. |
| `server-jarvis/src/index.ts` | Live turn completion/persistence | Build live reward snapshots from `result.writeEffects`, not successful tool calls. |
| `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md` | Phase C/D contract | Correct Phase C status and record the new proof gates. |
| `docs/PHASE_B_RUN_REWARD_ANTI_GAMING.md` | Reward evidence rationale | Document fingerprint-only live write credit. |
| `docs/PHASE_C_POLICY_INVENTORY.md` | **New:** policy inventory | Render every optimizable dimension and every explicitly fixed governance/mechanism rule. |

---

### Task 1: Complete and audit the eligible Phase C policy surface

**Why:** Most current dimensions are baseline aliases, not request-scoped decisions, and several reviewed decision constants are absent from θ. Conversely, candidate promotion thresholds are governance and must not be optimized by the candidate they judge.

**Files:**
- Create: `server-jarvis/src/orchestration/orchestration-policy-schema.ts`
- Create: `server-jarvis/src/orchestration/orchestration-policy-coverage.test.ts`
- Modify: `server-jarvis/src/orchestration/orchestration-policy.ts`
- Modify: `server-jarvis/src/orchestration/orchestration-policy.test.ts`
- Modify: `server-jarvis/src/orchestration/agent-pool.ts`
- Modify: `server-jarvis/src/orchestration/claude-delegate.ts`
- Modify: `server-jarvis/src/orchestration/conductor.ts`
- Modify: `server-jarvis/src/orchestration/context-budget.ts`
- Modify: `server-jarvis/src/orchestration/delegate-handoff-seed.ts`
- Modify: `server-jarvis/src/orchestration/delegate-intervention-policy.ts`
- Modify: `server-jarvis/src/orchestration/delegate-model-select.ts`
- Modify: `server-jarvis/src/orchestration/evidence-sufficiency.ts`
- Modify: `server-jarvis/src/orchestration/executor-progress-policy.ts`
- Modify: `server-jarvis/src/orchestration/mid-loop-intervention.ts`
- Modify: `server-jarvis/src/orchestration/model-scorecard.ts`
- Modify: `server-jarvis/src/orchestration/model-trial-policy.ts`
- Modify: `server-jarvis/src/orchestration/persistent-conductor.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts`
- Modify: `server-jarvis/src/orchestration/reliability-latency-rank.ts`
- Modify: `server-jarvis/src/orchestration/repetition-guard.ts`
- Modify: `server-jarvis/src/orchestration/reroute-policy.ts`
- Modify: `server-jarvis/src/orchestration/runtime-loop.ts`
- Modify: `server-jarvis/src/orchestration/dead-tool-suppression.ts`
- Modify: `server-jarvis/src/orchestration/turn-budget.ts`
- Modify: `server-jarvis/src/self-tuning/policy-staging.ts`
- Create: `docs/PHASE_C_POLICY_INVENTORY.md`
- Modify: `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md`

**Interfaces:**
- Produces: `THETA_DECISION_OWNERS: Record<keyof OrchestrationTheta, readonly string[]>`.
- Adds these eligible dimensions: `default_min_viable_stage_ms`, `progress_extension_ms`, `stage_extension_ceiling_ms`, `absolute_turn_cap_ms`, `model_scorecard_window_size`, `model_scorecard_unfit_error_rate`, `default_max_repair_cycles`, `max_review_repair_rounds_cap`, `dead_tool_suppress_threshold`.
- Removes from θ: `policy_canary_traffic_fraction`, `policy_min_canary_success_rate`, `policy_min_eligible_outcomes_before_shadow`, `policy_min_canary_runs_before_promotion`.
- Produces fixed `POLICY_STAGING_GOVERNANCE` in `policy-staging.ts` with the current values `0.1`, `0.6`, `20`, and `20` respectively.
- Guarantees: each remaining `THETA_KEYS` entry has a direct `policy().<key>` read in at least one declared owner file.

- [ ] **Step 1: Write the failing policy-coverage test**

Create `orchestration-policy-coverage.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { THETA_KEYS } from "./orchestration-policy";
import { THETA_DECISION_OWNERS } from "./orchestration-policy-schema";

const SRC_ROOT = resolve(import.meta.dir, "..");
const GOVERNANCE_KEYS = new Set([
  "policy_canary_traffic_fraction",
  "policy_min_canary_success_rate",
  "policy_min_eligible_outcomes_before_shadow",
  "policy_min_canary_runs_before_promotion",
]);

describe("Phase C policy coverage", () => {
  test("every eligible theta key has a live request-scoped decision read", () => {
    expect(Object.keys(THETA_DECISION_OWNERS).sort()).toEqual([...THETA_KEYS].sort());
    for (const key of THETA_KEYS) {
      const owners = THETA_DECISION_OWNERS[key];
      expect(owners.length).toBeGreaterThan(0);
      const hasLiveRead = owners.some((relativePath) =>
        readFileSync(resolve(SRC_ROOT, relativePath), "utf8")
          .includes(`policy().${key}`),
      );
      expect(hasLiveRead, `${key} has no policy().${key} decision read`).toBe(true);
    }
  });

  test("candidate policy cannot tune rollout governance", () => {
    for (const key of GOVERNANCE_KEYS) {
      expect(THETA_KEYS).not.toContain(key as never);
    }
  });
});
```

- [ ] **Step 2: Add focused behavior tests for currently stale aliases**

Add one overlay test to each existing owner test file. These tests must call the decision function inside `runWithTheta` and prove the changed θ value changes the decision:

```ts
test("quality push budget reads request-scoped theta", () => {
  const signal: MidLoopSignal = {
    writeIntent: true,
    successfulWrites: 1,
    distinctSuccessfulReads: 1,
    turnCount: 1,
    maxTurns: 5,
    stageRemainingMs: 100_000,
    deadToolSuppressed: false,
    implementationPhase: "quality",
    qualityPushesUsed: 1,
  };
  expect(runWithTheta({ max_quality_pushes: 1 }, () =>
    shouldRunQualityPhase(signal),
  )).toBe(false);
  expect(runWithTheta({ max_quality_pushes: 2 }, () =>
    shouldRunQualityPhase(signal),
  )).toBe(true);
});

test("no-tool ratio reads request-scoped theta", () => {
  const input = {
    writeIntent: true,
    emittedToolCalls: false,
    successfulWrites: 0,
    consecutiveNoToolTurns: 1,
    stageRemainingMs: 60_000,
    anyToolCallThisStage: true,
    executorTurns: 10,
    noToolTurns: 4,
  };
  expect(runWithTheta({ no_tool_ratio_ceiling: 0.3 }, () =>
    decideExecutorProgress(input),
  )).toBe("stop_partial");
  expect(runWithTheta({ no_tool_ratio_ceiling: 0.5 }, () =>
    decideExecutorProgress(input),
  )).toBe("continue");
});

test("delegate cooldown reads request-scoped theta", () => {
  let now = 1_000;
  const health = new DelegateHealth(() => now);
  runWithTheta({ delegate_health_cooldown_ms: 2_000 }, () => {
    health.strike("spawn_error");
    health.strike("spawn_error");
    health.strike("spawn_error");
  });
  now = 2_999;
  expect(health.isAvailable()).toBe(false);
  now = 3_000;
  expect(health.isAvailable()).toBe(true);
});
```

Import `MidLoopSignal`, `shouldRunQualityPhase`, `decideExecutorProgress`, and `DelegateHealth` directly from their production modules. Add the overlay cases beside their existing decision tests so no production-only test hook is introduced.

- [ ] **Step 3: Run the coverage/focused tests and verify they fail because decisions still use constants**

Run:

```powershell
cd server-jarvis
bun test src/orchestration/orchestration-policy-coverage.test.ts src/orchestration/mid-loop-intervention.test.ts src/orchestration/executor-progress-policy.test.ts src/orchestration/claude-delegate.test.ts
```

Expected: coverage fails for stale keys and the focused overlay tests show baseline behavior under both overlays.

- [ ] **Step 4: Define exact owner files for every eligible dimension**

Create `orchestration-policy-schema.ts` with this ownership map. Paths are relative to `server-jarvis/src` so the coverage test can read them:

```ts
import type { OrchestrationTheta } from "./orchestration-policy";

export const THETA_DECISION_OWNERS: Record<keyof OrchestrationTheta, readonly string[]> = {
  force_write_nudge_cap: ["orchestration/mid-loop-intervention.ts"],
  max_quality_pushes: ["orchestration/pipeline.ts", "orchestration/mid-loop-intervention.ts"],
  max_mid_loop_checks: ["orchestration/mid-loop-intervention.ts"],
  max_mid_loop_escalations: ["orchestration/conductor.ts", "orchestration/mid-loop-intervention.ts"],
  reserved_mid_loop_escalations: ["orchestration/mid-loop-intervention.ts"],
  mid_loop_endgame_budget_ms: ["orchestration/mid-loop-intervention.ts"],
  mid_loop_endgame_turn_ratio: ["orchestration/mid-loop-intervention.ts"],
  max_failed_write_attempts_without_effect: ["orchestration/effect-gate.ts"],
  identical_write_pressure_note_cap: ["orchestration/effect-gate.ts"],
  repeated_failed_writes_threshold: ["orchestration/delegate-intervention-policy.ts"],
  max_directives_per_turn: ["orchestration/directive-budget.ts"],
  default_max_reroutes_per_segment: ["orchestration/reroute-policy.ts"],
  local_stage_min_window_ms: ["orchestration/agent-pool.ts"],
  synthesis_runway_ms: ["orchestration/pipeline.ts"],
  routing_timeout_ms: ["orchestration/persistent-conductor.ts"],
  no_tool_retry_budget_floor_ms: ["orchestration/executor-progress-policy.ts"],
  no_tool_ratio_ceiling: ["orchestration/executor-progress-policy.ts"],
  no_tool_ratio_min_turns: ["orchestration/executor-progress-policy.ts"],
  min_no_tool_sample: ["orchestration/model-health.ts"],
  no_tool_demotion_threshold: ["orchestration/model-health.ts"],
  min_error_rate_sample: ["orchestration/model-health.ts"],
  error_rate_bench_threshold: ["orchestration/model-health.ts"],
  trial_sample_target: ["orchestration/model-trial-policy.ts"],
  reliability_latency_min_samples: ["orchestration/reliability-latency-rank.ts"],
  max_delegate_launches_per_run: ["orchestration/pipeline.ts"],
  default_free_thrash_threshold: ["orchestration/delegate-model-select.ts"],
  delegate_write_scoreboard_bench_attempts: ["orchestration/delegate-model-select.ts"],
  thrash_ttl_ms: ["orchestration/delegate-model-select.ts", "orchestration/pipeline.ts"],
  delegate_health_cooldown_ms: ["orchestration/claude-delegate.ts"],
  delegate_availability_cache_ms: ["orchestration/claude-delegate.ts"],
  delegate_api_retry_abort_threshold: ["orchestration/claude-delegate.ts"],
  max_handoff_seed_paths: ["orchestration/delegate-handoff-seed.ts"],
  deep_read_min_content_reads: ["orchestration/evidence-sufficiency.ts"],
  max_grounding_symbols: ["orchestration/symbol-grounding.ts"],
  max_grounding_greps: ["orchestration/symbol-grounding.ts"],
  grounding_grep_head_limit: ["orchestration/symbol-grounding.ts"],
  grounding_block_context_chars: ["orchestration/symbol-grounding.ts"],
  executor_tool_result_context_chars: ["orchestration/context-budget.ts", "orchestration/pipeline.ts"],
  executor_preflight_result_context_chars: ["orchestration/context-budget.ts", "orchestration/pipeline.ts"],
  write_turn_tool_result_context_chars: ["orchestration/context-budget.ts", "orchestration/pipeline.ts"],
  executor_transcript_budget_tokens: ["orchestration/context-budget.ts", "orchestration/pipeline.ts"],
  write_turn_transcript_budget_tokens: ["orchestration/context-budget.ts", "orchestration/pipeline.ts"],
  repetition_similarity_threshold: ["orchestration/repetition-guard.ts"],
  default_min_viable_stage_ms: ["orchestration/turn-budget.ts"],
  progress_extension_ms: ["orchestration/turn-budget.ts"],
  stage_extension_ceiling_ms: ["orchestration/turn-budget.ts"],
  absolute_turn_cap_ms: ["orchestration/turn-budget.ts"],
  model_scorecard_window_size: ["orchestration/model-scorecard.ts"],
  model_scorecard_unfit_error_rate: ["orchestration/model-scorecard.ts"],
  default_max_repair_cycles: ["orchestration/runtime-loop.ts"],
  max_review_repair_rounds_cap: ["orchestration/pipeline.ts"],
  dead_tool_suppress_threshold: ["orchestration/dead-tool-suppression.ts"],
};
```

- [ ] **Step 5: Move governance values outside θ**

Delete the four `policy_*` fields from `OrchestrationTheta`, `THETA_KEYS`, and `BASELINE_THETA`. Replace `POLICY_STAGING_THRESHOLDS`' θ-derived members with immutable governance:

```ts
export const POLICY_STAGING_GOVERNANCE = Object.freeze({
  canaryTrafficFraction: 0.1,
  minCanarySuccessRate: 0.6,
  minEligibleOutcomesBeforeShadow: 20,
  minCanaryRunsBeforePromotion: 20,
  maxCanaryUnderperformance: 0.05,
  minSamplesForRollback: 10,
  maxCanaryFailureRate: 0.5,
  maxCanaryRegressionVsProduction: 0.15,
});
```

Use `POLICY_STAGING_GOVERNANCE` for canary selection, shadow admission, promotion, and rollback. Keep `shouldApplyCanary(rng)` injectable; it compares `rng()` to the fixed traffic fraction.

- [ ] **Step 6: Add the nine reviewed missing dimensions at their current baselines**

Extend `OrchestrationTheta`, `THETA_KEYS`, and `BASELINE_THETA`:

```ts
default_min_viable_stage_ms: 5_000,
progress_extension_ms: 20_000,
stage_extension_ceiling_ms: 90_000,
absolute_turn_cap_ms: 180_000,
model_scorecard_window_size: 20,
model_scorecard_unfit_error_rate: 0.5,
default_max_repair_cycles: 2,
max_review_repair_rounds_cap: 2,
dead_tool_suppress_threshold: 2,
```

Keep `FINAL_STREAM_GRACE_MS`, extended-deep ceilings, provider timeouts, cryptographic sizes, and fixed canary governance outside θ. Record each exclusion and rationale in `PHASE_C_POLICY_INVENTORY.md`; do not continue claiming literally every numeric constant is optimizable.

- [ ] **Step 7: Replace stale decision constants with live policy reads**

At every owner file in the map, read θ at decision time. Representative replacements:

```ts
// executor-progress-policy.ts
if (
  executorTurns >= policy().no_tool_ratio_min_turns
  && noToolTurns / executorTurns >= policy().no_tool_ratio_ceiling
) return "stop_partial";

if (
  input.consecutiveNoToolTurns === 1
  && input.stageRemainingMs > policy().no_tool_retry_budget_floor_ms
) return "retry_strong";

// reroute-policy.ts
export function canApplyConductorReroute(
  applied: number,
  max = policy().default_max_reroutes_per_segment,
): boolean {
  return Number.isFinite(applied)
    && applied >= 0
    && applied < Math.max(1, Math.floor(max));
}

// context-budget.ts
export function executorToolResultContextChars(): number {
  return policy().executor_tool_result_context_chars;
}

// turn-budget.ts
const floor = MIN_VIABLE_STAGE_MS[stage] ?? policy().default_min_viable_stage_ms;
const extension = Math.min(newEvidenceCount, 3) * policy().progress_extension_ms;
const stageExtensionCeilingMs = extendedDeep
  ? Math.max(policy().stage_extension_ceiling_ms, EXTENDED_DEEP_EXECUTOR_MS)
  : policy().stage_extension_ceiling_ms;

// dead-tool-suppression.ts
return (this.structuralFailures.get(tool) ?? 0) >= policy().dead_tool_suppress_threshold;
```

Baseline alias exports may remain for compatibility assertions and documentation, but no live branch/default parameter may consume them. For objects that outlive a request, snapshot required θ values in the constructor under the active `runWithTheta` scope; do not read request ALS later from an unrelated async turn.

- [ ] **Step 8: Run coverage, owner tests, and typecheck**

Run:

```powershell
cd server-jarvis
bun test src/orchestration/orchestration-policy-coverage.test.ts src/orchestration/orchestration-policy.test.ts src/orchestration/mid-loop-intervention.test.ts src/orchestration/executor-progress-policy.test.ts src/orchestration/turn-budget.test.ts src/orchestration/model-scorecard.test.ts src/orchestration/runtime-loop.test.ts src/orchestration/dead-tool-suppression.test.ts src/self-tuning/policy-staging.test.ts
bun run typecheck
```

Expected: coverage finds every key and owner, all baseline behavior remains unchanged, and overlay-specific tests prove live decisions change.

- [ ] **Step 9: Write the policy inventory and correct the master-plan claim**

`PHASE_C_POLICY_INVENTORY.md` must contain three tables:

1. Optimizable θ dimensions: key, baseline, owner file, decision description.
2. Fixed evaluator/governance rules: reward objective and `POLICY_STAGING_GOVERNANCE`.
3. Fixed mechanism/safety rules: final-stream grace, extended-deep hard ceiling, cryptographic hash algorithm, and provider/API safety ceilings.

Change Phase C status in `MASTER_PLAN_LEARNED_ORCHESTRATION.md` from “complete” to “implementation complete; live fixture exit proof pending” and replace “every hand-tuned constant” with “every inventory-approved optimizable runtime decision.”

- [ ] **Step 10: Commit Task 1**

```powershell
git add server-jarvis/src/orchestration/orchestration-policy-schema.ts server-jarvis/src/orchestration/orchestration-policy-coverage.test.ts server-jarvis/src/orchestration/orchestration-policy.ts server-jarvis/src/orchestration/orchestration-policy.test.ts server-jarvis/src/orchestration/agent-pool.ts server-jarvis/src/orchestration/claude-delegate.ts server-jarvis/src/orchestration/conductor.ts server-jarvis/src/orchestration/context-budget.ts server-jarvis/src/orchestration/delegate-handoff-seed.ts server-jarvis/src/orchestration/delegate-intervention-policy.ts server-jarvis/src/orchestration/delegate-model-select.ts server-jarvis/src/orchestration/evidence-sufficiency.ts server-jarvis/src/orchestration/executor-progress-policy.ts server-jarvis/src/orchestration/mid-loop-intervention.ts server-jarvis/src/orchestration/model-scorecard.ts server-jarvis/src/orchestration/model-trial-policy.ts server-jarvis/src/orchestration/persistent-conductor.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/reliability-latency-rank.ts server-jarvis/src/orchestration/repetition-guard.ts server-jarvis/src/orchestration/reroute-policy.ts server-jarvis/src/orchestration/runtime-loop.ts server-jarvis/src/orchestration/dead-tool-suppression.ts server-jarvis/src/orchestration/turn-budget.ts server-jarvis/src/self-tuning/policy-staging.ts server-jarvis/src/self-tuning/policy-staging.test.ts docs/PHASE_C_POLICY_INVENTORY.md docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md
git commit -m "fix(orchestration): complete audited policy surface"
```

---

### Task 2: Enforce θ domains and cross-field invariants

**Why:** The current merge/vector paths accept any finite number. Negative timeouts, non-integer counts, ratios above one, and contradictory escalation budgets can reach live decisions or policy staging.

**Files:**
- Modify: `server-jarvis/src/orchestration/orchestration-policy-schema.ts`
- Modify: `server-jarvis/src/orchestration/orchestration-policy.ts`
- Modify: `server-jarvis/src/orchestration/orchestration-policy.test.ts`
- Modify: `server-jarvis/src/self-tuning/policy-staging.ts`
- Modify: `server-jarvis/src/self-tuning/policy-staging.test.ts`
- Modify: `server-jarvis/src/self-tuning/learned-pool-state.ts`

**Interfaces:**
- Produces: `ThetaDimensionSpec { baseline, min, max, kind, owners }` and `THETA_SPEC`.
- Produces: `ThetaValidationIssue`, `ThetaValidationError`, `validateThetaPatch`, `projectThetaPatch`, and `assertValidTheta`.
- Changes: `mergeTheta`, `parseTheta`, `setGlobalTheta`, and staged-policy proposal/load reject invalid values.
- Changes: `vectorToTheta` projects CMA-ES candidates by clamping and integer rounding.
- Enforces: `reserved_mid_loop_escalations <= max_mid_loop_escalations` and `stage_extension_ceiling_ms <= absolute_turn_cap_ms`.

- [ ] **Step 1: Write failing scalar-domain tests**

Add to `orchestration-policy.test.ts`:

```ts
test("manual theta patches reject unsafe domains", () => {
  expect(() => mergeTheta(BASELINE_THETA, { routing_timeout_ms: -1 }))
    .toThrow(ThetaValidationError);
  expect(() => mergeTheta(BASELINE_THETA, { no_tool_ratio_ceiling: 1.1 }))
    .toThrow(ThetaValidationError);
  expect(() => mergeTheta(BASELINE_THETA, { max_directives_per_turn: 1.5 }))
    .toThrow(ThetaValidationError);
});

test("optimizer vectors are deterministically projected", () => {
  const vector = thetaToVector(BASELINE_THETA);
  vector[THETA_KEYS.indexOf("routing_timeout_ms")] = -1;
  vector[THETA_KEYS.indexOf("no_tool_ratio_ceiling")] = 2;
  vector[THETA_KEYS.indexOf("max_directives_per_turn")] = 3.8;
  const projected = vectorToTheta(vector);
  expect(projected.routing_timeout_ms).toBe(1_000);
  expect(projected.no_tool_ratio_ceiling).toBe(1);
  expect(projected.max_directives_per_turn).toBe(4);
});
```

- [ ] **Step 2: Write failing cross-field and staging tests**

```ts
test("cross-field invariants reject contradictory theta", () => {
  expect(() => mergeTheta(BASELINE_THETA, {
    max_mid_loop_escalations: 1,
    reserved_mid_loop_escalations: 2,
  })).toThrow(/reserved_mid_loop_escalations/);
  expect(() => mergeTheta(BASELINE_THETA, {
    absolute_turn_cap_ms: 60_000,
    stage_extension_ceiling_ms: 90_000,
  })).toThrow(/stage_extension_ceiling_ms/);
});

test("policy staging rejects an invalid theta patch", () => {
  const result = proposePolicy(
    { domain: "budget", theta: { routing_timeout_ms: -1 } },
    "invalid timeout",
  );
  expect(result.action).toBe("rejected");
  expect(result.reason).toContain("invalid_theta:routing_timeout_ms");
  expect(getPolicyVersionStore().candidate).toBeNull();
});
```

- [ ] **Step 3: Run the tests and verify unsafe inputs are currently accepted**

```powershell
cd server-jarvis
bun test src/orchestration/orchestration-policy.test.ts src/self-tuning/policy-staging.test.ts
```

Expected: domain tests fail because values pass through, and staging creates a candidate.

- [ ] **Step 4: Define exact domain helpers and schema entries**

Use these constructors in `orchestration-policy-schema.ts`:

```ts
type ThetaKind = "integer" | "float";
export interface ThetaDimensionSpec {
  baseline: number;
  min: number;
  max: number;
  kind: ThetaKind;
  owners: readonly string[];
}

const count = (baseline: number, min: number, max: number, owners: readonly string[]): ThetaDimensionSpec =>
  ({ baseline, min, max, kind: "integer", owners });
const ratio = (baseline: number, owners: readonly string[]): ThetaDimensionSpec =>
  ({ baseline, min: 0, max: 1, kind: "float", owners });
const ms = (baseline: number, min: number, max: number, owners: readonly string[]): ThetaDimensionSpec =>
  ({ baseline, min, max, kind: "integer", owners });
const budget = (baseline: number, min: number, max: number, owners: readonly string[]): ThetaDimensionSpec =>
  ({ baseline, min, max, kind: "integer", owners });
```

Apply these exact ranges:

- Ratios `[0,1]`: `mid_loop_endgame_turn_ratio`, `no_tool_ratio_ceiling`, `no_tool_demotion_threshold`, `error_rate_bench_threshold`, `model_scorecard_unfit_error_rate`, `repetition_similarity_threshold`.
- Counts `[0,8]`: write nudge, quality push, mid-loop check/escalation/reserved, delegate launches, repair cycles, review-repair cap.
- Counts `[1,10]`: failed-write threshold, repeated-write threshold, thrash threshold, API retry threshold, dead-tool threshold.
- Counts `[1,100]`: directives, reroutes, sample floors/targets, scoreboard attempts, handoff paths, grounding symbols/head limit.
- `max_grounding_greps`: integer `[1,256]`.
- Durations use integer milliseconds: routing/retry/min-window/endgame `[1_000,600_000]`; TTL/cooldown/cache `[1_000,86_400_000]`; progress extension `[1_000,120_000]`; stage/turn caps `[10_000,3_600_000]`.
- Character budgets: integer `[256,1_000_000]`.
- Transcript token budgets: integer `[256,200_000]`.
- `model_scorecard_window_size`: integer `[1,1_000]`.

The schema is the single baseline source. Derive `THETA_KEYS` from `Object.keys(THETA_SPEC)`, and derive `BASELINE_THETA` from each entry's `baseline` so definitions cannot drift.

- [ ] **Step 5: Implement strict validation and optimizer projection**

```ts
export interface ThetaValidationIssue {
  key: string;
  value: unknown;
  reason: "unknown" | "non_finite" | "below_min" | "above_max" | "not_integer" | "cross_field";
  message: string;
}

export class ThetaValidationError extends Error {
  constructor(public readonly issues: readonly ThetaValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "ThetaValidationError";
  }
}

export function validateThetaPatch(patch: Record<string, unknown>): ThetaValidationIssue[];
export function projectThetaPatch(base: OrchestrationTheta, patch: Record<string, unknown>): OrchestrationTheta;
export function assertValidTheta(theta: OrchestrationTheta): OrchestrationTheta;
```

Strict/manual flow rejects unknown keys, non-finite values, out-of-range values, non-integer count/budget values, and cross-field violations. Projection flow ignores unknown keys, replaces non-finite values with the base value, clamps to `[min,max]`, rounds integer kinds with `Math.round`, then applies cross-field projection in this order:

```ts
projected.reserved_mid_loop_escalations = Math.min(
  projected.reserved_mid_loop_escalations,
  projected.max_mid_loop_escalations,
);
projected.stage_extension_ceiling_ms = Math.min(
  projected.stage_extension_ceiling_ms,
  projected.absolute_turn_cap_ms,
);
```

- [ ] **Step 6: Put strict/projected behavior on the correct boundaries**

- `mergeTheta`, `parseTheta`, `runWithTheta`, `setGlobalTheta`, and `applyThetaPatchGlobally`: strict validation.
- `proposePolicy`, persisted policy loading, and learned-pool activation: catch `ThetaValidationError`, reject/quarantine without mutating production or LKG.
- `vectorToTheta`: optimizer projection.
- `thetaToVector` and `serializeTheta`: call `assertValidTheta` before emitting.

Persisted legacy snapshots may omit newly added dimensions; merge them over `BASELINE_THETA` before full validation. Extra removed governance/reward keys are stripped only in the explicit legacy migration helper, not silently accepted from new proposals.

```ts
const LEGACY_REMOVED_THETA_KEYS = new Set([
  "reward_weight_writes",
  "reward_weight_check",
  "reward_weight_plan",
  "overclaim_penalty",
  "policy_canary_traffic_fraction",
  "policy_min_canary_success_rate",
  "policy_min_eligible_outcomes_before_shadow",
  "policy_min_canary_runs_before_promotion",
]);

export function migrateLegacyThetaPatch(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !LEGACY_REMOVED_THETA_KEYS.has(key)),
  );
}
```

Only persisted snapshot loading calls `migrateLegacyThetaPatch`. `proposePolicy`, `runWithTheta`, and manual/global setters validate the unmodified input and reject those removed keys as unknown.

- [ ] **Step 7: Run focused tests and the complete typecheck**

```powershell
cd server-jarvis
bun test src/orchestration/orchestration-policy.test.ts src/orchestration/orchestration-policy-coverage.test.ts src/self-tuning/policy-staging.test.ts src/self-tuning/learned-pool-state.test.ts
bun run typecheck
```

Expected: invalid manual/staged values reject, optimizer vectors project deterministically, and baseline serialization round-trips.

- [ ] **Step 8: Commit Task 2**

```powershell
git add server-jarvis/src/orchestration/orchestration-policy-schema.ts server-jarvis/src/orchestration/orchestration-policy.ts server-jarvis/src/orchestration/orchestration-policy.test.ts server-jarvis/src/self-tuning/policy-staging.ts server-jarvis/src/self-tuning/policy-staging.test.ts server-jarvis/src/self-tuning/learned-pool-state.ts server-jarvis/src/self-tuning/learned-pool-state.test.ts
git commit -m "fix(orchestration): validate and project policy theta"
```

---

### Task 3: Build a deterministic policy-trajectory rollout runner

**Why:** `rolloutFingerprint` proves only that inputs hash consistently. It does not execute decisions, control exploration randomness, or prove that the same fixture follows the same trajectory.

**Files:**
- Modify: `server-jarvis/src/orchestration/orchestration-policy.ts`
- Modify: `server-jarvis/src/orchestration/orchestration-policy.test.ts`
- Modify: `server-jarvis/src/orchestration/turn-budget.ts`
- Modify: `server-jarvis/src/self-tuning/conductor-learning.ts`
- Modify: `server-jarvis/src/self-tuning/conductor-learning.test.ts`
- Modify: `server-jarvis/src/self-tuning/policy-staging.ts`
- Create: `server-jarvis/src/eval/policy-rollout.ts`
- Create: `server-jarvis/src/eval/policy-rollout-fixtures.ts`
- Create: `server-jarvis/src/eval/policy-rollout.test.ts`
- Modify: `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md`

**Interfaces:**
- Produces: `RolloutRuntime { random, now, id }`, `rolloutRandom()`, `rolloutNow()`, and `rolloutId(prefix)`.
- Extends: `withRollout` installs θ plus deterministic random/time/id sources.
- Produces: typed `PolicyRolloutFixture`, `PolicyRolloutEvent`, `PolicyRolloutResult`, and `runPolicyRollout`.
- Guarantees: identical validated θ, seed, and fixture produce deeply equal trajectory arrays and the same SHA-256 trajectory digest.

- [ ] **Step 1: Write failing rollout-runtime tests**

Add to `orchestration-policy.test.ts`:

```ts
test("withRollout controls random, time, and ids", () => {
  const spec = { theta: BASELINE_THETA, seed: 42, fixtureId: "runtime" };
  const first = withRollout(spec, () => ({
    draws: [rolloutRandom(), rolloutRandom()],
    times: [rolloutNow(), rolloutNow()],
    ids: [rolloutId("evt"), rolloutId("evt")],
  }));
  const second = withRollout(spec, () => ({
    draws: [rolloutRandom(), rolloutRandom()],
    times: [rolloutNow(), rolloutNow()],
    ids: [rolloutId("evt"), rolloutId("evt")],
  }));
  expect(second.result).toEqual(first.result);
});
```

- [ ] **Step 2: Write the failing trajectory reproducibility test**

Create `policy-rollout.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { BASELINE_THETA } from "../orchestration/orchestration-policy";
import { POLICY_ROLLOUT_FIXTURES } from "./policy-rollout-fixtures";
import { runPolicyRollout } from "./policy-rollout";

describe("deterministic policy rollout", () => {
  test("same theta + seed + fixture produces the same trajectory", () => {
    const fixture = POLICY_ROLLOUT_FIXTURES[0]!;
    const spec = { theta: BASELINE_THETA, seed: 17, fixtureId: fixture.id };
    const first = runPolicyRollout(spec, fixture);
    const second = runPolicyRollout(spec, fixture);
    expect(second.events).toEqual(first.events);
    expect(second.trajectoryDigest).toBe(first.trajectoryDigest);
    expect(second.events.length).toBe(fixture.steps.length);
  });

  test("seed and theta changes affect the trajectory for the intended reason", () => {
    const fixture = POLICY_ROLLOUT_FIXTURES[0]!;
    const baseline = runPolicyRollout(
      { theta: BASELINE_THETA, seed: 17, fixtureId: fixture.id }, fixture,
    );
    const otherSeed = runPolicyRollout(
      { theta: BASELINE_THETA, seed: 18, fixtureId: fixture.id }, fixture,
    );
    const otherTheta = runPolicyRollout(
      { theta: { no_tool_ratio_ceiling: 0.2 }, seed: 17, fixtureId: fixture.id }, fixture,
    );
    expect(otherSeed.trajectoryDigest).not.toBe(baseline.trajectoryDigest);
    expect(otherTheta.events).not.toEqual(baseline.events);
  });
});
```

- [ ] **Step 3: Run the tests and verify they fail because only input hashing exists**

```powershell
cd server-jarvis
bun test src/orchestration/orchestration-policy.test.ts src/eval/policy-rollout.test.ts
```

Expected: rollout runtime/runner symbols are missing.

- [ ] **Step 4: Add request-scoped deterministic runtime services**

In `orchestration-policy.ts`, add a second ALS store:

```ts
export interface RolloutRuntime {
  random: () => number;
  now: () => number;
  id: (prefix: string) => string;
}

const rolloutRuntimeAls = new AsyncLocalStorage<RolloutRuntime>();

export function rolloutRandom(): number {
  return rolloutRuntimeAls.getStore()?.random() ?? Math.random();
}
export function rolloutNow(): number {
  return rolloutRuntimeAls.getStore()?.now() ?? Date.now();
}
export function rolloutId(prefix: string): string {
  return rolloutRuntimeAls.getStore()?.id(prefix) ?? `${prefix}_${crypto.randomUUID()}`;
}
```

`withRollout` creates one seeded PRNG, a deterministic epoch `1_700_000_000_000 + seed * 1_000`, monotonically increments time by one millisecond per call, and creates IDs as `${prefix}_${seed}_${counter}`. Install runtime ALS outside `runWithTheta` so both scopes remain active through async callbacks; update `withRollout` to accept and return `T | Promise<T>` without dropping ALS context.

- [ ] **Step 5: Route rollout-affecting nondeterminism through the runtime**

- `policy-staging.shouldApplyCanary`: default RNG becomes `rolloutRandom`.
- `conductor-learning` epsilon exploration: replace `Math.random()` with `rolloutRandom()`.
- `turn-budget` default `startedAt` and default `now` parameters: use `rolloutNow()`.
- Policy-rollout event IDs: use `rolloutId("rollout_event")`.

Do not mechanically replace diagnostic wall clocks or production persistence UUIDs that cannot affect a model-free policy decision. The fixture trajectory excludes diagnostic timestamps, durations, and database IDs.

- [ ] **Step 6: Define the fixture and event contracts**

Create `policy-rollout-fixtures.ts` with:

```ts
export type PolicyRolloutStep =
  | { kind: "canary_draw"; canaryActive: boolean }
  | { kind: "executor_progress"; input: ExecutorProgressInput }
  | { kind: "delegate_intervention"; input: DelegateInterventionInput }
  | { kind: "reroute_admission"; applied: number }
  | { kind: "dead_tool"; tool: string; failures: string[] };

export interface PolicyRolloutFixture {
  id: string;
  steps: readonly PolicyRolloutStep[];
}

export const POLICY_ROLLOUT_FIXTURES: readonly PolicyRolloutFixture[] = [{
  id: "completion_integrity_mixed",
  steps: [
    { kind: "canary_draw", canaryActive: true },
    {
      kind: "executor_progress",
      input: {
        writeIntent: true, emittedToolCalls: false, successfulWrites: 0,
        consecutiveNoToolTurns: 1, stageRemainingMs: 60_000,
        anyToolCallThisStage: true, executorTurns: 10, noToolTurns: 4,
      },
    },
    {
      kind: "delegate_intervention",
      input: {
        intervention: { kind: "force_write", note: "Apply the requested write now." },
        successfulReads: 2, successfulWrites: 0, failedWrites: 2,
        policyDenied: false, elapsedMs: 20_000, stageRemainingMs: 50_000,
        explorationLimitMs: 40_000, nativeFallbackReserveMs: 15_000,
      },
    },
    { kind: "reroute_admission", applied: 2 },
    {
      kind: "dead_tool", tool: "grep",
      failures: ["executable not found", "executable not found"],
    },
  ],
}];
```

Import `ExecutorProgressInput` and `DelegateInterventionInput` as types so the fixture object is compile-checked against the production decision contracts.

- [ ] **Step 7: Implement the model-free trajectory runner**

Create `policy-rollout.ts`:

```ts
export interface PolicyRolloutEvent {
  index: number;
  id: string;
  kind: PolicyRolloutStep["kind"];
  decision: string | boolean;
}

export interface PolicyRolloutResult {
  rolloutFingerprint: string;
  trajectoryDigest: string;
  theta: OrchestrationTheta;
  events: PolicyRolloutEvent[];
}

export function runPolicyRollout(
  spec: RolloutSpec,
  fixture: PolicyRolloutFixture,
): PolicyRolloutResult {
  if (spec.fixtureId !== fixture.id) {
    throw new Error(`fixture mismatch: spec=${spec.fixtureId} fixture=${fixture.id}`);
  }
  const execution = withRollout(spec, (rng) => {
    const events = fixture.steps.map((step, index) => {
      let decision: string | boolean;
      switch (step.kind) {
        case "canary_draw":
          decision = step.canaryActive
            ? rng() < POLICY_STAGING_GOVERNANCE.canaryTrafficFraction
            : false;
          break;
        case "executor_progress":
          decision = decideExecutorProgress(step.input);
          break;
        case "delegate_intervention":
          decision = decideDelegateIntervention(step.input);
          break;
        case "reroute_admission":
          decision = canApplyConductorReroute(step.applied);
          break;
        case "dead_tool": {
          const tracker = new DeadToolTracker();
          for (const failure of step.failures) tracker.record(step.tool, true, failure);
          decision = tracker.isSuppressed(step.tool);
          break;
        }
      }
      return { index, id: rolloutId("rollout_event"), kind: step.kind, decision };
    });
    return events;
  });
  if (execution.result instanceof Promise) {
    throw new Error("policy rollout fixtures must remain synchronous");
  }
  const events = execution.result;
  const trajectoryDigest = createHash("sha256")
    .update(JSON.stringify(events))
    .digest("hex");
  return {
    rolloutFingerprint: execution.fingerprint,
    trajectoryDigest,
    theta: execution.theta,
    events,
  };
}
```

- [ ] **Step 8: Run rollout, policy, and learning tests**

```powershell
cd server-jarvis
bun test src/eval/policy-rollout.test.ts src/orchestration/orchestration-policy.test.ts src/self-tuning/conductor-learning.test.ts src/self-tuning/policy-staging.test.ts src/orchestration/turn-budget.test.ts
bun run typecheck
```

Expected: identical inputs produce identical event arrays and digest; changed seed affects only seeded decisions/IDs; changed θ affects its owning decision.

- [ ] **Step 9: Correct the C3 documentation and commit**

Replace the old fingerprint-only C3 completion claim with:

```markdown
C3 proves deterministic, model-free policy trajectories over recorded fixture
inputs. It controls θ, PRNG, fixture identity, rollout time, and event IDs. It
does not claim live model/provider responses are deterministic; Phase D records
those outputs as stochastic rollout evidence.
```

```powershell
git add server-jarvis/src/orchestration/orchestration-policy.ts server-jarvis/src/orchestration/orchestration-policy.test.ts server-jarvis/src/orchestration/turn-budget.ts server-jarvis/src/self-tuning/conductor-learning.ts server-jarvis/src/self-tuning/conductor-learning.test.ts server-jarvis/src/self-tuning/policy-staging.ts server-jarvis/src/eval/policy-rollout.ts server-jarvis/src/eval/policy-rollout-fixtures.ts server-jarvis/src/eval/policy-rollout.test.ts docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md
git commit -m "feat(orchestration): execute deterministic policy rollouts"
```

---

### Task 4: Surface native write fingerprints on every pipeline result path

**Why:** The Tool runtime already records before/after content fingerprints in `ctx.write_effects`, but `PipelineResult` drops them. The production index can therefore persist only successful write-tool paths.

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts`
- Modify: `server-jarvis/src/orchestration/pipeline-telemetry.test.ts`
- Modify: `server-jarvis/src/orchestration/replan-loop.ts`
- Modify: `server-jarvis/src/orchestration/replan-loop.test.ts`
- Modify: `server-jarvis/src/orchestration/content-fingerprint.ts`

**Interfaces:**
- Adds: `writeEffects?: WriteEffectObservation[]` to `PipelineSegmentResult` and `PipelineResult`.
- Produces: `resetWriteEffectLedger()` and `snapshotWriteEffects()` on `PipelineExecutor`.
- Guarantees: one reset occurs at the start of a logical turn; replan/repair segments accumulate into the same ledger; every terminal result uses a defensive snapshot.

- [ ] **Step 1: Write failing direct-pipeline evidence tests**

Add to `pipeline-telemetry.test.ts` using the existing fake Tool runtime:

```ts
test("PipelineResult surfaces native write fingerprints", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "jarvis-write-effects-"));
  try {
    writeFileSync(join(workspace, "target.txt"), "before\n");
    const config = defaultConfig();
    config.jarvis_path = workspace;
    config.tools.enabled = true;
    config.tools.sandbox_mode = "workspace";
    config.claude_cli.delegate.enabled = false;
    const runtime = createToolRuntime();
    registerFilesystemBundle(runtime);
    const ctx = makeExecutionContext("chat", config, {
      workspace_path: workspace,
      requestApproval: async () => true,
    });
    const priorToolCalls = [{
      name: "read_file",
      arguments: { path: "target.txt" },
      output: "    1 | before",
      is_error: false,
      duration_ms: 1,
    }];
    let executorTurns = 0;
    const executor = new PipelineExecutor(
      async (_messages, options) => {
        if (options.stageLabel === "executor" && executorTurns++ === 0) {
          return {
            content: "apply edit",
            tool_calls: [toolCallWithArgs("edit_file", {
              path: "target.txt",
              old_string: "before",
              new_string: "after",
            })],
          };
        }
        if (options.stageLabel === "executor") return { content: "done" };
        if (options.stageLabel === "synthesizer") return { content: "Updated target.txt." };
        return { content: "unexpected" };
      },
      runtime,
      ctx,
      { recordStageRun: () => {} },
    );
    const result = await executor.execute(
      "Update target.txt",
      ["executor", "synthesizer"],
      "run-native-write-effects",
      () => {},
      {
        executionProfile: "full",
        rawMessage: "Update target.txt",
        taskRunWriteIntent: true,
        priorToolCalls,
      },
    );
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("after\n");
    expect(result.writeEffects).toHaveLength(1);
    expect(result.writeEffects?.[0]).toMatchObject({
      toolName: "edit_file",
      path: expect.stringContaining("target.txt"),
      changed: true,
    });
    expect(result.writeEffects?.[0]?.before.sha256)
      .not.toBe(result.writeEffects?.[0]?.after.sha256);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
```

Use the file/temp-runtime fixture already used by neighboring content-effect tests. The test must execute the canonical filesystem Tool handler; do not construct `writeEffects` by hand.

- [ ] **Step 2: Write failing replan/cancellation propagation tests**

Add to `replan-loop.test.ts`:

```ts
test("finalizeSegment preserves write effects", async () => {
  const effect = changedEffect("src/a.ts");
  const executor = {
    resetWriteEffectLedger: () => {},
    executeSegment: async () => ({
      state: {
        executor: { ok: true, narrative: "wrote file", toolCalls: [] },
      },
      synthesizerAnswer: "Change applied.",
      synthesizerEmptyCompletion: false,
      writeEffects: [effect],
    }),
  } as unknown as PipelineExecutor;
  const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
  const result = await runPipelineWithReplanning({
    contextMessage: "fix the bug",
    initialDecision: baseDecision({ pipeline: ["executor", "synthesizer"] }),
    turnRequirement: "full_execution",
    coordinator,
    routeOptions: { sessionId: "write-effects-finalize" },
    executor,
    agentRunId: "run-write-effects-finalize",
    onStateChange: () => {},
    baseOptions: {},
    maxReplans: 0,
  });
  expect(result.writeEffects).toEqual([effect]);
  expect(result.writeEffects?.[0]).not.toBe(effect);
});

test("cancelled result still carries landed write evidence", async () => {
  const effect = changedEffect("src/a.ts");
  const executor = {
    resetWriteEffectLedger: () => {},
    executeSegment: async () => ({
      state: {
        executor: {
          ok: false,
          narrative: "cancelled after write",
          toolCalls: [],
          terminalStatus: "cancelled" as const,
          errorCode: "delegate_aborted",
        },
      },
      writeEffects: [effect],
    }),
  } as unknown as PipelineExecutor;
  const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
  const result = await runPipelineWithReplanning({
    contextMessage: "fix then stop",
    initialDecision: baseDecision({ pipeline: ["executor", "synthesizer"] }),
    turnRequirement: "full_execution",
    coordinator,
    routeOptions: { sessionId: "write-effects-cancelled" },
    executor,
    agentRunId: "run-write-effects-cancelled",
    onStateChange: () => {},
    baseOptions: {},
    maxReplans: 0,
  });
  expect(result.cancelled).toBe(true);
  expect(result.writeEffects).toEqual([effect]);
});
```

Define `changedEffect(path)` in the test file to return a `WriteEffectObservation` whose `before.sha256` is `"a".repeat(64)`, `after.sha256` is `"b".repeat(64)`, both files exist, and `changed` is true.

- [ ] **Step 3: Run pipeline/replan tests and verify evidence is absent**

```powershell
cd server-jarvis
bun test src/orchestration/pipeline-telemetry.test.ts src/orchestration/replan-loop.test.ts
```

Expected: new assertions fail because result types/objects do not expose write effects.

- [ ] **Step 4: Add explicit logical-turn ledger methods**

In `PipelineExecutor`:

```ts
resetWriteEffectLedger(): void {
  this.ctx.write_effects = [];
}

snapshotWriteEffects(): WriteEffectObservation[] {
  return (this.ctx.write_effects ?? []).map((effect) => ({
    ...effect,
    before: { ...effect.before },
    after: { ...effect.after },
  }));
}
```

Call `resetWriteEffectLedger()` once at the start of `execute()`. For the production replan path, call it once at the start of `runPipelineWithReplanning` before its first `executeSegment`; do not reset on later segments:

```ts
args.executor.resetWriteEffectLedger?.();
```

Optional invocation preserves the existing structurally mocked `PipelineExecutor` objects in replan unit tests; the production class always implements the method.

- [ ] **Step 5: Put snapshots on segment and result boundaries**

Add `writeEffects: this.snapshotWriteEffects()` to `executeSegment`'s `finish(...)` output and every direct `PipelineResult` return. In `finalizeSegment`, define:

```ts
const evidenceFields = {
  toolCalls: segment.state.executor?.toolCalls,
  writeEffects: (segment.writeEffects ?? []).map((effect) => ({
    ...effect,
    before: { ...effect.before },
    after: { ...effect.after },
  })),
  checkResult: segment.checkResult,
  reviewerAccepted: segment.reviewerAccepted,
};
```

Spread `evidenceFields` into success, partial, failed, cancellation, cleanup-failure, and no-synthesizer returns. Keep effects even when the final outcome is failed; reward decides whether they earn credit.

- [ ] **Step 6: Run focused pipeline tests and typecheck**

```powershell
cd server-jarvis
bun test src/orchestration/content-fingerprint.test.ts src/orchestration/pipeline-telemetry.test.ts src/orchestration/replan-loop.test.ts
bun run typecheck
```

Expected: native before/after hashes reach both direct and production-style results, with no cross-turn leakage.

- [ ] **Step 7: Commit Task 4**

```powershell
git add server-jarvis/src/orchestration/content-fingerprint.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/pipeline-telemetry.test.ts server-jarvis/src/orchestration/replan-loop.ts server-jarvis/src/orchestration/replan-loop.test.ts
git commit -m "feat(orchestration): surface pipeline write fingerprints"
```

---

### Task 5: Convert delegate snapshots and persist fingerprint-only live reward evidence

**Why:** Delegate writes bypass native filesystem handlers, while live reward currently falls back to successful tool-call paths whenever effects are empty. Both paths need conservative ground truth.

**Files:**
- Modify: `server-jarvis/src/orchestration/claude-delegate.ts`
- Modify: `server-jarvis/src/orchestration/claude-delegate.test.ts`
- Modify: `server-jarvis/src/orchestration/stage-output.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts`
- Modify: `server-jarvis/src/orchestration/pipeline-delegate.test.ts`
- Modify: `server-jarvis/src/orchestration/run-reward.ts`
- Modify: `server-jarvis/src/orchestration/run-reward.test.ts`
- Create: `server-jarvis/src/orchestration/live-reward-evidence.ts`
- Create: `server-jarvis/src/orchestration/live-reward-evidence.test.ts`
- Modify: `server-jarvis/src/index.ts`
- Modify: `docs/PHASE_B_RUN_REWARD_ANTI_GAMING.md`

**Interfaces:**
- Adds: `writeEffects?: WriteEffectObservation[]` to `ExecutorStageOutput`.
- Produces: `delegateSnapshotWriteEffects(before, after, records): WriteEffectObservation[]`.
- Extends: `StoredRunRewardSnapshot` with `writeEvidenceSource: "fingerprints" | "legacy_tool_calls"`.
- Changes: an explicitly supplied empty `effects: []` means “fingerprint ledger observed no delta” and never falls back to tool calls.
- Produces: `buildLiveRunRewardSnapshot(input)` whose type requires `effects` and exposes no `toolCalls` field.
- Changes: live `index.ts` calls `buildLiveRunRewardSnapshot` with `result.writeEffects ?? []`.

- [ ] **Step 1: Write failing delegate snapshot conversion tests**

Add to `claude-delegate.test.ts`:

```ts
test("delegate snapshot diff produces cryptographic write effects", () => {
  const path = "c:\\repo\\claimed.ts";
  const before = [{
    root: "C:\\repo", kind: "git" as const, status: "", diffStat: "",
    fingerprint: "before", files: { [path]: `sha256:${"a".repeat(64)}` },
  }];
  const after = [{
    root: "C:\\repo", kind: "git" as const, status: " M claimed.ts", diffStat: "",
    fingerprint: "after", files: { [path]: `sha256:${"b".repeat(64)}` },
  }];
  const effects = delegateSnapshotWriteEffects(before, after, [{
    name: "edit_file", arguments: { path }, output: "ok", is_error: false, duration_ms: 1,
  }]);
  expect(effects).toEqual([expect.objectContaining({
    toolName: "edit_file", path, changed: true,
    before: expect.objectContaining({ sha256: "a".repeat(64), exists: true }),
    after: expect.objectContaining({ sha256: "b".repeat(64), exists: true }),
  })]);
});

test("unverified tool narration does not create a delegate write effect", () => {
  const root = [{
    root: "C:\\repo", kind: "git" as const, status: "", diffStat: "",
    fingerprint: "same", files: {},
  }];
  expect(delegateSnapshotWriteEffects(root, root, [{
    name: "write_file", arguments: { path: "C:\\repo\\claimed.ts" },
    output: "success", is_error: false, duration_ms: 1,
  }])).toEqual([]);
});
```

- [ ] **Step 2: Write failing reward-source tests**

Add to `run-reward.test.ts`:

```ts
test("explicit empty fingerprint ledger never falls back to successful tool calls", () => {
  const snapshot = buildStoredRunRewardSnapshot({
    writeRequired: true,
    effects: [],
    toolCalls: [{
      name: "write_file", is_error: false,
      arguments: { path: "src/a.ts" },
    }],
    check: { tier: "existing", ran: true, passed: true },
  });
  expect(snapshot.writeEvidenceSource).toBe("fingerprints");
  expect(snapshot.changedPaths).toEqual([]);
  expect(computeRunRewardFromStored(snapshot).terms.writes).toBe(0);
});

test("legacy snapshot fallback is explicitly labeled", () => {
  const snapshot = buildStoredRunRewardSnapshot({
    writeRequired: true,
    toolCalls: [{
      name: "write_file", is_error: false,
      arguments: { path: "src/a.ts" },
    }],
    check: { tier: "existing", ran: true, passed: true },
  });
  expect(snapshot.writeEvidenceSource).toBe("legacy_tool_calls");
  expect(snapshot.changedPaths).toEqual(["src/a.ts"]);
});
```

- [ ] **Step 3: Run delegate/reward tests and verify both unsafe fallbacks remain**

```powershell
cd server-jarvis
bun test src/orchestration/claude-delegate.test.ts src/orchestration/run-reward.test.ts
```

Expected: delegate converter is missing and empty effects still cause tool-call credit.

- [ ] **Step 4: Convert delegate file identities into content fingerprints**

Implement helpers in `claude-delegate.ts`:

```ts
function fingerprintFromDelegateIdentity(path: string, identity: string | undefined): ContentFingerprint {
  if (!identity || identity === "missing") {
    return { path, exists: false, bytes: 0, sha256: null };
  }
  const match = /^sha256:([a-f0-9]{64})$/i.exec(identity);
  return {
    path,
    exists: true,
    bytes: 0,
    sha256: match?.[1]?.toLowerCase() ?? createHash("sha256").update(identity).digest("hex"),
  };
}

export function delegateSnapshotWriteEffects(
  before: readonly DelegateRootSnapshot[],
  after: readonly DelegateRootSnapshot[],
  records: readonly ToolCallRecord[],
): WriteEffectObservation[];
```

Build maps over every normalized file path in `before.files` and `after.files`. Emit only paths whose identity changed or whose existence changed. Resolve `toolName` from the successful write record with the same normalized path; use `"delegate"` only for a verified unlocalized changed path. Do not emit root-level fingerprint-only changes when no changed file can be localized; keep those as delegate verification evidence, not Phase B write-path credit.

- [ ] **Step 5: Carry delegate effects into the shared pipeline ledger**

Add `writeEffects` to `ExecutorStageOutput`. Every successful/partial delegate return after the post-run snapshot includes:

```ts
writeEffects: delegateSnapshotWriteEffects(before, after, records),
```

When `pipeline.ts` accepts a delegate result, append defensive copies to the logical-turn ledger before returning or handing off:

```ts
for (const effect of delegated.writeEffects ?? []) {
  this.ctx.write_effects?.push({
    ...effect,
    before: { ...effect.before },
    after: { ...effect.after },
  });
}
```

Add a `pipeline-delegate.test.ts` case proving a delegate-changed path reaches `PipelineResult.writeEffects` exactly once.

- [ ] **Step 6: Make reward evidence source explicit and conservative**

In `buildStoredRunRewardSnapshot`, distinguish omitted effects from an observed empty ledger:

```ts
const hasFingerprintLedger = input.effects !== undefined && input.effects !== null;
const writes = hasFingerprintLedger
  ? writeEvidenceFromEffects(input.effects ?? [], {
      targetPaths: input.targetPaths,
      writeRequired: input.writeRequired,
    })
  : writeEvidenceFromToolCalls(input.toolCalls ?? [], {
      targetPaths: input.targetPaths,
      writeRequired: input.writeRequired,
    });

return {
  writeRequired: input.writeRequired,
  changedPaths: writes.changedPaths,
  writeEvidenceSource: hasFingerprintLedger ? "fingerprints" : "legacy_tool_calls",
  targetPaths: input.targetPaths,
  check: input.check,
  plan: input.plan ?? null,
  declaredOutcome: input.declaredOutcome ?? null,
};
```

`computeRunRewardFromStored` accepts older rows without `writeEvidenceSource` as legacy replay data. New live rows always serialize the explicit field.

- [ ] **Step 7: Create a typed fingerprint-only live reward boundary**

Create `live-reward-evidence.ts`:

```ts
import type { WriteEffectObservation } from "./content-fingerprint";
import type { CheckResult } from "./check-runner";
import {
  buildStoredRunRewardSnapshot,
  type DeclaredRunOutcome,
  type RunRewardPlanEvidence,
  type StoredRunRewardSnapshot,
} from "./run-reward";

export interface LiveRunRewardSnapshotInput {
  writeRequired: boolean;
  effects: readonly WriteEffectObservation[];
  targetPaths?: string[];
  check: Pick<CheckResult, "tier" | "ran" | "passed"> | null;
  plan?: RunRewardPlanEvidence | null;
  declaredOutcome?: DeclaredRunOutcome | null;
}

export function buildLiveRunRewardSnapshot(
  input: LiveRunRewardSnapshotInput,
): StoredRunRewardSnapshot {
  const snapshot = buildStoredRunRewardSnapshot(input);
  if (snapshot.writeEvidenceSource !== "fingerprints") {
    throw new Error("live reward snapshot requires fingerprint evidence");
  }
  return snapshot;
}
```

The interface intentionally has no `toolCalls` member, making fallback use a TypeScript error at the live boundary.

- [ ] **Step 8: Switch the live index reward path to the typed boundary**

Replace the live snapshot call with:

```ts
const runRewardSnapshot = buildLiveRunRewardSnapshot({
  writeRequired: writeRequiredForReward,
  effects: result.writeEffects ?? [],
  targetPaths: rewardTargetPaths,
  check: result.checkResult
    ? { tier: result.checkResult.tier, ran: result.checkResult.ran, passed: result.checkResult.passed }
    : null,
  plan: planEvidenceFromItems(latestTaskRun.plan?.items),
  declaredOutcome: verifiedRunOutcome,
});
```

Keep successful tool calls for task-run evidence counts and continuation targets; those are operational progress signals, not scalar write reward.

- [ ] **Step 9: Add a live-boundary persistence assertion**

Create `live-reward-evidence.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildLiveRunRewardSnapshot } from "./live-reward-evidence";
import type { WriteEffectObservation } from "./content-fingerprint";

function effect(path: string, changed: boolean): WriteEffectObservation {
  return {
    toolName: "edit_file",
    path,
    before: { path, exists: true, bytes: 3, sha256: "a".repeat(64) },
    after: {
      path,
      exists: true,
      bytes: 3,
      sha256: changed ? "b".repeat(64) : "a".repeat(64),
    },
    changed,
  };
}

describe("live reward evidence", () => {
  test("credits only changed fingerprint paths", () => {
    const snapshot = buildLiveRunRewardSnapshot({
      writeRequired: true,
      effects: [effect("src/changed.ts", true), effect("src/same.ts", false)],
      check: { tier: "existing", ran: true, passed: true },
    });
    expect(snapshot.writeEvidenceSource).toBe("fingerprints");
    expect(snapshot.changedPaths).toEqual(["src/changed.ts"]);
  });

  test("an observed empty ledger remains empty", () => {
    const snapshot = buildLiveRunRewardSnapshot({
      writeRequired: true,
      effects: [],
      check: { tier: "existing", ran: true, passed: true },
    });
    expect(snapshot.writeEvidenceSource).toBe("fingerprints");
    expect(snapshot.changedPaths).toEqual([]);
  });
});
```

Add a source assertion to the test that reads `index.ts` and expects it to contain `buildLiveRunRewardSnapshot({` and not contain `buildStoredRunRewardSnapshot({` in the live completion block.

```ts
import { readFileSync } from "fs";
import { resolve } from "path";

test("index uses the fingerprint-only live boundary", () => {
  const source = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");
  expect(source).toContain("buildLiveRunRewardSnapshot({");
  expect(source).not.toContain("buildStoredRunRewardSnapshot({");
});
```

- [ ] **Step 10: Run delegate, pipeline, reward, and live-boundary gates**

```powershell
cd server-jarvis
bun test src/orchestration/claude-delegate.test.ts src/orchestration/pipeline-delegate.test.ts src/orchestration/pipeline-telemetry.test.ts src/orchestration/replan-loop.test.ts src/orchestration/run-reward.test.ts src/orchestration/live-reward-evidence.test.ts
bun run typecheck
```

Expected: native and delegate content deltas persist; successful tool narration without a delta earns no write term.

- [ ] **Step 11: Document and commit Task 5**

Update `PHASE_B_RUN_REWARD_ANTI_GAMING.md` to state that new live runs always use `writeEvidenceSource="fingerprints"`; `legacy_tool_calls` exists only to replay historical snapshots that predate effect plumbing.

```powershell
git add server-jarvis/src/orchestration/claude-delegate.ts server-jarvis/src/orchestration/claude-delegate.test.ts server-jarvis/src/orchestration/stage-output.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/pipeline-delegate.test.ts server-jarvis/src/orchestration/run-reward.ts server-jarvis/src/orchestration/run-reward.test.ts server-jarvis/src/orchestration/live-reward-evidence.ts server-jarvis/src/orchestration/live-reward-evidence.test.ts server-jarvis/src/index.ts docs/PHASE_B_RUN_REWARD_ANTI_GAMING.md
git commit -m "fix(orchestration): persist fingerprinted write reward evidence"
```

---

### Task 6: Run the Phase C completion-integrity gate

**Why:** Findings 5-8 interact: rollout execution is meaningful only if θ is live and valid, and optimization is meaningful only if live rewards contain trustworthy effects.

**Files:**
- Verify only: all files changed in Tasks 1-5

**Interfaces:**
- Consumes: audited constrained θ, deterministic policy runner, and fingerprint-only live reward evidence.
- Produces: fresh proof that these four findings are closed without beginning Phase D.

- [ ] **Step 1: Run source-level policy audits**

```powershell
cd server-jarvis
bun test src/orchestration/orchestration-policy-coverage.test.ts
rg -n "policy_canary_traffic_fraction|policy_min_canary_success_rate|policy_min_eligible_outcomes_before_shadow|policy_min_canary_runs_before_promotion" src/orchestration/orchestration-policy.ts src/orchestration/orchestration-policy-schema.ts
rg -n "= BASELINE_THETA\." src/orchestration src/self-tuning --glob "!**/*.test.ts"
```

Expected:

- Coverage test passes for every `THETA_KEYS` entry.
- Governance-key search finds no θ/schema entries.
- Baseline aliases may remain as exported compatibility constants, but live decision branches identified by `THETA_DECISION_OWNERS` use `policy()`.

- [ ] **Step 2: Run the complete focused regression set**

```powershell
cd server-jarvis
bun test src/orchestration/orchestration-policy.test.ts src/orchestration/orchestration-policy-coverage.test.ts src/eval/policy-rollout.test.ts src/self-tuning/policy-staging.test.ts src/self-tuning/conductor-learning.test.ts src/orchestration/turn-budget.test.ts src/orchestration/model-scorecard.test.ts src/orchestration/runtime-loop.test.ts src/orchestration/dead-tool-suppression.test.ts src/orchestration/content-fingerprint.test.ts src/orchestration/claude-delegate.test.ts src/orchestration/pipeline-delegate.test.ts src/orchestration/pipeline-telemetry.test.ts src/orchestration/replan-loop.test.ts src/orchestration/run-reward.test.ts src/orchestration/live-reward-evidence.test.ts
```

Expected: zero failures.

- [ ] **Step 3: Prove deterministic trajectories in a standalone invocation**

Add this `--json` main guard to `policy-rollout.ts`:

```ts
if (import.meta.main) {
  const args = process.argv.slice(2);
  const valueAfter = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const fixtureId = valueAfter("--fixture") ?? "completion_integrity_mixed";
  const seed = Number(valueAfter("--seed") ?? "17");
  if (!Number.isInteger(seed)) throw new Error(`invalid integer seed: ${seed}`);
  const fixture = POLICY_ROLLOUT_FIXTURES.find((item) => item.id === fixtureId);
  if (!fixture) throw new Error(`unknown policy rollout fixture: ${fixtureId}`);
  const result = runPolicyRollout(
    { theta: BASELINE_THETA, seed, fixtureId },
    fixture,
  );
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      `fixture=${fixtureId} seed=${seed} trajectory=${result.trajectoryDigest}\n`,
    );
  }
}
```

Then run the same fixture twice:

```powershell
cd server-jarvis
$first = bun run src/eval/policy-rollout.ts --fixture completion_integrity_mixed --seed 17 --json
$second = bun run src/eval/policy-rollout.ts --fixture completion_integrity_mixed --seed 17 --json
if ($first -cne $second) { throw 'policy rollout output was not byte-identical' }
$first
```

Expected: byte-identical canonical JSON containing the same rollout fingerprint, trajectory digest, θ fingerprint, and ordered events.

- [ ] **Step 4: Run the complete Bun server suite**

```powershell
cd server-jarvis
bun test src
```

Expected: zero failures. Record the fresh test/file/expectation counts in the handoff.

- [ ] **Step 5: Run typecheck and patch hygiene**

```powershell
cd server-jarvis
bun run typecheck
cd ..
git diff --check
git status --short
git log -7 --oneline
```

Expected: clean typecheck and whitespace check. Status preserves the user-owned `.claude/launch.json` modification and pre-existing untracked documents unless separately authorized.

- [ ] **Step 6: Verify a live snapshot fixture uses fingerprint evidence**

Run the index-level test alone once more so its output is fresh and easy to cite:

```powershell
cd server-jarvis
bun test src/orchestration/live-reward-evidence.test.ts
```

Expected: the persisted snapshot is labeled `fingerprints`, contains only changed fingerprint paths, and does not credit the unrelated successful write call.

- [ ] **Step 7: Stop at the Phase C boundary**

Do not execute CMA-ES, propose/promote a candidate, deploy Jarvis, or claim Phase A live fixture completion. The handoff must say:

- Findings 5-8 are source/test complete.
- Phase C deterministic model-free exit proof is complete.
- Phase A live fixture measurement and any Phase D stochastic rollout program remain separate work.

---

## Self-Review Coverage

| Review finding | Covered by | Proof gate |
|---|---|---|
| 5. Policy vector is incomplete or baseline-only | Task 1 | Every inventory-approved θ key has an audited live `policy().key` owner; governance exclusions are explicit. |
| 6. θ accepts unsafe values | Task 2 | Manual/staged inputs reject; optimizer vectors project; cross-field invariants hold. |
| 7. C3 is fingerprint scaffolding, not trajectory replay | Task 3 | Same validated θ/seed/fixture yields byte-identical ordered events and digest. |
| 8. Live reward uses tool-call fallback | Tasks 4-5 | Native/delegate fingerprints reach `PipelineResult`; live stored snapshots are fingerprint-labeled and never tool-fallback. |

No task in this plan starts the optimizer, changes the Rust/Tauri or UI layers, deploys a runtime, or promotes a canary.
