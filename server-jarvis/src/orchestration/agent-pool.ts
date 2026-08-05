import type { Complexity, StageName, TaskType } from "./coordinator";
import { selectTrialCandidate } from "./model-trial-policy";
import {
  applyLearnedCapabilities,
  empiricalFirstTokenTimeoutFor,
  fallbackBoostFor,
  modelRoutingScoreDelta,
  stageRoutingScoreDelta,
} from "../self-tuning/learned-pool-state";
import {
  rankModelsByReliabilityLatency,
  type ReliabilityLatencyEntry,
} from "./reliability-latency-rank";

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
  /** Authoritative billing class supplied by live provider metadata. */
  billing_tier?: "free" | "go" | "paid";
  /**
   * Stable provider price ordering. Lower values are cheaper. Live catalog
   * enrichment supplies this for OpenCode Go models from the provider's
   * published plan pricing; it is intentionally separate from the learned
   * quality/speed scores so feedback can never silently spend past free
   * capacity or promote a more expensive Go model ahead of a cheaper one.
   */
  cost_rank?: number;
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

export interface AgentSelectionOptions {
  /** Coordinator difficulty signal; high favors capability over stage pins. */
  complexity?: Complexity;
  /** A bounded retry should ask for the strongest eligible alternative. */
  preferStrong?: boolean;
  /**
   * M5: remaining stage budget in ms. When set (and reliability stats are
   * injected via withReliabilityStats), models whose measured p50 first_token
   * exceeds this budget are refused before ranking.
   */
  remainingStageMs?: number;
  /**
   * M1b: when true and `preferLocalForStage(stage)`, inject conductor-class
   * local Ollama models and prefer them over remote free/Go pins. Remote
   * remains available via exclude-driven fallback (same idea as conductor
   * `fallback_to_api`). Callers gate this on Ollama health.
   */
  ollamaAvailable?: boolean;
  /**
   * Optional local model ids for M1b injection. Defaults to
   * {@link DEFAULT_LOCAL_STAGE_MODELS} (qwen3.5:4b / qwen3:8b). Production
   * wiring usually passes the conductor primary + fallback pair.
   */
  localModels?: readonly string[];
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
    default_for: ["coordinator", "synthesizer"],
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
    // Cross-family reviewer: executor defaults use DeepSeek, so review uses
    // Nemotron to reduce shared blind spots. The large model needs the wider
    // first-token allowance below when it is selected.
    default_for: ["reviewer"],
    first_token_timeout_ms: 55_000,
    enabled: true,
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

const FREE_ZEN_MODEL_IDS = new Set([
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "north-mini-code-free",
  "nemotron-3-ultra-free",
  "hy3-free",
]);

/**
 * M1b: stages that prefer a healthy local Ollama lane before remote free/Go.
 * Planner and reviewer are reasoning-light enough for the resident qwen-class
 * models; executor/synthesizer stay remote-first (tool-heavy / user-visible).
 */
export function preferLocalForStage(stage: string): boolean {
  return stage === "planner" || stage === "reviewer";
}

/**
 * Portable local models used when M1b injects candidates and the caller did
 * not supply `selection.localModels`. Mirrors the conductor default pair in
 * config.ts (`qwen3.5:4b` primary, `qwen3:8b` fallback).
 */
export const DEFAULT_LOCAL_STAGE_MODELS: readonly string[] = ["qwen3.5:4b", "qwen3:8b"];

/**
 * Minimum remaining stage window for a local Ollama pick to be worth taking.
 *
 * 2026-08-04 (run_cc660a4d): reviewer routed to qwen3.5:4b, the call errored
 * at 33s, and the stage still burned to its 120s deadline with nothing to show.
 * Planner showed the same shape (56.3s model timeout inside a 158s stage). A
 * local lane that cannot plausibly complete AND leave room for the remote
 * cascade is worse than going remote immediately.
 */
export const LOCAL_STAGE_MIN_WINDOW_MS = 75_000;

/**
 * Build a synthetic pool agent for a local Ollama model. Not stage-pinned
 * (`default_for: []`); selection is driven by {@link preferLocalForStage}
 * rather than competing with remote `default_for` pins.
 */
export function localStageAgent(modelId: string): OrchestratorAgent {
  const safe = modelId.replace(/[^a-zA-Z0-9._:-]+/g, "-");
  return {
    id: `local-stage-${safe}`,
    provider: "ollama",
    model_id: modelId,
    capabilities: {
      code: 0.72,
      reasoning: 0.8,
      speed: 0.88,
      cost: 1,
      json_reliability: 0.82,
    },
    default_for: [],
    enabled: true,
  };
}

/** User capacity policy: free OpenRouter + free Zen + local Ollama, then Go, then paid tail. */
export function orchestrationRoutingTier(agent: OrchestratorAgent): number {
  if (agent.billing_tier === "free") return 0;
  if (agent.billing_tier === "go") return 1;
  if (
    agent.provider === "ollama" ||
    (agent.provider === "openrouter" && (agent.model_id === "openrouter/free" || agent.model_id.endsWith(":free"))) ||
    (agent.provider === "opencode_zen" && (FREE_ZEN_MODEL_IDS.has(agent.model_id) || agent.model_id.endsWith("-free")))
  ) {
    return 0;
  }
  if (agent.provider === "opencode_go") return 1;
  if (agent.provider === "openrouter" || agent.provider === "opencode_zen") return 2;
  return 3;
}

export class AgentPool {
  private agents = new Map<string, OrchestratorAgent>();
  /**
   * Stage/model observation counts for the new-release trial policy. Optional
   * and injected so the pool stays free of telemetry dependencies — when it is
   * absent (tests, health probes, the /agents/pool view) selection behaves
   * exactly as before and no model is trialled.
   */
  private sampleCountFor?: (agent: OrchestratorAgent, stage: string) => number;
  /**
   * M5: optional reliability/latency stats from ModelScorecard (seeded from
   * model_attributions). When absent, pickFor ranking is unchanged.
   */
  private reliabilityStatsFor?: (
    agent: OrchestratorAgent,
    stage: string,
  ) => ReliabilityLatencyEntry | undefined;

