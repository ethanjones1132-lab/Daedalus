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

export const DEFAULT_ORCHESTRATOR_AGENTS: OrchestratorAgent[] = [
  {
    // Coordinator → OpenCode Go / Mimo 2.5. The coordinator only emits
    // short JSON routing decisions, so we want a fast, json-reliable,
    // reasoning-light model here. Mimo 2.5 fits that profile and the
    // OpenCode Go namespace has been our most reliable for cron work
    // (jarvis cron model = opencode-go/minimax-m3, with mimo-v2.5-pro
    // also used by other cron jobs). We deliberately avoid openrouter/free
    // here because the free router hangs on long-context coordinator
    // calls and surfaces no error to the caller (see the post-hang
    // diagnosis: 12-minute stalls on the planner call to openrouter/free).
    id: "go-mimo-v2-5-coordinator",
    provider: "opencode_go",
    model_id: "opencode-go/mimo-v2-5",
    capabilities: { code: 0.72, reasoning: 0.78, speed: 0.7, cost: 1, json_reliability: 0.88 },
    default_for: ["coordinator"],
    enabled: true,
  },
  {
    // Planner → OpenCode Zen / Nemotron Ultra Free. The planner needs
    // strong reasoning (chain-of-thought over the user's request) and
    // produces a structured markdown plan. Nemotron Ultra Free is the
    // highest-reasoning free model in the OpenCode Zen catalog and is
    // substantially more reliable than openrouter/free for streaming a
    // long plan to completion without dropping bytes mid-stream.
    id: "zen-nemotron-3-ultra-free-planner",
    provider: "opencode_zen",
    model_id: "opencode/nemotron-3-ultra-free",
    capabilities: { code: 0.78, reasoning: 0.94, speed: 0.5, cost: 1, json_reliability: 0.86 },
    default_for: ["planner"],
    enabled: true,
  },
  {
    // router-free is kept as a generic executor/reviewer/synthesizer
    // candidate only. It is no longer default_for any stage — the
    // coordinator and planner are pinned to the dedicated Go/Zen
    // models above. The free router is still useful for tool execution
    // (cheap, fast) and as a tail of the fallback cascade.
    id: "router-free",
    provider: "openrouter",
    model_id: "openrouter/free",
    capabilities: { code: 0.35, reasoning: 0.55, speed: 0.9, cost: 1, json_reliability: 0.75 },
    default_for: [],
    enabled: true,
  },
  {
    id: "code-free",
    provider: "openrouter",
    model_id: "qwen/qwen3-coder:free",
    capabilities: { code: 0.9, reasoning: 0.7, speed: 0.55, cost: 0.95, json_reliability: 0.75 },
    default_for: ["executor", "rewriter"],
    enabled: true,
  },
  {
    id: "north-code-mini-free",
    provider: "openrouter",
    model_id: "cohere/north-mini-code:free",
    capabilities: { code: 0.92, reasoning: 0.72, speed: 0.7, cost: 1, json_reliability: 0.78 },
    default_for: ["executor", "rewriter"],
    enabled: true,
  },
  {
    id: "deepseek-v4-flash",
    provider: "openrouter",
    model_id: "deepseek/deepseek-v4-flash",
    capabilities: { code: 0.9, reasoning: 0.86, speed: 0.78, cost: 0.55, json_reliability: 0.82 },
    default_for: ["executor", "reviewer"],
    enabled: true,
  },
  {
    id: "verifier-free",
    provider: "openrouter",
    model_id: "nvidia/llama-3.1-nemotron-ultra-253b-v1:free",
    capabilities: { code: 0.6, reasoning: 0.9, speed: 0.45, cost: 0.9, json_reliability: 0.85 },
    default_for: ["reviewer", "synthesizer"],
    enabled: true,
  },
  {
    id: "nemotron-ultra-free",
    provider: "openrouter",
    model_id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    capabilities: { code: 0.78, reasoning: 0.96, speed: 0.42, cost: 1, json_reliability: 0.88 },
    default_for: ["reviewer", "synthesizer"],
    enabled: true,
  },
  {
    id: "mimo-v25",
    provider: "openrouter",
    model_id: "xiaomi/mimo-v2.5",
    capabilities: { code: 0.84, reasoning: 0.88, speed: 0.62, cost: 0.62, json_reliability: 0.82 },
    default_for: ["planner", "synthesizer"],
    enabled: true,
  },
  {
    id: "zen-big-pickle-free",
    provider: "opencode_zen",
    model_id: "opencode/big-pickle",
    capabilities: { code: 0.82, reasoning: 0.72, speed: 0.75, cost: 1, json_reliability: 0.72 },
    default_for: ["executor"],
    enabled: true,
  },
  {
    id: "zen-mimo-v2-pro-free",
    provider: "opencode_zen",
    model_id: "opencode/mimo-v2-pro-free",
    capabilities: { code: 0.86, reasoning: 0.84, speed: 0.62, cost: 1, json_reliability: 0.78 },
    default_for: ["planner", "synthesizer"],
    enabled: true,
  },
  {
    id: "zen-mimo-v2-omni-free",
    provider: "opencode_zen",
    model_id: "opencode/mimo-v2-omni-free",
    capabilities: { code: 0.76, reasoning: 0.82, speed: 0.58, cost: 1, json_reliability: 0.74 },
    default_for: ["research"],
    enabled: true,
  },
  {
    id: "zen-minimax-m25-free",
    provider: "opencode_zen",
    model_id: "opencode/minimax-m2.5-free",
    capabilities: { code: 0.84, reasoning: 0.82, speed: 0.66, cost: 1, json_reliability: 0.8 },
    default_for: ["executor", "reviewer"],
    enabled: true,
  },
  {
    id: "zen-nemotron-super-free",
    provider: "opencode_zen",
    model_id: "opencode/nemotron-3-super-free",
    capabilities: { code: 0.78, reasoning: 0.9, speed: 0.56, cost: 1, json_reliability: 0.84 },
    default_for: ["reviewer"],
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
