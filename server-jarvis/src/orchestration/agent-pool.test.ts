import { describe, expect, test } from "bun:test";
import {
  AgentPool,
  DEFAULT_ORCHESTRATOR_AGENTS,
  firstTokenTimeoutFor,
  formatPoolDiversity,
  type OrchestratorAgent,
} from "./agent-pool";
import { getLearnedPoolState } from "../self-tuning/learned-pool-state";

const agents: OrchestratorAgent[] = [
  {
    id: "fast-router",
    provider: "openrouter",
    model_id: "openrouter/free",
    capabilities: { code: 0.35, reasoning: 0.45, speed: 0.95, cost: 0.95, json_reliability: 0.7 },
    default_for: ["coordinator", "planner"],
    enabled: true,
  },
  {
    id: "code-worker",
    provider: "openrouter",
    model_id: "qwen/qwen3-coder:free",
    capabilities: { code: 0.95, reasoning: 0.7, speed: 0.55, cost: 0.85, json_reliability: 0.75 },
    default_for: ["executor"],
    enabled: true,
  },
  {
    id: "verifier",
    provider: "openrouter",
    model_id: "nvidia/llama-3.1-nemotron-ultra-253b-v1:free",
    capabilities: { code: 0.55, reasoning: 0.9, speed: 0.45, cost: 0.8, json_reliability: 0.85 },
    default_for: ["reviewer", "synthesizer"],
    enabled: true,
  },
  {
    id: "disabled-paid",
    provider: "openrouter",
    model_id: "anthropic/claude-sonnet-4",
    capabilities: { code: 1, reasoning: 1, speed: 0.4, cost: 0.1, json_reliability: 0.95 },
    default_for: ["executor"],
    enabled: false,
  },
];

