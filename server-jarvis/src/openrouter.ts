// ═══════════════════════════════════════════════════════════════
// ── OpenRouter v2 — Production-Grade Integration ──
// ═══════════════════════════════════════════════════════════════
// Full streaming, tool-call compatibility, cost tracking,
// retry/fallback, and per-model capability gates.

import type { JarvisConfig, SurfaceType } from "./config";
import { AgentPool } from "./orchestration/agent-pool";
import {
  resolveProviderTarget,
  providerChatUrl,
  providerHeaders,
  type HttpProviderId,
} from "./providers";
import { isTemporarilyExcluded, recordHardFailure, recordRateLimit, recordStall, recordSuccess } from "./model-failure-memory";
import { backendForProvider, recordInferenceAttempt } from "./inference-metrics";
import { TurnDeadlineExceededError } from "./stream-liveness";
import { openCodeGoProtocolForModel } from "./orchestration/live-model-catalog";

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
// Cap how many DISTINCT models one chatCompletionWithFallback invocation will
// grind through before it fails honestly. resolveFallbackCascade appends the
// ENTIRE free OpenRouter catalog as a tail (see the catalog enumeration in that
// function), so a single call's cascade can be a dozen-plus models deep. Live
// telemetry saw up to 17 distinct models served across one benchmark session —
// "model roulette": long tail latency from sequentially probing many bad picks.
// Three attempts (stage default + two fallbacks) keep real cross-provider
// resilience while bounding the pathological tail on any single stage call.
const MAX_FALLBACK_MODELS = 3;
const PREFERRED_FREE_FALLBACKS = [
  "openrouter/free",
  "cohere/north-mini-code:free",
  "qwen/qwen3-coder:free",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1:free",
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

interface FallbackResolveOptions {
  stage?: string;
  taskType?: string;
  cascadeTier?: "cheap" | "strong";
  /**
   * Provider:model keys to drop from the cascade. Used to ADVANCE past a model
   * that returned a semantically-empty 200 (no content + no tool calls) on the
   * previous attempt — retrying the same model would just return empty again.
   */
  excludeModels?: ReadonlySet<string>;
  /** Absolute wall-clock deadline shared by the whole server turn. */
  deadlineAt?: number;
  /** Original turn budget, retained for actionable timeout metadata. */
  turnBudgetMs?: number;
}

function assertFallbackDeadline(options: FallbackResolveOptions): void {
  if (options.deadlineAt === undefined || Date.now() < options.deadlineAt) return;
  const error = new TurnDeadlineExceededError(options.stage ?? "fallback_cascade", options.turnBudgetMs ?? 0);
  error.message = `turn_deadline_exceeded: ${error.message}`;
  throw error;
}

/** One step in the cross-provider fallback cascade. */
interface CascadeEntry {
  provider: HttpProviderId;
  model_id: string;
}

const SUPPORTED_HTTP_PROVIDERS: ReadonlySet<string> = new Set([
  "openrouter",
  "opencode_zen",
  "opencode_go",
]);

/**
 * Resolve the stage's pool agents as an ordered cross-provider cascade. The
 * AgentPool already orders these optimally (stage default first, then by
 * overall score), so the cascade walks from the best model to progressively
 * cheaper/more-available ones — across OpenRouter and the OpenCode providers.
 */
function resolvePoolAgents(cfg: JarvisConfig, options: FallbackResolveOptions = {}): CascadeEntry[] {
  if (!options.stage) return [];
  const pool = new AgentPool(cfg.orchestrator?.agents ?? []);
  let agents;
  if (options.cascadeTier) {
    const cascade = pool.cascadeChain(options.stage, options.taskType ?? "general", options.excludeModels);
    agents = options.cascadeTier === "strong" ? [...cascade].reverse() : cascade;
  } else {
    // Honor excludeModels here too: a model that already returned an empty
    // completion for this stage (see index.ts's callModel empty-completion
    // cascade-advance) must not be re-selected as the "selected" agent whose
    // fallbackChain() we then build — otherwise the excluded model gets
    // filtered out of the resulting cascade by push()'s own exclusion check,
    // but the REST of the chain is sorted by fallbackChain's stage-agnostic
    // overallScore() rather than pickFor's stage+taskType-aware score(),
    // silently promoting a merely well-rounded model ahead of the model that
    // pickFor(stage, taskType, exclude) would directly and correctly select
    // as the true next-best candidate for this specific stage.
    const selected = pool.pickFor(options.stage, options.taskType ?? "general", options.excludeModels);
    agents = selected ? pool.fallbackChain(selected, options.stage, options.taskType ?? "general") : [];
  }
  return agents
    .filter((agent) => SUPPORTED_HTTP_PROVIDERS.has(agent.provider))
    .map((agent) => ({ provider: agent.provider as HttpProviderId, model_id: agent.model_id }));
}

/**
 * Build the full fallback cascade: the stage's pool agents (cross-provider,
 * optimally ordered) followed by an OpenRouter-only tail of free/configured
 * models. Pool agents are trusted as-is (NOT filtered against the OpenRouter
 * catalog — that catalog only knows OpenRouter ids, and would wrongly drop
 * valid OpenCode models). The catalog is only consulted to enumerate the free
 * OpenRouter tail.
 */
async function resolveFallbackCascade(cfg: JarvisConfig, options: FallbackResolveOptions = {}): Promise<CascadeEntry[]> {
  const requested = cfg.openrouter.model || "openrouter/free";
  const seen = new Set<string>();
  const excluded = options.excludeModels ?? new Set<string>();
  const cascade: CascadeEntry[] = [];
  const push = (entry: CascadeEntry) => {
    const key = `${entry.provider}:${entry.model_id}`;
    if (!entry.model_id || seen.has(key) || excluded.has(key) || excluded.has(`${entry.provider}:*`)) return;
    seen.add(key);
    cascade.push(entry);
  };

  // 1. Pool agents first — cross-provider, optimal order.
  for (const entry of resolvePoolAgents(cfg, options)) push(entry);

  // 2. OpenRouter free/configured tail (catalog-aware).
  try {
    const catalog = await listOpenRouterModels(cfg);
    const byId = new Map(catalog.map((model) => [model.id, model]));
    const paidFallbacksAllowed = Boolean((cfg.openrouter as any).enable_paid_fallbacks);
    if (byId.has(requested) || requested === "openrouter/free") {
      push({ provider: "openrouter", model_id: requested });
    }
    for (const id of PREFERRED_FREE_FALLBACKS) {
      if (id !== requested && byId.has(id)) push({ provider: "openrouter", model_id: id });
    }
    for (const model of catalog) {
      if (model.is_free && model.id !== requested) push({ provider: "openrouter", model_id: model.id });
    }
    for (const id of cfg.openrouter.fallbacks || []) {
      const model = byId.get(id);
      if (!model && !paidFallbacksAllowed) continue;
      if (model && !model.is_free && !paidFallbacksAllowed) continue;
      push({ provider: "openrouter", model_id: id });
    }
  } catch (error) {
    console.warn("[OpenRouter] Failed to build catalog-aware fallback tail:", error);
    push({ provider: "openrouter", model_id: requested });
    push({ provider: "openrouter", model_id: "openrouter/free" });
    for (const id of (cfg.openrouter.fallbacks || []).filter((m) => m.endsWith(":free") || m === "openrouter/free")) {
      push({ provider: "openrouter", model_id: id });
    }
  }

  return cascade;
}

/**
 * Strip or convert tool-related fields from messages for providers that do NOT
 * support native tool calling (OpenCode Zen/Go, or an OpenRouter free model
 * that uses the text tool protocol).
 *
 * When the orchestrator's executor stage runs multiple turns, the conversation
 * accumulates `role: "tool"` messages and assistant messages with `tool_calls`
 * fields. Non-tool-capable providers reject these with 400 errors like "missing
 * field `function`" or "missing field `type`", which tank the entire fallback
 * cascade (observed 2026-06-27: 15 consecutive 400s before landing on
 * openrouter/free).
 *
 * Transformation:
 *   1. `role: "tool"` → `role: "user"` with a descriptive prefix so the model
 *      still sees the tool's output in the conversation history.
 *   2. Strip `tool_calls` from assistant messages — the text protocol embeds
 *      calls in the text content, so the native field is redundant and harmful
 *      for text-protocol providers.
 */
function sanitizeToolMessages(msgs: Array<any>): Array<any> {
  if (!Array.isArray(msgs)) return msgs;
  return msgs.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    // Convert tool result messages to user role with a context prefix
    if (msg.role === "tool") {
      const name = typeof msg.name === "string" ? msg.name : "unknown_tool";
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      return { role: "user", content: `[Tool result from ${name}]: ${content}` };
    }
    // Strip tool_calls from assistant messages (text protocol was used)
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const { tool_calls, ...clean } = msg;
      return clean;
    }
    return msg;
  });
}

function anthropicMessageContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const blocks = content.flatMap((block) => {
    if (typeof block === "string") return [{ type: "text", text: block }];
    if (!block || typeof block !== "object") return [];
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") return [{ type: "text", text: value.text }];
    return [];
  });
  return blocks.length > 0 ? blocks : "";
}

/** Convert Jarvis's OpenAI-shaped stage request to OpenCode Go /messages. */
function buildAnthropicAttemptBody(body: Record<string, any>, model: string): Record<string, any> {
  const system: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }> = [];
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.role === "system") {
      const content = anthropicMessageContent(raw.content);
      if (typeof content === "string" && content.trim()) system.push(content);
      continue;
    }
    const role: "user" | "assistant" = raw.role === "assistant" ? "assistant" : "user";
    const content = anthropicMessageContent(raw.content);
    const previous = messages[messages.length - 1];
    if (previous?.role === role && typeof previous.content === "string" && typeof content === "string") {
      previous.content = `${previous.content}\n\n${content}`;
    } else {
      messages.push({ role, content });
    }
  }

  const maxTokens = Math.max(1, Number(body.max_tokens ?? body.max_completion_tokens ?? 8_192) || 8_192);
  const converted: Record<string, any> = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: body.stream !== false,
  };
  if (system.length > 0) converted.system = system.join("\n\n---\n\n");
  if (Number.isFinite(Number(body.temperature))) converted.temperature = Number(body.temperature);
  if (Number.isFinite(Number(body.top_p))) converted.top_p = Number(body.top_p);
  if (body.stop !== undefined) converted.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  return converted;
}

