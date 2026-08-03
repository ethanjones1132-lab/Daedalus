import { describe, expect, test, beforeEach } from "bun:test";
import { SelfTuningStore } from "../self-tuning/store";
import {
  __resetDelegateThrashForTests,
  __resetDelegateWriteScoreboardForTests,
  __reseedDelegateWriteScoreboardForTests,
  __setDelegateWriteScoreboardStoreForTests,
  clearDelegateThrash,
  DEFAULT_THRASH_TTL_MS,
  DELEGATE_WRITE_SCOREBOARD_SEEDS,
  delegateThrashKey,
  enumerateDelegateModelCandidates,
  getDelegateThrashCount,
  isDelegateThrashOutcome,
  isProxyResolvable,
  isToolCallCapableDelegate,
  DELEGATE_FREE_FIRST_MODELS,
  DELEGATE_GO_ANTHROPIC_MODELS,
  DELEGATE_GO_OPENAI_MODELS,
  DELEGATE_TOOL_INCAPABLE_MODELS,
  recordDelegateThrash,
  getBenchedDelegateModels,
  getDelegateWriteScoreboard,
  recordDelegateWriteOutcome,
  isEarnedFreeDelegateModel,
  rankDelegateAutoCandidates,
  rankModelsByWriteEvidence,
  selectDelegateModel,
  shouldRecordDelegateWriteOutcome,
  writeEvidenceScore,
} from "./delegate-model-select";

// 2026-08-01, live runs run_d84a937f / run_275068a5: the delegate is the
// PRIMARY write path, and `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
// sat second in DELEGATE_FREE_FIRST_MODELS. Reasoning models emit <think> and
// leave `content` empty, so there is nothing to parse as a tool call — the
// same trap already recorded for MiniMax M3. Observed: one executor turn
// produced 7825 output tokens with ZERO tool calls, the delegate's only edit
// was a no-op (`old_string` === `new_string`), and both delegate stages
// recorded ok=0 err=1.
//
// Exclusion is by EXPLICIT id, never a substring heuristic on "reasoning":
// a wrong exclusion silently costs a free lane, and re-enabling a model when
// it gains tool support must be a one-line edit.
describe("delegate tool-call capability filter", () => {
  beforeEach(() => {
    __setDelegateWriteScoreboardStoreForTests(new SelfTuningStore(":memory:"));
    __reseedDelegateWriteScoreboardForTests();
  });

  test("the known reasoning model is excluded", () => {
    expect(isToolCallCapableDelegate("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free")).toBe(false);
  });

  test("north-mini-code stays tool-capable but does not beat seeded minimax-m3", () => {
    expect(isToolCallCapableDelegate("cohere/north-mini-code:free")).toBe(true);
    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    expect(s.model).toBe("minimax-m3");
    expect(s.pool).toBe("go_capable");
  });

  test("a model is not excluded merely for having 'reasoning' in its id", () => {
    // Guards against the substring heuristic this deliberately avoids.
    expect(isToolCallCapableDelegate("vendor/some-reasoning-capable-coder:free")).toBe(true);
  });

  test("the exclusion set is injectable so a model can be toggled back", () => {
    expect(isToolCallCapableDelegate("cohere/north-mini-code:free", ["cohere/north-mini-code:free"]))
      .toBe(false);
    expect(isToolCallCapableDelegate("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", []))
      .toBe(true);
  });

  test("selection never returns an incapable model from the free pool", () => {
    for (let thrash = 0; thrash < DELEGATE_FREE_FIRST_MODELS.length + 2; thrash++) {
      const s = selectDelegateModel({
        configuredModel: "auto",
        thrashCount: thrash,
        proxyAvailable: true,
        hasOpenCodeGoKey: true,
      });
      if (s.pool !== "free") continue;
      expect(DELEGATE_TOOL_INCAPABLE_MODELS).not.toContain(s.model);
    }
  });

  test("seeded write evidence beats free pool on first auto selection", () => {
    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    expect(s.pool).toBe("go_capable");
    expect(s.model).toBe("minimax-m3");
    expect(s.reason).toBe("write_evidence");
  });
});