describe("AgentPool", () => {
  test("free OpenRouter and Zen capacity outranks an OpenCode Go stage pin", () => {
    const pool = new AgentPool([
      {
        id: "go-pinned",
        provider: "opencode_go",
        model_id: "deepseek-v4-flash",
        capabilities: { code: 1, reasoning: 1, speed: 1, cost: 1, json_reliability: 1 },
        default_for: ["synthesizer"],
        enabled: true,
        cost_rank: 1,
      },
      {
        id: "zen-free",
        provider: "opencode_zen",
        model_id: "mimo-v2.5-free",
        capabilities: { code: 0.7, reasoning: 0.8, speed: 0.7, cost: 1, json_reliability: 0.75 },
        default_for: [],
        enabled: true,
      },
      {
        id: "router-free",
        provider: "openrouter",
        model_id: "vendor/live-zero-cost",
        capabilities: { code: 0.92, reasoning: 0.75, speed: 0.62, cost: 1, json_reliability: 0.8 },
        default_for: [],
        enabled: true,
        billing_tier: "free",
      },
    ]);

    const picked = pool.pickFor("synthesizer", "general");
    expect(picked?.provider).not.toBe("opencode_go");
    expect(["opencode_zen", "openrouter"]).toContain(picked?.provider);
  });

  test("fallbacks exhaust every enabled free model before OpenCode Go, then order Go by cost", () => {
    const freeZen: OrchestratorAgent = {
      id: "zen-free",
      provider: "opencode_zen",
      model_id: "deepseek-v4-flash-free",
      capabilities: { code: 0.8, reasoning: 0.8, speed: 0.8, cost: 1, json_reliability: 0.8 },
      default_for: [],
      enabled: true,
    };
    const freeRouter: OrchestratorAgent = {
      ...freeZen,
      id: "router-free",
      provider: "openrouter",
      model_id: "meta-llama/llama-3.3-70b-instruct:free",
    };
    const expensiveGo: OrchestratorAgent = {
      ...freeZen,
      id: "go-expensive",
      provider: "opencode_go",
      model_id: "glm-5.2",
      cost_rank: 90,
    };
    const cheapGo: OrchestratorAgent = {
      ...freeZen,
      id: "go-cheap",
      provider: "opencode_go",
      model_id: "deepseek-v4-flash",
      default_for: ["executor"],
      cost_rank: 1,
    };
    const mediumGo: OrchestratorAgent = {
      ...freeZen,
      id: "go-medium",
      provider: "opencode_go",
      model_id: "minimax-m3",
      cost_rank: 20,
    };
    const pool = new AgentPool([expensiveGo, freeZen, mediumGo, freeRouter, cheapGo]);

    const selected = pool.pickFor("executor", "debug")!;
    const chain = pool.fallbackChain(selected, "executor", "debug");
    const firstGo = chain.findIndex((agent) => agent.provider === "opencode_go");
    expect(firstGo).toBe(2);
    expect(chain.slice(0, firstGo).every((agent) => agent.provider !== "opencode_go")).toBe(true);
    expect(chain.slice(firstGo).map((agent) => agent.model_id)).toEqual([
      "deepseek-v4-flash",
      "minimax-m3",
      "glm-5.2",
    ]);
  });

  test("cheap and strong cascades stay inside the free tier until it is excluded", () => {
    const pool = new AgentPool([
      {
        id: "free-fast",
        provider: "opencode_zen",
        model_id: "deepseek-v4-flash-free",
        capabilities: { code: 0.75, reasoning: 0.78, speed: 0.95, cost: 1, json_reliability: 0.85 },
        default_for: [],
        enabled: true,
      },
      {
        id: "free-strong",
        provider: "openrouter",
        model_id: "qwen/qwen3-coder:free",
        capabilities: { code: 0.96, reasoning: 0.9, speed: 0.5, cost: 1, json_reliability: 0.9 },
        default_for: [],
        enabled: true,
      },
      {
        id: "go-perfect",
        provider: "opencode_go",
        model_id: "deepseek-v4-pro",
        capabilities: { code: 1, reasoning: 1, speed: 1, cost: 1, json_reliability: 1 },
        default_for: ["executor"],
        enabled: true,
        cost_rank: 10,
      },
    ]);

    expect(pool.cascadeChain("executor", "debug").map((agent) => agent.id)).toEqual([
      "free-fast",
      "free-strong",
    ]);
    expect(pool.cascadeChain("executor", "debug", new Set(["opencode_zen:*", "openrouter:*"]))
      .map((agent) => agent.id)).toEqual(["go-perfect"]);
  });

  test("system_prompt field round-trips through AgentPool.add/list (T3.2)", () => {
    const pool = new AgentPool([]);
    pool.add({
      id: "with-prompt",
      provider: "openrouter",
      model_id: "m",
      capabilities: { code: 0.5, reasoning: 0.5, speed: 0.5, cost: 0.5, json_reliability: 0.5 },
      default_for: [],
      enabled: true,
      system_prompt: "Prefer bullet lists.",
    });
    expect(pool.list().find((a) => a.id === "with-prompt")?.system_prompt).toBe("Prefer bullet lists.");
  });

  test("pickFor prefers an enabled default_for agent for the stage", () => {
    const pool = new AgentPool(agents);

    expect(pool.pickFor("executor", "refactor")?.id).toBe("code-worker");
    expect(pool.pickFor("reviewer", "debug")?.id).toBe("verifier");
  });

  test("provider wildcard exclusions skip every model on a rate-limited endpoint", () => {
    const pool = new AgentPool([
      { ...agents[1], id: "go-pro", provider: "opencode_go", model_id: "deepseek-v4-pro" },
      { ...agents[1], id: "go-flash", provider: "opencode_go", model_id: "deepseek-v4-flash" },
      { ...agents[2], id: "zen-fallback", provider: "opencode_zen", model_id: "deepseek-v4-flash-free", default_for: [] },
    ]);

    expect(pool.pickFor("executor", "debug", new Set(["opencode_go:*"]))?.id).toBe("zen-fallback");
    expect(pool.cascadeChain("executor", "debug", new Set(["opencode_go:*"])).every((agent) => agent.provider !== "opencode_go")).toBe(true);
  });

  test("pickFor keeps a healthy stage default despite a negative learned score", () => {
    const pool = new AgentPool([
      {
        ...agents[0],
        id: "synth-default",
        default_for: ["synthesizer"],
        capabilities: { ...agents[0].capabilities, speed: 0.9 },
      },
      {
        ...agents[2],
        id: "learned-alternative",
        default_for: [],
        capabilities: { ...agents[2].capabilities, reasoning: 1, speed: 0.8 },
      },
    ]);

    const state = getLearnedPoolState();
    // Model-wide delta alone does not demote a pin (T1.6 is stage-scoped).
    state.modelRoutingScoreDeltas.set("openrouter:openrouter/free", -0.25);
    try {
      expect(pool.pickFor("synthesizer", "general")?.id).toBe("synth-default");
    } finally {
      state.modelRoutingScoreDeltas.delete("openrouter:openrouter/free");
    }
  });

  // T1.6: heavy stage-scoped delta demotes the default_for pin.
  test("pickFor demotes default_for pin when stage-scoped delta is heavily negative", () => {
    const pool = new AgentPool([
      {
        ...agents[0],
        id: "coord-default",
        model_id: "bad-coord",
        default_for: ["coordinator"],
        capabilities: { ...agents[0].capabilities, json_reliability: 0.5, speed: 0.5 },
      },
      {
        ...agents[2],
        id: "coord-alt",
        model_id: "good-coord",
        default_for: [],
        capabilities: { ...agents[2].capabilities, json_reliability: 0.95, speed: 0.8 },
      },
    ]);
    const state = getLearnedPoolState();
    // stageModelFeedbackKey = `${provider}:${modelId}:${stage}`
    const key = "openrouter:bad-coord:coordinator";
    state.stageModelRoutingScoreDeltas.set(key, -0.20);
    try {
      const picked = pool.pickFor("coordinator", "general");
      expect(picked?.id).not.toBe("coord-default");
      expect(picked?.id).toBe("coord-alt");
    } finally {
      state.stageModelRoutingScoreDeltas.delete(key);
    }
  });

  test("pickFor keeps pin when stage-scoped delta is only mildly negative", () => {
    const pool = new AgentPool([
      {
        ...agents[0],
        id: "coord-mild",
        model_id: "mild-coord",
        default_for: ["coordinator"],
        capabilities: { ...agents[0].capabilities, json_reliability: 0.9 },
      },
      {
        ...agents[2],
        id: "coord-other",
        model_id: "other-coord",
        default_for: [],
        capabilities: { ...agents[2].capabilities, json_reliability: 0.95 },
      },
    ]);
    const state = getLearnedPoolState();
    const key = "openrouter:mild-coord:coordinator";
    state.stageModelRoutingScoreDeltas.set(key, -0.10); // above demote threshold
    try {
      expect(pool.pickFor("coordinator", "general")?.id).toBe("coord-mild");
    } finally {
      state.stageModelRoutingScoreDeltas.delete(key);
    }
  });

  test("pickFor falls back to capability match when no stage default exists", () => {
    const pool = new AgentPool(agents);

    expect(pool.pickFor("rewriter", "refactor")?.id).toBe("code-worker");
    expect(pool.pickFor("rewriter", "research")?.id).toBe("verifier");
  });

  test("pickFor honors an exclude set keyed by provider:model_id", () => {
    const pool = new AgentPool(agents);
    // The default-for-executor is code-worker. Excluding it must produce a
    // different agent (the next-best by score).
    const exclude = new Set<string>(["openrouter:qwen/qwen3-coder:free"]);
    const picked = pool.pickFor("executor", "refactor", exclude);
    expect(picked?.id).not.toBe("code-worker");
    expect(picked).toBeDefined();
    expect(exclude.has(`${picked!.provider}:${picked!.model_id}`)).toBe(false);
  });

  test("high-complexity planner/executor selection prefers the strongest active-tier brain", () => {
    const pool = new AgentPool([
      {
        id: "default-fast",
        provider: "openrouter",
        model_id: "fast-default:free",
        capabilities: { code: 0.62, reasoning: 0.62, speed: 0.95, cost: 1, json_reliability: 0.8 },
        default_for: ["planner", "executor"],
        enabled: true,
      },
      {
        id: "strong-free",
        provider: "openrouter",
        model_id: "nemotron-strong:free",
        capabilities: { code: 0.95, reasoning: 0.96, speed: 0.45, cost: 1, json_reliability: 0.9 },
        default_for: [],
        enabled: true,
      },
      {
        id: "strong-go",
        provider: "opencode_go",
        model_id: "deepseek-v4-pro",
        capabilities: { code: 1, reasoning: 1, speed: 0.5, cost: 0.8, json_reliability: 0.95 },
        default_for: [],
        enabled: true,
      },
    ]);

    expect(pool.pickFor("planner", "debug", undefined, { complexity: "medium" })?.id).toBe("default-fast");
    expect(pool.pickFor("planner", "debug", undefined, { complexity: "high" })?.id).toBe("strong-free");
    expect(pool.pickFor("executor", "debug", undefined, { complexity: "high" })?.id).toBe("strong-free");
    // Cost policy remains authoritative: high complexity biases within the
    // active tier and only reaches Go when the free tier is excluded.
    expect(pool.pickFor("executor", "debug", new Set(["openrouter:*"]), { complexity: "high" })?.id).toBe("strong-go");
  });

  test("reviewer default is cross-family from the deepseek executor defaults", () => {
    const executor = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.default_for.includes("executor"));
    const reviewer = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.default_for.includes("reviewer"));
    expect(executor?.model_id).toContain("deepseek");
    expect(reviewer?.model_id).toContain("nemotron");
    expect(reviewer?.model_id).not.toBe(executor?.model_id);
  });

  test("pickFor returns undefined when exclude set covers every enabled agent", () => {
    const pool = new AgentPool(agents);
    const exclude = new Set<string>([
      "openrouter:openrouter/free",
      "openrouter:qwen/qwen3-coder:free",
      "openrouter:nvidia/llama-3.1-nemotron-ultra-253b-v1:free",
    ]);
    expect(pool.pickFor("executor", "refactor", exclude)).toBeUndefined();
    expect(pool.pickFor("coordinator", "general", exclude)).toBeUndefined();
  });

  test("cascadeChain honors an exclude set and skips the excluded agent", () => {
    const pool = new AgentPool([
      {
        id: "cheap-fast",
        provider: "openrouter",
        model_id: "cheap-fast:free",
        capabilities: { code: 0.6, reasoning: 0.6, speed: 0.95, cost: 0.95, json_reliability: 0.7 },
        default_for: [],
        enabled: true,
      },
      {
        id: "strong-worker",
        provider: "openrouter",
        model_id: "strong:free",
        capabilities: { code: 0.95, reasoning: 0.85, speed: 0.4, cost: 0.5, json_reliability: 0.85 },
        default_for: [],
        enabled: true,
      },
    ]);

    // Sanity: cheap-fast wins the cheap tier (high speed + cost); strong-worker
    // is the strong tier (high code/reasoning). The cheap-score floor requires
    // code OR reasoning ≥ 0.55.
    const baseline = pool.cascadeChain("executor", "debug");
    expect(baseline.map((agent) => agent.id)).toEqual(["cheap-fast", "strong-worker"]);

    // Excluding cheap-fast should drop it from the chain — the strong tier
    // (strong-worker) is the only one left that meets the cheap floor.
    const exclude = new Set<string>(["openrouter:cheap-fast:free"]);
    const chain = pool.cascadeChain("executor", "debug", exclude);
    expect(chain.map((agent) => agent.id)).not.toContain("cheap-fast");
    expect(chain.map((agent) => agent.id)).toContain("strong-worker");
  });

  test("fallbackChain starts with the selected agent and excludes disabled agents", () => {
    const pool = new AgentPool(agents);
    const chain = pool.fallbackChain(pool.pickFor("executor", "refactor")!);

    expect(chain.map((a) => a.id)[0]).toBe("code-worker");
    expect(chain.map((a) => a.id)).not.toContain("disabled-paid");
    expect(chain.length).toBe(3);
  });

  test("cascadeChain returns a cheap fast agent before a stronger executor", () => {
    const pool = new AgentPool([
      {
        id: "cheap-fast",
        provider: "openrouter",
        model_id: "openrouter/free",
        capabilities: { code: 0.62, reasoning: 0.55, speed: 0.96, cost: 1, json_reliability: 0.7 },
        default_for: ["executor"],
        enabled: true,
      },
      {
        id: "strong-worker",
        provider: "openrouter",
        model_id: "deepseek/deepseek-v4-flash:free",
        capabilities: { code: 0.95, reasoning: 0.88, speed: 0.62, cost: 0.45, json_reliability: 0.85 },
        default_for: ["executor"],
        enabled: true,
      },
    ]);

    expect(pool.cascadeChain("executor", "debug").map((agent) => agent.id)).toEqual([
      "cheap-fast",
      "strong-worker",
    ]);
  });

  test("add, remove, and disable update available agents", () => {
    const pool = new AgentPool([]);
    pool.add(agents[0]);
    pool.add(agents[1]);
    expect(pool.pickFor("executor", "refactor")?.id).toBe("code-worker");

    pool.disable("code-worker");
    expect(pool.pickFor("executor", "refactor")?.id).toBe("fast-router");

    pool.remove("fast-router");
    expect(pool.pickFor("planner", "general")).toBeUndefined();
  });

  test("coverage reports diversity counts and capability gaps", () => {
    const pool = new AgentPool(agents);
    const coverage = pool.coverage();

    expect(coverage.enabled).toBe(3);
    expect(coverage.diversity.code_strong).toBe(1);
    expect(coverage.diversity.reasoning_strong).toBe(1);
    expect(coverage.diversity.fast).toBe(1);
    expect(coverage.diversity.cheap).toBe(3);
    expect(coverage.stage_gaps).toContain("rewriter");
    expect(coverage.stage_gaps).not.toContain("executor");
  });

  // Task 3.4: a provider_diversity of 1 is the monoculture that amplified
  // the 2026-07-11 latency incident (every stage funneled to one slow
  // provider after the others lost eligibility). The coverage surface must
  // make that state visible.
  test("coverage reports per-provider counts and flags a single-provider monoculture", () => {
    const singleProvider = new AgentPool(agents); // fixtures are all openrouter
    const mono = singleProvider.coverage();
    expect(mono.providers).toEqual({ openrouter: 3 });
    expect(mono.provider_diversity).toBe(1);

    const mixed = new AgentPool([
      ...agents,
      {
        id: "go-worker",
        provider: "opencode_go",
        model_id: "deepseek-v4-pro",
        capabilities: { code: 0.9, reasoning: 0.85, speed: 0.5, cost: 0.9, json_reliability: 0.8 },
        default_for: ["executor"],
        enabled: true,
      },
    ]);
    const diverse = mixed.coverage();
    expect(diverse.provider_diversity).toBe(2);
    expect(diverse.providers.opencode_go).toBe(1);
  });

  test("formatPoolDiversity produces the compact metric from the roadmap", () => {
    const pool = new AgentPool(agents);

    expect(formatPoolDiversity(pool.coverage())).toBe("1 code-strong, 1 reasoning-strong, 1 fast, 3 cheap");
  });

  test("default pool wires the provider/model set from the attached agent pool", () => {
    const byModel = new Set(DEFAULT_ORCHESTRATOR_AGENTS.map((agent) => agent.model_id));

    // OpenCode Zen (bare ids, OpenAI-compatible)
    expect(byModel).toContain("mimo-v2.5-free");
    expect(byModel).toContain("nemotron-3-ultra-free");
    expect(byModel).toContain("north-mini-code-free");
    expect(byModel).toContain("deepseek-v4-flash-free");
    // OpenCode Go (bare ids, OpenAI-compatible; minimax-m3 included via /chat/completions)
    expect(byModel).toContain("mimo-v2.5");
    expect(byModel).toContain("deepseek-v4-pro");
    expect(byModel).toContain("minimax-m3");
    // OpenRouter (namespaced ids)
    expect(byModel).toContain("openrouter/free");
    expect(byModel).toContain("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(byModel).toContain("cohere/north-mini-code:free");
    expect(byModel).toContain("deepseek/deepseek-v4-flash");
    expect(byModel).toContain("inclusionai/ling-2.6-flash");
    expect(byModel).toContain("google/gemma-4-31b-it:free");

    // All three HTTP providers are represented so the fallback cascade can
    // hop across providers when one is rate-limited.
    const providers = new Set(DEFAULT_ORCHESTRATOR_AGENTS.map((a) => a.provider));
    expect(providers).toContain("opencode_zen");
    expect(providers).toContain("opencode_go");
    expect(providers).toContain("openrouter");
  });

  test("stage defaults use runnable OpenCode Go models, not stale free Zen ids", () => {
    // The free router caused multi-minute stalls on the coordinator/planner
    // stages (post-hang diagnosis 2026-06-24). Both stages now default to
    // OpenCode Zen models with dedicated keys.
    const coordinator = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.default_for.includes("coordinator"));
    const planner = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.default_for.includes("planner"));
    const executor = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.default_for.includes("executor"));
    const rewriter = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.default_for.includes("rewriter"));
    const synthesizer = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.default_for.includes("synthesizer"));

    expect(coordinator).toBeDefined();
    expect(coordinator?.provider).toBe("opencode_go");
    // Non-reasoning, terminal-JSON model — reasoning-heavy models emit no
    // `content` for short coordinator prompts and break routing.
    expect(coordinator?.model_id).toBe("deepseek-v4-flash");

    expect(planner).toBeDefined();
    expect(planner?.provider).toBe("opencode_go");
    expect(planner?.model_id).toBe("deepseek-v4-pro");
    expect(executor?.model_id).toBe("deepseek-v4-pro");
    expect(rewriter?.model_id).toBe("deepseek-v4-pro");
    expect(synthesizer?.model_id).toBe("deepseek-v4-flash");
  });

  test("deepseek-v4-pro keeps a cold-start first-token allowance", () => {
    const pool = new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS);
    expect(firstTokenTimeoutFor(pool, "deepseek-v4-pro", 30_000)).toBe(45_000);
  });

  test("no stage defaults to the unreliable openrouter/free router model", () => {
    const stages = ["coordinator", "planner", "executor", "reviewer", "rewriter", "synthesizer"];
    for (const stage of stages) {
      const def = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.default_for.includes(stage));
      expect(def, `stage ${stage} has a default agent`).toBeDefined();
      expect(def?.model_id, `stage ${stage} must not default to openrouter/free`).not.toBe("openrouter/free");
    }
  });

  test("synthesizer still uses free capacity when an OpenCode Go model is excluded", () => {
    const pool = new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS);
    const picked = pool.pickFor(
      "synthesizer",
      "general",
      new Set(["opencode_go:deepseek-v4-flash"]),
    );
    expect(["openrouter", "opencode_zen"]).toContain(picked?.provider);
  });

  test("stale Zen Nemotron remains disabled with its documented first-token override", () => {
    // The live diagnosis named `nemotron-3-ultra-free` as a model that
    // hits the 30s first-token watchdog right as valid content begins
    // streaming. The override is the seam that prevents the chain from
    // aborting that turn.
    const planner = DEFAULT_ORCHESTRATOR_AGENTS.find((a) => a.default_for.includes("planner"));
    const synth = DEFAULT_ORCHESTRATOR_AGENTS.find((a) => a.default_for.includes("synthesizer"));
    const nemotron = DEFAULT_ORCHESTRATOR_AGENTS.find((a) => a.model_id === "nemotron-3-ultra-free");
    expect(planner?.model_id).not.toBe("nemotron-3-ultra-free");
    expect(synth?.model_id).not.toBe("nemotron-3-ultra-free");
    expect(nemotron?.enabled).toBe(false);
    expect(nemotron?.first_token_timeout_ms).toBe(55_000);
  });

  test("firstTokenTimeoutFor does not resurrect disabled DEFAULT Zen Nemotron", () => {
    // Regression guard for the 2026-06-27 first-token watchdog bug. The
    // orchestrator and agent-loop call sites in `index.ts` used to compute
    // the per-model override value but pass the global 30_000 constant to
    // `setTimeout(...)` — so slow cold-starts were still aborted at 30s
    // despite the override being "in effect". The fix is for each call
    // site to use `firstTokenTimeoutFor(pool, model, MODEL_FIRST_TOKEN_TIMEOUT_MS)`
    // as the *delay* itself, not just the log message. This test pins the
    // resolution so any future regression in the call site (e.g. someone
    // re-uses the global constant instead of the resolved value) is caught
    // by the helper's contract.
    const defaultPool = new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS);
    const nemotron = DEFAULT_ORCHESTRATOR_AGENTS.find((a) => a.model_id === "nemotron-3-ultra-free");
    // 55_000 must be the resolved value — not 30_000 — so the call site
    // genuinely grants the wider window.
    expect(firstTokenTimeoutFor(defaultPool, nemotron!.model_id, 30_000)).toBe(30_000);
  });
});

