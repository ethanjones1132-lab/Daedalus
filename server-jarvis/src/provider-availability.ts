import type { BackendType, JarvisConfig } from "./config";
import type { OrchestratorAgent } from "./orchestration/agent-pool";
import { resolveProviderTarget } from "./providers";

type RoutedProvider = OrchestratorAgent["provider"];

function hasCredential(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length >= 10;
}

/**
 * Providers whose requests leave this machine for a third-party service.
 * vLLM is the user's own self-hosted server and Ollama / llama.cpp run here,
 * so none of those count as cloud.
 */
const CLOUD_PROVIDERS: ReadonlySet<string> = new Set(["openrouter", "opencode_zen", "opencode_go", "claude_cli"]);

export function isCloudProvider(provider: string | undefined | null): boolean {
  return typeof provider === "string" && CLOUD_PROVIDERS.has(provider);
}

/** A local Inference backend: the selected engine runs on this machine. */
export function isLocalBackend(backend: BackendType | string | undefined): boolean {
  return backend === "llama_cpp" || backend === "ollama";
}

/**
 * The one local-boundary policy. With a cloud Inference backend selected
 * (OpenRouter or Claude CLI) the user already chose cloud inference. With a
 * local backend, cloud help is used only when "Allow cloud helpers"
 * (`orchestrator.allow_cloud_helpers`) is explicitly on. Every routing path
 * that could reach a cloud provider (stage pool, HTTP fallback tail,
 * executor delegate, conductor API fallback, Agent tool) asks this.
 */
export function cloudHelpersAllowed(cfg: Pick<JarvisConfig, "active_backend" | "orchestrator">): boolean {
  if (!isLocalBackend(cfg.active_backend)) return true;
  return cfg.orchestrator?.allow_cloud_helpers === true;
}

/** True only when Jarvis can make a request to this provider right now. */
export function isProviderAvailable(
  cfg: JarvisConfig,
  provider: RoutedProvider,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (provider) {
    case "openrouter":
      return hasCredential(cfg.openrouter.api_key);
    case "opencode_zen":
      return hasCredential(cfg.opencode_zen?.api_key);
    case "opencode_go":
      return hasCredential(cfg.opencode_go?.api_key);
    case "vllm":
      try {
        resolveProviderTarget(cfg, "vllm", env);
        return true;
      } catch {
        return false;
      }
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
 * claude_cli remains genuinely unwired for stage dispatch. An explicitly
 * configured vLLM model is projected here so /agents/pool and stage routing
 * use the same availability gate.
 */
export function routableOrchestratorAgents(
  cfg: JarvisConfig,
  env: NodeJS.ProcessEnv = process.env,
): OrchestratorAgent[] {
  const ROUTABLE = new Set(["openrouter", "opencode_zen", "opencode_go", "ollama", "vllm"]);
  const configured = cfg.orchestrator?.agents ?? [];
  const configuredVllm = configured.find((agent) =>
    agent.provider === "vllm" && agent.model_id === cfg.vllm?.model,
  );
  const vllmAgents: OrchestratorAgent[] = [];
  if (isProviderAvailable(cfg, "vllm", env)) {
    if (configuredVllm) {
      vllmAgents.push({
        ...configuredVllm,
        first_token_timeout_ms: configuredVllm.first_token_timeout_ms ?? cfg.vllm.first_token_timeout_ms,
      });
    } else {
      const explicitlyDisabled = configured.some((agent) =>
        agent.provider === "vllm" && agent.model_id === cfg.vllm.model && agent.enabled === false,
      );
      if (!explicitlyDisabled) {
        vllmAgents.push({
          id: "configured-vllm",
          provider: "vllm",
          model_id: cfg.vllm.model,
          capabilities: { code: 0.7, reasoning: 0.7, speed: 0.65, cost: 0.5, json_reliability: 0.7 },
          default_for: [],
          enabled: true,
          first_token_timeout_ms: cfg.vllm.first_token_timeout_ms,
        });
      }
    }
  }
  return [...configured.filter((agent) => agent.provider !== "vllm"), ...vllmAgents].filter((agent) => {
    if (!ROUTABLE.has(agent.provider)) {
      if (agent.enabled !== false) {
        console.warn(
          `[providers] filtering unroutable pool agent id=${agent.id} provider=${agent.provider} ` +
          `(only openrouter/opencode_zen/opencode_go/vllm/ollama are served over HTTP/local)`,
        );
      }
      return false;
    }
    // Local boundary: with a local backend and cloud helpers off, no cloud
    // pool agent is routable, however it got credentials (including keys the
    // config silently fills from OPENCODE_API_KEY / OPENROUTER_API_KEY).
    if (isCloudProvider(agent.provider) && !cloudHelpersAllowed(cfg)) return false;
    return isProviderAvailable(cfg, agent.provider, env);
  });
}

/** Stable facts supplied to stages so they do not invent Jarvis's active runtime. */
export function configuredInferenceFacts(cfg: JarvisConfig): { backend: BackendType; selectedModel: string } {
  switch (cfg.active_backend) {
    case "ollama":
      return { backend: "ollama", selectedModel: cfg.ollama.model };
    case "llama_cpp":
      return { backend: "llama_cpp", selectedModel: cfg.llama_cpp.model };
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