describe("selectDelegateModel (W1.1 scoreboard ranking)", () => {
  beforeEach(() => {
    __setDelegateWriteScoreboardStoreForTests(new SelfTuningStore(":memory:"));
    __reseedDelegateWriteScoreboardForTests();
  });

  test("auto + thrash=0 + proxy up + go key → minimax-m3 (highest write evidence)", () => {
    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    expect(s.model).toBe("minimax-m3");
    expect(s.pool).toBe("go_capable");
    expect(s.reason).toBe("write_evidence");
  });

  // W1.4.1 permanent pin — do not weaken or delete; pairs with W1.2 proxy-up pin.
  test("selector returns highest write-evidence available model (minimax-m3 vs free-pool fixture)", () => {
    __resetDelegateWriteScoreboardForTests();
    // Fixture: free looks cheap but has poor write evidence; minimax is proven.
    recordDelegateWriteOutcome("minimax-m3", true);
    for (let i = 0; i < 10; i++) {
      // pad minimax to high rate with confidence
      recordDelegateWriteOutcome("minimax-m3", true);
    }
    // free pool: many attempts, few writes
    for (let i = 0; i < 10; i++) {
      recordDelegateWriteOutcome("cohere/north-mini-code:free", i === 0);
    }

    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
      freeModels: ["cohere/north-mini-code:free"],
      goAnthropicModels: ["minimax-m3"],
      goOpenaiModels: ["deepseek-v4-flash"],
    });
    expect(s.model).toBe("minimax-m3");
    expect(writeEvidenceScore(getDelegateWriteScoreboard("minimax-m3")).rate)
      .toBeGreaterThan(writeEvidenceScore(getDelegateWriteScoreboard("cohere/north-mini-code:free")).rate);
  });

  test("historical seeds document minimax ~96% and free pool ~9%", () => {
    const minimax = DELEGATE_WRITE_SCOREBOARD_SEEDS.find((s) => s.model === "minimax-m3")!;
    expect(minimax.attempts).toBe(123);
    expect(minimax.verifiedWrites).toBe(118);
    expect(minimax.verifiedWrites / minimax.attempts).toBeCloseTo(0.96, 2);

    const freeSeeds = DELEGATE_WRITE_SCOREBOARD_SEEDS.filter((s) => s.model.includes(":free"));
    const freeAttempts = freeSeeds.reduce((n, s) => n + s.attempts, 0);
    const freeVerified = freeSeeds.reduce((n, s) => n + s.verifiedWrites, 0);
    expect(freeAttempts).toBe(33);
    expect(freeVerified / freeAttempts).toBeCloseTo(0.09, 2);
  });

  test("thrash rotates through evidence-ranked candidates", () => {
    const s0 = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    const s1 = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 1,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    expect(s0.model).toBe("minimax-m3");
    expect(s1.model).not.toBe(s0.model);
    // Thrash after minimax must prefer other Go before free (even seeded free).
    expect(s1.pool).toBe("go_capable");
    expect(s1.model.includes(":free")).toBe(false);
  });

  test("thrash=1 after minimax prefers Go over free with lower rate", () => {
    // Seeds: free rates ~0.06–0.125, unseeded Go rate 0. Pure rate ranking
    // would pick free; auto candidates must keep Go ahead of free.
    const s1 = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 1,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    expect(s1.pool).toBe("go_capable");
    const goIds: string[] = [...DELEGATE_GO_ANTHROPIC_MODELS, ...DELEGATE_GO_OPENAI_MODELS];
    expect(goIds).toContain(s1.model);
    expect(s1.model).not.toBe("minimax-m3");
  });

  test("thrash at threshold promotes among Go capable by write evidence (not cheapest first)", () => {
    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 2,
      thrashThreshold: 2,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    expect(s.pool).toBe("go_capable");
    // With seeds, minimax-m3 remains the highest-evidence Go model.
    expect(s.model).toBe("minimax-m3");
    expect(s.reason).toContain("thrash_promoted");
  });

  test("no proxy promotes to Anthropic-native Go (minimax) instead of free", () => {
    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: false,
      hasOpenCodeGoKey: true,
    });
    expect(s.pool).toBe("go_capable");
    expect(s.model).toBe("minimax-m3");
    expect(s.reason).toContain("no_proxy");
  });

  test("operator pin is honored until thrash threshold", () => {
    const s = selectDelegateModel({
      configuredModel: "minimax-m3",
      thrashCount: 0,
      proxyAvailable: true,
    });
    expect(s).toMatchObject({ model: "minimax-m3", reason: "operator_pin", pool: "go_capable" });
    const promoted = selectDelegateModel({
      configuredModel: "minimax-m3",
      thrashCount: 2,
      thrashThreshold: 2,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    expect(promoted.pool).toBe("go_capable");
    // Evidence-ranked Go promotion (not deepseek-first).
    expect(promoted.model).toBe("minimax-m3");
    expect(promoted.reason).toContain("thrash_promoted");
  });

  test("enumerate includes free, go openai, and anthropic candidates", () => {
    const list = enumerateDelegateModelCandidates({
      configuredModel: "auto",
      thrashCount: 0,
      thrashThreshold: 2,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    expect(list[0]?.model).toBe("minimax-m3");
    expect(list.some((s) => s.model === "deepseek-v4-flash")).toBe(true);
    expect(list.some((s) => s.model === "minimax-m3")).toBe(true);
    // Free models still appear later in the evidence-ranked walk when not benched.
    expect(list.some((s) => s.pool === "free" || s.model.includes(":free"))).toBe(true);
  });
});

describe("selectDelegateModel (W1.2 Anthropic Go while proxy up)", () => {
  beforeEach(() => {
    __setDelegateWriteScoreboardStoreForTests(new SelfTuningStore(":memory:"));
    __reseedDelegateWriteScoreboardForTests();
  });

  // W1.4.1 permanent pin — proxy availability must never drop the Anthropic Go lane.
  test("proxy-up does not exclude Anthropic-native Go models from consideration", () => {
    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    // minimax-m3 is Anthropic-native Go and must win with seeds even when proxy is up
    expect(DELEGATE_GO_ANTHROPIC_MODELS).toContain(s.model as typeof DELEGATE_GO_ANTHROPIC_MODELS[number]);
    expect(s.model).toBe("minimax-m3");
  });

  test("with empty free pool and proxy up, anthropic Go still ranks against openai Go", () => {
    __resetDelegateWriteScoreboardForTests();
    // Only deepseek has weak evidence; minimax has strong evidence.
    for (let i = 0; i < 5; i++) recordDelegateWriteOutcome("minimax-m3", true);
    for (let i = 0; i < 5; i++) recordDelegateWriteOutcome("deepseek-v4-flash", false);

    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
      freeModels: [],
      goOpenaiModels: ["deepseek-v4-flash"],
      goAnthropicModels: ["minimax-m3"],
    });
    expect(s.model).toBe("minimax-m3");
    expect(s.pool).toBe("go_capable");
  });

  test("enumerate with proxy up still lists anthropic Go models", () => {
    const list = enumerateDelegateModelCandidates({
      configuredModel: "auto",
      thrashCount: 0,
      thrashThreshold: 2,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    for (const model of DELEGATE_GO_ANTHROPIC_MODELS) {
      expect(list.some((s) => s.model === model)).toBe(true);
    }
  });
});

describe("selectDelegateModel (W1.3 earned free lane)", () => {
  beforeEach(() => {
    __setDelegateWriteScoreboardStoreForTests(new SelfTuningStore(":memory:"));
    __resetDelegateWriteScoreboardForTests();
  });

  test("free without verifiedWrites is not auto-selected", () => {
    // Attempts without writes do not earn free; Go still selected.
    recordDelegateWriteOutcome("vendor/unproven:free", false);
    recordDelegateWriteOutcome("vendor/unproven:free", false);
    for (let i = 0; i < 3; i++) recordDelegateWriteOutcome("minimax-m3", true);

    expect(isEarnedFreeDelegateModel("vendor/unproven:free")).toBe(false);

    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
      freeModels: ["vendor/unproven:free"],
      goAnthropicModels: ["minimax-m3"],
      goOpenaiModels: [],
    });
    expect(s.model).toBe("minimax-m3");
    expect(s.pool).toBe("go_capable");
  });

  test("unseen free model is not auto-selected until it has a verified write", () => {
    expect(isEarnedFreeDelegateModel("vendor/never-tried:free")).toBe(false);
    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: true,
      hasOpenCodeGoKey: false,
      freeModels: ["vendor/never-tried:free"],
      goOpenaiModels: [],
      goAnthropicModels: [],
    });
    // No eligible free or go → fallback minimax (not the unproven free).
    expect(s.model).not.toBe("vendor/never-tried:free");
  });

  test("operator pin can still force an unearned free model", () => {
    const s = selectDelegateModel({
      configuredModel: "vendor/never-tried:free",
      thrashCount: 0,
      proxyAvailable: true,
      freeModels: ["vendor/never-tried:free"],
    });
    expect(s).toMatchObject({
      model: "vendor/never-tried:free",
      reason: "operator_pin",
      pool: "free",
    });
  });

  test("benched free model is not selected even as thrash rotates", () => {
    recordDelegateWriteOutcome("vendor/failing:free", false);
    recordDelegateWriteOutcome("vendor/failing:free", false);
    recordDelegateWriteOutcome("vendor/failing:free", false);
    // Give healthy free weak evidence; minimax strong.
    recordDelegateWriteOutcome("vendor/healthy:free", true);
    for (let i = 0; i < 5; i++) recordDelegateWriteOutcome("minimax-m3", true);

    const selection = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
      freeModels: ["vendor/failing:free", "vendor/healthy:free"],
      benchedModels: getBenchedDelegateModels(),
    });

    expect(selection.model).not.toBe("vendor/failing:free");
    expect(getBenchedDelegateModels()).toContain("vendor/failing:free");
  });

  test("free model with no verified writes after bench attempts stays benched", () => {
    for (let i = 0; i < 3; i++) {
      recordDelegateWriteOutcome("cohere/north-mini-code:free", false);
    }
    expect(getDelegateWriteScoreboard("cohere/north-mini-code:free")?.benched).toBe(true);
    expect(isEarnedFreeDelegateModel("cohere/north-mini-code:free")).toBe(false);
  });

  test("rankDelegateAutoCandidates keeps Go ahead of free unless free beats best Go rate", () => {
    for (let i = 0; i < 10; i++) recordDelegateWriteOutcome("minimax-m3", true);
    // Free has some evidence but lower rate than minimax.
    recordDelegateWriteOutcome("vendor/ok:free", true);
    recordDelegateWriteOutcome("vendor/ok:free", false);
    recordDelegateWriteOutcome("vendor/ok:free", false);

    const ranked = rankDelegateAutoCandidates(
      ["vendor/ok:free"],
      ["minimax-m3", "deepseek-v4-flash"],
    );
    expect(ranked[0]).toBe("minimax-m3");
    expect(ranked.indexOf("deepseek-v4-flash")).toBeLessThan(ranked.indexOf("vendor/ok:free"));
  });
});

