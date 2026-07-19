import type { JarvisConfig } from "../config";
import type { AgentCapabilities, OrchestratorAgent } from "./agent-pool";

type CatalogProvider = "openrouter" | "opencode_zen" | "opencode_go";
type CatalogStatus = "live" | "cached" | "unavailable" | "unconfigured";

interface RawCatalogModel {
  id?: unknown;
  name?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  architecture?: { output_modalities?: unknown; modality?: unknown };
}

export interface ProviderCatalogState {
  status: CatalogStatus;
  checked_at: string;
  model_count: number;
  eligible_count: number;
  latency_ms: number;
  error?: string;
}

export interface LiveModelCatalogSnapshot {
  agents: OrchestratorAgent[];
  catalogs: Record<CatalogProvider, ProviderCatalogState>;
  discovered_at: string;
}

export interface LiveModelCatalogOptions {
  fetcher?: typeof fetch;
  forceRefresh?: boolean;
  timeoutMs?: number;
}

const CATALOG_TTL_MS = 5 * 60 * 1000;
let cachedSnapshot: LiveModelCatalogSnapshot | undefined;
let cachedFingerprint = "";
let cachedAt = 0;

export function resetLiveModelCatalogCache(): void {
  cachedSnapshot = undefined;
  cachedFingerprint = "";
  cachedAt = 0;
}

export function latestLiveModelCatalogSnapshot(): LiveModelCatalogSnapshot | undefined {
  return cachedSnapshot ? cloneSnapshot(cachedSnapshot, "cached") : undefined;
}

function credentialConfigured(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length >= 10;
}

function catalogFingerprint(cfg: JarvisConfig): string {
  // This value remains process-private and is never logged or returned. Using
  // the actual credentials here ensures a rotated key invalidates the cache
  // even when the replacement happens to have the same length.
  return JSON.stringify([
    cfg.openrouter.base_url,
    cfg.openrouter.api_key,
    cfg.opencode_zen?.base_url,
    cfg.opencode_zen?.api_key,
    cfg.opencode_go?.base_url,
    cfg.opencode_go?.api_key,
  ]);
}

function cloneSnapshot(snapshot: LiveModelCatalogSnapshot, status?: "cached"): LiveModelCatalogSnapshot {
  return {
    discovered_at: snapshot.discovered_at,
    agents: snapshot.agents.map((agent) => ({
      ...agent,
      capabilities: { ...agent.capabilities },
      default_for: [...agent.default_for],
    })),
    catalogs: Object.fromEntries(Object.entries(snapshot.catalogs).map(([provider, state]) => [
      provider,
      { ...state, status: status && state.status === "live" ? status : state.status },
    ])) as Record<CatalogProvider, ProviderCatalogState>,
  };
}

function modelId(raw: RawCatalogModel): string | undefined {
  if (typeof raw?.id !== "string") return undefined;
  const id = raw.id.trim();
  return id || undefined;
}

