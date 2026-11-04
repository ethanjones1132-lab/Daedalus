import type { JarvisConfig } from "../config";
import { checkVllmHealth, type VllmHealth } from "../providers";
import { routableOrchestratorAgents } from "../provider-availability";
import type { OrchestratorAgent } from "./agent-pool";

const HEALTH_CACHE_MS = 10_000;
let cachedHealth: { key: string; expiresAt: number; promise: Promise<VllmHealth> } | undefined;

function vllmHealthKey(cfg: JarvisConfig): string {
  const vllm = cfg.vllm;
  return [vllm?.enabled, vllm?.base_url, vllm?.model, vllm?.api_key_env].join("\u0000");
}

/** Build the routable pool only after an enabled vLLM endpoint passes its health probe. */
export async function routableAgentsWithProviderHealth(
  cfg: JarvisConfig,
  deps: { env?: NodeJS.ProcessEnv; probe?: typeof checkVllmHealth; now?: () => number } = {},
): Promise<OrchestratorAgent[]> {
  const env = deps.env ?? process.env;
  const probe = deps.probe ?? checkVllmHealth;
  const now = deps.now ?? Date.now;
  let vllmHealthy = true;

  if (cfg.vllm?.enabled) {
    const key = vllmHealthKey(cfg);
    if (!cachedHealth || cachedHealth.key !== key || cachedHealth.expiresAt <= now()) {
      const promise = probe(cfg.vllm, { env });
      cachedHealth = { key, expiresAt: now() + HEALTH_CACHE_MS, promise };
    }
    try {
      vllmHealthy = (await cachedHealth.promise).reachable;
    } catch {
      vllmHealthy = false;
    }
  }

  const agents = routableOrchestratorAgents(cfg, env);
  return vllmHealthy ? agents : agents.filter((agent) => agent.provider !== "vllm");
}

/** Reset process-local probe state for deterministic tests. */
export function resetRoutableAgentPoolHealthCache(): void {
  cachedHealth = undefined;
}
