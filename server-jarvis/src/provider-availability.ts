import type { BackendType, JarvisConfig } from "./config";
import type { OrchestratorAgent } from "./orchestration/agent-pool";

type RoutedProvider = OrchestratorAgent["provider"];

function hasCredential(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length >= 10;
}

/** True only when Jarvis can make a request to this provider right now. */
export function isProviderAvailable(cfg: JarvisConfig, provider: RoutedProvider): boolean {
  switch (provider) {
    case "openrouter":
      return hasCredential(cfg.openrouter.api_key);
    case "opencode_zen":
      return hasCredential(cfg.opencode_zen?.api_key);
    case "opencode_go":
      return hasCredential(cfg.opencode_go?.api_key);
    case "ollama":
      // Local, no credential to check, no per-request cost. A pool-selected
      // ollama agent resolves its own reachability at call time (with
      // graceful fallback), the same as the resident conductor — it isn't
      // gated on the unrelated backend-wide active_backend toggle.
      return true;
    case "claude_cli":
      return cfg.claude_cli.enabled;
  }
}

/**
 * Removes agent-pool entries that would only create a guaranteed failed hop.
 * T3.4 originally also filtered ollama/claude_cli pool agents (they were
 * never served by resolveProviderTarget's HTTP path — previously silent
 * OpenRouter retarget). 2026-07-31: the stage-dispatch path in index.ts now
 * routes ollama-provider agents through resolveOllamaChatTarget instead of
 * resolveProviderTarget, so ollama is a real routable target again — only
 * claude_cli remains genuinely unwired for stage dispatch.
 */
export function routableOrchestratorAgents(cfg: JarvisConfig): OrchestratorAgent[] {
  const ROUTABLE = new Set(["openrouter", "opencode_zen", "opencode_go", "ollama"]);
  return (cfg.orchestrator?.agents ?? []).filter((agent) => {
    if (!ROUTABLE.has(agent.provider)) {
      if (agent.enabled !== false) {
        console.warn(
          `[providers] filtering unroutable pool agent id=${agent.id} provider=${agent.provider} ` +
          `(only openrouter/opencode_zen/opencode_go/ollama are served over HTTP/local)`,
        );
      }
      return false;
    }
    return isProviderAvailable(cfg, agent.provider);
  });
}

/** Stable facts supplied to stages so they do not invent Jarvis's active runtime. */
export function configuredInferenceFacts(cfg: JarvisConfig): { backend: BackendType; selectedModel: string } {
  switch (cfg.active_backend) {
    case "ollama":
      return { backend: "ollama", selectedModel: cfg.ollama.model };
    case "claude_cli":
      return { backend: "claude_cli", selectedModel: cfg.claude_cli.model ?? "" };
    case "openrouter":
    default:
      return { backend: "openrouter", selectedModel: cfg.openrouter.model };
  }
}

export function runtimeFactsSystemMessage(cfg: JarvisConfig): string {
  const { backend, selectedModel } = configuredInferenceFacts(cfg);
  return `Runtime facts: the active inference backend is ${backend}; the configured selected model is ${selectedModel || "unspecified"}. Do not claim a different backend or model unless the user explicitly supplies one.`;
}
