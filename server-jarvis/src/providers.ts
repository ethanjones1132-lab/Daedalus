// ═══════════════════════════════════════════════════════════════
// Provider routing — resolve the right endpoint + key per agent.
// ═══════════════════════════════════════════════════════════════
// The orchestrator agent pool mixes OpenRouter with OpenAI-compatible
// secondary providers (OpenCode Zen / OpenCode Go). They all speak the same
// `/chat/completions` SSE protocol, but live on different base URLs with
// different API keys. The fallback cascade can hop across providers, so each
// attempt must resolve its target here rather than assuming OpenRouter.

import type { JarvisConfig } from "./config";
import { openCodeGoProtocolForModel } from "./orchestration/live-model-catalog";

/** Providers that are reachable over the OpenAI-compatible HTTP path. */
export type HttpProviderId = "openrouter" | "opencode_zen" | "opencode_go";

export interface ProviderTarget {
  provider: HttpProviderId;
  base_url: string;
  api_key: string;
  /** First-body-byte watchdog for this provider. */
  first_token_timeout_ms: number;
  /** Path appended to base_url for chat completions. */
  chat_path: string;
}

/** T3.4: explicit error instead of silently retargeting ollama/claude_cli to OpenRouter. */
export class UnroutableProviderError extends Error {
  constructor(readonly provider: string) {
    super(`Unroutable orchestrator provider "${provider}" — only openrouter, opencode_zen, opencode_go are served`);
    this.name = "UnroutableProviderError";
  }
}

/**
 * Resolve the HTTP endpoint + key for a provider.
 * T3.4: unknown providers throw UnroutableProviderError (was: silent OpenRouter retarget).
 */
export function resolveProviderTarget(cfg: JarvisConfig, provider: string): ProviderTarget {
  switch (provider) {
    case "openrouter":
      return {
        provider: "openrouter",
        base_url: (cfg.openrouter.base_url || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
        api_key: cfg.openrouter.api_key || "",
        first_token_timeout_ms: Number((cfg.openrouter as any).first_token_timeout_ms ?? 30_000),
        chat_path: "/chat/completions",
      };
    case "opencode_zen":
      return {
        provider: "opencode_zen",
        base_url: (cfg.opencode_zen?.base_url || "https://opencode.ai/zen/v1").replace(/\/+$/, ""),
        api_key: cfg.opencode_zen?.api_key || "",
        first_token_timeout_ms: cfg.opencode_zen?.first_token_timeout_ms || 45_000,
        chat_path: "/chat/completions",
      };
    case "opencode_go":
      return {
        provider: "opencode_go",
        base_url: (cfg.opencode_go?.base_url || "https://opencode.ai/zen/go/v1").replace(/\/+$/, ""),
        api_key: cfg.opencode_go?.api_key || "",
        first_token_timeout_ms: cfg.opencode_go?.first_token_timeout_ms || 45_000,
        chat_path: "/chat/completions",
      };
    default:
      throw new UnroutableProviderError(provider);
  }
}



/** Full chat-completions URL for a provider target. */
export function providerChatUrl(target: ProviderTarget, modelId?: string): string {
  const path = target.provider === "opencode_go" && modelId && openCodeGoProtocolForModel(modelId) === "anthropic"
    ? "/messages"
    : target.chat_path;
  return `${target.base_url}${path}`;
}

/** Standard auth + attribution headers for an OpenAI-compatible provider. */
export function providerHeaders(cfg: JarvisConfig, target: ProviderTarget, modelId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${target.api_key}`,
    "Content-Type": "application/json",
  };
  // OpenRouter uses referer/title for attribution + free-tier routing; the
  // OpenCode providers ignore them harmlessly, so we send them everywhere.
  headers["HTTP-Referer"] = cfg.openrouter.site_url || "http://localhost:19877";
  headers["X-Title"] = cfg.openrouter.site_name || "Jarvis";
  if (target.provider === "opencode_go" && modelId && openCodeGoProtocolForModel(modelId) === "anthropic") {
    // OpenCode Go's /messages models use the Anthropic wire protocol. Keep the
    // Bearer header for gateway compatibility and add the canonical Anthropic
    // headers expected by the same endpoint.
    headers["x-api-key"] = target.api_key;
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}