describe("pickFor synthesizer fast-prose preference (2026-07-03 incident)", () => {
  // The live config had `zen-nemotron-ultra-free` (speed 0.55) as
  // `default_for: ["planner", "synthesizer"]` — a slow reasoning model
  // sitting on the user-visible answer stage. The synthesizer should prefer
  // a fast candidate when one is available, without touching other stages.
  const slowSynthDefault: OrchestratorAgent = {
    id: "slow-synth-default",
    provider: "opencode_zen",
    model_id: "nemotron-3-ultra-free",
    capabilities: { code: 0.8, reasoning: 0.95, speed: 0.55, cost: 1, json_reliability: 0.88 },
    default_for: ["planner", "synthesizer"],
    enabled: true,
  };
  const fastSynthCandidate: OrchestratorAgent = {
    id: "fast-synth-candidate",
    provider: "opencode_zen",
    model_id: "deepseek-v4-flash-free",
    capabilities: { code: 0.9, reasoning: 0.86, speed: 0.82, cost: 1, json_reliability: 0.9 },
    default_for: [],
    enabled: true,
  };

  test("picks the faster candidate for synthesizer when the default is slow (speed < 0.7)", () => {
    const pool = new AgentPool([slowSynthDefault, fastSynthCandidate]);
    const picked = pool.pickFor("synthesizer", "general");
    expect(picked?.id).toBe("fast-synth-candidate");
  });

  test("keeps the original slow default when no candidate clears the speed >= 0.7 bar", () => {
    const onlySlow = new AgentPool([slowSynthDefault]);
    const picked = onlySlow.pickFor("synthesizer", "general");
    expect(picked?.id).toBe("slow-synth-default");
  });

  test("does not affect other stages with a slow default (e.g. planner)", () => {
    const pool = new AgentPool([slowSynthDefault, fastSynthCandidate]);
    const picked = pool.pickFor("planner", "general");
    expect(picked?.id).toBe("slow-synth-default");
  });

  test("leaves the slow model in the pool as a fallback/cascade candidate", () => {
    const pool = new AgentPool([slowSynthDefault, fastSynthCandidate]);
    const picked = pool.pickFor("synthesizer", "general")!;
    const chain = pool.fallbackChain(picked, "synthesizer", "general");
    expect(chain.map((a) => a.id)).toContain("slow-synth-default");
  });

  test("returns the slow default when the exclude set removes the only fast candidate", () => {
    // Exclusion happens BEFORE the fast-prose demotion, so a fast candidate
    // that just failed (rate limit / empty completion) is not re-selected —
    // and with no fast candidate left, the slow default keeps the stage
    // covered rather than leaving it empty.
    const pool = new AgentPool([slowSynthDefault, fastSynthCandidate]);
    const exclude = new Set<string>([
      `${fastSynthCandidate.provider}:${fastSynthCandidate.model_id}`,
    ]);
    expect(pool.pickFor("synthesizer", "general", exclude)?.id).toBe("slow-synth-default");
  });

  test("does not demote the synthesizer default when it already clears speed >= 0.7", () => {
    const fastDefault: OrchestratorAgent = {
      id: "fast-synth-default",
      provider: "opencode_zen",
      model_id: "deepseek-v4-flash-free",
      capabilities: { code: 0.9, reasoning: 0.86, speed: 0.82, cost: 1, json_reliability: 0.9 },
      default_for: ["synthesizer"],
      enabled: true,
    };
    const pool = new AgentPool([fastDefault, fastSynthCandidate]);
    expect(pool.pickFor("synthesizer", "general")?.id).toBe("fast-synth-default");
  });
});

