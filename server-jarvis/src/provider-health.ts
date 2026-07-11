import type { JarvisConfig } from "./config";
import { providerHeaders, resolveProviderTarget, type HttpProviderId } from "./providers";

export interface ProviderHealth {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

const providerName: Record<HttpProviderId, string> = {
  openrouter: "OpenRouter",
  opencode_zen: "OpenCode Zen",
  opencode_go: "OpenCode Go",
};

function safeConnectionMessage(name: string, error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : "unknown error";
  // Fetch failures normally contain only transport details, but scrub the
  // credential defensively in case a custom fetch implementation includes it.
  const sanitized = secret ? message.split(secret).join("[REDACTED]") : message;
  return `${name} connection failed: ${sanitized}`;
}

/** Probe one OpenAI-compatible provider without exposing its credential. */
export async function checkHttpProviderHealth(
  cfg: JarvisConfig,
  provider: HttpProviderId | string,
): Promise<ProviderHealth> {
  if (provider !== "openrouter" && provider !== "opencode_zen" && provider !== "opencode_go") {
    return { ok: false, latency_ms: 0, error: "Unknown HTTP provider." };
  }
  const target = resolveProviderTarget(cfg, provider);
  const name = providerName[target.provider];
  if (!target.api_key.trim()) {
    return { ok: false, latency_ms: 0, error: `${name} API key is not configured.` };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${target.base_url}/models`, {
      method: "GET",
      headers: providerHeaders(cfg, target),
      signal: controller.signal,
    });
    const latency_ms = Date.now() - startedAt;
    if (response.ok) return { ok: true, latency_ms };

    const error = response.status === 401
      ? `${name} rejected this API key (401).`
      : response.status === 403
        ? `${name} denied access for this API key (403).`
        : response.status === 429
          ? `${name} rate limited this request (429).`
          : `${name} returned HTTP ${response.status}.`;
    return { ok: false, latency_ms, error };
  } catch (error) {
    return {
      ok: false,
      latency_ms: Date.now() - startedAt,
      error: safeConnectionMessage(name, error, target.api_key),
    };
  } finally {
    clearTimeout(timeout);
  }
}
