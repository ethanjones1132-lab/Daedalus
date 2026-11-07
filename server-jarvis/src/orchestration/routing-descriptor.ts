import { createHash } from "node:crypto";
import type { JarvisConfig } from "../config";
import { isProviderAvailable } from "../provider-availability";
import { ROUTING_STAGES, validateStageRouteConfig, type RoutingStage, type StageTarget } from "./stage-route-policy";

export interface RoutingDescriptor {
  descriptor_version: 1;
  backend: string;
  enabled: boolean;
  allow_cloud_helpers: boolean;
  providers: {
    ollama: { base_url: string; model: string };
    llama_cpp: { base_url: string; model: string };
    openrouter: { base_url: string; model: string };
    opencode_zen: { base_url: string };
    opencode_go: { base_url: string };
    vllm: { enabled: boolean; base_url: string; model: string };
  };
  stage_models: Record<RoutingStage, StageTarget | "automatic">;
  fallback_chains: Record<RoutingStage, readonly StageTarget[] | "automatic">;
  conductor: {
    enabled: boolean;
    model: string;
    fallback_model: string;
    base_url: string;
    kv_backend: string;
    fallback_to_api: boolean;
  };
  provider_readiness: {
    ollama: boolean;
    llama_cpp: boolean;
    openrouter: boolean;
    opencode_zen: boolean;
    opencode_go: boolean;
    vllm: boolean;
  };
}

function normalizePrimary(value: unknown): StageTarget | "automatic" {
  if (value === undefined || value === "automatic") return "automatic";
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid routing descriptor stage primary");
  const target = value as Record<string, unknown>;
  if (typeof target.provider !== "string" || typeof target.model !== "string") throw new Error("invalid routing descriptor stage primary");
  return { provider: target.provider as StageTarget["provider"], model: target.model };
}

function normalizeFallbacks(value: unknown): readonly StageTarget[] | "automatic" {
  if (value === undefined || value === "automatic") return "automatic";
  if (!Array.isArray(value)) throw new Error("invalid routing descriptor fallback chain");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid routing descriptor fallback target");
    const target = item as Record<string, unknown>;
    if (typeof target.provider !== "string" || typeof target.model !== "string") throw new Error("invalid routing descriptor fallback target");
    return { provider: target.provider as StageTarget["provider"], model: target.model };
  });
}

/** Build the shared, secret-free projection of fields that can change stage routing. */
export function createRoutingDescriptor(
  cfg: JarvisConfig,
  env: NodeJS.ProcessEnv = process.env,
): RoutingDescriptor {
  const errors = validateStageRouteConfig(cfg.orchestrator, cfg.llama_cpp?.model ?? "");
  if (errors.length > 0) throw new Error("invalid routing descriptor configuration");
  const stageModels = {} as Record<RoutingStage, StageTarget | "automatic">;
  const fallbackChains = {} as Record<RoutingStage, readonly StageTarget[] | "automatic">;
  for (const stage of ROUTING_STAGES) {
    stageModels[stage] = normalizePrimary(cfg.orchestrator.stage_models?.[stage]);
    fallbackChains[stage] = normalizeFallbacks(cfg.orchestrator.fallback_chains?.[stage]);
  }
  const vllm = cfg.vllm;
  const conductor = cfg.orchestrator.conductor;
  const llamaBaseUrl = cfg.llama_cpp?.base_url || "http://127.0.0.1:8080/v1";
  return {
    descriptor_version: 1,
    backend: cfg.active_backend || "llama_cpp",
    enabled: cfg.orchestrator.enabled !== false,
    allow_cloud_helpers: cfg.orchestrator.allow_cloud_helpers === true,
    providers: {
      ollama: {
        base_url: cfg.ollama?.base_url || "http://localhost:11434/v1",
        model: cfg.ollama?.model || "qwen3.5-9b:latest",
      },
      llama_cpp: {
        base_url: llamaBaseUrl,
        model: cfg.llama_cpp?.model || "Qwen3.6-35B-A3B-UD-IQ2_M-keep96.gguf",
      },
      openrouter: {
        base_url: cfg.openrouter?.base_url || "https://openrouter.ai/api/v1",
        model: cfg.openrouter?.model || "cohere/north-mini-code:free",
      },
      opencode_zen: { base_url: cfg.opencode_zen?.base_url || "https://opencode.ai/zen/v1" },
      opencode_go: { base_url: cfg.opencode_go?.base_url || "https://opencode.ai/zen/go/v1" },
      vllm: {
        enabled: vllm?.enabled === true,
        base_url: vllm?.base_url || "",
        model: vllm?.model || "",
      },
    },
    stage_models: stageModels,
    fallback_chains: fallbackChains,
    conductor: {
      enabled: conductor?.enabled !== false,
      model: conductor?.model || "Qwen3.6-35B-A3B-UD-IQ2_M-keep96.gguf",
      fallback_model: conductor?.fallback_model || "",
      base_url: conductor?.base_url || llamaBaseUrl,
      kv_backend: conductor?.kv_backend || "llama_cpp",
      fallback_to_api: conductor?.fallback_to_api !== false,
    },
    provider_readiness: {
      ollama: isProviderAvailable(cfg, "ollama", env),
      llama_cpp: Boolean(cfg.llama_cpp?.base_url?.trim() && cfg.llama_cpp?.model?.trim()),
      openrouter: isProviderAvailable(cfg, "openrouter", env),
      opencode_zen: isProviderAvailable(cfg, "opencode_zen", env),
      opencode_go: isProviderAvailable(cfg, "opencode_go", env),
      vllm: isProviderAvailable(cfg, "vllm", env),
    },
  };
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, sortedValue(nested)]));
  }
  return value;
}

export function canonicalRoutingDescriptorJson(descriptor: RoutingDescriptor): string {
  return JSON.stringify(sortedValue(descriptor));
}

export function routingDescriptorFingerprint(
  cfg: JarvisConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return createHash("sha256").update(canonicalRoutingDescriptorJson(createRoutingDescriptor(cfg, env)), "utf8").digest("hex");
}
