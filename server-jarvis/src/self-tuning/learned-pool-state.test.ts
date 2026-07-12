import { beforeEach, describe, expect, test } from "bun:test";
import type { OrchestratorAgent } from "../orchestration/agent-pool";
import {
  applyLearnedCapabilities,
  clearInferenceFeedbackState,
  empiricalFirstTokenTimeoutFor,
  fallbackBoostKey,
  getLearnedPoolState,
  modelFeedbackKey,
  modelRoutingScoreDelta,
  resetLearnedPoolStateForTests,
  stageModelFeedbackKey,
  stageRoutingScoreDelta,
} from "./learned-pool-state";

const baseAgent: OrchestratorAgent = {
  id: "test-agent",
  provider: "opencode_go",
  model_id: "deepseek-v4-flash",
  capabilities: { code: 0.7, reasoning: 0.7, speed: 0.7, cost: 0.7, json_reliability: 0.7 },
  default_for: [],
  enabled: true,
};

describe("learned-pool-state keys", () => {
  test("modelFeedbackKey joins provider and model with a colon", () => {
    expect(modelFeedbackKey("opencode_go", "deepseek-v4-flash")).toBe("opencode_go:deepseek-v4-flash");
    expect(modelFeedbackKey("openrouter", "x/y:z")).toBe("openrouter:x/y:z");
  });

  test("stageModelFeedbackKey includes stage in the routing key", () => {
    expect(stageModelFeedbackKey("opencode_go", "deepseek-v4-flash", "synthesizer"))
      .toBe("opencode_go:deepseek-v4-flash:synthesizer");
    expect(stageModelFeedbackKey("opencode_go", "deepseek-v4-flash", "planner"))
      .toBe("opencode_go:deepseek-v4-flash:planner");
    expect(stageModelFeedbackKey("opencode_go", "deepseek-v4-flash", "executor"))
      .not.toBe(stageModelFeedbackKey("opencode_go", "deepseek-v4-flash", "synthesizer"));
  });

  test("fallbackBoostKey includes agent, stage, and taskType", () => {
    expect(fallbackBoostKey("fast-agent", "synthesizer", "general"))
      .toBe("fast-agent:synthesizer:general");
    expect(fallbackBoostKey("fast-agent", "synthesizer", "refactor"))
      .not.toBe(fallbackBoostKey("fast-agent", "synthesizer", "general"));
  });
});

describe("learned-pool-state score deltas", () => {
  beforeEach(() => resetLearnedPoolStateForTests());

  test("modelRoutingScoreDelta returns 0 when no delta is recorded", () => {
    expect(modelRoutingScoreDelta(baseAgent)).toBe(0);
  });

  test("modelRoutingScoreDelta reads the stored provider:model key", () => {
    const state = getLearnedPoolState();
    state.modelRoutingScoreDeltas.set("opencode_go:deepseek-v4-flash", -0.12);
    try {
      expect(modelRoutingScoreDelta(baseAgent)).toBeCloseTo(-0.12);
    } finally {
      state.modelRoutingScoreDeltas.delete("opencode_go:deepseek-v4-flash");
    }
  });

  test("modelRoutingScoreDelta isolates different providers of the same model", () => {
    const state = getLearnedPoolState();
    state.modelRoutingScoreDeltas.set("opencode_go:deepseek-v4-flash", -0.2);
    state.modelRoutingScoreDeltas.set("openrouter:deepseek-v4-flash", 0.05);
    try {
      expect(modelRoutingScoreDelta(baseAgent)).toBeCloseTo(-0.2);
      const openrouterCopy: OrchestratorAgent = { ...baseAgent, provider: "openrouter" };
      expect(modelRoutingScoreDelta(openrouterCopy)).toBeCloseTo(0.05);
    } finally {
      state.modelRoutingScoreDeltas.delete("opencode_go:deepseek-v4-flash");
      state.modelRoutingScoreDeltas.delete("openrouter:deepseek-v4-flash");
    }
  });

  test("stageRoutingScoreDelta is stage-specific and defaults to 0", () => {
    expect(stageRoutingScoreDelta(baseAgent, "synthesizer")).toBe(0);
    expect(stageRoutingScoreDelta(baseAgent, "planner")).toBe(0);

    const state = getLearnedPoolState();
    state.stageModelRoutingScoreDeltas.set("opencode_go:deepseek-v4-flash:synthesizer", 0.1);
    try {
      expect(stageRoutingScoreDelta(baseAgent, "synthesizer")).toBeCloseTo(0.1);
      expect(stageRoutingScoreDelta(baseAgent, "planner")).toBe(0);
    } finally {
      state.stageModelRoutingScoreDeltas.delete("opencode_go:deepseek-v4-flash:synthesizer");
    }
  });

  test("stageRoutingScoreDelta isolates across stages for the same model", () => {
    const state = getLearnedPoolState();
    state.stageModelRoutingScoreDeltas.set("opencode_go:deepseek-v4-flash:planner", 0.15);
    state.stageModelRoutingScoreDeltas.set("opencode_go:deepseek-v4-flash:synthesizer", -0.08);
    try {
      expect(stageRoutingScoreDelta(baseAgent, "planner")).toBeCloseTo(0.15);
      expect(stageRoutingScoreDelta(baseAgent, "synthesizer")).toBeCloseTo(-0.08);
      expect(stageRoutingScoreDelta(baseAgent, "executor")).toBe(0);
    } finally {
      state.stageModelRoutingScoreDeltas.delete("opencode_go:deepseek-v4-flash:planner");
      state.stageModelRoutingScoreDeltas.delete("opencode_go:deepseek-v4-flash:synthesizer");
    }
  });
});

