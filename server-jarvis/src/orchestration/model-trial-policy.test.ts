import { describe, expect, test } from "bun:test";
import {
  TRIAL_SAMPLE_TARGET,
  isTrialEligibleStage,
  selectTrialCandidate,
} from "./model-trial-policy";
import type { OrchestratorAgent } from "./agent-pool";

function agent(over: Partial<OrchestratorAgent> = {}): OrchestratorAgent {
  return {
    id: "some-agent",
    provider: "openrouter",
    model_id: "vendor/model:free",
    capabilities: { code: 0.68, reasoning: 0.72, speed: 0.84, cost: 1, json_reliability: 0.76 },
    default_for: [],
    enabled: true,
    billing_tier: "free",
    ...over,
  };
}

/**
 * Sample-count lookup keyed the way ModelScorecard keys its slots. The proven
 * incumbent is pre-seeded as graduated in every case: it is a free-tier lane
 * too, so without a count it would read as the most data-starved candidate
 * and win its own trial.
 */
const counts = (map: Record<string, number>) =>
  (a: OrchestratorAgent) =>
    ({ "opencode_zen:deepseek-v4-flash-free": 400, ...map })[`${a.provider}:${a.model_id}`] ?? 0;

describe("new-release trial policy", () => {
  // A newly released free model cannot win the scored ranking: its
  // capabilities come from a name-matching regex in `inferredCapabilities`
  // that assigns `code: 0.68` when the pool median is 0.85. Measured
  // 2026-08-01: deepseek-v4-flash-free 684 uses, ling-3.0-flash-free 19,
  // laguna-s-2.1:free 3 — and the few it got were cascade fallbacks, not
  // picks. It is pre-judged by its name and never earns data to correct it.
  //
  // So: try it aggressively until there IS data, then let it compete on
  // merit. The graduation threshold is ModelScorecard's own MIN_SAMPLES, so
  // "enough data" has one definition in the codebase. Bad trials terminate
  // themselves — >=50% errors over >=6 samples puts a model in
  // `unfitKeys`, which `pickFor` already excludes.
  const untried = agent({ id: "ling", model_id: "inclusionai/ling-3.0-flash:free" });
  const proven = agent({
    id: "deepseek",
    model_id: "deepseek-v4-flash-free",
    provider: "opencode_zen",
    capabilities: { code: 0.9, reasoning: 0.86, speed: 0.82, cost: 1, json_reliability: 0.9 },
  });

  test("an untried free model is chosen over a proven one", () => {
    const pick = selectTrialCandidate([proven, untried], "executor", counts({
      "opencode_zen:deepseek-v4-flash-free": 400,
      "openrouter/free": 0,
    }));
    expect(pick?.id).toBe("ling");
  });

  test("a model graduates once it reaches the sample target", () => {
    const pick = selectTrialCandidate([proven, untried], "executor", counts({
      "openrouter:inclusionai/ling-3.0-flash:free": TRIAL_SAMPLE_TARGET,
    }));
    expect(pick).toBeUndefined();
  });

  test("one sample short of the target is still in trial", () => {
    const pick = selectTrialCandidate([proven, untried], "executor", counts({
      "openrouter:inclusionai/ling-3.0-flash:free": TRIAL_SAMPLE_TARGET - 1,
    }));
    expect(pick?.id).toBe("ling");
  });

  test("the most data-starved candidate goes first", () => {
    const laguna = agent({ id: "laguna", model_id: "poolside/laguna-s-2.1:free" });
    const pick = selectTrialCandidate([untried, laguna, proven], "executor", counts({
      "openrouter:inclusionai/ling-3.0-flash:free": 4,
      "openrouter:poolside/laguna-s-2.1:free": 1,
    }));
    expect(pick?.id).toBe("laguna");
  });

  test("only free-tier models are trialled — never spend to explore", () => {
    const paid = agent({ id: "paid", model_id: "vendor/premium", billing_tier: "paid" });
    expect(selectTrialCandidate([paid], "executor", counts({}))).toBeUndefined();
  });

  test("a Go-tier model is not trialled either", () => {
    const go = agent({ id: "go", provider: "opencode_go", model_id: "deepseek-v4-pro", billing_tier: "go" });
    expect(selectTrialCandidate([go], "executor", counts({}))).toBeUndefined();
  });

  test("a disabled agent is never trialled", () => {
    expect(selectTrialCandidate([agent({ enabled: false })], "executor", counts({}))).toBeUndefined();
  });

  test("no trial candidates yields undefined so scored ranking proceeds", () => {
    expect(selectTrialCandidate([proven], "executor", counts({ "opencode_zen:deepseek-v4-flash-free": 400 })))
      .toBeUndefined();
  });
});

describe("trial stage eligibility", () => {
  // The coordinator picks the pipeline for the whole turn. A bad route is not
  // recoverable by a cascade the way a bad executor/reviewer pick is — it
  // mis-shapes every stage downstream. Explore everywhere it is cheap to be
  // wrong, never where being wrong poisons the turn.
  test("the coordinator is never used as a proving ground", () => {
    expect(isTrialEligibleStage("coordinator")).toBe(false);
  });

  test("recoverable stages are eligible", () => {
    for (const stage of ["planner", "executor", "reviewer", "rewriter", "synthesizer"]) {
      expect(isTrialEligibleStage(stage)).toBe(true);
    }
  });

  test("selectTrialCandidate honors stage eligibility", () => {
    const untried = agent({ id: "ling", model_id: "inclusionai/ling-3.0-flash:free" });
    expect(selectTrialCandidate([untried], "coordinator", counts({}))).toBeUndefined();
    expect(selectTrialCandidate([untried], "executor", counts({}))?.id).toBe("ling");
  });
});