describe("delegate thrash accounting", () => {
  test("records and clears thrash per key", () => {
    __resetDelegateThrashForTests();
    expect(getDelegateThrashCount("run-a")).toBe(0);
    expect(recordDelegateThrash("run-a")).toBe(1);
    expect(recordDelegateThrash("run-a")).toBe(2);
    clearDelegateThrash("run-a");
    expect(getDelegateThrashCount("run-a")).toBe(0);
  });

  test("session thrash key trims and falls back", () => {
    expect(delegateThrashKey("  session-abc  ")).toBe("session-abc");
    expect(delegateThrashKey("")).toBe("unknown-session");
    expect(delegateThrashKey("   ")).toBe("unknown-session");
  });

  test("expires thrash after thrash_ttl_ms", () => {
    __resetDelegateThrashForTests();
    const t0 = 1_000_000;
    const ttl = 60_000;
    expect(recordDelegateThrash("session-ttl", ttl, t0)).toBe(1);
    expect(getDelegateThrashCount("session-ttl", ttl, t0 + 30_000)).toBe(1);
    expect(getDelegateThrashCount("session-ttl", ttl, t0 + ttl + 1)).toBe(0);
    // Re-record after expiry starts a fresh counter.
    expect(recordDelegateThrash("session-ttl", ttl, t0 + ttl + 2)).toBe(1);
    expect(DEFAULT_THRASH_TTL_MS).toBe(30 * 60_000);
  });

  test("thrash outcomes match no-write / stream failures / handoff", () => {
    expect(isDelegateThrashOutcome({ ok: true, hasVerifiedWrite: true })).toBe(false);
    expect(isDelegateThrashOutcome({ ok: true, hasVerifiedWrite: false })).toBe(true);
    expect(isDelegateThrashOutcome({
      ok: false, hasVerifiedWrite: false, errorCode: "delegate_no_write",
    })).toBe(true);
    expect(isDelegateThrashOutcome({
      ok: false, hasVerifiedWrite: false, errorCode: "delegate_stream_error",
    })).toBe(true);
    expect(isDelegateThrashOutcome({
      ok: false, hasVerifiedWrite: false, errorCode: "mid_loop_handoff",
    })).toBe(true);
    // Named CLI stream failures used to surface as delegate_exit_nonzero
    // (matched via "exit"). Preferring delegate_cli_error must stay thrash-
    // eligible so free→Go promotion still advances on repeated CLI failures.
    expect(isDelegateThrashOutcome({
      ok: false, hasVerifiedWrite: false, errorCode: "delegate_cli_error",
    })).toBe(true);
    expect(isDelegateThrashOutcome({
      ok: false, hasVerifiedWrite: false, errorCode: "delegate_exit_nonzero",
    })).toBe(true);
  });
});