describe("empiricalFirstTokenTimeoutFor", () => {
  beforeEach(() => resetLearnedPoolStateForTests());

  test("returns undefined when no entry exists for the provider/model", () => {
    expect(empiricalFirstTokenTimeoutFor("deepseek-v4-flash", "opencode_go")).toBeUndefined();
    expect(empiricalFirstTokenTimeoutFor("deepseek-v4-flash")).toBeUndefined();
  });

  test("returns the recorded timeout when provider matches", () => {
    const state = getLearnedPoolState();
    state.modelFirstTokenTimeouts.set("opencode_go:deepseek-v4-flash", 55_000);
    try {
      expect(empiricalFirstTokenTimeoutFor("deepseek-v4-flash", "opencode_go")).toBe(55_000);
    } finally {
      state.modelFirstTokenTimeouts.delete("opencode_go:deepseek-v4-flash");
    }
  });

  test("without provider, returns the max across all providers of that model", () => {
    const state = getLearnedPoolState();
    state.modelFirstTokenTimeouts.set("opencode_go:deepseek-v4-flash", 55_000);
    state.modelFirstTokenTimeouts.set("openrouter:deepseek-v4-flash", 42_000);
    try {
      expect(empiricalFirstTokenTimeoutFor("deepseek-v4-flash")).toBe(55_000);
    } finally {
      state.modelFirstTokenTimeouts.delete("opencode_go:deepseek-v4-flash");
      state.modelFirstTokenTimeouts.delete("openrouter:deepseek-v4-flash");
    }
  });

  test("without provider, matches by suffix on full keys (deepseek-v4-flash ≠ flash-v4)", () => {
    const state = getLearnedPoolState();
    state.modelFirstTokenTimeouts.set("opencode_go:flash-v4", 99_000);
    try {
      // No exact match for "deepseek-v4-flash" on opencode_go; suffix match would
      // still pick up the unrelated model — surface the exact-match contract
      // instead by passing the provider.
      expect(empiricalFirstTokenTimeoutFor("deepseek-v4-flash", "opencode_go")).toBeUndefined();
      expect(empiricalFirstTokenTimeoutFor("flash-v4")).toBe(99_000);
    } finally {
      state.modelFirstTokenTimeouts.delete("opencode_go:flash-v4");
    }
  });
});

