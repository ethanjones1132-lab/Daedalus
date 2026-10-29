// ═══════════════════════════════════════════════════════════════
// Provider routing — resolve the right endpoint + key per agent.
// ═══════════════════════════════════════════════════════════════
// The orchestrator agent pool mixes OpenRouter, OpenCode Zen/Go, and a
// self-hosted vLLM endpoint. Each uses its own target; the fallback cascade
// resolves that target per attempt rather than assuming OpenRouter.

import type { JarvisConfig, VllmConfig } from "./config";
import { openCodeGoProtocolForModel } from "./orchestration/live-model-catalog";

/** Providers that are reachable over the OpenAI-compatible HTTP path. */
export type HttpProviderId = "openrouter" | "opencode_zen" | "opencode_go" | "vllm";

export function isHttpProviderId(provider: string): provider is HttpProviderId {
  return provider === "openrouter" || provider === "opencode_zen" || provider === "opencode_go" || provider === "vllm";
}

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
    super(`Unroutable orchestrator provider "${provider}" — only openrouter, opencode_zen, opencode_go, and vllm are served`);
    this.name = "UnroutableProviderError";
  }
}

/** A vLLM pool entry cannot be used because its explicit config is incomplete. */
export class VllmProviderConfigurationError extends Error {
  readonly code = "VLLM_NOT_CONFIGURED";

  constructor(readonly reason: string) {
    super(`vLLM provider is not configured: ${reason}`);
    this.name = "VllmProviderConfigurationError";
  }
}

/** A configured vLLM endpoint failed and no cascade candidate answered. */
export class VllmProviderRequestError extends Error {
  readonly code = "VLLM_UNAVAILABLE";

  constructor(readonly model: string, readonly detail: string) {
    super(`vLLM provider request failed for model ${model}: ${detail}`);
    this.name = "VllmProviderRequestError";
  }
}

/** Resolve only the named environment variable; config never stores the key. */
export function resolveVllmApiKey(
  config: Pick<VllmConfig, "api_key_env"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = config?.api_key_env?.trim() ?? "";
  if (!name) return "";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new VllmProviderConfigurationError("api_key_env must be an environment variable name");
  }
  const value = env[name]?.trim() ?? "";
  if (!value) throw new VllmProviderConfigurationError(`environment variable ${name} is not set`);
  return value;
}

function configuredVllmBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new VllmProviderConfigurationError("base_url is required");
  }
  const base = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new VllmProviderConfigurationError("base_url must be an absolute HTTP URL");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new VllmProviderConfigurationError("base_url must use HTTP or HTTPS without embedded credentials");
  }
  if (parsed.search || parsed.hash || base.includes("?") || base.includes("#")) {
    throw new VllmProviderConfigurationError("base_url must not contain a query string or fragment");
  }
  return base;
}

/**
 * Resolve the HTTP endpoint + key for a provider.
 * T3.4: unknown providers throw UnroutableProviderError (was: silent OpenRouter retarget).
 */
export function resolveProviderTarget(
  cfg: JarvisConfig,
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderTarget {
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
    case "vllm": {
      const vllm = cfg.vllm;
      if (vllm?.enabled !== true) throw new VllmProviderConfigurationError("set vllm.enabled to true");
      const base_url = configuredVllmBaseUrl(vllm.base_url);
      if (typeof vllm.model !== "string" || !vllm.model.trim()) {
        throw new VllmProviderConfigurationError("model is required");
      }
      const timeoutMs = Number(vllm.first_token_timeout_ms);
      return {
        provider: "vllm",
        base_url,
        api_key: resolveVllmApiKey(vllm, env),
        first_token_timeout_ms: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000,
        chat_path: "/chat/completions",
      };
    }
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
    "Content-Type": "application/json",
  };
  if (target.api_key || target.provider !== "vllm") {
    headers.Authorization = `Bearer ${target.api_key}`;
  }
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

/** Whether a provider accepts an OpenAI `tools` block on the request. */
export function providerSupportsNativeTools(provider: HttpProviderId): boolean {
  return provider === "openrouter" || provider === "vllm";
}

/** Replace a provider secret before putting endpoint errors in logs or status. */
export function redactProviderSecret(message: string, secret: string): string {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}

/** Send one vLLM chat request and preserve typed, redacted endpoint failures. */
export async function fetchVllmChat(
  cfg: JarvisConfig,
  target: ProviderTarget,
  modelId: string,
  body: Record<string, unknown>,
  options: Pick<RequestInit, "signal"> = {},
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  try {
    const response = await fetcher(providerChatUrl(target, modelId), {
      method: "POST",
      headers: providerHeaders(cfg, target, modelId),
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      const detail = redactProviderSecret(`HTTP ${response.status}: ${responseText.slice(0, 300)}`, target.api_key);
      throw new VllmProviderRequestError(modelId, detail);
    }
    return response;
  } catch (error) {
    if (error instanceof VllmProviderRequestError || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    const detail = redactProviderSecret(error instanceof Error ? error.message : String(error), target.api_key);
    throw new VllmProviderRequestError(modelId, detail);
  }
}

export interface VllmHealth {
  enabled: boolean;
  reachable: boolean;
  models: string[];
  latency_ms: number;
  error?: string;
}

export interface VllmHealthDeps {
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const VLLM_PROBE_TIMEOUT_MS = 5_000;

/** Probe an enabled vLLM endpoint's OpenAI-compatible model-list route. */
export async function checkVllmHealth(
  cfg: VllmConfig,
  deps: VllmHealthDeps = {},
): Promise<VllmHealth> {
  if (!cfg?.enabled) {
    return { enabled: false, reachable: false, models: [], latency_ms: 0, error: "disabled" };
  }

  let target: ProviderTarget;
  try {
    target = resolveProviderTarget({ vllm: cfg } as JarvisConfig, "vllm", deps.env);
  } catch (error) {
    return {
      enabled: true,
      reachable: false,
      models: [],
      latency_ms: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const fetcher = deps.fetcher ?? fetch;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VLLM_PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (target.api_key) headers.Authorization = `Bearer ${target.api_key}`;
    const response = await fetcher(`${target.base_url}/models`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { data?: unknown };
    const models = Array.isArray(payload?.data)
      ? payload.data
        .map((model) => model && typeof model === "object" ? (model as { id?: unknown }).id : undefined)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    return { enabled: true, reachable: true, models, latency_ms: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      enabled: true,
      reachable: false,
      models: [],
      latency_ms: Date.now() - started,
      error: redactProviderSecret(message, target.api_key).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}