describe("delegate verified-write scoreboard", () => {
  beforeEach(() => {
    __setDelegateWriteScoreboardStoreForTests(new SelfTuningStore(":memory:"));
    __resetDelegateWriteScoreboardForTests();
  });

  test("benches a model after three attempts with zero verified writes", () => {
    expect(recordDelegateWriteOutcome("vendor/failing:free", false)).toMatchObject({
      attempts: 1,
      verifiedWrites: 0,
      benched: false,
    });
    recordDelegateWriteOutcome("vendor/failing:free", false);
    const final = recordDelegateWriteOutcome("vendor/failing:free", false);

    expect(final).toMatchObject({ attempts: 3, verifiedWrites: 0, benched: true });
    expect(getBenchedDelegateModels()).toEqual(["vendor/failing:free"]);
    expect(getDelegateWriteScoreboard("vendor/failing:free")).toEqual(final);
  });

  test("a verified write prevents benching even after three attempts", () => {
    recordDelegateWriteOutcome("vendor/working:free", false);
    recordDelegateWriteOutcome("vendor/working:free", false);
    const result = recordDelegateWriteOutcome("vendor/working:free", true);

    expect(result).toMatchObject({ attempts: 3, verifiedWrites: 1, benched: false });
    expect(getBenchedDelegateModels()).not.toContain("vendor/working:free");
  });

  test("selection skips a benched free model", () => {
    recordDelegateWriteOutcome("vendor/failing:free", false);
    recordDelegateWriteOutcome("vendor/failing:free", false);
    recordDelegateWriteOutcome("vendor/failing:free", false);
    // Give healthy free the only free-side evidence so thrash=0 can still
    // prefer it when Go models have zero evidence — but with empty board
    // after reset, rank prefers Anthropic Go via tier break. Seed healthy
    // free higher than unproven go? Actually with 0 evidence everywhere
    // except failing benched, tier order: anthropic > openai > free.
    // Force free-only selection via no go key and no go models if needed.
    recordDelegateWriteOutcome("vendor/healthy:free", true);
    recordDelegateWriteOutcome("vendor/healthy:free", true);

    const selection = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: true,
      hasOpenCodeGoKey: false,
      freeModels: ["vendor/failing:free", "vendor/healthy:free"],
      goOpenaiModels: [],
      goAnthropicModels: [],
      benchedModels: getBenchedDelegateModels(),
    });

    expect(selection.model).toBe("vendor/healthy:free");
  });

  test("scoreboard persists across hydrate via SelfTuningStore", () => {
    const store = new SelfTuningStore(":memory:");
    __setDelegateWriteScoreboardStoreForTests(store);
    __resetDelegateWriteScoreboardForTests();

    recordDelegateWriteOutcome("minimax-m3", true);
    recordDelegateWriteOutcome("minimax-m3", true);
    expect(getDelegateWriteScoreboard("minimax-m3")?.attempts).toBe(2);

    // Simulate process restart: new in-memory module cache, same store rows.
    __setDelegateWriteScoreboardStoreForTests(store);
    // Force re-hydrate from store (not suppressed empty)
    const row = store.getDelegateWriteScoreboardRow("minimax-m3");
    expect(row?.attempts).toBe(2);
    expect(row?.verified_writes).toBe(2);

    // Re-bind and load
    __setDelegateWriteScoreboardStoreForTests(store);
    // After set, hydrated=false; get should load from store
    expect(getDelegateWriteScoreboard("minimax-m3")).toMatchObject({
      model: "minimax-m3",
      attempts: 2,
      verifiedWrites: 2,
      benched: false,
    });
  });

  test("empty store is seeded from history on first hydrate", () => {
    const store = new SelfTuningStore(":memory:");
    __setDelegateWriteScoreboardStoreForTests(store);
    // hydrated=false, seed not suppressed → seeds applied
    expect(getDelegateWriteScoreboard("minimax-m3")).toMatchObject({
      model: "minimax-m3",
      attempts: 123,
      verifiedWrites: 118,
      benched: false,
    });
    expect(store.getDelegateWriteScoreboardRow("minimax-m3")?.attempts).toBe(123);
  });

  test("rankModelsByWriteEvidence orders by rate then attempts", () => {
    recordDelegateWriteOutcome("a", true); // 1/1
    recordDelegateWriteOutcome("b", true);
    recordDelegateWriteOutcome("b", false); // 1/2
    recordDelegateWriteOutcome("c", false); // 0/1
    const ranked = rankModelsByWriteEvidence(["c", "b", "a"]);
    expect(ranked[0]).toBe("a");
    expect(ranked[1]).toBe("b");
    expect(ranked[2]).toBe("c");
  });

  test("shouldRecordDelegateWriteOutcome skips abort/integration/handoff", () => {
    expect(shouldRecordDelegateWriteOutcome({ hasVerifiedWrite: true, errorCode: "delegate_aborted" }))
      .toBe(true);
    expect(shouldRecordDelegateWriteOutcome({ hasVerifiedWrite: false, errorCode: "delegate_aborted" }))
      .toBe(false);
    expect(shouldRecordDelegateWriteOutcome({ hasVerifiedWrite: false, errorCode: "delegate_integration_error" }))
      .toBe(false);
    expect(shouldRecordDelegateWriteOutcome({ hasVerifiedWrite: false, errorCode: "mid_loop_handoff" }))
      .toBe(false);
    expect(shouldRecordDelegateWriteOutcome({ hasVerifiedWrite: false, errorCode: "mid_loop_abort" }))
      .toBe(false);
    expect(shouldRecordDelegateWriteOutcome({ hasVerifiedWrite: false, errorCode: "delegate_no_write" }))
      .toBe(true);
    expect(shouldRecordDelegateWriteOutcome({ hasVerifiedWrite: false, errorCode: "delegate_stream_error" }))
      .toBe(true);
    expect(shouldRecordDelegateWriteOutcome({ hasVerifiedWrite: false })).toBe(true);
  });

  test("abort outcomes do not bench a model via three failed scoreboard records", () => {
    // Simulate pipeline gating: aborts never call recordDelegateWriteOutcome.
    for (let i = 0; i < 3; i++) {
      expect(shouldRecordDelegateWriteOutcome({
        hasVerifiedWrite: false,
        errorCode: "delegate_aborted",
      })).toBe(false);
    }
    expect(getDelegateWriteScoreboard("minimax-m3")).toBeUndefined();
    expect(getBenchedDelegateModels()).not.toContain("minimax-m3");
  });

  test("hydrate merges missing historical seeds without overwriting live counters", () => {
    const store = new SelfTuningStore(":memory:");
    store.upsertDelegateWriteScoreboard({
      model: "minimax-m3",
      attempts: 5,
      verifiedWrites: 4,
      benched: false,
    });
    __setDelegateWriteScoreboardStoreForTests(store);
    // Hydrate loads live minimax counters and fills free seeds that were missing.
    expect(getDelegateWriteScoreboard("minimax-m3")).toMatchObject({
      attempts: 5,
      verifiedWrites: 4,
    });
    expect(getDelegateWriteScoreboard("cohere/north-mini-code:free")).toMatchObject({
      attempts: 17,
      verifiedWrites: 1,
    });
    expect(getDelegateWriteScoreboard("google/gemma-4-31b-it:free")).toMatchObject({
      attempts: 16,
      verifiedWrites: 2,
    });
  });
});

