import { normalizeConfig, defaultConfig, type JarvisConfig } from "../config";
import { routableOrchestratorAgents } from "../provider-availability";
import { streamOpenRouterSSE } from "../openrouter";
import { AgentPool } from "./agent-pool";
import { RoutePlan, type RouteAttempt, type RoutePreflightRejection } from "./route-plan";
import {
  resolveStageRoute,
  runStageRoute,
  validateStageRouteConfig,
  type AutomaticStageRoute,
  type RoutingStage,
  type StageTarget,
} from "./stage-route-policy";
import { requestStageTarget } from "./stage-target-request";

export const ROUTE_DIAGNOSTIC_TIMEOUT_MS = 90_000;
export const ROUTE_DIAGNOSTIC_OUTPUT_MAX_CHARS = 4_096;

export type RouteDiagnosticStatus = "success" | "failed" | "cancelled" | "timeout";

export interface RouteDiagnosticInput {
  operation_id: string;
  stage: string;
  config: unknown;
}

export interface RouteDiagnosticResult {
  operation_id: string;
  stage: string;
  status: RouteDiagnosticStatus;
  attempts: RouteAttempt[];
  rejected_candidates: RoutePreflightRejection[];
  answered_by?: RouteDiagnosticSummary["answered_by"];
  left_machine: boolean;
  duration_ms: number;
  reason_code?: string;
}

type RouteDiagnosticSummary = ReturnType<RoutePlan["summary"]>;

export interface RouteDiagnosticCancelResult {
  operation_id: string;
  cancelled: boolean;
}

export interface RouteDiagnosticService {
  run(input: unknown): Promise<RouteDiagnosticResult>;
  cancel(operationId: unknown): RouteDiagnosticCancelResult;
}

export interface RouteDiagnosticDependencies {
  requestTarget?: typeof requestStageTarget;
  parseContent?: (response: Response, signal: AbortSignal) => Promise<string>;
  automaticRoute?: (cfg: JarvisConfig, stage: RoutingStage) => AutomaticStageRoute | Promise<AutomaticStageRoute>;
  timeoutMs?: number;
  now?: () => number;
}

interface ActiveDiagnostic {
  operationId: string;
  controller: AbortController;
  cancelReason?: "cancelled" | "timeout";
}

const OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failedResult(
  operationId: string,
  stage: string,
  reasonCode: string,
  durationMs = 0,
): RouteDiagnosticResult {
  return {
    operation_id: operationId,
    stage,
    status: "failed",
    attempts: [],
    rejected_candidates: [],
    left_machine: false,
    duration_ms: Math.max(0, Math.round(durationMs)),
    reason_code: reasonCode,
  };
}

function configuredAutomaticRoute(cfg: JarvisConfig, stage: RoutingStage): AutomaticStageRoute {
  const pool = new AgentPool(routableOrchestratorAgents(cfg));
  const selected = pool.pickFor(stage, "general", undefined, { complexity: "medium" });
  const toTarget = (agent: ReturnType<AgentPool["pickFor"]>): StageTarget | undefined => {
    if (!agent) return undefined;
    if (agent.provider === "ollama" || agent.provider === "openrouter" || agent.provider === "opencode_zen" || agent.provider === "opencode_go" || agent.provider === "vllm") {
      return { provider: agent.provider, model: agent.model_id };
    }
    return undefined;
  };
  let primary = toTarget(selected);
  if (!primary) {
    if (cfg.active_backend === "llama_cpp") primary = { provider: "llama_cpp", model: cfg.llama_cpp.model };
    else if (cfg.active_backend === "ollama") primary = { provider: "ollama", model: cfg.ollama.model };
    else primary = { provider: "openrouter", model: cfg.openrouter.model || "openrouter/free" };
  }
  const fallbackAgents = selected ? pool.fallbackChain(selected, stage, "general").slice(1) : [];
  return {
    primary,
    fallbacks: fallbackAgents.map(toTarget).filter((candidate): candidate is StageTarget => Boolean(candidate)),
  };
}

async function parseResponseContent(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const chunks: string[] = [];
  let size = 0;
  for await (const chunk of streamOpenRouterSSE(response)) {
    if (signal.aborted) throw new DOMException("route diagnostic aborted", "AbortError");
    const delta: unknown = chunk.choices?.[0]?.delta?.content;
    const text = typeof delta === "string"
      ? delta
      : Array.isArray(delta)
        ? delta.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("")
        : "";
    if (!text || size >= ROUTE_DIAGNOSTIC_OUTPUT_MAX_CHARS) continue;
    const remaining = ROUTE_DIAGNOSTIC_OUTPUT_MAX_CHARS - size;
    const bounded = text.slice(0, remaining);
    chunks.push(bounded);
    size += bounded.length;
  }
  return chunks.join("");
}