  /** Supply observation counts so unproven free lanes can be trialled. */
  withTrialSampleCounts(fn: (agent: OrchestratorAgent, stage: string) => number): this {
    this.sampleCountFor = fn;
    return this;
  }

  /**
   * Supply measured success/latency stats so pickFor can refuse models whose
   * p50 first_token exceeds remaining stage budget and rank survivors by
   * successRate / latency within the active cost tier.
   */
  withReliabilityStats(
    fn: (agent: OrchestratorAgent, stage: string) => ReliabilityLatencyEntry | undefined,
  ): this {
    this.reliabilityStatsFor = fn;
    return this;
  }

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

  pickFor(
    stage: string,
    taskType: TaskType | string,
    exclude?: ReadonlySet<string>,
    selection: AgentSelectionOptions = {},
  ): OrchestratorAgent | undefined {
    // Filter out excluded `provider:model_id` pairs FIRST so we never re-select
    // a model that just returned an empty completion (or hit a rate limit). The
    // exclude set is keyed by `${provider}:${model_id}` to match the format used
    // by `chatCompletionWithFallback` in `index.ts` so the two layers stay
    // consistent.
    const filterExclude = (agent: OrchestratorAgent) =>
      !exclude || (
        !exclude.has(`${agent.provider}:${agent.model_id}`) &&
        !exclude.has(`${agent.provider}:*`)
      );
    let candidates = this.enabled().filter(filterExclude).map(applyLearnedCapabilities);
    // M1b: when Ollama is healthy and this stage prefers local, inject the
    // conductor-class local models (or caller-supplied list) so they can win
    // even if the live pool has no ollama entries. Exclusions still apply so
    // a failed local hop advances to the next local, then remote.
    if (preferLocalForStage(stage) && selection.ollamaAvailable) {
      // Fail fast rather than spend the stage window on a local lane that
      // cannot finish and still leave room for the remote cascade.
      const window = selection.remainingStageMs;
      const windowAllowsLocal =
        typeof window !== "number"
        || !Number.isFinite(window)
        || window >= LOCAL_STAGE_MIN_WINDOW_MS;
      if (windowAllowsLocal) {
        candidates = this.injectLocalStageCandidates(candidates, exclude, selection);
        const localPick = this.pickPreferredLocal(candidates, stage, selection);
        if (localPick) return localPick;
      }
    }
    if (candidates.length === 0) return undefined;
    // Cost/capacity policy is a hard boundary, not another weighted hint. A
    // perfect Go stage pin must not leapfrog any healthy free OpenRouter/Zen
    // model. Only after the entire active tier is excluded does the next tier
    // become eligible.
    const activeTier = Math.min(...candidates.map(orchestrationRoutingTier));
    let tierCandidates = candidates.filter((agent) => orchestrationRoutingTier(agent) === activeTier);
    // M5: refuse models whose measured p50 first_token exceeds remaining stage
    // budget. Never leave the stage uncovered — if every candidate is refused,
    // keep the original tier set (a late answer beats no answer).
    tierCandidates = this.applyReliabilityLatencyFilter(tierCandidates, stage, selection);
    // New-release trial (model-trial-policy.ts). A model discovered from a
    // live catalog is scored from a name-matching regex, which puts any
    // unfamiliar family below the pool median and keeps it there — it can
    // never earn the data that would correct the guess. Try it aggressively
    // until it has enough observations to grade, then let it compete on
    // merit. Runs AFTER the exclusion + tier filters, so an unfit model
    // (>=50% errors over >=6 samples) has already been removed and no trial
    // can leave the active cost tier.
    const trialPick = this.sampleCountFor
      ? selectTrialCandidate(tierCandidates, stage, (agent) => this.sampleCountFor!(agent, stage))
      : undefined;
    if (trialPick) return trialPick;
    const highComplexityBrain = selection.complexity === "high"
      && (stage === "planner" || stage === "executor");
    const stageDefault = highComplexityBrain
      ? undefined
      : tierCandidates.find((agent) => agent.default_for.includes(stage));
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
        if (stage === "synthesizer") return this.preferFastSynthesizer(stageDefault, tierCandidates, taskType);
        return stageDefault;
      }
    }
    return tierCandidates.sort((a, b) => this.compareWithinTier(a, b, stage, taskType, selection))[0];
  }

  /**
   * M1b helper: append synthetic local agents for models not already present
   * in the candidate set (and not excluded).
   */
  private injectLocalStageCandidates(
    candidates: OrchestratorAgent[],
    exclude: ReadonlySet<string> | undefined,
    selection: AgentSelectionOptions,
  ): OrchestratorAgent[] {
    const models = selection.localModels?.length
      ? selection.localModels
      : DEFAULT_LOCAL_STAGE_MODELS;
    const keys = new Set(candidates.map((agent) => `${agent.provider}:${agent.model_id}`));
    const injected: OrchestratorAgent[] = [];
    for (const modelId of models) {
      const key = `ollama:${modelId}`;
      if (keys.has(key)) continue;
      if (exclude?.has(key) || exclude?.has("ollama:*")) continue;
      injected.push(applyLearnedCapabilities(localStageAgent(modelId)));
      keys.add(key);
    }
    return injected.length > 0 ? [...candidates, ...injected] : candidates;
  }

  /**
   * M1b helper: pick the preferred local Ollama agent for a stage.
   * Order: stage-pinned ollama agent (operator config), then preferred model
   * list order, then any remaining ollama agent. Returns undefined when no
   * local candidate remains (caller falls through to remote ranking).
   */
  private pickPreferredLocal(
    candidates: OrchestratorAgent[],
    stage: string,
    selection: AgentSelectionOptions,
  ): OrchestratorAgent | undefined {
    const locals = candidates.filter((agent) => agent.provider === "ollama");
    if (locals.length === 0) return undefined;
    const stagePinned = locals.find((agent) => agent.default_for.includes(stage));
    if (stagePinned) return stagePinned;
    const models = selection.localModels?.length
      ? selection.localModels
      : DEFAULT_LOCAL_STAGE_MODELS;
    locals.sort((a, b) => {
      const ia = models.indexOf(a.model_id);
      const ib = models.indexOf(b.model_id);
      const ra = ia === -1 ? 1000 : ia;
      const rb = ib === -1 ? 1000 : ib;
      if (ra !== rb) return ra - rb;
      return a.id.localeCompare(b.id);
    });
    return locals[0];
  }

  /**
   * M5 hard filter: drop agents whose scorecard p50 first_token exceeds the
   * remaining stage budget (sample >= N). Soft no-op when stats or budget are
   * absent. Never returns an empty list when `agents` was non-empty.
   */
  private applyReliabilityLatencyFilter(
    agents: OrchestratorAgent[],
    stage: string,
    selection: AgentSelectionOptions,
  ): OrchestratorAgent[] {
    if (!this.reliabilityStatsFor) return agents;
    if (
      typeof selection.remainingStageMs !== "number"
      || !Number.isFinite(selection.remainingStageMs)
    ) {
      return agents;
    }
    const entries: ReliabilityLatencyEntry[] = [];
    for (const agent of agents) {
      const entry = this.reliabilityStatsFor(agent, stage);
      if (entry) entries.push(entry);
    }
    if (entries.length === 0) return agents;
    const ranked = rankModelsByReliabilityLatency(entries, selection.remainingStageMs);
    const allowed = new Set(ranked.map((e) => e.key));
    // Agents with no stats are kept (unknown is not refused).
    const filtered = agents.filter((agent) => {
      const key = `${agent.provider}:${agent.model_id}`;
      const hasStats = entries.some((e) => e.key === key);
      return !hasStats || allowed.has(key);
    });
    if (filtered.length === 0) {
      console.warn(
        `[agent-pool] M5 latency filter would empty stage=${stage} tier ` +
        `(remainingStageMs=${selection.remainingStageMs}); keeping unfiltered tier`,
      );
      return agents;
    }
    if (filtered.length < agents.length) {
      const dropped = agents.length - filtered.length;
      console.warn(
        `[agent-pool] M5 latency filter refused ${dropped} model(s) for stage=${stage} ` +
        `(p50 first_token > remainingStageMs=${selection.remainingStageMs})`,
      );
    }
    return filtered;
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
    const sortWithLearning = (a: OrchestratorAgent, b: OrchestratorAgent): number => {
      const tierDelta = orchestrationRoutingTier(a) - orchestrationRoutingTier(b);
      if (tierDelta !== 0) return tierDelta;
      const goCostDelta = this.goCostDelta(a, b);
      if (goCostDelta !== 0) return goCostDelta;
      // Preserve the stage-selected model at the head of its own tier. This
      // keeps fallback metadata truthful while still allowing a lower-cost
      // tier to move ahead if a caller supplied a stale/non-policy selection.
      if (a.id === selected.id) return -1;
      if (b.id === selected.id) return 1;
      let scoreA = this.overallScore(a);
      let scoreB = this.overallScore(b);
      if (stage && taskType) {
        // fallbackBoostFor honors request-scoped canary policy overlay.
        scoreA += fallbackBoostFor(a.id, stage, taskType);
        scoreB += fallbackBoostFor(b.id, stage, taskType);
      }
      scoreA += modelRoutingScoreDelta(a);
      scoreB += modelRoutingScoreDelta(b);
      return scoreB - scoreA;
    };
    return [applyLearnedCapabilities(selected), ...candidates].sort(sortWithLearning);
  }

  cascadeChain(stage: string, taskType: TaskType | string, exclude?: ReadonlySet<string>): OrchestratorAgent[] {
    const filterExclude = (agent: OrchestratorAgent) =>
      !exclude || (
        !exclude.has(`${agent.provider}:${agent.model_id}`) &&
        !exclude.has(`${agent.provider}:*`)
      );
    const candidates = this.enabled().filter(filterExclude).map(applyLearnedCapabilities);
    if (candidates.length === 0) return [];
    const activeTier = Math.min(...candidates.map(orchestrationRoutingTier));
    const tierCandidates = candidates.filter((agent) => orchestrationRoutingTier(agent) === activeTier);
    const cheapFirst = tierCandidates
      .filter((agent) => agent.capabilities.code >= 0.55 || agent.capabilities.reasoning >= 0.55)
      .sort((a, b) => {
        const goCostDelta = this.goCostDelta(a, b);
        return goCostDelta !== 0
          ? goCostDelta
          : this.cascadeCheapScore(b, stage, taskType) - this.cascadeCheapScore(a, stage, taskType);
      })[0];
    if (!cheapFirst) return [];

    const strongSecond = tierCandidates
      .filter((agent) => agent.id !== cheapFirst.id)
      .sort((a, b) => this.compareWithinTier(a, b, stage, taskType))[0];

    return [cheapFirst, strongSecond].filter((agent): agent is OrchestratorAgent => Boolean(agent));
  }

  /**
   * Up to two lanes to race for one stage, on DISTINCT providers.
   *
   * Distinct providers is the point: two lanes behind the same queue share the
   * same first-token tail, so racing them buys nothing. Bounded at two so the
   * free-tier request budget is not multiplied further.
   */
  raceCandidates(stage: string, taskType: TaskType | string): OrchestratorAgent[] {
    const chain = this.cascadeChain(stage, taskType);
    // No explicit `enabled` filter here: `cascadeChain` builds its candidate
    // list from `this.enabled()` (verified by reading its implementation), so
    // a disabled agent can never reach this point.
    const picked: OrchestratorAgent[] = [];
    const seenProviders = new Set<string>();
    for (const agent of chain) {
      if (seenProviders.has(agent.provider)) continue;
      seenProviders.add(agent.provider);
      picked.push(agent);
      if (picked.length === 2) break;
    }
    return picked;
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

  private scoreWithFeedback(
    agent: OrchestratorAgent,
    stage: string,
    taskType: TaskType | string,
    selection: AgentSelectionOptions = {},
  ): number {
    let score = this.score(agent, stage, taskType) + modelRoutingScoreDelta(agent) + stageRoutingScoreDelta(agent, stage);
    if (selection.preferStrong || (selection.complexity === "high" && (stage === "planner" || stage === "executor"))) {
      // Keep the cost tier and learned penalties hard constraints, then bias
      // the remaining candidates toward the capability the stage actually
      // needs. This is deliberately a score adjustment, not a model pin.
      const capability = stage === "planner"
        ? agent.capabilities.reasoning
        : agent.capabilities.code;
      score += capability * 0.35 + agent.capabilities.reasoning * 0.15 + agent.capabilities.code * 0.1;
    }
    return score;
  }

  private goCostDelta(a: OrchestratorAgent, b: OrchestratorAgent): number {
    if (a.provider !== "opencode_go" || b.provider !== "opencode_go") return 0;
    const rankA = Number.isFinite(a.cost_rank) ? Number(a.cost_rank) : (1 - a.capabilities.cost) * 1000;
    const rankB = Number.isFinite(b.cost_rank) ? Number(b.cost_rank) : (1 - b.capabilities.cost) * 1000;
    return rankA - rankB;
  }

  private compareWithinTier(
    a: OrchestratorAgent,
    b: OrchestratorAgent,
    stage: string,
    taskType: TaskType | string,
    selection: AgentSelectionOptions = {},
  ): number {
    // Preserve Go plan cost ordering as a hard policy within the go tier.
    const goCostDelta = this.goCostDelta(a, b);
    if (goCostDelta !== 0) return goCostDelta;
    // M5: among free/paid peers with measured stats, prefer success/latency
    // over raw capability/price scores so a fast reliable free model beats a
    // slow flaky one even when hand-tuned caps favor the slow one.
    const relDelta = this.reliabilityLatencyCompare(a, b, stage);
    if (relDelta !== 0) return relDelta;
    return this.scoreWithFeedback(b, stage, taskType, selection) - this.scoreWithFeedback(a, stage, taskType, selection);
  }

  /**
   * Compare two agents by successRate / p50 first_token. Returns 0 when either
   * side lacks stats so existing scoring remains the tie-breaker.
   * Negative means `a` should sort before `b` (Array.sort ascending: lower first).
   * We return scoreB - scoreA so higher reliability score ranks first.
   */
  private reliabilityLatencyCompare(
    a: OrchestratorAgent,
    b: OrchestratorAgent,
    stage: string,
  ): number {
    if (!this.reliabilityStatsFor) return 0;
    const entryA = this.reliabilityStatsFor(a, stage);
    const entryB = this.reliabilityStatsFor(b, stage);
    if (!entryA || !entryB) return 0;
    // Both need at least one latency sample for the ratio to mean "prefer fast".
    if (
      typeof entryA.p50FirstTokenMs !== "number"
      || typeof entryB.p50FirstTokenMs !== "number"
    ) {
      return 0;
    }
    const ranked = rankModelsByReliabilityLatency([entryA, entryB], undefined);
    if (ranked.length < 2) return 0;
    if (ranked[0]!.key === entryA.key && ranked[0]!.key !== entryB.key) return -1;
    if (ranked[0]!.key === entryB.key && ranked[0]!.key !== entryA.key) return 1;
    return 0;
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
