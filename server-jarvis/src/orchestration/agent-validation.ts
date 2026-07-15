// T3.1: validate orchestrator agent pool entries.
// WARN-level only at config load so existing configs keep booting.

import type { OrchestratorAgent } from "./agent-pool";
import { ORCHESTRATOR_STAGES } from "./agent-pool";

const ROUTABLE_PROVIDERS = new Set(["openrouter", "opencode_zen", "opencode_go"]);
const CAP_KEYS = ["code", "reasoning", "speed", "cost", "json_reliability"] as const;

export interface AgentValidationIssue {
  agentId: string;
  level: "error" | "warn";
  message: string;
}

export function validateOrchestratorAgent(
  agent: OrchestratorAgent,
  peers: OrchestratorAgent[] = [],
): AgentValidationIssue[] {
  const issues: AgentValidationIssue[] = [];
  const id = agent.id || "<missing-id>";

  if (!agent.id?.trim()) {
    issues.push({ agentId: id, level: "error", message: "id is required" });
  }
  if (peers.some((p) => p.id === agent.id && p !== agent)) {
    issues.push({ agentId: id, level: "error", message: `duplicate id "${agent.id}"` });
  }

  if (!ROUTABLE_PROVIDERS.has(agent.provider)) {
    issues.push({
      agentId: id,
      level: "error",
      message: `provider "${agent.provider}" is not routable (must be openrouter|opencode_zen|opencode_go)`,
    });
  }

  for (const key of CAP_KEYS) {
    const v = agent.capabilities?.[key];
    if (typeof v !== "number" || v < 0 || v > 1) {
      issues.push({
        agentId: id,
        level: "error",
        message: `capabilities.${key} must be in [0,1] (got ${v})`,
      });
    }
  }

  for (const stage of agent.default_for ?? []) {
    if (!(ORCHESTRATOR_STAGES as readonly string[]).includes(stage)) {
      issues.push({
        agentId: id,
        level: "error",
        message: `default_for includes unknown stage "${stage}"`,
      });
    }
  }

  // Unknown model_ids should declare first_token_timeout_ms (1–60s).
  // We only warn when the field is present but out of range; missing is ok
  // for known pool models but required for custom ids — warn if missing AND
  // no default_for empty (custom agents typically pin at least one stage).
  if (agent.first_token_timeout_ms !== undefined) {
    const ms = agent.first_token_timeout_ms;
    if (typeof ms !== "number" || ms < 1_000 || ms > 60_000) {
      issues.push({
        agentId: id,
        level: "error",
        message: `first_token_timeout_ms must be 1000–60000 (got ${ms})`,
      });
    }
  }

  if ((agent.default_for ?? []).includes("coordinator") && (agent.capabilities?.json_reliability ?? 0) < 0.85) {
    issues.push({
      agentId: id,
      level: "warn",
      message: `coordinator pin requires json_reliability ≥ 0.85 (got ${agent.capabilities?.json_reliability})`,
    });
  }

  const sp = (agent as OrchestratorAgent & { system_prompt?: string }).system_prompt;
  if (typeof sp === "string" && sp.length > 4000) {
    issues.push({
      agentId: id,
      level: "error",
      message: `system_prompt exceeds 4000 chars (${sp.length})`,
    });
  }

  return issues;
}

export function validateOrchestratorAgents(agents: OrchestratorAgent[]): AgentValidationIssue[] {
  const all: AgentValidationIssue[] = [];
  for (const agent of agents) {
    all.push(...validateOrchestratorAgent(agent, agents));
  }
  return all;
}
