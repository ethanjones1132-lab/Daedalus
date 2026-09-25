/**
 * Freshness contracts for operational inference feedback.
 *
 * The learned-pool maps are seeded once per process by
 * `loadInferenceFeedback()` at module scope (`server-jarvis/src/index.ts`) and
 * are only reloaded by the six-hourly cron refresh. A producer that never runs
 * (cron disabled, host asleep, missing `JARVIS_PYTHON_BIN`, non-zero exit)
 * therefore leaves one measurement steering live routing forever. These
 * contracts pin that a learned value carries its own deadline: once the clock
 * passes it, no reader — routing score, stage score, first-token budget, or
 * capability — may return it, and the confirmed-success path (a still-valid
 * policy re-applied by a successful refresh) keeps working.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentPool, firstTokenTimeoutFor, type OrchestratorAgent } from "../orchestration/agent-pool";
import { applyInferenceFeedback } from "./inference-feedback";
import { refreshInferenceFeedback } from "./inference-feedback-refresh";
import {
  applyLearnedCapabilities,
  applyPolicySnapshotToPool,
  empiricalFirstTokenTimeoutFor,
  getLearnedPoolState,
  inferenceFeedbackExpiryFor,
  isLearnedValueFresh,
  modelRoutingScoreDelta,
  modelFeedbackKey,
  resetLearnedPoolStateForTests,
  runWithPolicyOverlay,
  setLearnedPoolClockForTests,
  snapshotStagedPolicyFields,
  stageModelFeedbackKey,
  stageRoutingScoreDelta,
  type PolicySnapshot,
} from "./learned-pool-state";
import {
  getPolicyVersionStore,
  resetPolicyStagingForTests,
  type PolicyVersion,
} from "./policy-staging";

const T0 = Date.parse("2026-07-10T12:00:00.000Z");
const HOUR = 3_600_000;

let nowMs = T0;

const slowModel: OrchestratorAgent = {
  id: "slow-model",
  provider: "openrouter",
  model_id: "slow-model",
  capabilities: { code: 0.9, reasoning: 0.95, speed: 0.8, cost: 1, json_reliability: 0.9 },
  default_for: ["synthesizer"],
  enabled: true,
  first_token_timeout_ms: 25_000,
};

const fastModel: OrchestratorAgent = {
  id: "fast-model",
  provider: "openrouter",
  model_id: "fast-model",
  capabilities: { code: 0.8, reasoning: 0.82, speed: 0.9, cost: 1, json_reliability: 0.85 },
  default_for: [],
  enabled: true,
};

const cronKey = modelFeedbackKey("openrouter", "slow-model");
const cronStageKey = stageModelFeedbackKey("openrouter", "slow-model", "synthesizer");

function policy(expiresAt: string, firstToken = 42_000) {
  return {
    schema_version: 1,
    generated_at: "2026-07-10T00:00:00.000Z",
    expires_at: expiresAt,
    routing_policy: {
      min_samples: 5,
      model_adjustments: {
        [cronKey]: {
          sample_count: 12,
          routing_score_delta: -0.25,
          speed_capability_delta: -0.15,
          reliability_capability_delta: -0.1,
          first_token_timeout_ms: firstToken,
        },
        [modelFeedbackKey("openrouter", "fast-model")]: {
          sample_count: 10,
          routing_score_delta: 0.15,
          speed_capability_delta: 0.05,
          reliability_capability_delta: 0.05,
          first_token_timeout_ms: 18_000,
        },
      },
      stage_adjustments: {
        [cronStageKey]: { sample_count: 5, routing_score_delta: -0.25 },
      },
    },
  };
}

function emptySnapshot(overrides: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    modelRoutingScoreDeltas: {},
    stageModelRoutingScoreDeltas: {},
    fallbackBoosts: {},
    modelFirstTokenTimeouts: {},
    recovery: {},
    ...overrides,
  };
}

function seedProductionSnapshot(snapshot: PolicySnapshot, id: string): void {
  applyPolicySnapshotToPool(snapshot);
  const production: PolicyVersion = {
    id,
    version: 1,
    stage: "production",
    domain: "routing",
    snapshot,
    patch: { domain: "routing", modelRoutingScoreDeltas: snapshot.modelRoutingScoreDeltas },
    rationale: "seeded for freshness durability test",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    eligibleOutcomes: 0,
    eligibleSuccessCount: 0,
    eligibleFailureCount: 0,
    history: [],
  };
  getPolicyVersionStore().production = production;
}

function applyAt(value: unknown): { applied: number; ignored: number; reason?: string; expiresAt?: string } {
  return applyInferenceFeedback(value, { now: new Date(nowMs) });
}

function runRefresh(
  exitCode: number,
  loadPolicy?: (path: string) => ReturnType<typeof applyInferenceFeedback>,
): ReturnType<typeof refreshInferenceFeedback> {
  return refreshInferenceFeedback({
    scriptPath: "/tmp/automate_inference_metrics.py",
    runCommand: async () => ({ exitCode, stdout: "producer output", stderr: exitCode === 0 ? "" : "boom" }),
    loadPolicy,
    paths: { python: "python", dbPath: "db", reportsPath: "reports", policyPath: "policy" },
  });
}

describe("inference-feedback value freshness", () => {
  beforeEach(() => {
    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
    nowMs = T0;
    setLearnedPoolClockForTests(() => nowMs);
  });

  afterEach(() => {
    setLearnedPoolClockForTests(null);
  });

  test("a still-valid policy is applied, reports its expiry, and is honoured on read", () => {
    const result = applyAt(policy("2026-07-12T00:00:00.000Z"));
    expect(result.applied).toBe(3);
    expect(result.ignored).toBe(0);
    expect(result.reason).toBeUndefined();
    expect(result.expiresAt).toBe("2026-07-12T00:00:00.000Z");

    expect(modelRoutingScoreDelta(slowModel)).toBeCloseTo(-0.25);
    expect(stageRoutingScoreDelta(slowModel, "synthesizer")).toBeCloseTo(-0.25);
    expect(empiricalFirstTokenTimeoutFor("slow-model", "openrouter")).toBe(42_000);
    const adjusted = applyLearnedCapabilities(slowModel);
    expect(adjusted.capabilities.speed).toBeCloseTo(0.65);
    expect(adjusted.capabilities.json_reliability).toBeCloseTo(0.8);
  });

  test("the expiry boundary is the same instant the loader already enforced", () => {
    const expiresAt = "2026-07-10T13:00:00.000Z";
    applyAt(policy(expiresAt));
    const deadline = Date.parse(expiresAt);

    nowMs = deadline - 1;
    expect(modelRoutingScoreDelta(slowModel)).toBeCloseTo(-0.25);
    expect(empiricalFirstTokenTimeoutFor("slow-model", "openrouter")).toBe(42_000);

    nowMs = deadline;
    expect(modelRoutingScoreDelta(slowModel)).toBe(0);
    expect(empiricalFirstTokenTimeoutFor("slow-model", "openrouter")).toBeUndefined();

    // The pure decision agrees at both sides of the boundary and fails closed
    // on an unusable deadline.
    expect(isLearnedValueFresh(deadline, deadline - 1)).toBe(true);
    expect(isLearnedValueFresh(deadline, deadline)).toBe(false);
    expect(isLearnedValueFresh(deadline, deadline + 1)).toBe(false);
    expect(isLearnedValueFresh(undefined, deadline + 1)).toBe(true);
    expect(isLearnedValueFresh(Number.NaN, deadline)).toBe(false);
  });

  test("a clock past expires_at releases every learned reader", () => {
    applyAt(policy("2026-07-10T13:00:00.000Z"));
    nowMs = Date.parse("2026-07-10T13:00:00.000Z") + 1;

    expect(modelRoutingScoreDelta(slowModel)).toBe(0);
    expect(stageRoutingScoreDelta(slowModel, "synthesizer")).toBe(0);
    expect(empiricalFirstTokenTimeoutFor("slow-model", "openrouter")).toBeUndefined();
    expect(empiricalFirstTokenTimeoutFor("slow-model")).toBeUndefined();
    expect(applyLearnedCapabilities(slowModel)).toBe(slowModel);

    // The released entries are gone from the maps themselves, not just hidden
    // behind a reader, so a later snapshot cannot re-persist them.
    const state = getLearnedPoolState();
    expect(state.modelRoutingScoreDeltas.has(cronKey)).toBe(false);
    expect(state.stageModelRoutingScoreDeltas.has(cronStageKey)).toBe(false);
    expect(state.modelFirstTokenTimeouts.has(cronKey)).toBe(false);
    expect(state.modelCapabilityDeltas.has(cronKey)).toBe(false);
  });

  test("the ledger records one deadline per accepted value and drops it on release", () => {
    const deadline = Date.parse("2026-07-10T13:00:00.000Z");
    applyAt(policy("2026-07-10T13:00:00.000Z"));
    expect(inferenceFeedbackExpiryFor("modelRoutingScoreDeltas", cronKey)).toBe(deadline);
    expect(inferenceFeedbackExpiryFor("stageModelRoutingScoreDeltas", cronStageKey)).toBe(deadline);
    expect(inferenceFeedbackExpiryFor("modelFirstTokenTimeouts", cronKey)).toBe(deadline);
    expect(inferenceFeedbackExpiryFor("modelCapabilityDeltas", cronKey)).toBe(deadline);
    // A promoted key is no longer the cron measurement, so it carries no
    // report deadline and is never released by one.
    expect(inferenceFeedbackExpiryFor("modelRoutingScoreDeltas", "openrouter:promoted")).toBeUndefined();

    nowMs = deadline + 1;
    modelRoutingScoreDelta(slowModel);
    expect(inferenceFeedbackExpiryFor("modelRoutingScoreDeltas", cronKey)).toBeUndefined();
    expect(inferenceFeedbackExpiryFor("stageModelRoutingScoreDeltas", cronStageKey)).toBe(deadline);
  });

  test("a released first-token budget falls back to the configured override, then the default", () => {
    const pool = new AgentPool([slowModel, fastModel]);
    applyAt(policy("2026-07-10T13:00:00.000Z"));
    // Empirical wins while the measurement is still valid.
    expect(firstTokenTimeoutFor(pool, "slow-model", 30_000, 60_000, "openrouter")).toBe(42_000);

    nowMs = Date.parse("2026-07-10T13:00:00.000Z") + 1;
    // Configured override for the same model.
    expect(firstTokenTimeoutFor(pool, "slow-model", 30_000, 60_000, "openrouter")).toBe(25_000);
    // No override anywhere: the caller's configured base budget, not the
    // released measurement and not an unbounded value.
    expect(firstTokenTimeoutFor(pool, "fast-model", 30_000, 60_000, "openrouter")).toBe(30_000);
    // The cap still wins over the configured base budget.
    expect(firstTokenTimeoutFor(pool, "fast-model", 30_000, 20_000, "openrouter")).toBe(20_000);
  });

  test("a value with no recorded deadline never expires", () => {
    const state = getLearnedPoolState();
    state.modelRoutingScoreDeltas.set(cronKey, -0.25);
    state.modelFirstTokenTimeouts.set(cronKey, 42_000);
    nowMs = T0 + 365 * 24 * HOUR;
    expect(modelRoutingScoreDelta(slowModel)).toBeCloseTo(-0.25);
    expect(empiricalFirstTokenTimeoutFor("slow-model", "openrouter")).toBe(42_000);
  });

  test("a promoted key written after cron feedback is not governed by the cron deadline", () => {
    applyAt(policy("2026-07-10T13:00:00.000Z"));
    seedProductionSnapshot(
      emptySnapshot({ modelRoutingScoreDeltas: { [cronKey]: 0.2 }, modelFirstTokenTimeouts: { [cronKey]: 33_000 } }),
      "pv-promoted-over-cron",
    );

    nowMs = Date.parse("2026-07-10T13:00:00.000Z") + 1;
    expect(modelRoutingScoreDelta(slowModel)).toBeCloseTo(0.2);
    expect(empiricalFirstTokenTimeoutFor("slow-model", "openrouter")).toBe(33_000);
  });

  test("a released key is not captured into a production snapshot", () => {
    applyAt(policy("2026-07-10T13:00:00.000Z"));
    const promotedKey = modelFeedbackKey("openrouter", "fast-model");
    seedProductionSnapshot(emptySnapshot({ modelRoutingScoreDeltas: { [promotedKey]: 0.05 } }), "pv-snapshot");

    const stillValid = snapshotStagedPolicyFields();
    expect(stillValid.modelRoutingScoreDeltas[cronKey]).toBeCloseTo(-0.25);
    expect(stillValid.stageModelRoutingScoreDeltas[cronStageKey]).toBeCloseTo(-0.25);
    expect(stillValid.modelFirstTokenTimeouts[cronKey]).toBe(42_000);
    expect(stillValid.modelRoutingScoreDeltas[promotedKey]).toBeCloseTo(0.05);

    nowMs = Date.parse("2026-07-10T13:00:00.000Z") + 1;
    const afterDeadline = snapshotStagedPolicyFields();
    expect(Object.prototype.hasOwnProperty.call(afterDeadline.modelRoutingScoreDeltas, cronKey)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(afterDeadline.stageModelRoutingScoreDeltas, cronStageKey)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(afterDeadline.modelFirstTokenTimeouts, cronKey)).toBe(false);
    expect(afterDeadline.modelRoutingScoreDeltas[promotedKey]).toBeCloseTo(0.05);
  });

  test("a canary overlay arm is unaffected by the global cron deadline", () => {
    applyAt(policy("2026-07-10T13:00:00.000Z"));
    const overlay = emptySnapshot({ modelFirstTokenTimeouts: { [cronKey]: 33_000 } });
    nowMs = Date.parse("2026-07-10T13:00:00.000Z") + 1;
    expect(runWithPolicyOverlay(overlay, () => empiricalFirstTokenTimeoutFor("slow-model", "openrouter"))).toBe(33_000);
  });

  test("an unparsable deadline is rejected at load and leaves nothing behind", () => {
    expect(applyAt(policy("not-a-date")).reason).toBe("expired");
    expect(applyAt({ ...policy("2026-07-12T00:00:00.000Z"), expires_at: undefined }).reason).toBe("expired");
    nowMs = T0 + HOUR;
    expect(modelRoutingScoreDelta(slowModel)).toBe(0);
    expect(empiricalFirstTokenTimeoutFor("slow-model", "openrouter")).toBeUndefined();
  });

  test("the write-time first-token clamp is preserved and cannot outlive the deadline", () => {
    applyAt(policy("2026-07-10T13:00:00.000Z", 400));
    expect(empiricalFirstTokenTimeoutFor("slow-model", "openrouter")).toBe(1_000);
    nowMs = Date.parse("2026-07-10T13:00:00.000Z") + 1;
    expect(empiricalFirstTokenTimeoutFor("slow-model", "openrouter")).toBeUndefined();
  });
});

describe("inference-feedback refresh against a moving clock", () => {
  beforeEach(() => {
    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
    nowMs = T0;
    setLearnedPoolClockForTests(() => nowMs);
  });

  afterEach(() => {
    setLearnedPoolClockForTests(null);
  });

  test("a failed producer refresh does not leave an expired policy in force", async () => {
    applyAt(policy("2026-07-10T13:00:00.000Z"));
    const promotedKey = modelFeedbackKey("openrouter", "fast-model");
    seedProductionSnapshot(emptySnapshot({ modelRoutingScoreDeltas: { [promotedKey]: 0.2 } }), "pv-survives-failure");
    nowMs = Date.parse("2026-07-10T13:00:00.000Z") + 1;

    let loadPolicyCalls = 0;
    const result = await runRefresh(1, (path) => {
      loadPolicyCalls += 1;
      return applyAt(policy("2026-07-11T13:00:00.000Z"));
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
    expect(loadPolicyCalls).toBe(0);
    expect(modelRoutingScoreDelta(slowModel)).toBe(0);
    expect(stageRoutingScoreDelta(slowModel, "synthesizer")).toBe(0);
    expect(empiricalFirstTokenTimeoutFor("slow-model", "openrouter")).toBeUndefined();
    const pool = new AgentPool([slowModel, fastModel]);
    expect(firstTokenTimeoutFor(pool, "slow-model", 30_000, 60_000, "openrouter")).toBe(25_000);
    // Promoted production policy is untouched by an unrelated producer failure.
    expect(modelRoutingScoreDelta(fastModel)).toBeCloseTo(0.2);
  });

  test("a successful refresh applies the policy and reports the new expiry", async () => {
    const result = await runRefresh(0, (path) => applyAt(policy("2026-07-10T18:00:00.000Z")));

    expect(result.success).toBe(true);
    expect(result.applied).toBe(3);
    expect(result.ignored).toBe(0);
    expect(result.expiresAt).toBe("2026-07-10T18:00:00.000Z");
    expect(modelRoutingScoreDelta(slowModel)).toBeCloseTo(-0.25);
    expect(empiricalFirstTokenTimeoutFor("slow-model", "openrouter")).toBe(42_000);
  });

  test("a successful refresh re-arms a still-valid policy with the later deadline", async () => {
    applyAt(policy("2026-07-10T13:00:00.000Z"));
    const firstDeadline = Date.parse("2026-07-10T13:00:00.000Z");

    nowMs = firstDeadline - 60_000;
    const result = await runRefresh(0, (path) => applyAt(policy("2026-07-10T20:00:00.000Z")));
    expect(result.success).toBe(true);
    expect(result.expiresAt).toBe("2026-07-10T20:00:00.000Z");

    // Past the original deadline but inside the refreshed one: still steering.
    nowMs = firstDeadline + 60_000;
    expect(modelRoutingScoreDelta(slowModel)).toBeCloseTo(-0.25);
    expect(empiricalFirstTokenTimeoutFor("slow-model", "openrouter")).toBe(42_000);

    // Past the refreshed deadline too: released.
    nowMs = Date.parse("2026-07-10T20:00:00.000Z") + 1;
    expect(modelRoutingScoreDelta(slowModel)).toBe(0);
    expect(empiricalFirstTokenTimeoutFor("slow-model", "openrouter")).toBeUndefined();
  });

  test("a refresh that generates a policy the loader rejects reports a fixed reason", async () => {
    const result = await runRefresh(0, () => ({ applied: 0, ignored: 0, reason: "expired" as const }));
    expect(result.success).toBe(false);
    expect(result.error).toBe("generated inference policy was not applied: expired");
    expect(result.expiresAt).toBeUndefined();
  });
});
