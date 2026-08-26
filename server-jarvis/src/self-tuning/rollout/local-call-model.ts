// ═══════════════════════════════════════════════════════════════
// Local-only CallModelFn for Phase-D rollouts
// ═══════════════════════════════════════════════════════════════
// No remote code path. Pool pick may fall through to a non-ollama agent
// (agent-pool "never empty the pool" at pickFor local-only filter), but this
// module always pins to the resolved local default and increments
// stats.nonLocalPickFallbacks so a systematic mis-pick is visible.

import type { JarvisConfig } from "../../config";
import { checkOllamaHealth } from "../../ollama";
import {
  AgentPool,
  DEFAULT_LOCAL_STAGE_MODELS,
} from "../../orchestration/agent-pool";
import type {
  CallModelFn,
  ChatMessage,
  Complexity,
  TaskType,
} from "../../orchestration/coordinator";
import { routableOrchestratorAgents } from "../../provider-availability";
import {
  buildTextToolInstructions,
  extractTextToolCalls,
  resolveToolCallsFromTurn,
} from "../../text-tools";
import type { ToolDefinition } from "../../tool-types";
import {
  callOllamaChat,
  resolveLocalTarget,
  type OllamaTransportDeps,
} from "./ollama-local-transport";
import { applyAgentSystemPrompt } from "../../orchestration/agent-system-prompt";
import { directiveForModel } from "../../orchestration/local-model-directives";

export interface LocalCallModelStats {
  calls: number;
  byModel: Record<string, number>;
  /**
   * Turns with empty content AND no tool_calls. True silent/broken generation
   * (template failure, thinking-only with no action). Does NOT include native
   * tool-only turns — those are normal agentic behavior and used to inflate
   * this counter, which confounded "silent quitter" diagnostics across models.
   */
  emptyContentTurns: number;
  /** Subset of emptyContentTurns that also carried a non-empty thinking channel. */
  thinkingOnlyTurns: number;
  /** Empty content but at least one native/text tool_call — productive agentic turn. */
  toolOnlyTurns: number;
  /** Outgoing system message received a per-model corrective directive splice. */
  directivesApplied: number;
  nonLocalPickFallbacks: number;
  /**
   * prompt_eval_count compared against requested num_ctx. Nonzero means
   * rewards may be measuring harness truncation, not θ.
   */
  truncationSuspected: number;
}

export interface MakeLocalCallModelOptions {
  /** Default num_ctx for every call. Rollouts pin this on /api/chat. */
  num_ctx?: number;
  timeoutMs?: number;
  /** Injectable transport deps (fetch) for tests. */
  deps?: OllamaTransportDeps;
  /**
   * Override installed-model discovery. When set, skips checkOllamaHealth for
   * the localModels intersection (still resolves target per call via transport).
   */
  localModelsOverride?: readonly string[];
}

export type LocalCallModel = CallModelFn & {
  stats: LocalCallModelStats;
};

const DEFAULT_NUM_CTX = 16_384;

function equivalentModelName(a: string, b: string): boolean {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/:latest$/, "");
  return normalize(a) === normalize(b);
}

function installedMatch(installed: readonly string[], candidate: string): string | null {
  return installed.find((name) => equivalentModelName(name, candidate)) ?? null;
}

/**
 * Preferred local model ids: conductor pair + DEFAULT_LOCAL_STAGE_MODELS,
 * intersected with what is actually installed.
 */
export function resolveLocalStageModels(
  cfg: JarvisConfig,
  installed: readonly string[],
): string[] {
  const preferred = uniqueStrings([
    cfg.orchestrator?.conductor?.model,
    cfg.orchestrator?.conductor?.fallback_model,
    ...DEFAULT_LOCAL_STAGE_MODELS,
  ]);
  const out: string[] = [];
  for (const candidate of preferred) {
    const match = installedMatch(installed, candidate);
    if (match && !out.some((m) => equivalentModelName(m, match))) {
      out.push(match);
    }
  }
  // If nothing preferred is installed, fall back to whatever DEFAULT list
  // matches (empty preferred intersection should not leave the pool empty of
  // injection candidates — inject will still use DEFAULT_LOCAL_STAGE_MODELS).
  return out.length > 0 ? out : [...DEFAULT_LOCAL_STAGE_MODELS];
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v?.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function withTextToolInstructions(
  messages: ChatMessage[],
  tools: ToolDefinition[],
): ChatMessage[] {
  const textInstructions = buildTextToolInstructions(tools);
  const effectiveMessages = [...messages];
  const sysIdx = effectiveMessages.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    effectiveMessages[sysIdx] = {
      ...effectiveMessages[sysIdx],
      content: `${effectiveMessages[sysIdx].content}\n\n${textInstructions}`,
    };
  } else {
    effectiveMessages.unshift({ role: "system", content: textInstructions });
  }
  return effectiveMessages;
}

/**
 * Build a CallModelFn that only ever calls local Ollama via `/api/chat`.
 *
 * Stage comes from `options.stageLabel` per call (not bound at construction) —
 * rollouts run four stages through one callModel.
 */