describe("delegate only selects models the claude_cli proxy can resolve", () => {
  const installed = ["qwythos9b-conductor:latest", "qwen3.5:4b", "qwen3:8b"];
  const goOpenaiModels = ["deepseek-v4-flash", "mimo-v2.5"];

  beforeEach(() => {
    __setDelegateWriteScoreboardStoreForTests(new SelfTuningStore(":memory:"));
    __resetDelegateWriteScoreboardForTests();
  });

  test("a namespaced id routes to OpenRouter and is resolvable", () => {
    expect(isProxyResolvable("cohere/north-mini-code:free", installed, goOpenaiModels)).toBe(true);
    expect(isProxyResolvable("deepseek/deepseek-v4-flash", installed, goOpenaiModels)).toBe(true);
  });

  test("a bare OpenCode Go OpenAI-format id resolves via rule 1, not Ollama", () => {
    for (const model of DELEGATE_GO_OPENAI_MODELS) {
      expect(isProxyResolvable(model, [], goOpenaiModels)).toBe(true);
    }
  });

  test("a bare id NOT in the Go OpenAI list is only resolvable when installed in Ollama", () => {
    expect(isProxyResolvable("qwen3:8b", installed, goOpenaiModels)).toBe(true);
    expect(isProxyResolvable("deepseek-v4-flash-free", installed, goOpenaiModels)).toBe(false);
  });

  test("claude-* placeholders fall back to the proxy default model", () => {
    expect(isProxyResolvable("claude-sonnet-4", installed, goOpenaiModels)).toBe(true);
  });

  test("every default free-first model is namespaced", () => {
    for (const model of DELEGATE_FREE_FIRST_MODELS) {
      expect({ model, namespaced: model.includes("/") })
        .toEqual({ model, namespaced: true });
    }
  });

  test("a custom goOpenaiModels list is honored by free-pool resolvability, not the module default", () => {
    // "custom-bare-model" is NOT namespaced, NOT installed in Ollama, and NOT
    // in the module-level DELEGATE_GO_OPENAI_MODELS default -- it only
    // resolves if selectDelegateModel's OWN resolved `goOpenai` (from
    // input.goOpenaiModels) is what gets passed into isProxyResolvable for
    // the free-pool filter, rather than isProxyResolvable falling back to
    // its own default parameter.
    //
    // With scoreboard ranking, give the free bare model evidence so it wins
    // over unproven Go anthropic fallback when go lists are empty of evidence.
    recordDelegateWriteOutcome("custom-bare-model", true);
    const result = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      freeModels: ["custom-bare-model"],
      goOpenaiModels: ["custom-bare-model"], // NOT in DELEGATE_GO_OPENAI_MODELS
      goAnthropicModels: [],
      hasOpenCodeGoKey: false,
      installedOllamaModels: [],
    });
    expect(result.model).toBe("custom-bare-model");
    expect(result.pool).toBe("free");
  });
});