function normalizedProbeConfig(value: unknown): { config?: JarvisConfig; reasonCode?: string } {
  if (!isRecord(value)) return { reasonCode: "invalid_config" };
  const raw = value as Record<string, any>;
  const alias = typeof raw.llama_cpp?.model === "string"
    ? raw.llama_cpp.model
    : defaultConfig().llama_cpp.model;
  if (validateStageRouteConfig(raw.orchestrator, alias).length > 0) {
    return { reasonCode: "invalid_route_config" };
  }
  try {
    return { config: normalizeConfig(raw) };
  } catch {
    return { reasonCode: "invalid_config" };
  }
}

function summaryResult(
  operationId: string,
  stage: string,
  status: RouteDiagnosticStatus,
  summary: RouteDiagnosticSummary,
  durationMs: number,
  reasonCode?: string,
): RouteDiagnosticResult {
  return {
    operation_id: operationId,
    stage,
    status,
    attempts: summary.attempts,
    rejected_candidates: summary.preflight_rejections,
    ...(summary.answered_by ? { answered_by: summary.answered_by } : {}),
    left_machine: summary.left_machine,
    duration_ms: Math.max(0, Math.round(durationMs)),
    ...(reasonCode ? { reason_code: reasonCode.slice(0, 96) } : {}),
  };
}

