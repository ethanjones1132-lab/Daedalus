// ═══════════════════════════════════════════════════════════════
// ── OpenRouter v2 — Production-Grade Integration ──
// ═══════════════════════════════════════════════════════════════
// Full streaming, tool-call compatibility, cost tracking,
// retry/fallback, and per-model capability gates.

import type { JarvisConfig, SurfaceType } from "./config";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  [key: string]: string | undefined;
}

export interface OpenRouterArchitecture {
  modality?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  tokenizer?: string;
  instruct_type?: string | null;
}

export interface OpenRouterDefaultParameters {

  top_p?: number | null;
  top_k?: number | null;
  frequency_penalty?: number | null;
  presence_penalty?: number | null;
  repetition_penalty?: number | null;
  [key: string]: unknown;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  max_completion_tokens?: number | null;
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number | null;
    is_moderated?: boolean;
  };
  pricing: OpenRouterPricing;
  description: string;
  source: "openrouter";
  architecture: OpenRouterArchitecture;
  modality: string;
  supported_parameters: string[];
  default_parameters: OpenRouterDefaultParameters;
  is_free: boolean;
  is_router: boolean;
  created: number;
}

export interface OpenRouterHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface OpenRouterCostInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  generation_id: string;
  model: string;
}

export interface OpenRouterError {
  status: number;
  code: string;
  message: string;
  retry_after?: number;
}

export interface OpenRouterRetryResult {
  ok: boolean;
  model_used: string;
  retries: number;
  error?: string;
}

export interface EffectiveOpenRouterRequestConfig {
  model_id: string;
  model?: OpenRouterModel;
  is_free: boolean;
  is_router: boolean;
  context_length?: number;
  max_completion_tokens?: number;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  supports_tools: boolean;
  supported_parameters: string[];
  timeout_ms: number;
}

// ═══════════════════════════════════════════════════════════════
// In-Memory Cache
// ═══════════════════════════════════════════════════════════════

let cachedModels: OpenRouterModel[] | null = null;
let lastFetchTime = 0;
let lastUsedApiKey = "";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function clearOpenRouterCache(): void {
  cachedModels = null;
  lastFetchTime = 0;
  lastUsedApiKey = "";
}

