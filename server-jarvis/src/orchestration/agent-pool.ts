import type { StageName, TaskType } from "./coordinator";

export interface AgentCapabilities {
  code: number;
  reasoning: number;
  speed: number;
  cost: number;
  json_reliability: number;
}

export interface OrchestratorAgent {
  id: string;
  provider: "openrouter" | "ollama" | "claude_cli" | "opencode_zen" | "opencode_go";
  model_id: string;
  capabilities: AgentCapabilities;
  default_for: string[];
  enabled: boolean;
  /**
   * Optional per-model first-token timeout override in milliseconds. Use when a
   * known-good model has reliably-slow cold-start latency (e.g. large reasoning
   * models) and the default 30s first-token watchdog is too tight. When omitted,
   * `firstTokenTimeoutFor` falls back to the supplied `baseMs` argument (which
   * itself defaults to 30s). The cap is enforced by the caller so this value
   * cannot exceed the outer 60s stream-stall watchdog.
   */
  first_token_timeout_ms?: number;
}

export interface AgentPoolCoverage {
  total: number;
  enabled: number;
  diversity: {
    code_strong: number;
    reasoning_strong: number;
    fast: number;
    cheap: number;
  };
  stage_gaps: string[];
}

export const ORCHESTRATOR_STAGES = [
  "coordinator",
  "planner",
  "executor",
  "reviewer",
  "rewriter",
  "synthesizer",
] as const;

// Provider routing note: `model_id` is the EXACT id each provider's
// /chat/completions endpoint expects. OpenCode Zen/Go use bare ids
// (e.g. "mimo-v2.5-free"); OpenRouter uses namespaced ids
// (e.g. "nvidia/nemotron-3-ultra-550b-a55b:free"). The endpoint + key for
// each provider are resolved at request time via `resolveProviderTarget`
// (see providers.ts), so the same fallback cascade can hop across providers.
//
// Stage pinning: the OpenCode Zen models lead each stage (most reliable,
// dedicated keys, no free-router hangs). OpenCode Go and OpenRouter free
// models form the cross-provider fallback tail so a single provider's rate
// limit or outage never kills a turn. OpenCode Go `minimax-m3` IS included (it
// serves OpenAI-compatible /chat/completions) as a non-default reasoning
// fallback member; its `<think>` blocks are stripped by buildSynthesizerContext
// and the chat ReasoningParser. It is never a stage default (would burn budget
// on reasoning for short JSON like the coordinator needs).
export const DEFAULT_ORCHESTRATOR_AGENTS: OrchestratorAgent[] = [
  // ── OpenCode Zen (primary, OpenAI-compatible) ───────────────────
  {
    // Coordinator → short JSON routing decisions: fast, terminal, NO reasoning
    // overhead. deepseek-v4-flash-free emits clean JSON content directly
    // (verified) — unlike the reasoning-heavy mimo models, which burn their
    // token budget on <think> and leave `content` empty, breaking routing.
    id: "zen-deepseek-v4-flash-free",
    provider: "opencode_zen",
    model_id: "deepseek-v4-flash-free",
    capabilities: { code: 0.9, reasoning: 0.86, speed: 0.82, cost: 1, json_reliability: 0.9 },
    default_for: ["coordinator", "reviewer"],
    enabled: true,
  },
  {
    // mimo-v2.5-free stays in the pool as a general fallback member, but NOT as
    // a stage default — it's reasoning-only for short prompts (emits no content).
    id: "zen-mimo-v25-free",
    provider: "opencode_zen",
    model_id: "mimo-v2.5-free",
    capabilities: { code: 0.72, reasoning: 0.8, speed: 0.7, cost: 1, json_reliability: 0.7 },
    default_for: [],
    enabled: true,
  },
  {
    // Planner + synthesizer → strongest reasoning in the Zen catalog.
    id: "zen-nemotron-ultra-free",
    provider: "opencode_zen",
    model_id: "nemotron-3-ultra-free",
    capabilities: { code: 0.8, reasoning: 0.95, speed: 0.55, cost: 1, json_reliability: 0.88 },
    default_for: ["planner", "synthesizer"],
    // Live 2026-06-26 diagnosis: this model has reliably-slow cold-start
    // latency and was hitting the 30s first-token watchdog right as valid
    // content began streaming. Per-model override widens the window to 55s
    // (still below the 60s stream-stall cap).
    first_token_timeout_ms: 55_000,
    enabled: true,
  },
  {
    // Executor + rewriter → code-specialized.
    id: "zen-north-code-free",
    provider: "opencode_zen",
    model_id: "north-mini-code-free",
    capabilities: { code: 0.92, reasoning: 0.72, speed: 0.72, cost: 1, json_reliability: 0.8 },
    default_for: ["executor", "rewriter"],
    enabled: true,
  },
  // ── OpenCode Go (OpenAI-compatible tail) ────────────────────────
  {
    id: "go-mimo-v25",
    provider: "opencode_go",
    model_id: "mimo-v2.5",
    capabilities: { code: 0.8, reasoning: 0.85, speed: 0.72, cost: 0.9, json_reliability: 0.86 },
    default_for: [],
    enabled: true,
  },
  {
    id: "go-deepseek-v4-pro",
    provider: "opencode_go",
    model_id: "deepseek-v4-pro",
    capabilities: { code: 0.93, reasoning: 0.9, speed: 0.6, cost: 0.7, json_reliability: 0.85 },
    default_for: ["executor"],
    enabled: true,
  },
  {
    // MiniMax M3 — strong reasoning, OpenCode Go via /chat/completions. Pure
    // fallback tail member (default_for: []) — never coordinator (emits <think>).
    id: "go-minimax-m3",
    provider: "opencode_go",
    model_id: "minimax-m3",
    capabilities: { code: 0.85, reasoning: 0.9, speed: 0.6, cost: 0.7, json_reliability: 0.78 },
    default_for: [],
    enabled: true,
  },
  // ── OpenRouter (cross-provider fallback tail) ───────────────────
  {
    id: "or-owl-alpha",
    provider: "openrouter",
    model_id: "openrouter/owl-alpha",
    capabilities: { code: 0.6, reasoning: 0.72, speed: 0.8, cost: 1, json_reliability: 0.78 },
    default_for: [],
    enabled: true,
  },
  {
    id: "or-nemotron-ultra-free",
    provider: "openrouter",
    model_id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    capabilities: { code: 0.78, reasoning: 0.96, speed: 0.42, cost: 1, json_reliability: 0.88 },
    default_for: ["reviewer"],
    // Same family as `zen-nemotron-ultra-free` — large reasoning model with
    // slow cold-start. Same per-model override.
    first_token_timeout_ms: 55_000,
    enabled: true,
  },
  {
    id: "or-north-code-free",
    provider: "openrouter",
    model_id: "cohere/north-mini-code:free",
    capabilities: { code: 0.92, reasoning: 0.72, speed: 0.7, cost: 1, json_reliability: 0.78 },
    default_for: ["rewriter"],
    enabled: true,
  },
  {
    id: "or-deepseek-v4-flash",
    provider: "openrouter",
    model_id: "deepseek/deepseek-v4-flash",
    capabilities: { code: 0.9, reasoning: 0.86, speed: 0.78, cost: 0.55, json_reliability: 0.82 },
    default_for: ["executor", "reviewer"],
    enabled: true,
  },
  {
    id: "or-nemotron-nano-reasoning-free",
    provider: "openrouter",
    model_id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    capabilities: { code: 0.6, reasoning: 0.82, speed: 0.85, cost: 1, json_reliability: 0.8 },
    default_for: [],
    enabled: true,
  },
  {
    id: "or-ling-flash",
    provider: "openrouter",
    model_id: "inclusionai/ling-2.6-flash",
    capabilities: { code: 0.7, reasoning: 0.78, speed: 0.88, cost: 0.8, json_reliability: 0.8 },
    default_for: [],
    enabled: true,
  },
  {
    id: "or-gemma4-free",
    provider: "openrouter",
    model_id: "google/gemma-4-31b-it:free",
    capabilities: { code: 0.62, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.76 },
    default_for: [],
    enabled: true,
  },
  {
    id: "or-laguna-m1-free",
    provider: "openrouter",
    model_id: "poolside/laguna-m.1:free",
    capabilities: { code: 0.85, reasoning: 0.74, speed: 0.7, cost: 1, json_reliability: 0.76 },
    default_for: [],
    enabled: true,
  },
  {
    id: "or-laguna-xs2-free",
    provider: "openrouter",
    model_id: "poolside/laguna-xs.2:free",
    capabilities: { code: 0.8, reasoning: 0.68, speed: 0.85, cost: 1, json_reliability: 0.74 },
    default_for: [],
    enabled: true,
  },
];

