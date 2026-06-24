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

  test("default pool includes requested OpenCode Zen and frontier OpenRouter models", () => {
    const defaultIds = new Set(DEFAULT_ORCHESTRATOR_AGENTS.map((agent) => agent.model_id));

    expect(defaultIds).toContain("opencode/big-pickle");
    expect(defaultIds).toContain("opencode/mimo-v2-pro-free");
    expect(defaultIds).toContain("opencode/minimax-m2.5-free");
    expect(defaultIds).toContain("opencode/nemotron-3-super-free");
    expect(defaultIds).toContain("deepseek/deepseek-v4-flash");
    expect(defaultIds).toContain("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(defaultIds).toContain("cohere/north-mini-code:free");
    expect(defaultIds).toContain("xiaomi/mimo-v2.5");
  });

  test("coordinator defaults to opencode-go Mimo 2.5 and planner defaults to opencode Zen Nemotron Ultra Free", () => {
    // The free router caused 12+ minute stalls on the coordinator/planner
    // stages (post-hang diagnosis 2026-06-24). Pin the coordinator to the
    // OpenCode Go Mimo 2.5 model and the planner to the OpenCode Zen
    // Nemotron Ultra Free model so neither stage can pick the unreliable
    // openrouter/free as its default.
    const coordinator = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.default_for.includes("coordinator"));
    const planner = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.default_for.includes("planner"));

    expect(coordinator).toBeDefined();
    expect(coordinator?.provider).toBe("opencode_go");
    expect(coordinator?.model_id).toBe("opencode-go/mimo-v2-5");

    expect(planner).toBeDefined();
    expect(planner?.provider).toBe("opencode_zen");
    expect(planner?.model_id).toBe("opencode/nemotron-3-ultra-free");
  });

  test("openrouter/free is no longer the default for any stage", () => {
    const routerFree = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.id === "router-free");
    expect(routerFree).toBeDefined();
    // It still exists in the pool as a generic executor/reviewer/
    // synthesizer candidate and as a tail of the fallback cascade,
    // but it must not be the default_for any stage.
    expect(routerFree?.default_for ?? []).toEqual([]);
  });
});
