import type { JarvisConfig } from "../config";
import { ollamaBaseUrlCandidates } from "../ollama";
import { fetchVllmChat, providerChatUrl, providerHeaders, resolveProviderTarget } from "../providers";
import { buildSingleProviderRequestBody, normalizeSingleProviderResponse } from "../openrouter";
import type { StageTarget } from "./stage-route-policy";

/** Send one provider/model request and preserve its stream, normalizing wire protocols as needed. */
export async function requestStageTarget(
  cfg: JarvisConfig,
  target: StageTarget,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const requestBody = JSON.stringify({ ...body, model: target.model });

  if (target.provider === "llama_cpp") {
    const baseUrl = cfg.llama_cpp.base_url.replace(/\/+$/, "");
    return fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
      signal,
    });
  }

  if (target.provider === "ollama") {
    let lastError: unknown;
    for (const baseUrl of ollamaBaseUrlCandidates(cfg.ollama)) {
      try {
        return await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { Authorization: "Bearer ollama", "Content-Type": "application/json" },
          body: requestBody,
          signal,
        });
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new Error("No Ollama endpoint candidates are configured");
  }

  const providerTarget = resolveProviderTarget(cfg, target.provider);
  const providerBody = buildSingleProviderRequestBody(target.provider, target.model, body as Record<string, any>);
  const response = target.provider === "vllm"
    ? await fetchVllmChat(cfg, providerTarget, target.model, providerBody, { signal })
    : await fetch(providerChatUrl(providerTarget, target.model), {
        method: "POST",
        headers: providerHeaders(cfg, providerTarget, target.model),
        body: JSON.stringify(providerBody),
        signal,
      });
  return normalizeSingleProviderResponse(response, target.provider, target.model);
}
