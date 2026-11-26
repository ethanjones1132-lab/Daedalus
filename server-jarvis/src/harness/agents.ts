import { AgentPool, type OrchestratorAgent } from "../orchestration/agent-pool";
import { modelFamily } from "../orchestration/model-family";

export { modelFamily } from "../orchestration/model-family";

/** The pool identity of the agent a harness stage runs as. */
export interface HarnessAgentRef {
  id: string;
  provider: OrchestratorAgent["provider"];
  model_id: string;
}

/**
 * A named pool id wins; the template's generic ids ("maker",
 * "independent-checker") are roles, so they resolve through the pool's stage
 * default (executor for the maker, reviewer for the checker).
 */
export function resolveHarnessAgent(
  agents: readonly OrchestratorAgent[],
  agentId: string,
  stage: "executor" | "reviewer",
): OrchestratorAgent | undefined {
  const pool = new AgentPool([...agents]);
  return pool.enabled().find((agent) => agent.id === agentId) ?? pool.pickFor(stage, "general");
}

/**
 * The model family an agent resolves to, for maker/checker independence. The
 * harness rule is about the model the checker reasons with, not the id it was
 * given. The family table and resolver live in the orchestration layer so the
 * fallback cascade can exclude families with the same rule; this module
 * re-exports it.
 */
export function agentFamily(agent: Pick<OrchestratorAgent, "model_id">): string {
  return modelFamily(agent.model_id);
}