export function makeLocalCallModel(
  cfg: JarvisConfig,
  opts: MakeLocalCallModelOptions = {},
): LocalCallModel {
  const stats: LocalCallModelStats = {
    calls: 0,
    byModel: {},
    emptyContentTurns: 0,
    thinkingOnlyTurns: 0,
    toolOnlyTurns: 0,
    directivesApplied: 0,
    nonLocalPickFallbacks: 0,
    truncationSuspected: 0,
  };

  const numCtx = opts.num_ctx ?? DEFAULT_NUM_CTX;
  const deps = opts.deps ?? {};

  let cachedLocalModels: string[] | null =
    opts.localModelsOverride ? [...opts.localModelsOverride] : null;

  async function localModels(): Promise<string[]> {
    if (cachedLocalModels) return cachedLocalModels;
    const health = await checkOllamaHealth(cfg.ollama);
    cachedLocalModels = resolveLocalStageModels(cfg, health.models);
    return cachedLocalModels;
  }

  const callModel: LocalCallModel = async (messages, options) => {
    const stage = options?.stageLabel || "executor";
    const tools: ToolDefinition[] = (options?.tools as ToolDefinition[] | undefined) ?? [];
    const models = await localModels();

    const pool = new AgentPool(routableOrchestratorAgents(cfg));
    const exclude = options?.excludeModels
      ? new Set(options.excludeModels)
      : undefined;
    const remainingStageMs =
      options?.stageAbort && typeof (options as { remainingStageMs?: number }).remainingStageMs === "number"
        ? (options as { remainingStageMs?: number }).remainingStageMs
        : undefined;

    // remainingStageMs is not on CallModelFn options today; compute from stageAbort
    // is not available either. Pass undefined — pool still injects locals when
    // ollamaAvailable is true and window is unset.
    void remainingStageMs;

    const pick = pool.pickFor(
      stage,
      "general" as TaskType,
      exclude,
      {
        ollamaAvailable: true,
        localModels: models,
        complexity: options?.complexity as Complexity | undefined,
        preferStrong: options?.preferStrongModel,
      },
    );

    let desiredModel = pick?.provider === "ollama" ? pick.model_id : undefined;
    if (!desiredModel || pick?.provider !== "ollama") {
      stats.nonLocalPickFallbacks += 1;
      desiredModel = models[0] ?? cfg.ollama.model;
    }

    const target = await resolveLocalTarget(cfg, desiredModel, deps);
    // Production semantics: native-vs-text from /api/show capability.
    const supportsNative = target.supportsNativeTools;
    const useTextTools = tools.length > 0 && !supportsNative;
    // Per-model corrective directive (same splice the live path builds via
    // OrchestratorAgent.system_prompt). Reuses applyAgentSystemPrompt so
    // rollouts exercise the same prompt shape as production.
    const directive = directiveForModel(target.model);
    if (directive) stats.directivesApplied += 1;
    const withDirective = applyAgentSystemPrompt(
      messages as Array<{ role?: string; content?: string; [k: string]: unknown }>,
      directive,
    ) as ChatMessage[];
    const effectiveMessages = useTextTools
      ? withTextToolInstructions(withDirective, tools)
      : withDirective;

    const result = await callOllamaChat(
      target,
      effectiveMessages,
      {
        temperature: options?.temperature ?? cfg.temperature ?? 0.2,
        top_p: cfg.top_p ?? 0.95,
        num_ctx: numCtx,
        num_predict: options?.max_tokens ?? cfg.max_tokens ?? 1024,
        seed: options?.seed,
        tools,
        useNativeTools: !useTextTools && tools.length > 0,
        timeoutMs: opts.timeoutMs,
        stageAbort: options?.stageAbort,
      },
      deps,
    );

    stats.calls += 1;
    stats.byModel[result.model] = (stats.byModel[result.model] ?? 0) + 1;

    // Split the "empty content" diagnostic into true silence vs tool-only
    // turns. The multi-model sweep's emptyContentTurns rates were not
    // comparable across models that prefer native tool_calls (often empty
    // content) vs models that narrate before tools.
    const hasToolCalls = result.tool_calls.length > 0;
    if (!result.content.trim()) {
      if (hasToolCalls) {
        stats.toolOnlyTurns += 1;
      } else {
        stats.emptyContentTurns += 1;
        if (result.thinking.trim()) {
          stats.thinkingOnlyTurns += 1;
        }
      }
    }

    if (
      typeof result.prompt_eval_count === "number" &&
      result.prompt_eval_count > numCtx
    ) {
      // Daemon reported more prompt tokens than the requested context — either
      // num_ctx was not honored or the count is post-truncation noise. Flag it.
      stats.truncationSuspected += 1;
    }
    // Soft signal: if prompt_eval_count is exactly at a known low default and
    // we requested higher, the options block may have been ignored (would only
    // happen if someone switched this transport to /v1 by mistake).
    if (
      typeof result.prompt_eval_count === "number" &&
      numCtx > 4096 &&
      result.prompt_eval_count >= numCtx
    ) {
      // Full context used — not truncation; leave alone.
    }

    const nativeCalls = result.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    }));

    const resolved = resolveToolCallsFromTurn({
      nativeCalls,
      fullText: result.content,
      tools,
      useTextTools,
      modelId: result.model,
    });

    const cleaned =
      resolved.textParseAttempted && tools.length > 0
        ? extractTextToolCalls(result.content, tools).cleanedText
        : result.content;

    return {
      content: cleaned,
      tool_calls: resolved.calls.length > 0 ? resolved.calls : undefined,
      model: result.model,
      _modelUsed: result.model,
      _provider: "ollama",
    };
  };

  callModel.stats = stats;
  return callModel;
}
