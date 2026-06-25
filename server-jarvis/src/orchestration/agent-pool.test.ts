import { describe, expect, test } from "bun:test";
import { AgentPool, DEFAULT_ORCHESTRATOR_AGENTS, formatPoolDiversity, type OrchestratorAgent } from "./agent-pool";

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
  test("pickFor prefers an enabled default_for agent for the stage", () => {
    const pool = new AgentPool(agents);

    expect(pool.pickFor("executor", "refactor")?.id).toBe("code-worker");
    expect(pool.pickFor("reviewer", "debug")?.id).toBe("verifier");
  });

  test("pickFor falls back to capability match when no stage default exists", () => {
    const pool = new AgentPool(agents);

    expect(pool.pickFor("rewriter", "refactor")?.id).toBe("code-worker");
    expect(pool.pickFor("rewriter", "research")?.id).toBe("verifier");
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
        model_id: "deepseek/deepseek-v4-flash",
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
    // OpenCode Go (bare ids, OpenAI-compatible; minimax-m3 omitted — Anthropic format)
    expect(byModel).toContain("mimo-v2.5");
    expect(byModel).toContain("deepseek-v4-pro");
    expect(byModel).not.toContain("minimax-m3");
    // OpenRouter (namespaced ids)
    expect(byModel).toContain("openrouter/owl-alpha");
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

  test("coordinator and planner default to reliable OpenCode Zen models, not the free router", () => {
    // The free router caused multi-minute stalls on the coordinator/planner
    // stages (post-hang diagnosis 2026-06-24). Both stages now default to
    // OpenCode Zen models with dedicated keys.
    const coordinator = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.default_for.includes("coordinator"));
    const planner = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.default_for.includes("planner"));

    expect(coordinator).toBeDefined();
    expect(coordinator?.provider).toBe("opencode_zen");
    // Non-reasoning, terminal-JSON model — reasoning-heavy models emit no
    // `content` for short coordinator prompts and break routing.
    expect(coordinator?.model_id).toBe("deepseek-v4-flash-free");

    expect(planner).toBeDefined();
    expect(planner?.provider).toBe("opencode_zen");
    expect(planner?.model_id).toBe("nemotron-3-ultra-free");
  });

  test("no stage defaults to the unreliable openrouter/free router model", () => {
    const stages = ["coordinator", "planner", "executor", "reviewer", "rewriter", "synthesizer"];
    for (const stage of stages) {
      const def = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.default_for.includes(stage));
      expect(def, `stage ${stage} has a default agent`).toBeDefined();
      expect(def?.model_id, `stage ${stage} must not default to openrouter/free`).not.toBe("openrouter/free");
    }
  });
});