function numericPrice(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isOpenRouterFreeTextModel(raw: RawCatalogModel): boolean {
  const id = modelId(raw);
  if (!id) return false;
  const prompt = numericPrice(raw.pricing?.prompt);
  const completion = numericPrice(raw.pricing?.completion);
  const isFree = id === "openrouter/free" || id.endsWith(":free") || (prompt === 0 && completion === 0);
  if (!isFree) return false;

  const outputs = Array.isArray(raw.architecture?.output_modalities)
    ? raw.architecture!.output_modalities!.filter((value): value is string => typeof value === "string")
    : [];
  if (outputs.length > 0 && !outputs.includes("text")) return false;
  const modality = typeof raw.architecture?.modality === "string" ? raw.architecture.modality.toLowerCase() : "";
  if (modality && !modality.includes("text") && (modality.includes("audio") || modality.includes("image"))) return false;

  // Catalog zero-price utilities such as moderation/content-safety classifiers
  // are live endpoints, but they cannot synthesize an orchestration stage.
  return !/(?:content[-_ ]?safety|moderation|guard)(?:\b|[-_/])/i.test(`${id} ${String(raw.name ?? "")}`);
}

export function isOpenCodeZenFreeModelId(id: string): boolean {
  return id === "big-pickle" || id.endsWith("-free");
}

/**
 * Lower means cheaper. The order follows OpenCode Go's published per-token
 * plan prices; exact-price ties use the user's preferred models first.
 * Unknown newly-added catalog models remain usable at the end of the Go tail.
 */
export function openCodeGoCostRank(id: string): number {
  const ranks: Record<string, number> = {
    "deepseek-v4-flash": 1,
    "mimo-v2.5": 2,
    "deepseek-v4-pro": 10,
    "mimo-v2.5-pro": 11,
    "minimax-m3": 20,
    "minimax-m2.7": 21,
    "minimax-m2.5": 22,
    "qwen3.5-plus": 23,
    "qwen3.7-plus": 30,
    "qwen3.6-plus": 31,
    "glm-5": 35,
    "kimi-k2.5": 36,
    "kimi-k2.7-code": 40,
    "kimi-k2.6": 41,
    "glm-5.2": 45,
    "glm-5.1": 46,
    "grok-4.5": 50,
    "qwen3.7-max": 55,
    "kimi-k3": 60,
  };
  return ranks[id] ?? 1_000;
}

export type OpenCodeProtocol = "openai" | "anthropic";

export function openCodeGoProtocolForModel(id: string): OpenCodeProtocol {
  if (
    id.startsWith("minimax-m") ||
    id === "qwen3.7-max" ||
    id === "qwen3.7-plus" ||
    id === "qwen3.6-plus" ||
    id === "qwen3.5-plus"
  ) {
    return "anthropic";
  }
  return "openai";
}

const KNOWN_CAPABILITIES: Record<string, Partial<AgentCapabilities>> = {
  "deepseek-v4-flash": { code: 0.9, reasoning: 0.86, speed: 0.86, json_reliability: 0.9 },
  "deepseek-v4-flash-free": { code: 0.9, reasoning: 0.86, speed: 0.82, json_reliability: 0.9 },
  "deepseek-v4-pro": { code: 0.93, reasoning: 0.9, speed: 0.7, json_reliability: 0.85 },
  "mimo-v2.5": { code: 0.8, reasoning: 0.85, speed: 0.72, json_reliability: 0.86 },
  "mimo-v2.5-free": { code: 0.72, reasoning: 0.8, speed: 0.7, json_reliability: 0.7 },
  "minimax-m3": { code: 0.85, reasoning: 0.9, speed: 0.65, json_reliability: 0.8 },
  "north-mini-code-free": { code: 0.92, reasoning: 0.72, speed: 0.72, json_reliability: 0.8 },
  "nemotron-3-ultra-free": { code: 0.8, reasoning: 0.95, speed: 0.55, json_reliability: 0.88 },
  "big-pickle": { code: 0.82, reasoning: 0.84, speed: 0.75, json_reliability: 0.82 },
};

function inferredCapabilities(provider: CatalogProvider, id: string): AgentCapabilities {
  const lower = id.toLowerCase();
  const known = KNOWN_CAPABILITIES[id] ?? {};
  const fast = /(?:flash|nano|mini|xs|small)/.test(lower);
  const code = /(?:code|coder|deepseek|mimo)/.test(lower);
  const reasoning = /(?:reason|ultra|hermes|nemotron|deepseek|minimax)/.test(lower);
  return {
    code: known.code ?? (code ? 0.84 : 0.68),
    reasoning: known.reasoning ?? (reasoning ? 0.84 : 0.72),
    speed: known.speed ?? (fast ? 0.84 : 0.68),
    cost: provider === "opencode_go" ? Math.max(0.05, 1 - openCodeGoCostRank(id) / 1_100) : 1,
    json_reliability: known.json_reliability ?? 0.76,
  };
}

function dynamicAgent(provider: CatalogProvider, id: string): OrchestratorAgent {
  return {
    id: `live-${provider}-${id.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`,
    provider,
    model_id: id,
    capabilities: inferredCapabilities(provider, id),
    default_for: [],
    enabled: true,
    billing_tier: provider === "opencode_go" ? "go" : "free",
    ...(provider === "opencode_go" ? { cost_rank: openCodeGoCostRank(id) } : {}),
  };
}

function providerConfig(cfg: JarvisConfig, provider: CatalogProvider): { baseUrl: string; apiKey: string } {
  if (provider === "openrouter") {
    return {
      baseUrl: (cfg.openrouter.base_url || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
      apiKey: cfg.openrouter.api_key || "",
    };
  }
  const value = provider === "opencode_zen" ? cfg.opencode_zen : cfg.opencode_go;
  const fallback = provider === "opencode_zen" ? "https://opencode.ai/zen/v1" : "https://opencode.ai/zen/go/v1";
  return { baseUrl: (value?.base_url || fallback).replace(/\/+$/, ""), apiKey: value?.api_key || "" };
}

async function fetchCatalog(
  cfg: JarvisConfig,
  provider: CatalogProvider,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<{ state: ProviderCatalogState; models: RawCatalogModel[] }> {
  const checkedAt = new Date().toISOString();
  const { baseUrl, apiKey } = providerConfig(cfg, provider);
  if (!credentialConfigured(apiKey)) {
    return {
      models: [],
      state: { status: "unconfigured", checked_at: checkedAt, model_count: 0, eligible_count: 0, latency_ms: 0 },
    };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("catalog-timeout"), timeoutMs);
  try {
    const response = await fetcher(`${baseUrl}/models`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { data?: unknown };
    const models = Array.isArray(payload.data) ? payload.data.filter((value): value is RawCatalogModel => Boolean(value && typeof value === "object")) : [];
    const eligible = provider === "openrouter"
      ? models.filter(isOpenRouterFreeTextModel).length
      : provider === "opencode_zen"
        ? models.map(modelId).filter((id): id is string => Boolean(id)).filter(isOpenCodeZenFreeModelId).length
        : models.map(modelId).filter(Boolean).length;
    return {
      models,
      state: {
        status: "live",
        checked_at: checkedAt,
        model_count: models.length,
        eligible_count: eligible,
        latency_ms: Date.now() - started,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      models: [],
      state: {
        status: "unavailable",
        checked_at: checkedAt,
        model_count: 0,
        eligible_count: 0,
        latency_ms: Date.now() - started,
        error: message.slice(0, 120),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function mergeAgents(
  configured: OrchestratorAgent[],
  results: Record<CatalogProvider, { state: ProviderCatalogState; models: RawCatalogModel[] }>,
): OrchestratorAgent[] {
  const liveIds = Object.fromEntries((Object.keys(results) as CatalogProvider[]).map((provider) => [
    provider,
    new Set(results[provider].models.map(modelId).filter((id): id is string => Boolean(id))),
  ])) as Record<CatalogProvider, Set<string>>;
  const merged = new Map<string, OrchestratorAgent>();

  for (const agent of configured) {
    if (!(agent.provider in results)) continue;
    const provider = agent.provider as CatalogProvider;
    const result = results[provider];
    // A successful live catalog is authoritative and removes retired ids. If
    // discovery is down, preserve the configured fallbacks so a transient
    // metadata outage cannot take inference down with it.
    if (result.state.status === "live" && !liveIds[provider].has(agent.model_id)) continue;
    const catalogModel = result.models.find((raw) => modelId(raw) === agent.model_id);
    const free = provider === "openrouter"
      ? Boolean(catalogModel && isOpenRouterFreeTextModel(catalogModel)) || agent.model_id === "openrouter/free" || agent.model_id.endsWith(":free")
      : provider === "opencode_zen" && isOpenCodeZenFreeModelId(agent.model_id);
    merged.set(`${provider}:${agent.model_id}`, {
      ...agent,
      capabilities: { ...agent.capabilities },
      default_for: [...agent.default_for],
      enabled: free ? true : agent.enabled,
      billing_tier: free ? "free" : provider === "opencode_go" ? "go" : (agent.billing_tier ?? "paid"),
      ...(provider === "opencode_go" ? { cost_rank: openCodeGoCostRank(agent.model_id) } : {}),
    });
  }

  for (const provider of Object.keys(results) as CatalogProvider[]) {
    const result = results[provider];
    if (result.state.status !== "live") continue;
    for (const raw of result.models) {
      const id = modelId(raw);
      if (!id) continue;
      const eligible = provider === "openrouter"
        ? isOpenRouterFreeTextModel(raw)
        : provider === "opencode_zen"
          ? isOpenCodeZenFreeModelId(id)
          : true;
      if (!eligible) continue;
      const key = `${provider}:${id}`;
      if (!merged.has(key)) merged.set(key, dynamicAgent(provider, id));
    }
  }

  return [...merged.values()];
}

export async function discoverLiveOrchestratorAgents(
  cfg: JarvisConfig,
  options: LiveModelCatalogOptions = {},
): Promise<LiveModelCatalogSnapshot> {
  const fingerprint = catalogFingerprint(cfg);
  if (
    !options.forceRefresh &&
    cachedSnapshot &&
    cachedFingerprint === fingerprint &&
    Date.now() - cachedAt < CATALOG_TTL_MS
  ) {
    return cloneSnapshot(cachedSnapshot, "cached");
  }

  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 8_000);
  const providers: CatalogProvider[] = ["openrouter", "opencode_zen", "opencode_go"];
  const entries = await Promise.all(providers.map(async (provider) => [
    provider,
    await fetchCatalog(cfg, provider, fetcher, timeoutMs),
  ] as const));
  const results = Object.fromEntries(entries) as Record<CatalogProvider, { state: ProviderCatalogState; models: RawCatalogModel[] }>;
  const snapshot: LiveModelCatalogSnapshot = {
    discovered_at: new Date().toISOString(),
    agents: mergeAgents(cfg.orchestrator?.agents ?? [], results),
    catalogs: Object.fromEntries(providers.map((provider) => [provider, results[provider].state])) as Record<CatalogProvider, ProviderCatalogState>,
  };

  cachedSnapshot = cloneSnapshot(snapshot);
  cachedFingerprint = fingerprint;
  cachedAt = Date.now();
  return snapshot;
}