describe("firstTokenTimeoutFor", () => {
  const poolAgents: OrchestratorAgent[] = [
    {
      id: "swift",
      provider: "openrouter",
      model_id: "openrouter/free",
      capabilities: { code: 0.5, reasoning: 0.5, speed: 0.95, cost: 1, json_reliability: 0.7 },
      default_for: [],
      enabled: true,
    },
    {
      id: "nemotron",
      provider: "opencode_zen",
      model_id: "nemotron-3-ultra-free",
      capabilities: { code: 0.8, reasoning: 0.95, speed: 0.55, cost: 1, json_reliability: 0.88 },
      default_for: ["planner", "synthesizer"],
      first_token_timeout_ms: 55_000,
      enabled: true,
    },
    {
      id: "nemotron-disabled",
      provider: "openrouter",
      model_id: "nvidia/nemotron-3-ultra-550b-a55b:free",
      capabilities: { code: 0.78, reasoning: 0.96, speed: 0.42, cost: 1, json_reliability: 0.88 },
      default_for: [],
      first_token_timeout_ms: 55_000,
      enabled: false,
    },
  ];
  const pool = new AgentPool(poolAgents);

  test("returns the per-model override when the model is in the pool and enabled", () => {
    expect(firstTokenTimeoutFor(pool, "nemotron-3-ultra-free", 30_000)).toBe(55_000);
  });

  test("returns baseMs when the model is in the pool but has no override", () => {
    expect(firstTokenTimeoutFor(pool, "openrouter/free", 30_000)).toBe(30_000);
  });

  test("returns baseMs when the model is not in the pool at all", () => {
    expect(firstTokenTimeoutFor(pool, "some/unknown-model:free", 30_000)).toBe(30_000);
  });

  test("returns baseMs when the pool reference is missing", () => {
    expect(firstTokenTimeoutFor(undefined, "nemotron-3-ultra-free", 30_000)).toBe(30_000);
  });

  test("returns baseMs when the modelId is missing", () => {
    expect(firstTokenTimeoutFor(pool, undefined, 30_000)).toBe(30_000);
  });

  test("ignores overrides on disabled agents — fall back to the global default", () => {
    // The override is on the agent record, but the agent is `enabled: false`.
    // The watchdog should not silently trust an override for a model the pool
    // considers off; fall back to the global base.
    expect(firstTokenTimeoutFor(pool, "nvidia/nemotron-3-ultra-550b-a55b:free", 30_000)).toBe(30_000);
  });

  test("clamps the override to the supplied cap", () => {
    const cap = 40_000;
    expect(firstTokenTimeoutFor(pool, "nemotron-3-ultra-free", 30_000, cap)).toBe(40_000);
  });

  test("clamps the override to the 1s floor (no zero/negative values)", () => {
    const agentsZero: OrchestratorAgent[] = [{
      id: "evil",
      provider: "openrouter",
      model_id: "evil/model",
      capabilities: { code: 0.5, reasoning: 0.5, speed: 0.5, cost: 0.5, json_reliability: 0.5 },
      default_for: [],
      first_token_timeout_ms: 0,
      enabled: true,
    }];
    const p = new AgentPool(agentsZero);
    expect(firstTokenTimeoutFor(p, "evil/model", 30_000)).toBe(1_000);
  });

  test("returns baseMs clamped to 1s floor when baseMs itself is bogus", () => {
    // Defensive: a misconfigured `baseMs` (NaN, negative) must not produce
    // a zero/negative timeout, which would mean "abort immediately."
    expect(firstTokenTimeoutFor(pool, "openrouter/free", Number.NaN)).toBe(30_000);
    expect(firstTokenTimeoutFor(pool, "openrouter/free", -5)).toBe(1_000);
  });

  describe("DEFAULT pool fallback (2026-07-03 incident, session 1d4727cf)", () => {
    // A custom config pool with 16 agents, none carrying
    // `first_token_timeout_ms` for nemotron-3-ultra-free — this reproduces
    // the live user config that caused the 30s abort on a model with a
    // known 55s cold-start profile.
    const customAgents: OrchestratorAgent[] = [
      {
        id: "custom-nemotron",
        provider: "opencode_zen",
        model_id: "nemotron-3-ultra-free",
        capabilities: { code: 0.8, reasoning: 0.95, speed: 0.55, cost: 1, json_reliability: 0.88 },
        default_for: ["synthesizer"],
        // No first_token_timeout_ms — mirrors the live custom config.
        enabled: true,
      },
      {
        id: "custom-fast",
        provider: "opencode_zen",
        model_id: "deepseek-v4-flash-free",
        capabilities: { code: 0.9, reasoning: 0.86, speed: 0.82, cost: 1, json_reliability: 0.9 },
        default_for: ["coordinator"],
        enabled: true,
      },
    ];
    const customPool = new AgentPool(customAgents);

    test("inherits the DEFAULT pool's override by model_id when the active pool omits it", () => {
      // DEFAULT_ORCHESTRATOR_AGENTS carries first_token_timeout_ms: 55_000 for
      // nemotron-3-ultra-free — the active (custom) pool doesn't set it, so
      // the lookup must inherit it rather than fall through to baseMs.
      expect(firstTokenTimeoutFor(customPool, "nemotron-3-ultra-free", 30_000)).toBe(55_000);
    });

    test("a model unknown to both pools still returns the passed default", () => {
      expect(firstTokenTimeoutFor(customPool, "totally/unknown-model", 30_000)).toBe(30_000);
    });

    test("an explicit override in the active pool still wins over the DEFAULT pool's", () => {
      const overridingAgents: OrchestratorAgent[] = [
        {
          id: "custom-nemotron-tuned",
          provider: "opencode_zen",
          model_id: "nemotron-3-ultra-free",
          capabilities: { code: 0.8, reasoning: 0.95, speed: 0.55, cost: 1, json_reliability: 0.88 },
          default_for: ["synthesizer"],
          first_token_timeout_ms: 20_000,
          enabled: true,
        },
      ];
      const overridingPool = new AgentPool(overridingAgents);
      expect(firstTokenTimeoutFor(overridingPool, "nemotron-3-ultra-free", 30_000)).toBe(20_000);
    });

    test("DEFAULT pool inheritance is still clamped to the supplied cap", () => {
      expect(firstTokenTimeoutFor(customPool, "nemotron-3-ultra-free", 30_000, 40_000)).toBe(40_000);
    });

    test("a model disabled in the active pool (no enabled duplicate) does NOT inherit the DEFAULT override", () => {
      // Disabling is an intentional "don't trust this model" signal — the
      // DEFAULT pool's tuning must not silently resurrect it.
      const disabledOnly = new AgentPool([
        {
          id: "custom-nemotron-off",
          provider: "opencode_zen",
          model_id: "nemotron-3-ultra-free",
          capabilities: { code: 0.8, reasoning: 0.95, speed: 0.55, cost: 1, json_reliability: 0.88 },
          default_for: [],
          enabled: false,
        },
      ]);
      expect(firstTokenTimeoutFor(disabledOnly, "nemotron-3-ultra-free", 30_000)).toBe(30_000);
    });

    test("a disabled duplicate model_id does not suppress inheritance for the enabled copy", () => {
      // The pool is keyed by agent `id`, so the same model_id can appear
      // once enabled (no override) and once disabled. The enabled copy is
      // live, so DEFAULT-pool inheritance must still apply — a stale
      // disabled duplicate must not resurrect the 30s-abort bug.
      const duplicatePool = new AgentPool([
        {
          id: "custom-nemotron-on",
          provider: "opencode_zen",
          model_id: "nemotron-3-ultra-free",
          capabilities: { code: 0.8, reasoning: 0.95, speed: 0.55, cost: 1, json_reliability: 0.88 },
          default_for: ["synthesizer"],
          enabled: true,
        },
        {
          id: "custom-nemotron-off",
          provider: "openrouter",
          model_id: "nemotron-3-ultra-free",
          capabilities: { code: 0.8, reasoning: 0.95, speed: 0.55, cost: 1, json_reliability: 0.88 },
          default_for: [],
          enabled: false,
        },
      ]);
      expect(firstTokenTimeoutFor(duplicatePool, "nemotron-3-ultra-free", 30_000)).toBe(55_000);
    });
  });
});
