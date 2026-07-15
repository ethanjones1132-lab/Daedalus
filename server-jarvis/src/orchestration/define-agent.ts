// T3.3: guarded define_agent path (feature-flagged OFF by default).
// Future conductor-facing seam for dynamic specialized agents. Writes the FULL
// agents array via saveConfig (deepMerge replaces arrays wholesale; never the
// Rust SQLite side).

import { loadConfig, saveConfig, type JarvisConfig } from "../config";
import type { OrchestratorAgent } from "./agent-pool";
import { AgentPool } from "./agent-pool";
import { validateOrchestratorAgent } from "./agent-validation";

export interface DynamicAgentsConfig {
  enabled: boolean;
  max_dynamic_agents: number;
}

export const DEFAULT_DYNAMIC_AGENTS: DynamicAgentsConfig = {
  enabled: false,
  max_dynamic_agents: 4,
};

export interface DefineAgentResult {
  ok: true;
  agent: OrchestratorAgent;
  pool_size: number;
}

export interface DefineAgentError {
  ok: false;
  status: 400 | 403 | 409;
  error: string;
  details?: string[];
}

export type DefineAgentOutcome = DefineAgentResult | DefineAgentError;

function isDynamicAgent(agent: OrchestratorAgent): boolean {
  return agent.id.startsWith("dyn-") || (agent as { dynamic?: boolean }).dynamic === true;
}

/**
 * Register a new pool agent under the dynamic_agents feature flag.
 * Always writes the complete agents array via saveConfig.
 */
export function defineAgent(
  candidate: OrchestratorAgent,
  options: {
    load?: () => JarvisConfig;
    save?: (partial: Partial<JarvisConfig>) => JarvisConfig;
  } = {},
): DefineAgentOutcome {
  const load = options.load ?? loadConfig;
  const save = options.save ?? ((partial: Partial<JarvisConfig>) => saveConfig(partial));

  const cfg = load();
  const dyn = (cfg.orchestrator as { dynamic_agents?: DynamicAgentsConfig })?.dynamic_agents
    ?? DEFAULT_DYNAMIC_AGENTS;

  if (!dyn.enabled) {
    return {
      ok: false,
      status: 403,
      error: "dynamic_agents disabled",
      details: ["Set orchestrator.dynamic_agents.enabled=true to allow define_agent"],
    };
  }

  const existing = [...(cfg.orchestrator?.agents ?? [])];
  const dynamicCount = existing.filter(isDynamicAgent).length;
  if (dynamicCount >= (dyn.max_dynamic_agents ?? 4)) {
    return {
      ok: false,
      status: 400,
      error: "max_dynamic_agents exceeded",
      details: [`Already have ${dynamicCount} dynamic agents (max ${dyn.max_dynamic_agents})`],
    };
  }

  // Force dynamic marker on the id so restarts can count them.
  const agent: OrchestratorAgent = {
    ...candidate,
    id: candidate.id.startsWith("dyn-") ? candidate.id : `dyn-${candidate.id}`,
    enabled: candidate.enabled !== false,
    default_for: [...(candidate.default_for ?? [])],
  };

  if (existing.some((a) => a.id === agent.id)) {
    return {
      ok: false,
      status: 409,
      error: "duplicate agent id",
      details: [`Agent id "${agent.id}" already exists`],
    };
  }

  const issues = validateOrchestratorAgent(agent, [...existing, agent]);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length > 0) {
    return {
      ok: false,
      status: 400,
      error: "agent validation failed",
      details: errors.map((e) => e.message),
    };
  }

  // Provider-diversity guard: simulated coverage must not drop below 2
  // providers when the pool already has ≥2.
  const trial = new AgentPool([...existing, agent]);
  const before = new AgentPool(existing).coverage();
  const after = trial.coverage();
  if (before.provider_diversity >= 2 && after.provider_diversity < 2) {
    return {
      ok: false,
      status: 400,
      error: "provider diversity collapse",
      details: [
        `Adding this agent would reduce provider_diversity from ${before.provider_diversity} to ${after.provider_diversity}`,
      ],
    };
  }

  // deepMerge replaces arrays wholesale — write the FULL agents array.
  const nextAgents = [...existing, agent];
  save({
    orchestrator: {
      ...cfg.orchestrator,
      agents: nextAgents,
    } as JarvisConfig["orchestrator"],
  });

  return {
    ok: true,
    agent,
    pool_size: nextAgents.length,
  };
}