function checkKeyChange(apiKey: string): void {
  if (apiKey !== lastUsedApiKey) {
    cachedModels = null;
    lastFetchTime = 0;
    lastUsedApiKey = apiKey;
  }
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function minDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

function parsePrice(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isOpenRouterFreeModel(modelOrId: OpenRouterModel | string, pricing?: OpenRouterPricing): boolean {
  const id = typeof modelOrId === "string" ? modelOrId : modelOrId.id;
  const price = typeof modelOrId === "string" ? pricing : modelOrId.pricing;
  if (id === "openrouter/free" || id.endsWith(":free")) return true;
  const prompt = parsePrice(price?.prompt);
  const completion = parsePrice(price?.completion);
  return prompt === 0 && completion === 0;
}

export function isOpenRouterRouterModel(modelOrId: OpenRouterModel | string): boolean {
  const id = typeof modelOrId === "string" ? modelOrId : modelOrId.id;
  if (id === "openrouter/free" || id === "openrouter/fusion") return true;
  if (typeof modelOrId !== "string" && modelOrId.architecture?.tokenizer === "Router") return true;
  return false;
}

function normalizeSupportedParameters(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeOpenRouterModel(raw: any): OpenRouterModel {
  const id = String(raw?.id ?? "");
  const pricing: OpenRouterPricing = raw?.pricing ?? {};
  const architecture: OpenRouterArchitecture = raw?.architecture ?? {};
  const model: OpenRouterModel = {
    id,
    name: raw?.name || id.split("/").pop() || id,
    context_length: positiveInteger(raw?.context_length) ?? 32768,
    max_completion_tokens: positiveInteger(raw?.top_provider?.max_completion_tokens) ?? positiveInteger(raw?.max_completion_tokens) ?? null,
    top_provider: raw?.top_provider,
    pricing,
    description: raw?.description || "",
    source: "openrouter",
    architecture,
    modality: architecture.modality || "text",
    supported_parameters: normalizeSupportedParameters(raw?.supported_parameters),
    default_parameters: raw?.default_parameters ?? {},
    is_free: false,
    is_router: false,
    created: raw?.created || 0,
  };
  model.is_free = isOpenRouterFreeModel(model);
  model.is_router = isOpenRouterRouterModel(model);
  return model;
}

function openRouterCatalogBucket(model: OpenRouterModel): number {
  if (model.is_free) return 0;
  if (model.is_router) return 1;
  return 2;
}

function compareOpenRouterModels(a: OpenRouterModel, b: OpenRouterModel): number {
  const bucketDiff = openRouterCatalogBucket(a) - openRouterCatalogBucket(b);
  if (bucketDiff !== 0) return bucketDiff;
  const contextDiff = (openRouterModelContextLength(b) ?? 0) - (openRouterModelContextLength(a) ?? 0);
  if (contextDiff !== 0) return contextDiff;
  return a.id.localeCompare(b.id);
}

export function estimateOpenRouterMessageTokens(messages: Array<any>): number {
  const chars = messages.reduce((total, message) => {
    const content = typeof message?.content === "string"
      ? message.content
      : JSON.stringify(message?.content ?? "");
    return total + String(message?.role ?? "").length + content.length + JSON.stringify(message?.tool_calls ?? "").length;
  }, 0);
  return Math.ceil(chars / 4) + (messages.length * 4) + 64;
}

export function openRouterModelContextLength(model?: OpenRouterModel): number | undefined {
  return positiveInteger(model?.top_provider?.context_length) ?? positiveInteger(model?.context_length);
}

export function openRouterModelMaxCompletionTokens(model?: OpenRouterModel): number | undefined {
  return positiveInteger(model?.top_provider?.max_completion_tokens) ?? positiveInteger(model?.max_completion_tokens);
}

export async function resolveOpenRouterMaxTokens(
  cfg: JarvisConfig,
  modelId: string,
  messages: Array<any>,
  requested?: unknown,
): Promise<number | undefined> {
  const hasExplicitRequest = requested !== undefined && requested !== null;
  const requestedTokens = positiveInteger(hasExplicitRequest ? requested : cfg.max_tokens);

  try {
    const models = await listOpenRouterModels(cfg);
    const model = models.find((m) => m.id === modelId);
    const completionLimit = openRouterModelMaxCompletionTokens(model);
    const contextLength = openRouterModelContextLength(model);
    const contextAvailable = contextLength
      ? Math.max(1, contextLength - estimateOpenRouterMessageTokens(messages))
      : undefined;
    const modelLimit = minDefined(completionLimit, contextAvailable);

    if (modelLimit !== undefined) {
      return modelLimit;
    }
  } catch (error) {
    console.warn("[OpenRouter] Failed to resolve model token limits:", error);
  }

  return hasExplicitRequest ? requestedTokens : undefined;
}

// ═══════════════════════════════════════════════════════════════
// Tool-Call Compatibility (per-model gates)
// ═══════════════════════════════════════════════════════════════

/**
 * Models known to support native OpenAI-compatible tool calls via OpenRouter.
 * Anthropic, Google, and Mistral models sometimes have partial support.
 * When false, fall back to the text-based <tool_call> protocol.
 */
export function isOpenRouterModelSupportsTools(modelOrId: OpenRouterModel | string): boolean {
  const modelId = typeof modelOrId === "string" ? modelOrId : modelOrId.id;
  if (!modelId) return false;
  if (modelId === "openrouter/free") return false;
  if (typeof modelOrId !== "string" && modelOrId.supported_parameters.length > 0) {
    return modelOrId.supported_parameters.includes("tools");
  }

  // OpenAI models: full native tool support
  if (modelId.startsWith("openai/")) return true;

  // Anthropic via OpenRouter: tools supported (Anthropic -> OpenAI format conversion)
  if (modelId.startsWith("anthropic/")) return true;

  // Google Gemini via OpenRouter: partial tool support (generally works)
  if (modelId.startsWith("google/")) return true;

  // Mistral Large: tool support works
  if (modelId.includes("mistral-large")) return true;

  // DeepSeek: tool support works via OpenRouter
  if (modelId.startsWith("deepseek/")) return true;

  // Qwen on OpenRouter: depends on provider; usually routed toTogether/ Fireworks with OpenAI API
  // → treat as *no native tools* and use text fallback to be safe
  if (modelId.startsWith("qwen/")) return false;

  // Meta / Llama: usually no native tools via OpenRouter
  if (modelId.startsWith("meta-llama/")) return false;

  // Nous / Hermes: text-only via OpenRouter
  if (modelId.startsWith("nousresearch/")) return false;

  // Default: conservative — no native tools, use text protocol
  return false;
}

function supportsOpenRouterParameter(model: OpenRouterModel | undefined, parameter: string): boolean {
  if (!model || model.supported_parameters.length === 0) return true;
  return model.supported_parameters.includes(parameter);
}

function surfaceTemperatureValue(cfg: JarvisConfig, surface: SurfaceType | undefined): number | undefined {
  if (surface && cfg.surface_temperatures?.[surface] !== undefined) return cfg.surface_temperatures[surface];
  return cfg.temperature;
}

export async function resolveEffectiveOpenRouterRequestConfig(
  cfg: JarvisConfig,
  modelId: string,
  messages: Array<any>,
  options: {
    requestedMaxTokens?: unknown;
    requestedTemperature?: unknown;
    requestedTopP?: unknown;
    surface?: SurfaceType;
  } = {},
): Promise<EffectiveOpenRouterRequestConfig> {
  let model: OpenRouterModel | undefined;
  try {
    const models = await listOpenRouterModels(cfg);
    model = models.find((candidate) => candidate.id === modelId);
  } catch (error) {
    console.warn("[OpenRouter] Failed to resolve model catalog metadata:", error);
  }

  const isRouter = model ? model.is_router : isOpenRouterRouterModel(modelId);
  const isFree = model ? model.is_free : isOpenRouterFreeModel(modelId);
  const completionLimit = openRouterModelMaxCompletionTokens(model);
  const contextLength = openRouterModelContextLength(model) ?? (isRouter ? 200000 : undefined);
  const contextAvailable = contextLength
    ? Math.max(1, contextLength - estimateOpenRouterMessageTokens(messages))
    : undefined;
  const hasExplicitMax = options.requestedMaxTokens !== undefined && options.requestedMaxTokens !== null;
  const requestedMax = positiveInteger(hasExplicitMax ? options.requestedMaxTokens : cfg.max_tokens);
  const conservativeRouterCap = isRouter ? 8192 : undefined;
  const modelLimit = minDefined(completionLimit, contextAvailable, conservativeRouterCap);
  const maxTokens = minDefined(modelLimit, requestedMax) ?? modelLimit ?? (hasExplicitMax ? requestedMax : undefined);

  const requestedTemp = typeof options.requestedTemperature === "number"
    ? options.requestedTemperature
    : Number(options.requestedTemperature);
  const defaultTemp = typeof model?.default_parameters?.temperature === "number"
    ? model.default_parameters.temperature
    : undefined;
  const configuredTemp = surfaceTemperatureValue(cfg, options.surface);
  const temperature = Number.isFinite(requestedTemp)
    ? requestedTemp
    : (isRouter ? Math.min(configuredTemp ?? 0.1, 0.2) : (configuredTemp ?? defaultTemp));

  const requestedTopP = typeof options.requestedTopP === "number"
    ? options.requestedTopP
    : Number(options.requestedTopP);
  const defaultTopP = typeof model?.default_parameters?.top_p === "number"
    ? model.default_parameters.top_p
    : undefined;
  const topP = Number.isFinite(requestedTopP) ? requestedTopP : (cfg.top_p ?? defaultTopP);

  return {
    model_id: modelId,
    model,
    is_free: isFree,
    is_router: isRouter,
    context_length: contextLength,
    max_completion_tokens: completionLimit,
    max_tokens: maxTokens,
    temperature: supportsOpenRouterParameter(model, "temperature") ? temperature : undefined,
    top_p: supportsOpenRouterParameter(model, "top_p") ? topP : undefined,
    supports_tools: isOpenRouterModelSupportsTools(model ?? modelId),
    supported_parameters: model?.supported_parameters ?? [],
    timeout_ms: cfg.openrouter.timeout_ms || 300000,
  };
}

export async function applyOpenRouterRequestConfig(
  requestBody: Record<string, any>,
  cfg: JarvisConfig,
  modelId: string,
  messages: Array<any>,
  options: {
    requestedMaxTokens?: unknown;
    requestedTemperature?: unknown;
    requestedTopP?: unknown;
    surface?: SurfaceType;
  } = {},
): Promise<EffectiveOpenRouterRequestConfig> {
  const effective = await resolveEffectiveOpenRouterRequestConfig(cfg, modelId, messages, options);
  requestBody.model = modelId;
  if (effective.max_tokens !== undefined) requestBody.max_tokens = effective.max_tokens;
  else delete requestBody.max_tokens;
  if (effective.temperature !== undefined) requestBody.temperature = effective.temperature;
  else delete requestBody.temperature;
  if (effective.top_p !== undefined) requestBody.top_p = effective.top_p;
  else delete requestBody.top_p;
  // Top-K sampling (ADR 0002 Layer 1). OpenRouter forwards this to providers
  // that support it; providers that don't simply ignore it.
  if (typeof cfg.top_k === "number" && cfg.top_k > 0) requestBody.top_k = cfg.top_k;
  else delete requestBody.top_k;
  if (!effective.supports_tools) delete requestBody.tools;

  console.log(
    `[OpenRouter] effective model=${modelId} free=${effective.is_free} router=${effective.is_router} ` +
    `ctx=${effective.context_length ?? "unknown"} max_out=${effective.max_tokens ?? "default"} tools=${effective.supports_tools ? "native" : "text"}`
  );
  return effective;
}

// ═══════════════════════════════════════════════════════════════
// Streaming: Robust SSE Parser
// ═══════════════════════════════════════════════════════════════

export interface SSEChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: any[];
      reasoning?: string;
    };
    finish_reason: string | null;
    logprobs?: any;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  // OpenRouter-specific extras
  or_cost?: number;
  or_id?: string;
}

/**
 * Parse a raw SSE line from the stream.
 * Returns null for [DONE], structured data for data: lines, throws on bad JSON.
 */
function parseSSELine(line: string): SSEChunk | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("data: ")) return null;

  const payload = trimmed.slice(6).trim();
  if (payload === "[DONE]") return null;

  // Some providers send "data: data: {…}" — strip double prefix
  if (payload.startsWith("data: ")) {
    return parseSSELine(`data: ${payload.slice(6)}`);
  }

  if (!payload) return null;

  try {
    const parsed = JSON.parse(payload);
    return parsed as SSEChunk;
  } catch {
    // Not valid JSON — likely a provider error or half-line
    return null;
  }
}

