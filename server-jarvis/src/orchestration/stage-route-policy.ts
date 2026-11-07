import type { JarvisConfig, OrchestratorConfig } from "../config";

export const ROUTING_STAGES = [
  "coordinator",
  "planner",
  "executor",
  "reviewer",
  "rewriter",
  "synthesizer",
] as const;

export type RoutingStage = (typeof ROUTING_STAGES)[number];

export const STAGE_TARGET_PROVIDERS = [
  "llama_cpp",
  "ollama",
  "openrouter",
  "opencode_zen",
  "opencode_go",
  "vllm",
] as const;

export type StageTargetProvider = (typeof STAGE_TARGET_PROVIDERS)[number];
export type StageTarget = { provider: StageTargetProvider; model: string };
export type StageModels = Partial<Record<RoutingStage, StageTarget | "automatic">>;
export type StageFallbacks = Partial<Record<RoutingStage, StageTarget[] | "automatic">>;

export const MAX_STAGE_FALLBACKS = 8;
export const MAX_STAGE_MODEL_ID_LENGTH = 512;

export interface AutomaticStageRoute {
  primary?: StageTarget;
  fallbacks: readonly StageTarget[];
}

/** A stable, unambiguous identity for exclusion and de-duplication. */
export function stageTargetKey(target: Pick<StageTarget, "provider" | "model">): string {
  return JSON.stringify([target.provider, target.model]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTarget(
  value: unknown,
  path: string,
  servingAlias: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be a provider/model target`);
    return;
  }

  if (!STAGE_TARGET_PROVIDERS.includes(value.provider as StageTargetProvider)) {
    errors.push(`${path}.provider must be one of: ${STAGE_TARGET_PROVIDERS.join(", ")}`);
  }

  if (typeof value.model !== "string" || !value.model.trim()) {
    errors.push(`${path}.model must be a nonblank model ID`);
  } else if (value.model.length > MAX_STAGE_MODEL_ID_LENGTH) {
    errors.push(`${path}.model must be at most ${MAX_STAGE_MODEL_ID_LENGTH} characters`);
  }

  if (value.provider === "llama_cpp" && value.model !== servingAlias) {
    errors.push(`${path}.model must match the configured llama.cpp serving alias`);
  }
}

/** Validate raw routing settings without healing or rewriting invalid values. */
export function validateStageRouteConfig(
  orchestrator: Pick<OrchestratorConfig, "stage_models" | "fallback_chains"> | null | undefined,
  llamaCppServingAlias: string,
): string[] {
  if (!orchestrator) return [];

  const errors: string[] = [];
  const knownStages = new Set<string>(ROUTING_STAGES);

  if (orchestrator.stage_models !== undefined) {
    if (!isRecord(orchestrator.stage_models)) {
      errors.push("orchestrator.stage_models must be an object keyed by routing stage");
    } else {
      for (const [stage, value] of Object.entries(orchestrator.stage_models)) {
        const path = `orchestrator.stage_models.${stage}`;
        if (!knownStages.has(stage)) {
          errors.push(`${path} uses an unknown routing stage`);
          continue;
        }
        if (value !== "automatic") validateTarget(value, path, llamaCppServingAlias, errors);
      }
    }
  }

  if (orchestrator.fallback_chains !== undefined) {
    if (!isRecord(orchestrator.fallback_chains)) {
      errors.push("orchestrator.fallback_chains must be an object keyed by routing stage");
    } else {
      for (const [stage, value] of Object.entries(orchestrator.fallback_chains)) {
        const path = `orchestrator.fallback_chains.${stage}`;
        if (!knownStages.has(stage)) {
          errors.push(`${path} uses an unknown routing stage`);
          continue;
        }
        if (value === "automatic") continue;
        if (!Array.isArray(value)) {
          errors.push(`${path} must be an array of targets or "automatic"`);
          continue;
        }
        if (value.length > MAX_STAGE_FALLBACKS) {
          errors.push(`${path} must contain at most ${MAX_STAGE_FALLBACKS} targets`);
        }
        for (let index = 0; index < Math.min(value.length, MAX_STAGE_FALLBACKS); index += 1) {
          validateTarget(value[index], `${path}[${index}]`, llamaCppServingAlias, errors);
        }
      }
    }
  }

  return errors;
}

export function hasStageRouteOverride(cfg: JarvisConfig, stage: RoutingStage): boolean {
  const primary = cfg.orchestrator.stage_models?.[stage];
  const fallbacks = cfg.orchestrator.fallback_chains?.[stage];
  return (primary !== undefined && primary !== "automatic") ||
    (fallbacks !== undefined && fallbacks !== "automatic");
}

export function resolveStageRoute(
  cfg: JarvisConfig,
  stage: RoutingStage,
  automatic: AutomaticStageRoute,
  excluded: ReadonlySet<string>,
): StageTarget[] {
  const errors = validateStageRouteConfig(cfg.orchestrator, cfg.llama_cpp?.model ?? "");
  if (errors.length > 0) {
    throw new Error(`Invalid stage route configuration: ${errors.join("; ")}`);
  }

  const configuredPrimary = cfg.orchestrator.stage_models?.[stage];
  const primary = configuredPrimary && configuredPrimary !== "automatic"
    ? configuredPrimary
    : automatic.primary;
  const configuredFallbacks = cfg.orchestrator.fallback_chains?.[stage];
  const fallbacks = Array.isArray(configuredFallbacks)
    ? configuredFallbacks
    : automatic.fallbacks;

  const resolved: StageTarget[] = [];
  const seen = new Set<string>();
  for (const candidate of [...(primary ? [primary] : []), ...fallbacks]) {
    const key = stageTargetKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    if (excluded.has(key)) continue;
    resolved.push(candidate);
  }
  return resolved;
}
