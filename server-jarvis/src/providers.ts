// ═══════════════════════════════════════════════════════════════
// Provider routing — resolve the right endpoint + key per agent.
// ═══════════════════════════════════════════════════════════════
// The orchestrator agent pool mixes OpenRouter with OpenAI-compatible
// secondary providers (OpenCode Zen / OpenCode Go). They all speak the same
// `/chat/completions` SSE protocol, but live on different base URLs with
// different API keys. The fallback cascade can hop across providers, so each
// attempt must resolve its target here rather than assuming OpenRouter.

import type { JarvisConfig } from "./config";

/** Providers that are reachable over the OpenAI-compatible HTTP path. */
export type HttpProviderId = "openrouter" | "opencode_zen" | "opencode_go";

export interface ProviderTarget {
  provider: HttpProviderId;
  base_url: string;
  api_key: string;
  /** Path appended to base_url for chat completions. */
  chat_path: string;
}

/**
 * Resolve the HTTP endpoint + key for a provider. Unknown providers (ollama,
 * claude_cli, or anything not configured) fall back to OpenRouter so a stray
 * pool entry can never produce an undefined URL.
 */
export function resolveProviderTarget(cfg: JarvisConfig, provider: string): ProviderTarget {
  switch (provider) {
    case "opencode_zen":
      return {
        provider: "opencode_zen",
        base_url: (cfg.opencode_zen?.base_url || "https://opencode.ai/zen/v1").replace(/\/+$/, ""),
        api_key: cfg.opencode_zen?.api_key || "",
        chat_path: "/chat/completions",
      };
    case "opencode_go":
      return {
        provider: "opencode_go",
        base_url: (cfg.opencode_go?.base_url || "https://opencode.ai/zen/go/v1").replace(/\/+$/, ""),
        api_key: cfg.opencode_go?.api_key || "",
        chat_path: "/chat/completions",
      };
    default:
      return {
        provider: "openrouter",
        base_url: (cfg.openrouter.base_url || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
        api_key: cfg.openrouter.api_key || "",
        chat_path: "/chat/completions",
      };
  }
}

/** Full chat-completions URL for a provider target. */
export function providerChatUrl(target: ProviderTarget): string {
  return `${target.base_url}${target.chat_path}`;
}

/** Standard auth + attribution headers for an OpenAI-compatible provider. */
export function providerHeaders(cfg: JarvisConfig, target: ProviderTarget): Record<string, string> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${target.api_key}`,
    "Content-Type": "application/json",
  };
  // OpenRouter uses referer/title for attribution + free-tier routing; the
  // OpenCode providers ignore them harmlessly, so we send them everywhere.
  headers["HTTP-Referer"] = cfg.openrouter.site_url || "http://localhost:19877";
  headers["X-Title"] = cfg.openrouter.site_name || "Jarvis";
  return headers;
}