/**
 * Read an SSE stream and accumulate chunks.
 * Handles partial lines across buffer boundaries and malformed providers.
 */
export async function* streamOpenRouterSSE(
  response: Response,
): AsyncGenerator<SSEChunk, { cost: OpenRouterCostInfo | null; error: OpenRouterError | null }, unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { cost: null, error: { status: 500, code: "no_body", message: "Response body missing" } };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedCost: OpenRouterCostInfo | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = parseSSELine(line);
        if (chunk) {
          // Accumulate cost from final usage block
          if (chunk.usage) {
            accumulatedCost = {
              prompt_tokens: chunk.usage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
              total_cost_usd: chunk.or_cost ?? 0,
              generation_id: chunk.or_id ?? "",
              model: chunk.model ?? "",
            };
          }
          yield chunk;
        }
      }
    }

    // Flush any remaining buffer content
    if (buffer.trim()) {
      const lines = buffer.split("\n").filter(Boolean);
      for (const line of lines) {
        const chunk = parseSSELine(line);
        if (chunk) {
          if (chunk.usage) {
            accumulatedCost = {
              prompt_tokens: chunk.usage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
              total_cost_usd: chunk.or_cost ?? 0,
              generation_id: chunk.or_id ?? "",
              model: chunk.model ?? "",
            };
          }
          yield chunk;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { cost: accumulatedCost, error: null };
}

// ═══════════════════════════════════════════════════════════════
// Retry / Fallback Logic
// ═══════════════════════════════════════════════════════════════

const RETRY_DELAYS = [1000, 2000, 4000]; // ms exponential backoff
const PREFERRED_FREE_FALLBACKS = [
  "openrouter/free",
  "openrouter/owl-alpha",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "qwen/qwen3-coder:free",
  "openai/gpt-oss-120b:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine if an HTTP status is retryable
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 502 || status === 504;
}

async function resolveFallbackModels(cfg: JarvisConfig): Promise<string[]> {
  const requested = cfg.openrouter.model || "openrouter/free";
  try {
    const catalog = await listOpenRouterModels(cfg);
    const byId = new Map(catalog.map((model) => [model.id, model]));
    const freeCatalogIds = catalog
      .filter((model) => model.is_free && model.id !== requested)
      .map((model) => model.id);
    const paidFallbacksAllowed = Boolean((cfg.openrouter as any).enable_paid_fallbacks);
    const configuredFallbacks = (cfg.openrouter.fallbacks || [])
      .filter((modelId) => {
        const model = byId.get(modelId);
        if (!model) return paidFallbacksAllowed;
        return model.is_free || paidFallbacksAllowed;
      });

    return Array.from(new Set([
      requested,
      ...PREFERRED_FREE_FALLBACKS.filter((id) => id !== requested && byId.has(id)),
      ...freeCatalogIds,
      ...configuredFallbacks,
    ]));
  } catch (error) {
    console.warn("[OpenRouter] Failed to build catalog-aware fallback list:", error);
    const configuredFreeOnly = (cfg.openrouter.fallbacks || []).filter((id) => id.endsWith(":free") || id === "openrouter/free");
    return Array.from(new Set([requested, "openrouter/free", ...configuredFreeOnly]));
  }
}

/**
 * Attempt a chat completion with the given model, retrying on transient errors.
 * Falls back to the provided fallback models if the primary model fails.
 */
export async function chatCompletionWithFallback(
  cfg: JarvisConfig,
  requestBody: any,
  signal?: AbortSignal,
): Promise<{ response: Response; model_used: string; retries: number }> {
  const allModels = await resolveFallbackModels(cfg);
  let lastError = "";
  const primaryRetryCount = Math.max(0, Number(cfg.openrouter.max_retries ?? RETRY_DELAYS.length));

  for (let attempt = 0; attempt < allModels.length; attempt++) {
    const model = allModels[attempt];
    const retryDelays = attempt === 0
      ? RETRY_DELAYS.slice(0, primaryRetryCount)
      : RETRY_DELAYS.slice(0, Math.min(primaryRetryCount, 1)); // Less retries for fallbacks

    for (let retry = 0; retry <= retryDelays.length; retry++) {
      try {
        const modelRequestBody = { ...requestBody, model };
        await applyOpenRouterRequestConfig(
          modelRequestBody,
          cfg,
          model,
          modelRequestBody.messages ?? [],
          {
            requestedTemperature: requestBody.temperature,
            requestedTopP: requestBody.top_p,
          },
        );
        const res = await fetch(`${cfg.openrouter.base_url}/chat/completions`, {
          method: "POST",
          signal,
          headers: {
            "Authorization": `Bearer ${cfg.openrouter.api_key}`,
            "Content-Type": "application/json",
            "HTTP-Referer": cfg.o
            "X-Title": cfg.openrouter.site_name,
          },
          body: JSON.stringify(modelRequestBody),
        });

        if (res.ok) {
          return { response: res, model_used: model, retries: retry + attempt };
        }

        // Non-retryable error
        if (!isRetryableStatus(res.status)) {
          const body = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        }

        // Retryable error — wait and retry with same model
        if (retry < retryDelays.length) {
          const delayMs = retryDelays[retry] + Math.random() * 500;
          console.warn(`[OpenRouter] ${model} returned ${res.status}, retrying in ${Math.round(delayMs)}ms (attempt ${retry + 1}/${retryDelays.length})`);
          await sleep(delayMs);
          continue;
        }

        // Exhausted retries for this model, move to next fallback
        lastError = `Model ${model} failed after ${retryDelays.length + 1} attempts`;
        break;
      } catch (e: any) {
        if (e.name === "AbortError" || e.message?.includes("abort")) {
          throw e; // Don't retry user-aborted requests
        }
        lastError = e.message || String(e);
        if (retry < retryDelays.length) {
          await sleep(retryDelays[retry]);
        }
      }
    }
  }

  throw new Error(`All OpenRouter models exhausted. Last error: ${lastError}`);
}

// ═══════════════════════════════════════════════════════════════
// Health Check
// ═══════════════════════════════════════════════════════════════

export async function checkOpenRouterHealth(cfg: JarvisConfig, forceRefresh = false): Promise<OpenRouterHealth> {
  checkKeyChange(cfg.openrouter.api_key);
  const start = Date.now();

  if (!forceRefresh && cachedModels && (Date.now() - lastFetchTime < CACHE_TTL_MS)) {
    return { ok: true, latencyMs: 0 };
  }

  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);

    const res = await fetch(`${cfg.openrouter.base_url}/models`, {
      signal: ctrl.signal,
      headers: {
        "Authorization": `Bearer ${cfg.openrouter.api_key}`,
        "HTTP-Referer": cfg.openrouter.site_url,
        "X-Title": cfg.openrouter.site_name,
      },
    });

    if (res.status === 401) {
      return { ok: false, latencyMs: Date.now() - start, error: "Invalid API key — check your key at https://openrouter.ai/keys" };
    }
    if (res.status === 429) {
      return { ok: false, latencyMs: Date.now() - start, error: "Rate limited — too many requests to OpenRouter" };
    }
    if (res.status === 503) {
      return { ok: false, latencyMs: Date.now() - start, error: "OpenRouter is overloaded — try again shortly" };
    }
    if (!res.ok) {
      return { ok: false, latencyMs: Date.now() - start, error: `HTTP ${res.status}` };
    }

    // Cache models
    const json = await res.json();
    const models = (json.data || []).map(normalizeOpenRouterModel).sort(compareOpenRouterModels);

    cachedModels = models;
    lastFetchTime = Date.now();

    return { ok: true, latencyMs: Date.now() - start };
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - start, error: e.message || String(e) };
  }
}

