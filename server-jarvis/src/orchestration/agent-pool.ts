import type { StageName, TaskType } from "./coordinator";
import {
  applyLearnedCapabilities,
  empiricalFirstTokenTimeoutFor,
  fallbackBoostKey,
  getLearnedPoolState,
  modelRoutingScoreDelta,
  stageRoutingScoreDelta,
} from "../self-tuning/learned-pool-state";

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
  /**
   * T3.2: optional agent-specific system prompt (≤4000 chars). Spliced into
   * the leading system message in callModelAttempt when present. Inert until
   * an agent defines it.
   */
  system_prompt?: string;
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
  /**
   * Enabled agents per provider (Task 3.4). The 2026-07-11 pool collapse —
   * every stage funneled to one opencode_go model — happened because zen
   * agents were disabled in live config while OpenRouter 401'd, leaving one
   * eligible provider. A single-provider pool is a latency/availability
   * monoculture the operator should see, not discover from logs.
   */
  providers: Record<string, number>;
  /** Distinct providers among enabled agents. 1 = monoculture warning. */
  provider_diversity: number;
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
// Stage pinning: OpenCode Go models lead each stage because the current
// OpenCode catalog exposes `deepseek-v4-flash`/`deepseek-v4-pro` as runnable
// model ids. The older Zen `*-free` ids are retained as documented catalog
// records but disabled by default; on current keys they can 400, require
// billing, or stall before first token, so they must not be stage defaults or
// automatic fallback picks.
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
    default_for: [],
    enabled: false,
  },
  {
    // mimo-v2.5-free stays in the pool as a general fallback member, but NOT as
    // a stage default — it's reasoning-only for short prompts (emits no content).
    id: "zen-mimo-v25-free",
    provider: "opencode_zen",
    model_id: "mimo-v2.5-free",
    capabilities: { code: 0.72, reasoning: 0.8, speed: 0.7, cost: 1, json_reliability: 0.7 },
    default_for: [],
    enabled: false,
  },
  {
    // Planner + synthesizer → strongest reasoning in the Zen catalog.
    id: "zen-nemotron-ultra-free",
    provider: "opencode_zen",
    model_id: "nemotron-3-ultra-free",
    capabilities: { code: 0.8, reasoning: 0.95, speed: 0.55, cost: 1, json_reliability: 0.88 },
    default_for: [],
    // Live 2026-06-26 diagnosis: this model has reliably-slow cold-start
    // latency and was hitting the 30s first-token watchdog right as valid
    // content began streaming. Per-model override widens the window to 55s
    // (still below the 60s stream-stall cap).
    first_token_timeout_ms: 55_000,
    enabled: false,
  },
  {
    // Executor + rewriter → code-specialized.
    id: "zen-north-code-free",
    provider: "opencode_zen",
    model_id: "north-mini-code-free",
    capabilities: { code: 0.92, reasoning: 0.72, speed: 0.72, cost: 1, json_reliability: 0.8 },
    default_for: [],
    enabled: false,
  },
  // ── OpenCode Go (OpenAI-compatible tail) ────────────────────────
  {
    id: "go-deepseek-v4-flash",
    provider: "opencode_go",
    model_id: "deepseek-v4-flash",
    capabilities: { code: 0.9, reasoning: 0.86, speed: 0.82, cost: 0.85, json_reliability: 0.9 },
    default_for: ["coordinator", "reviewer", "synthesizer"],
    enabled: true,
  },
  {
    id: "go-mimo-v25",
    provider: "opencode_go",
    model_id: "mimo-v2.5",
    capabilities: { code: 0.8, reasoning: 0.85, speed: 0.72, cost: 0.9, json_reliability: 0.86 },
    default_for: [],
    enabled: true,
  },
  {
    // Measured cold starts: 19,278ms and 28,180ms in live stage attribution.
    // Keep a margin below the 60s stream-stall watchdog for routed pro calls.
    id: "go-deepseek-v4-pro",
    provider: "opencode_go",
    model_id: "deepseek-v4-pro",
    capabilities: { code: 0.93, reasoning: 0.9, speed: 0.7, cost: 0.7, json_reliability: 0.85 },
    default_for: ["planner", "executor", "rewriter", "synthesizer"],
    first_token_timeout_ms: 45_000,
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
    id: "or-openrouter-free",
    provider: "openrouter",
    model_id: "openrouter/free",
    capabilities: { code: 0.55, reasoning: 0.65, speed: 0.8, cost: 1, json_reliability: 0.72 },
    default_for: [],
    enabled: true,
  },
  {
    id: "or-nemotron-ultra-free",
    provider: "openrouter",
    model_id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    capabilities: { code: 0.78, reasoning: 0.96, speed: 0.42, cost: 1, json_reliability: 0.88 },
    default_for: [],
    // Same family as `zen-nemotron-ultra-free` — large reasoning model with
    // slow cold-start. Same per-model override.
    first_token_timeout_ms: 55_000,
    enabled: false,
  },
  {
    id: "or-north-code-free",
    provider: "openrouter",
    model_id: "cohere/north-mini-code:free",
    capabilities: { code: 0.92, reasoning: 0.72, speed: 0.7, cost: 1, json_reliability: 0.78 },
    default_for: [],
    enabled: true,
  },
  {
    id: "or-deepseek-v4-flash",
    provider: "openrouter",
    model_id: "deepseek/deepseek-v4-flash",
    capabilities: { code: 0.9, reasoning: 0.86, speed: 0.78, cost: 0.55, json_reliability: 0.82 },
    default_for: [],
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

// Minimum `capabilities.speed` for a model to serve as the synthesizer's
// primary pick (see `preferFastSynthesizer`). Intentionally lower than the
// 0.8 "fast" diversity bar in `coverage()` — that bar counts genuinely quick
// models for pool-health reporting, while this one only needs to exclude
// slow reasoning models (e.g. speed 0.55 nemotron) from the user-visible
// answer stage.
const SYNTHESIZER_MIN_SPEED = 0.7;

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

  /**
   * Stage-scoped learned penalty threshold for demoting a `default_for` pin
   * (T1.6). A model with ≤ -0.15 stage-scoped delta is skipped as the pin and
   * scored ranking takes over. Milder penalties keep the pin. Stage-scoped so
   * a model bad at coordinator JSON can still be a fine synthesizer.
   */
  static readonly DEFAULT_FOR_DEMOTE_DELTA = -0.15;

  pickFor(stage: string, taskType: TaskType | string, exclude?: ReadonlySet<string>): OrchestratorAgent | undefined {
    // Filter out excluded `provider:model_id` pairs FIRST so we never re-select
    // a model that just returned an empty completion (or hit a rate limit). The
    // exclude set is keyed by `${provider}:${model_id}` to match the format used
    // by `chatCompletionWithFallback` in `index.ts` so the two layers stay
    // consistent.
    const filterExclude = (agent: OrchestratorAgent) =>
      !exclude || !exclude.has(`${agent.provider}:${agent.model_id}`);
    const candidates = this.enabled().filter(filterExclude).map(applyLearnedCapabilities);
    if (candidates.length === 0) return undefined;
    const stageDefault = candidates.find((agent) => agent.default_for.includes(stage));
    if (stageDefault) {
      // T1.6: heavy stage-scoped learned penalty demotes the pin so a
      // coordinator with 18% parse success stops being re-selected every turn.
      // Exclusions still win above via filterExclude.
      const stageDelta = stageRoutingScoreDelta(stageDefault, stage);
      if (stageDelta <= AgentPool.DEFAULT_FOR_DEMOTE_DELTA) {
        console.warn(
          `[agent-pool] default_for pin demoted for stage=${stage} model=${stageDefault.model_id} ` +
          `stage_delta=${stageDelta.toFixed(3)} ≤ ${AgentPool.DEFAULT_FOR_DEMOTE_DELTA}; falling through to scored ranking`,
        );
      } else {
        if (stage === "synthesizer") return this.preferFastSynthesizer(stageDefault, candidates, taskType);
        return stageDefault;
      }
    }
    return candidates.sort((a, b) => this.scoreWithFeedback(b, stage, taskType) - this.scoreWithFeedback(a, stage, taskType))[0];
  }

  /**
   * Live incident 2026-07-03 (session 1d4727cf, turn 1): a custom config pool
   * resolved `nemotron-3-ultra-free` — a strong-reasoning but slow model
   * (pool speed 0.55) — as the `default_for: ["synthesizer"]` pick, which is
   * the user-visible answer stage. Slow cold-starts there read as the
   * assistant hanging. Reasoning quality matters less than latency for the
   * synthesizer specifically (it's turning already-gathered context into
   * prose, not solving a hard problem), so when the stage default is slow
   * (speed < 0.7) we demote it to fallback/cascade position and promote the
   * best-scoring candidate that still clears the speed bar. If nothing
   * clears the bar, we keep the original default rather than leave the
   * stage uncovered — a slow answer beats no answer. Reuses the same
   * `score` machinery `pickFor` already falls back to for other stages, so
   * this isn't a parallel selection path — just a narrower candidate set.
   */
  private preferFastSynthesizer(
    stageDefault: OrchestratorAgent,
    candidates: OrchestratorAgent[],
    taskType: TaskType | string,
  ): OrchestratorAgent {
    if (stageDefault.capabilities.speed >= SYNTHESIZER_MIN_SPEED) return stageDefault;
    const fastCandidates = candidates.filter((agent) => agent.capabilities.speed >= SYNTHESIZER_MIN_SPEED);
    if (fastCandidates.length === 0) return stageDefault;
    const replacement = fastCandidates.sort(
      (a, b) => this.score(b, "synthesizer", taskType) - this.score(a, "synthesizer", taskType),
    )[0]!;
    console.warn(
      `[agent-pool] synthesizer default "${stageDefault.model_id}" demoted (speed ${stageDefault.capabilities.speed} < ${SYNTHESIZER_MIN_SPEED}); ` +
        `using "${replacement.model_id}" (speed ${replacement.capabilities.speed}) for fast prose instead. ` +
        `"${stageDefault.model_id}" remains available as a fallback/cascade member.`,
    );
    return replacement;
  }

  fallbackChain(selected: OrchestratorAgent, stage?: string, taskType?: TaskType | string): OrchestratorAgent[] {
    const candidates = this.enabled()
      .filter((agent) => agent.id !== selected.id)
      .map(applyLearnedCapabilities);
    const learned = getLearnedPoolState();
    const sortWithLearning = (a: OrchestratorAgent, b: OrchestratorAgent): number => {
      let scoreA = this.overallScore(a);
      let scoreB = this.overallScore(b);
      if (stage && taskType) {
        scoreA += learned.fallbackBoosts.get(fallbackBoostKey(a.id, stage, taskType)) ?? 0;
        scoreB += learned.fallbackBoosts.get(fallbackBoostKey(b.id, stage, taskType)) ?? 0;
      }
      scoreA += modelRoutingScoreDelta(a);
      scoreB += modelRoutingScoreDelta(b);
      return scoreB - scoreA;
    };
    return [
      applyLearnedCapabilities(selected),
      ...candidates.sort(sortWithLearning),
    ];
  }

  cascadeChain(stage: string, taskType: TaskType | string, exclude?: ReadonlySet<string>): OrchestratorAgent[] {
    const filterExclude = (agent: OrchestratorAgent) =>
      !exclude || !exclude.has(`${agent.provider}:${agent.model_id}`);
    const candidates = this.enabled().filter(filterExclude).map(applyLearnedCapabilities);
    if (candidates.length === 0) return [];
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
    const providers: Record<string, number> = {};
    for (const agent of enabled) {
      providers[agent.provider] = (providers[agent.provider] ?? 0) + 1;
    }
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
      providers,
      provider_diversity: Object.keys(providers).length,
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

  private scoreWithFeedback(agent: OrchestratorAgent, stage: string, taskType: TaskType | string): number {
    return this.score(agent, stage, taskType) + modelRoutingScoreDelta(agent) + stageRoutingScoreDelta(agent, stage);
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
 *   1. Exact `model_id` match in the ACTIVE pool with a `first_token_timeout_ms` set.
 *   2. Exact `model_id` match in the DEFAULT pool with a `first_token_timeout_ms` set.
 *   3. `baseMs` argument (the caller's default — usually the global 30s).
 * Step 2 exists because of the 2026-07-03 incident (session 1d4727cf): a
 * user's live config supplies a fully CUSTOM `orchestrator.agents` array (16
 * agents, none carrying `first_token_timeout_ms`), and the active pool at the
 * call site is built straight from that config — so it silently shadows the
 * DEFAULT pool's per-model overrides. `nemotron-3-ultra-free` has a known
 * 55s cold-start profile (see DEFAULT_ORCHESTRATOR_AGENTS above), but the
 * custom pool has no opinion on it, so the lookup fell through to the global
 * 30s and aborted mid-stream right as content began arriving. A missing
 * tuning field in a custom pool must not silently discard a model's known
 * cold-start profile — inherit it from the DEFAULT pool by `model_id` before
 * giving up and using the generic default. Exception: if the active pool
 * knows the model_id but has explicitly disabled it, that's a deliberate
 * "don't trust this model" signal and the DEFAULT pool's override is not
 * inherited (matches the pre-existing "disabled agents don't get overrides"
 * contract this helper already had).
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
  provider?: string,
): number {
  const fallback = Math.max(1_000, Number(baseMs) || 30_000);
  if (!modelId) return Math.min(fallback, capMs);
  const match = pool?.enabled().find((agent) => agent.model_id === modelId);
  // The pool is keyed by agent `id`, so the same model_id can exist twice —
  // once enabled, once disabled. The disable carve-out only applies when NO
  // enabled copy is live; otherwise a stale disabled duplicate would suppress
  // DEFAULT-pool inheritance for the enabled copy and resurrect the 30s-abort
  // bug this helper exists to prevent.
  const knownButDisabled =
    Boolean(pool) && !match && pool!.list().some((agent) => agent.model_id === modelId && !agent.enabled);
  const empirical = knownButDisabled
    ? undefined
    : empiricalFirstTokenTimeoutFor(modelId, provider ?? match?.provider);
  if (empirical !== undefined) {
    return Math.max(1_000, Math.min(empirical, capMs));
  }
  if (!pool) return Math.min(fallback, capMs);
  let override = match?.first_token_timeout_ms;
  if ((typeof override !== "number" || !Number.isFinite(override)) && !knownButDisabled) {
    // Active pool has no opinion for this model — fall back to the DEFAULT
    // pool's override for the same model_id before giving up entirely. Skip
    // this when the active pool explicitly disabled the model: disabling is
    // an intentional "don't trust this model" signal that must not be
    // silently overridden by the DEFAULT pool's tuning.
    const defaultMatch = DEFAULT_ORCHESTRATOR_AGENTS.find((agent) => agent.model_id === modelId);
    override = defaultMatch?.first_token_timeout_ms;
  }
  if (typeof override !== "number" || !Number.isFinite(override)) {
    return Math.min(fallback, capMs);
  }
  return Math.max(1_000, Math.min(Number(override), capMs));
}