/** A single in-flight probe; it never creates a chat Session or TaskRun. */
export function createRouteDiagnosticService(
  dependencies: RouteDiagnosticDependencies = {},
): RouteDiagnosticService {
  const requestTarget = dependencies.requestTarget ?? requestStageTarget;
  const parseContent = dependencies.parseContent ?? parseResponseContent;
  const automaticRoute = dependencies.automaticRoute ?? configuredAutomaticRoute;
  const timeoutMs = Math.max(1, Math.min(ROUTE_DIAGNOSTIC_TIMEOUT_MS, dependencies.timeoutMs ?? ROUTE_DIAGNOSTIC_TIMEOUT_MS));
  const now = dependencies.now ?? Date.now;
  let active: ActiveDiagnostic | undefined;

  return {
    async run(rawInput: unknown): Promise<RouteDiagnosticResult> {
      const startedAt = now();
      const input = isRecord(rawInput) ? rawInput : {};
      const validOperationId = typeof input.operation_id === "string" && OPERATION_ID.test(input.operation_id);
      const operationId = validOperationId ? input.operation_id as string : "invalid-operation";
      const stage = typeof input.stage === "string" ? input.stage.slice(0, 64) : "";
      if (!validOperationId) {
        return failedResult(operationId, stage, "invalid_operation_id", now() - startedAt);
      }
      if (!isRecord(rawInput) || typeof input.stage !== "string" || !STAGES.has(stage)) {
        return failedResult(operationId, stage, "invalid_stage", now() - startedAt);
      }
      const normalized = normalizedProbeConfig(input.config);
      if (!normalized.config) {
        return failedResult(operationId, stage, normalized.reasonCode ?? "invalid_config", now() - startedAt);
      }
      if (active) {
        return failedResult(operationId, stage, active.operationId === operationId ? "duplicate_operation" : "busy", now() - startedAt);
      }

      const cfg = normalized.config;
      const routeStage = stage as RoutingStage;
      const controller = new AbortController();
      const current: ActiveDiagnostic = { operationId, controller };
      active = current;
      const deadline = startedAt + timeoutMs;
      const timer = setTimeout(() => {
        current.cancelReason = "timeout";
        controller.abort("route_diagnostic_timeout");
      }, Math.max(0, deadline - now()));
      const routePlan = new RoutePlan();
      let reasonCode: string | undefined;
      try {
        const primarySetting = cfg.orchestrator.stage_models?.[routeStage];
        const fallbackSetting = cfg.orchestrator.fallback_chains?.[routeStage];
        const needsAutomatic = primarySetting === undefined || primarySetting === "automatic" ||
          fallbackSetting === undefined || fallbackSetting === "automatic";
        const auto = needsAutomatic
          ? await automaticRoute(cfg, routeStage)
          : { fallbacks: [] };
        if (controller.signal.aborted) {
          return summaryResult(operationId, stage, current.cancelReason ?? "cancelled", routePlan.summary(), now() - startedAt, current.cancelReason ?? "cancelled");
        }
        const candidates = resolveStageRoute(cfg, routeStage, auto, new Set());
        const fixedBody: Record<string, unknown> = {
          model: "",
          messages: [{ role: "user", content: "Reply with exactly OK." }],
          stream: true,
          temperature: 0,
          max_tokens: 64,
        };
        await runStageRoute(candidates, {
          cfg,
          signal: controller.signal,
          deadline,
          onRejected: (target, reason) => { routePlan.reject(target, reason, routeStage); },
        }, async (target, signal) => {
          const attemptStartedAt = now();
          try {
            const response = await requestTarget(cfg, target, { ...fixedBody, model: target.model }, signal);
            if (!response.ok) {
              await response.body?.cancel().catch(() => {});
              const safeError = `http_${response.status}`;
              routePlan.add({ stage: routeStage, provider: target.provider, model: target.model, choice: attemptChoice(cfg, routeStage, candidates, target), outcome: "http_error", duration_ms: now() - attemptStartedAt, error: safeError });
              return { usable: false, reason: safeError };
            }
            const content = await parseContent(response, signal);
            if (signal.aborted) {
              const outcome = current.cancelReason ?? "cancelled";
              routePlan.add({ stage: routeStage, provider: target.provider, model: target.model, choice: attemptChoice(cfg, routeStage, candidates, target), outcome, duration_ms: now() - attemptStartedAt, error: outcome });
              throw new DOMException("route diagnostic aborted", "AbortError");
            }
            const usable = content.trim().length > 0;
            const outcome = usable ? "success" : "empty_completion";
            routePlan.add({ stage: routeStage, provider: target.provider, model: target.model, choice: attemptChoice(cfg, routeStage, candidates, target), outcome, answered: usable, duration_ms: now() - attemptStartedAt, ...(!usable ? { error: outcome } : {}) });
            return usable
              ? { usable: true, value: undefined }
              : { usable: false, reason: outcome };
          } catch (error) {
            if (signal.aborted) {
              if (!routePlan.attempts.some((attempt) => attempt.model === target.model && (attempt.outcome === "cancelled" || attempt.outcome === "timeout"))) {
                const outcome = current.cancelReason ?? "cancelled";
                routePlan.add({ stage: routeStage, provider: target.provider, model: target.model, choice: attemptChoice(cfg, routeStage, candidates, target), outcome, duration_ms: now() - attemptStartedAt, error: outcome });
              }
              throw error;
            }
            routePlan.add({ stage: routeStage, provider: target.provider, model: target.model, choice: attemptChoice(cfg, routeStage, candidates, target), outcome: "http_error", duration_ms: now() - attemptStartedAt, error: "request_failed" });
            return { usable: false, reason: "request_failed" };
          }
        });
        const summary = routePlan.summary();
        return summaryResult(operationId, stage, "success", summary, now() - startedAt);
      } catch (error) {
        if (error instanceof Error && error.name === "StageRouteExhaustedError") {
          reasonCode = error.message.startsWith("stage_route_exhausted") ? "stage_route_exhausted" : "candidates_exhausted";
        } else if (controller.signal.aborted) {
          reasonCode = current.cancelReason ?? "cancelled";
        } else {
          reasonCode = "route_test_failed";
        }
        const status = current.cancelReason === "timeout" ? "timeout" : controller.signal.aborted ? "cancelled" : "failed";
        return summaryResult(operationId, stage, status, routePlan.summary(), now() - startedAt, reasonCode);
      } finally {
        clearTimeout(timer);
        if (active === current) active = undefined;
      }
    },

    cancel(operationId: unknown): RouteDiagnosticCancelResult {
      const id = typeof operationId === "string" ? operationId : "";
      if (!active || !OPERATION_ID.test(id) || active.operationId !== id) {
        return { operation_id: id, cancelled: false };
      }
      active.cancelReason = "cancelled";
      active.controller.abort("route_diagnostic_cancelled");
      return { operation_id: id, cancelled: true };
    },
  };
}

function attemptChoice(cfg: JarvisConfig, stage: RoutingStage, candidates: readonly StageTarget[], target: StageTarget): RouteAttempt["choice"] {
  if (candidates.indexOf(target) > 0) return "fallback";
  const primary = cfg.orchestrator.stage_models?.[stage];
  return primary !== undefined && primary !== "automatic" ? "configured" : "pool";
}

const STAGES = new Set<string>(["coordinator", "planner", "executor", "reviewer", "rewriter", "synthesizer"]);

export const routeDiagnosticService = createRouteDiagnosticService();