// ═══════════════════════════════════════════════════════════════
// Model Discovery
// ═══════════════════════════════════════════════════════════════

export async function listOpenRouterModels(cfg: JarvisConfig, forceRefresh = false): Promise<OpenRouterModel[]> {
  checkKeyChange(cfg.openrouter.api_key);
  const now = Date.now();

  if (!forceRefresh && cachedModels && (now - lastFetchTime < CACHE_TTL_MS)) {
    return cachedModels;
  }

  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10000);

    const res = await fetch(`${cfg.openrouter.base_url}/models`, {
      signal: ctrl.signal,
      headers: {
        "Authorization": `Bearer ${cfg.openrouter.api_key}`,
        "HTTP-Referer": cfg.openrouter.site_url,
        "X-Title": cfg.openrouter.site_name,
      },
    });

    if (!res.ok) return cachedModels || [];

    const json = await res.json();
    const models = (json.data || []).map(normalizeOpenRouterModel).sort(compareOpenRouterModels);

    cachedModels = models;
    lastFetchTime = now;
    return models;
  } catch (e) {
    console.error("[OpenRouter] Model listing failed:", e);
    return cachedModels || [];
  }
}

// ═══════════════════════════════════════════════════════════════
// Chat Headers
// ═══════════════════════════════════════════════════════════════

export function openRouterHeaders(cfg: JarvisConfig): Record<string, string> {
  return {
    "Authorization": `Bearer ${cfg.openrouter.api_key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": cfg.openrouter.site_url,
    "X-Title": cfg.openrouter.site_name,
  };
}

// ═══════════════════════════════════════════════════════════════
// Cost Tracking (stub — call after streaming finishes)
// ═══════════════════════════════════════════════════════════════

export function logOpenRouterCost(cost: OpenRouterCostInfo | null): void {
  if (!cost) return;
  console.log(
    `[OpenRouter Cost] ${cost.total_tokens} tokens ($${cost.total_cost_usd.toFixed(6)}) via ${cost.model} [${cost.generation_id}]`
  );
}