export class AgentPool {
  private agents = new Map<string, OrchestratorAgent>();

  constructor(agents: OrchestratorAgent[]) {
    for (const agent of agents) this.add(agent);
  }

  list(): OrchestratorAgent[] {
    return Array.from(this.agents.values());
  }

  enabled(): OrchestratorAgent[] {
    return this.list().filter((agent) => agent.enabled);
  }

  add(agent: OrchestratorAgent): void {
    this.agents.set(agent.id, { ...agent, default_for: [...agent.default_for] });
  }

  remove(id: string): void {
    this.agents.delete(id);
  }

  disable(id: string): void {
    const agent = this.agents.get(id);
    if (agent) this.agents.set(id, { ...agent, enabled: false });
  }

  pickFor(stage: string, taskType: TaskType | string): OrchestratorAgent | undefined {
    const candidates = this.enabled();
    const stageDefault = candidates.find((agent) => agent.default_for.includes(stage));
    if (stageDefault) return stageDefault;
    return candidates.sort((a, b) => this.score(b, stage, taskType) - this.score(a, stage, taskType))[0];
  }

  fallbackChain(selected: OrchestratorAgent): OrchestratorAgent[] {
    const candidates = this.enabled().filter((agent) => agent.id !== selected.id);
    return [
      selected,
      ...candidates.sort((a, b) => this.overallScore(b) - this.overallScore(a)),
    ];
  }