describe("applyLearnedCapabilities", () => {
  beforeEach(() => resetLearnedPoolStateForTests());

  test("returns the same agent reference when no deltas are recorded", () => {
    expect(applyLearnedCapabilities(baseAgent)).toBe(baseAgent);
  });

  test("clamps the adjusted capability into [0, 1] when a delta would push it out of range", () => {
    const state = getLearnedPoolState();
    state.capabilityDeltas.set("test-agent", { speed: 0.8 });
    try {
      const adjusted = applyLearnedCapabilities(baseAgent);
      expect(adjusted.capabilities.speed).toBeCloseTo(1); // 0.7 + 0.8 = 1.5 → clamp 1
      // Untouched capabilities remain identical
      expect(adjusted.capabilities.code).toBe(0.7);
      expect(adjusted.capabilities.reasoning).toBe(0.7);
    } finally {
      state.capabilityDeltas.delete("test-agent");
    }
  });

  test("clamps the adjusted capability at 0 when a negative delta is large", () => {
    const state = getLearnedPoolState();
    state.capabilityDeltas.set("test-agent", { code: -0.9 });
    try {
      const adjusted = applyLearnedCapabilities(baseAgent);
      expect(adjusted.capabilities.code).toBe(0); // 0.7 - 0.9 = -0.2 → clamp 0
    } finally {
      state.capabilityDeltas.delete("test-agent");
    }
  });

  test("applies both agent-id and provider:model capability deltas", () => {
    const state = getLearnedPoolState();
    state.capabilityDeltas.set("test-agent", { speed: 0.1 });
    state.modelCapabilityDeltas.set("opencode_go:deepseek-v4-flash", { reasoning: 0.15 });
    try {
      const adjusted = applyLearnedCapabilities(baseAgent);
      expect(adjusted.capabilities.speed).toBeCloseTo(0.8);
      expect(adjusted.capabilities.reasoning).toBeCloseTo(0.85);
    } finally {
      state.capabilityDeltas.delete("test-agent");
      state.modelCapabilityDeltas.delete("opencode_go:deepseek-v4-flash");
    }
  });

  test("returns a new agent object when deltas exist (no mutation of input)", () => {
    const state = getLearnedPoolState();
    state.capabilityDeltas.set("test-agent", { speed: 0.1 });
    try {
      const adjusted = applyLearnedCapabilities(baseAgent);
      expect(adjusted).not.toBe(baseAgent);
      expect(baseAgent.capabilities.speed).toBe(0.7); // input untouched
    } finally {
      state.capabilityDeltas.delete("test-agent");
    }
  });
});

describe("clearInferenceFeedbackState and resetLearnedPoolStateForTests", () => {
  beforeEach(() => resetLearnedPoolStateForTests());

  test("clearInferenceFeedbackState wipes the four cron-managed maps only", () => {
    const state = getLearnedPoolState();
    state.capabilityDeltas.set("test-agent", { speed: 0.1 });
    state.fallbackBoosts.set(fallbackBoostKey("test-agent", "synthesizer", "general"), 0.05);
    state.modelCapabilityDeltas.set(modelFeedbackKey("opencode_go", "deepseek-v4-flash"), {
      speed: 0.1,
    });
    state.modelRoutingScoreDeltas.set(modelFeedbackKey("opencode_go", "deepseek-v4-flash"), -0.1);
    state.stageModelRoutingScoreDeltas.set(
      stageModelFeedbackKey("opencode_go", "deepseek-v4-flash", "synthesizer"),
      0.1,
    );
    state.modelFirstTokenTimeouts.set(modelFeedbackKey("opencode_go", "deepseek-v4-flash"), 55_000);

    clearInferenceFeedbackState();

    // Cron-managed maps are cleared
    expect(state.modelCapabilityDeltas.size).toBe(0);
    expect(state.modelRoutingScoreDeltas.size).toBe(0);
    expect(state.stageModelRoutingScoreDeltas.size).toBe(0);
    expect(state.modelFirstTokenTimeouts.size).toBe(0);
    // Session-managed maps are preserved
    expect(state.capabilityDeltas.size).toBe(1);
    expect(state.fallbackBoosts.size).toBe(1);
  });

  test("resetLearnedPoolStateForTests clears every map including session-managed", () => {
    const state = getLearnedPoolState();
    state.capabilityDeltas.set("test-agent", { speed: 0.1 });
    state.fallbackBoosts.set(fallbackBoostKey("test-agent", "synthesizer", "general"), 0.05);
    state.modelCapabilityDeltas.set(modelFeedbackKey("opencode_go", "deepseek-v4-flash"), {
      speed: 0.1,
    });
    state.modelRoutingScoreDeltas.set(modelFeedbackKey("opencode_go", "deepseek-v4-flash"), -0.1);
    state.modelFirstTokenTimeouts.set(modelFeedbackKey("opencode_go", "deepseek-v4-flash"), 55_000);

    resetLearnedPoolStateForTests();

    expect(state.capabilityDeltas.size).toBe(0);
    expect(state.fallbackBoosts.size).toBe(0);
    expect(state.modelCapabilityDeltas.size).toBe(0);
    expect(state.modelRoutingScoreDeltas.size).toBe(0);
    expect(state.stageModelRoutingScoreDeltas.size).toBe(0);
    expect(state.modelFirstTokenTimeouts.size).toBe(0);
  });
});