function mapAnthropicStopReason(reason: unknown): string | null {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  if (typeof reason === "string" && reason) return "stop";
  return null;
}

/**
 * Normalize Anthropic /messages SSE into the OpenAI-compatible SSE contract
 * consumed by both Jarvis streaming loops. Hidden thinking stays hidden via
 * `delta.reasoning`; visible text and final usage retain their normal fields.
 */
function normalizeAnthropicSse(response: Response, requestedModel: string): Response {
  const source = response.body;
  if (!source) return response;
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let messageId = "";
  let responseModel = requestedModel;
  let inputTokens = 0;
  let outputTokens = 0;
  let doneEmitted = false;

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") return;
        let event: any;
        try { event = JSON.parse(payload); } catch { return; }

        if (event.type === "message_start") {
          messageId = String(event.message?.id ?? messageId);
          responseModel = String(event.message?.model ?? responseModel);
          inputTokens = Number(event.message?.usage?.input_tokens ?? inputTokens) || inputTokens;
          return;
        }
        if (event.type === "content_block_delta") {
          if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
            emit({ id: messageId, model: responseModel, choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }] });
          } else if ((event.delta?.type === "thinking_delta" || event.delta?.type === "reasoning_delta") && typeof (event.delta.thinking ?? event.delta.reasoning) === "string") {
            emit({ id: messageId, model: responseModel, choices: [{ index: 0, delta: { reasoning: event.delta.thinking ?? event.delta.reasoning }, finish_reason: null }] });
          }
          return;
        }
        if (event.type === "message_delta") {
          outputTokens = Number(event.usage?.output_tokens ?? outputTokens) || outputTokens;
          emit({
            id: messageId,
            model: responseModel,
            choices: [{ index: 0, delta: {}, finish_reason: mapAnthropicStopReason(event.delta?.stop_reason) }],
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
            },
          });
          return;
        }
        if (event.type === "error") {
          emit({ error: event.error ?? { message: "Anthropic protocol stream error" } });
          return;
        }
        if (event.type === "message_stop" && !doneEmitted) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          doneEmitted = true;
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) handleLine(line);
        }
        buffer += decoder.decode();
        if (buffer) handleLine(buffer);
        if (!doneEmitted) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    },
  });
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  return new Response(readable, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Build the per-attempt request body for a provider. OpenRouter bodies get the
 * full catalog-aware massaging (max_tokens, temperature/top_p gating, native
 * tool support). OpenCode (Zen/Go) are OpenAI-compatible but have no catalog
 * here, so we send a lean body and drop `tools` (those stages use the text
 * tool protocol — see callModel's `useTextTools`).
 *
 * CRITICAL: Tool-related message fields are sanitised for providers that do
 * NOT support native tools. Without this, a multi-turn executor conversation
 * that accumulated `role: "tool"` and `tool_calls` fields would cause a 400
 * error on every non-tool-capable model in the fallback cascade.
 */
async function buildAttemptBody(
  cfg: JarvisConfig,
  provider: HttpProviderId,
  requestBody: any,
  model: string,
): Promise<Record<string, any>> {
  const body: Record<string, any> = { ...requestBody, model };
  if (provider === "openrouter") {
    await applyOpenRouterRequestConfig(body, cfg, model, body.messages ?? [], {
      requestedTemperature: requestBody.temperature,
      requestedTopP: requestBody.top_p,
    });
    // Sanitize tool message fields for OpenRouter models that resolved to
    // text-tool-protocol (body.tools was already deleted by the config step).
    if (!body.tools && Array.isArray(body.messages)) {
      body.messages = sanitizeToolMessages(body.messages);
    }
  } else {
    delete body.tools;
    delete body.tool_choice;
    // Always sanitize for non-OpenRouter providers (OpenCode Zen/Go) — they
    // use the text tool protocol and cannot process native tool message fields.
    if (Array.isArray(body.messages)) {
      body.messages = sanitizeToolMessages(body.messages);
    }
    if (provider === "opencode_go" && openCodeGoProtocolForModel(model) === "anthropic") {
      return buildAnthropicAttemptBody(body, model);
    }
  }
  return body;
}

/**
 * Attempt a chat completion, cascading across the stage's agent pool and an
 * OpenRouter fallback tail. Fallback policy:
 *   • Rate-limit (429): retry the SAME model at most twice — after 2 consecutive
 *     429s, advance to the next optimal pool model (per the orchestrator spec).
 *   • Other transient (502/503/504) or network errors: one short retry, then
 *     advance.
 *   • Non-retryable HTTP (4xx other than 429): advance to the next model rather
 *     than aborting the whole turn — a single bad model/provider never kills a
 *     turn that another pool model could answer.
 *   • First-token watchdog: a model that opens the connection but never sends a
 *     body byte within the timeout is abandoned and the cascade advances.
 * Only when EVERY model is exhausted do we throw.
 */
export async function chatCompletionWithFallback(
  cfg: JarvisConfig,
  requestBody: any,
  signal?: AbortSignal,
  options: FallbackResolveOptions = {},
): Promise<{
  response: Response;
  model_used: string;
  provider_used: HttpProviderId;
  /** Actual failed HTTP/transport attempts before the successful response. */
  retries: number;
  /** Number of distinct cascade entries advanced past. */
  fallback_depth: number;
  fallback_reason?: string;
}> {
  assertFallbackDeadline(options);
  const cascade = await resolveFallbackCascade(cfg, options);
  if (cascade.length === 0) {
    cascade.push({ provider: "openrouter", model_id: cfg.openrouter.model || "openrouter/free" });
  }

  // Cross-turn failure memory (model-failure-memory.ts): a model that hard
  // failed or stalled repeatedly, or a provider that repeatedly returned
  // 429, is skipped here so later stages do not pay the same retry tax.
  // Never let exclusion leave zero attemptable entries — if everything
  // remaining is excluded, fall back to the original cascade and warn.
  const excludedNow = cascade.filter(
    (entry) => !isTemporarilyExcluded(entry.provider, entry.model_id),
  );
  const effectiveCascade = excludedNow.length > 0 ? excludedNow : cascade;
  if (excludedNow.length < cascade.length) {
    const skipped = cascade.filter((entry) => !excludedNow.includes(entry));
    if (excludedNow.length === 0) {
      console.warn(
        `[Fallback] All ${cascade.length} cascade entries are in temporary failure cooldown — ignoring exclusions and using the original cascade anyway.`,
      );
    } else {
      for (const entry of skipped) {
        console.warn(`[Fallback] Skipping ${entry.provider}:${entry.model_id} — in temporary failure or rate-limit cooldown.`);
      }
    }
  }

  let lastError = "";
  let totalAttempts = 0;
  let fallbackReason: string | undefined;
  // `max_retries` is the configured ceiling on per-model attempts. The 2-strike
  // rate-limit rule and the single-retry transient policy are clamped to it, so
  // setting max_retries=0 disables all same-model retries (immediate advance).
  const maxRetries = Math.max(0, Number(cfg.openrouter.max_retries ?? RETRY_DELAYS.length));
  // User rule: 2 consecutive rate-limit (429) errors on a model → next pool model.
  const RATE_LIMIT_MAX_ATTEMPTS = Math.max(1, Math.min(2, maxRetries + 1));
  // Non-429 transient errors (502/503/504, network): at most one short retry.
  const OTHER_TRANSIENT_MAX_ATTEMPTS = Math.max(1, Math.min(2, maxRetries + 1));
  // First-token watchdog: how long to wait for the response body's first byte
  // before declaring the model hung and advancing the cascade. Guards against
  // a model that opens the HTTP connection but never streams (the post-hang
  // diagnosis: multi-minute stalls on a free-router call).
  // Bound the cascade to at most MAX_FALLBACK_MODELS distinct models per call.
  // `capHit` records whether we deliberately stopped short of a longer cascade
  // (so the final error can distinguish "we capped at 3" from "the whole small
  // pool was genuinely exhausted") for operator diagnosis.
  const cappedCascade = effectiveCascade.slice(0, MAX_FALLBACK_MODELS);
  const capHit = effectiveCascade.length > cappedCascade.length;
  for (let modelIdx = 0; modelIdx < cappedCascade.length; modelIdx++) {
    assertFallbackDeadline(options);
    const { provider, model_id: model } = cappedCascade[modelIdx];
    const target = resolveProviderTarget(cfg, provider);
    const firstTokenTimeoutMs = Math.max(1_000, target.first_token_timeout_ms);
    if (!target.api_key) {
      lastError = `No API key configured for provider "${provider}" (model ${model}) — skipping`;
      console.warn(`[Fallback] ${lastError}`);
      continue;
    }

    let rateLimitStrikes = 0;
    let transientRetries = 0;

    // Per-model attempt loop. Each `continue` retries the same model; each
    // `break` advances to the next model in the cascade.
    attemptLoop: while (true) {
      assertFallbackDeadline(options);
      const STALL_REASON = `first-token-timeout:${provider}:${model}`;
      const attemptCtrl = new AbortController();
      const onUserAbort = () => attemptCtrl.abort(signal?.reason);
      if (signal) {
        if (signal.aborted) attemptCtrl.abort(signal.reason);
        else signal.addEventListener("abort", onUserAbort, { once: true });
      }
      let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
      let headersTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        totalAttempts += 1;
        const attemptBody = await buildAttemptBody(cfg, provider, requestBody, model);
        // Headers leash (live incident 2026-07-16 PM, session f458849c): the
        // body-bytes watchdog below only arms AFTER the HTTP response headers
        // arrive. A provider that accepts the connection and never answers
        // left the attempt bounded only by the caller's whole-request budget
        // (47-74s observed), consuming the stage window or the turn deadline.
        // Bound the pre-header phase by the same per-provider first-token
        // window and advance the cascade instead.
        const HEADERS_STALL_REASON = `headers-timeout:${provider}:${model}`;
        const fetchPromise = fetch(providerChatUrl(target, model), {
          method: "POST",
          signal: attemptCtrl.signal,
          headers: providerHeaders(cfg, target, model),
          body: JSON.stringify(attemptBody),
        });
        // The losing race arm may reject (AbortError) after we've moved on —
        // register a no-op handler so it can never surface as an unhandled
        // rejection. The raced arm below still observes the real outcome.
        fetchPromise.catch(() => {});
        const headersOutcome = await Promise.race([
          fetchPromise.then((res) => ({ kind: "response" as const, res })),
          new Promise<{ kind: "headers-timeout" }>((resolve) => {
            headersTimer = setTimeout(() => resolve({ kind: "headers-timeout" }), firstTokenTimeoutMs);
          }),
        ]);
        clearTimeout(headersTimer);
        if (headersOutcome.kind === "headers-timeout") {
          attemptCtrl.abort(HEADERS_STALL_REASON);
          lastError = `Model ${model} (${provider}) returned no HTTP response headers within ${firstTokenTimeoutMs}ms (headers timeout)`;
          console.warn(`[Fallback] ${lastError} — advancing to next model`);
          fallbackReason = "first_token_timeout";
          recordStall(provider, model);
          recordInferenceAttempt({
            ts: Date.now(),
            stage: options.stage ?? "agent",
            provider: backendForProvider(provider, "openrouter"),
            model,
            outcome: "first_token_timeout",
            latency_ms: firstTokenTimeoutMs,
            fallback_attempt: modelIdx,
          });
          break attemptLoop;
        }
        const res = headersOutcome.res;

        if (res.ok) {
          // First-token watchdog: race the first body chunk against the timer.
          const bodyReader = res.body?.getReader();
          if (!bodyReader) {
            recordSuccess(provider, model);
            return {
              response: provider === "opencode_go" && openCodeGoProtocolForModel(model) === "anthropic"
                ? normalizeAnthropicSse(res, model)
                : res,
              model_used: model,
              provider_used: provider,
              retries: Math.max(0, totalAttempts - 1),
              fallback_depth: modelIdx,
              fallback_reason: fallbackReason,
            };
          }
          const firstByteTimeout = new Promise<"timeout">((resolve) => {
            watchdogTimer = setTimeout(() => resolve("timeout"), firstTokenTimeoutMs);
          });
          const raceResult = await Promise.race([
            bodyReader.read().then((chunk) => ({ kind: "chunk" as const, chunk })),
            firstByteTimeout.then(() => ({ kind: "timeout" as const })),
          ]);
          if (raceResult.kind === "timeout") {
            attemptCtrl.abort(STALL_REASON);
            try { await bodyReader.cancel().catch(() => {}); } catch {}
            lastError = `Model ${model} (${provider}) sent no body bytes within ${firstTokenTimeoutMs}ms (first-token timeout)`;
            console.warn(`[Fallback] ${lastError} — advancing to next model`);
            fallbackReason = "first_token_timeout";
            recordStall(provider, model);
            recordInferenceAttempt({
              ts: Date.now(),
              stage: options.stage ?? "agent",
              provider: backendForProvider(provider, "openrouter"),
              model,
              outcome: "first_token_timeout",
              latency_ms: firstTokenTimeoutMs,
              fallback_attempt: modelIdx,
            });
            break attemptLoop;
          }
          clearTimeout(watchdogTimer);
          const rewrapped = rewrapReadableStreamWithFirstChunk(
            bodyReader as unknown as ReadableStreamDefaultReader<any>,
            raceResult.chunk as ReadableStreamReadResult<any>,
          );
          let newResponse = new Response(rewrapped, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
          if (provider === "opencode_go" && openCodeGoProtocolForModel(model) === "anthropic") {
            newResponse = normalizeAnthropicSse(newResponse, model);
          }
          recordSuccess(provider, model);
          return {
            response: newResponse,
            model_used: model,
            provider_used: provider,
            retries: Math.max(0, totalAttempts - 1),
            fallback_depth: modelIdx,
            fallback_reason: fallbackReason,
          };
        }

        // ── Rate limit: 2-strike rule ──
        if (res.status === 429) {
          await res.text().catch(() => "");
          rateLimitStrikes++;
          recordRateLimit(provider, model);
          fallbackReason = "rate_limited";
          lastError = `Model ${model} (${provider}) rate limited (429) [strike ${rateLimitStrikes}/${RATE_LIMIT_MAX_ATTEMPTS}]`;
          if (rateLimitStrikes >= RATE_LIMIT_MAX_ATTEMPTS) {
            console.warn(`[Fallback] ${lastError} — advancing to next optimal pool model`);
            break attemptLoop;
          }
          const delayMs = RETRY_DELAYS[rateLimitStrikes - 1] ?? 1000;
          console.warn(`[Fallback] ${lastError} — retrying same model in ${Math.round(delayMs)}ms`);
          await sleep(delayMs + Math.random() * 300);
          continue attemptLoop;
        }

        // ── Other transient errors (502/503/504): one short retry ──
        if (isRetryableStatus(res.status)) {
          await res.text().catch(() => "");
          transientRetries++;
          fallbackReason = `http_${res.status}`;
          lastError = `Model ${model} (${provider}) returned ${res.status} [retry ${transientRetries}/${OTHER_TRANSIENT_MAX_ATTEMPTS}]`;
          if (transientRetries >= OTHER_TRANSIENT_MAX_ATTEMPTS) {
            console.warn(`[Fallback] ${lastError} — advancing to next model`);
            break attemptLoop;
          }
          await sleep((RETRY_DELAYS[transientRetries - 1] ?? 1000) + Math.random() * 300);
          continue attemptLoop;
        }

        // ── Non-retryable HTTP error: advance, don't kill the turn ──
        const body = await res.text().catch(() => "");
        lastError = `Model ${model} (${provider}) HTTP ${res.status}: ${body.slice(0, 160)}`;
        console.warn(`[Fallback] ${lastError} — advancing to next model`);
        // Cross-turn memory: this is a hard, non-retryable failure (never a
        // 429, never a retried transient 5xx, never a first-token stall —
        // those are handled above/below and never reach this branch). Two of
        // these on the same provider:model within the cooldown window will
        // exclude it from future cascades until the window lapses.
        fallbackReason = `http_${res.status}`;
        recordHardFailure(provider, model);
        break attemptLoop;
      } catch (e: any) {
        // Distinguish user-cancel (fatal) from watchdog-abort / network error.
        const isStall = (e?.message ?? "").includes(STALL_REASON)
          || (attemptCtrl.signal.reason === STALL_REASON);
        const isUserCancel = signal?.aborted && !isStall;
        if (isUserCancel || (e.name === "AbortError" && !isStall)) {
          throw e; // Don't retry user-aborted requests
        }
        if (isStall) {
          lastError = e.message || lastError;
          break attemptLoop;
        }
        // Network/transport error — one short retry, then advance.
        transientRetries++;
        fallbackReason = "network_error";
        lastError = e.message || String(e);
        if (transientRetries >= OTHER_TRANSIENT_MAX_ATTEMPTS) {
          console.warn(`[Fallback] Model ${model} (${provider}) network error: ${lastError} — advancing to next model`);
          break attemptLoop;
        }
        await sleep(RETRY_DELAYS[transientRetries - 1] ?? 1000);
        continue attemptLoop;
      } finally {
        if (watchdogTimer) clearTimeout(watchdogTimer);
        if (headersTimer) clearTimeout(headersTimer);
        if (signal) signal.removeEventListener("abort", onUserAbort);
      }
    }
  }

  throw new Error(
    capHit
      ? `All ${cappedCascade.length} attempted provider models exhausted (fallback cap ${MAX_FALLBACK_MODELS} of ${effectiveCascade.length} available). Last error: ${lastError}`
      : `All provider models exhausted. Last error: ${lastError}`,
  );
}

/**
 * Reassemble a ReadableStream from an already-read first chunk plus
 * the remaining body of the original stream. Used by
 * `chatCompletionWithFallback` after the first-token watchdog fires
 * the first body byte: we already consumed the first chunk (to test
 * whether bytes were arriving), so we re-prepend it to a tee of the
 * rest of the original stream and return a Response the caller can
 * read normally.
 */
function rewrapReadableStreamWithFirstChunk(
  original: ReadableStreamDefaultReader<any>,
  firstChunk: ReadableStreamReadResult<any>,
): ReadableStream<any> {
  let firstEnqueued = false;
  return new ReadableStream<any>({
    async pull(controller) {
      if (!firstEnqueued && !firstChunk.done && firstChunk.value !== undefined) {
        controller.enqueue(firstChunk.value);
        firstEnqueued = true;
      }
      try {
        const next = await original.read();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (e) {
        controller.error(e);
      }
    },
    cancel(reason) {
      return original.cancel(reason).catch(() => {});
    },
  });
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
// Cost Tracking
// ═══════════════════════════════════════════════════════════════

export function logOpenRouterCost(cost: OpenRouterCostInfo | null): void {
  if (!cost) return;
  console.log(
    `[OpenRouter Cost] ${cost.total_tokens} tokens ($${cost.total_cost_usd.toFixed(6)}) via ${cost.model} [${cost.generation_id}]`
  );
}