  cascadeChain(stage: string, taskType: TaskType | string): OrchestratorAgent[] {
    const candidates = this.enabled();
    const cheapFirst = candidates
      .filter((agent) => agent.capabilities.code >= 0.55 || agent.capabilities.reasoning >= 0.55)
      .sort((a, b) => this.cascadeCheapScore(b, stage, taskType) - this.cascadeCheapScore(a, stage, taskType))[0];
    if (!cheapFirst) return [];

    const strongSecond = candidates
      .filter((agent) => agent.id !== cheapFirst.id)
      .sort((a, b) => this.score(b, stage, taskType) - this.score(a, stage, taskType))[0];

    return [cheapFirst, strongSecond].filter((agent): agent is OrchestratorAgent => Boolean(agent));
  }

  coverage(): AgentPoolCoverage {
    const enabled = this.enabled();
    return {
      total: this.agents.size,
      enabled: enabled.length,
      diversity: {
        code_strong: enabled.filter((agent) => agent.capabilities.code >= 0.8).length,
        reasoning_strong: enabled.filter((agent) => agent.capabilities.reasoning >= 0.8).length,
        fast: enabled.filter((agent) => agent.capabilities.speed >= 0.8).length,
        cheap: enabled.filter((agent) => agent.capabilities.cost >= 0.8).length,
      },
      stage_gaps: ORCHESTRATOR_STAGES.filter((stage) => !enabled.some((agent) => agent.default_for.includes(stage))),
    };
  }

  private score(agent: OrchestratorAgent, stage: string, taskType: TaskType | string): number {
    const caps = agent.capabilities;
    const stageWeights = taskType === "research" || taskType === "plan" || taskType === "docs"
      ? { reasoning: 0.45, json_reliability: 0.25, speed: 0.1, cost: 0.1, code: 0.1 }
      : stage === "executor" || stage === "rewriter"
      ? { code: 0.45, reasoning: 0.25, json_reliability: 0.15, speed: 0.1, cost: 0.05 }
      : stage === "reviewer" || stage === "synthesizer"
        ? { reasoning: 0.45, json_reliability: 0.25, code: 0.15, speed: 0.05, cost: 0.1 }
        : { speed: 0.3, cost: 0.25, json_reliability: 0.2, reasoning: 0.15, code: 0.1 };
    const taskBoost = taskType === "refactor" || taskType === "debug" || taskType === "code_review" || taskType === "test"
      ? caps.code * 0.2
      : taskType === "research" || taskType === "plan" || taskType === "docs"
        ? caps.reasoning * 0.2
        : 0;
    return this.weighted(caps, stageWeights) + taskBoost;
  }

  private overallScore(agent: OrchestratorAgent): number {
    return this.weighted(agent.capabilities, {
      code: 0.25,
      reasoning: 0.25,
      json_reliability: 0.2,
      speed: 0.15,
      cost: 0.15,
    });
  }

  private cascadeCheapScore(agent: OrchestratorAgent, stage: string, taskType: TaskType | string): number {
    const caps = agent.capabilities;
    return this.weighted(caps, {
      speed: 0.35,
      cost: 0.35,
      json_reliability: 0.1,
      code: stage === "executor" || taskType === "debug" || taskType === "refactor" ? 0.15 : 0.05,
      reasoning: stage === "reviewer" || taskType === "research" || taskType === "plan" ? 0.15 : 0.05,
    });
  }

  private weighted(caps: AgentCapabilities, weights: Partial<Record<keyof AgentCapabilities, number>>): number {
    return Object.entries(weights).reduce((sum, [key, weight]) => {
      return sum + caps[key as keyof AgentCapabilities] * (weight ?? 0);
    }, 0);
  }
}

export function formatPoolDiversity(coverage: AgentPoolCoverage): string {
  return [
    `${coverage.diversity.code_strong} code-strong`,
    `${coverage.diversity.reasoning_strong} reasoning-strong`,
    `${coverage.diversity.fast} fast`,
    `${coverage.diversity.cheap} cheap`,
  ].join(", ");
}

/**
 * Resolve the first-token watchdog timeout (in ms) for a model that may be
 * present in the agent pool. Lookup order:
 *   1. Exact `model_id` match in the pool with a `first_token_timeout_ms` set.
 *   2. `baseMs` argument (the caller's default — usually the global 30s).
 * The returned value is clamped to `[1_000, capMs]` so it can never exceed the
 * outer stream-stall watchdog and can never be zero/negative. Pass
 * `capMs = Infinity` to skip the upper clamp (used by callers that don't have
 * a stall watchdog layered above).
 */
export function firstTokenTimeoutFor(
  pool: AgentPool | undefined,
  modelId: string | undefined,
  baseMs: number,
  capMs: number = 60_000,
): number {
  const fallback = Math.max(1_000, Number(baseMs) || 30_000);
  if (!pool || !modelId) return Math.min(fallback, capMs);
  const match = pool.enabled().find((agent) => agent.model_id === modelId);
  const override = match?.first_token_timeout_ms;
  if (typeof override !== "number" || !Number.isFinite(override)) {
    return Math.min(fallback, capMs);
  }
  return Math.max(1_000, Math.min(Number(override), capMs));
}
