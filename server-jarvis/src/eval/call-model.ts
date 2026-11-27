// server-jarvis/src/eval/call-model.ts
// ═══════════════════════════════════════════════════════════════
// Shared CallModelFn builder, extracted from semantic-harness.ts so it can
// be reused by anything that needs to make a real model call through the
// production fallback cascade (e.g. skill-promotion.ts's judge gate)
// without pulling in the rest of the live semantic eval runner.
// ═══════════════════════════════════════════════════════════════

import { type JarvisConfig } from "../config";
import { chatCompletionWithFallback, isOpenRouterModelSupportsTools } from "../openrouter";
import { buildTextToolInstructions, extractTextToolCalls, resolveToolCallsFromTurn } from "../text-tools";
import { AgentPool, type OrchestratorAgent } from "../orchestration/agent-pool";
import { StageAbortedError } from "../orchestration/stage-abort-link";
import type { CallModelFn, ChatMessage } from "../orchestration/coordinator";
import { cloudHelpersAllowed, isCloudProvider, isProviderAvailable } from "../provider-availability";
import type { HttpProviderId } from "../providers";
import type { ToolDefinition } from "../tool-types";

/** A pool agent this module can reach over an HTTP provider adapter. */
export interface CallModelAgent {
  provider: OrchestratorAgent["provider"];
  model_id: string;
}

export interface MakeCallModelOptions {
  /** Run on this resolved agent instead of the stage's pool pick. */
  agent?: CallModelAgent;
  /**
   * Model families the fallback cascade must never use. The harness checker
   * passes the maker's family here so a pinned independent checker can never
   * silently fall back to a maker-family answer.
   */
  excludeFamilies?: readonly string[];
}

/**
 * A call result plus the spend the provider actually reported for it. `_costUsd`
 * is absent unless the provider returned a finite, non-negative amount: a caller
 * must never infer or estimate one.
 */
export type AttributedCallModelResult = Awaited<ReturnType<CallModelFn>> & {
  _costUsd?: number;
};

/** `CallModelFn` that also reports actual provider cost. Assignable to `CallModelFn`. */
export type AttributedCallModelFn = (
  messages: Array<ChatMessage>,
  options?: Parameters<CallModelFn>[1],
) => Promise<AttributedCallModelResult>;

/**
 * Accept only an amount a provider actually reported. Missing, malformed,
 * negative or non-finite values stay absent rather than becoming a fabricated
 * zero the ledger would then treat as real spend.
 */
export function reportedCostUsd(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const HTTP_CALL_PROVIDERS: ReadonlySet<string> = new Set(["openrouter", "opencode_zen", "opencode_go", "vllm"]);

/**
 * Determine whether the agent the pool would actually pick for `stage`
 * supports native OpenAI-style function calling. Mirrors index.ts's
 * `modelSupportsNativeTools` resolution (minus the Ollama branch, which
 * callers of this module never exercise): opencode_zen/opencode_go are
 * hardcoded to the text-tool protocol; everything else defers to
 * `isOpenRouterModelSupportsTools`. Falls back to `true` (native) when the
 * pool can't resolve an agent for the stage, matching the fallback cascade's
 * own behavior of defaulting to plain OpenRouter in that case.
 */
export function resolveModelSupportsNativeTools(cfg: JarvisConfig, stage: string): boolean {
  const pool = new AgentPool(cfg.orchestrator?.agents ?? []);
  const agent = pool.pickFor(stage, "general");
  if (!agent) return true;
  return agentSupportsNativeTools(agent);
}

/** The same native-vs-text rule, for an explicitly supplied agent. */
export function agentSupportsNativeTools(agent: CallModelAgent): boolean {
  if (agent.provider === "opencode_zen" || agent.provider === "opencode_go") return false;
  return isOpenRouterModelSupportsTools(agent.model_id);
}

/**
 * Fail closed when the manifest-named agent cannot be reached, rather than
 * silently falling through to the stage role (which is what the harness is
 * trying to stop).
 */
function assertAgentCallable(cfg: JarvisConfig, agent: CallModelAgent): void {
  if (!HTTP_CALL_PROVIDERS.has(agent.provider)) {
    throw new Error(
      `agent "${agent.model_id}" uses provider "${agent.provider}", which the model-call path cannot serve`,
    );
  }
  if (isCloudProvider(agent.provider) && !cloudHelpersAllowed(cfg)) {
    throw new Error(
      `agent "${agent.model_id}" is unavailable: provider "${agent.provider}" is cloud and cloud helpers are disabled`,
    );
  }
  if (!isProviderAvailable(cfg, agent.provider)) {
    throw new Error(`agent "${agent.model_id}" is unavailable on provider "${agent.provider}"`);
  }
}

/** Inject the text tool-call protocol instructions into the system message,
 *  matching index.ts's `useTextTools` system-prompt augmentation. */
function withTextToolInstructions(messages: ChatMessage[], tools: ToolDefinition[]): ChatMessage[] {
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
 * Fail closed when the caller's stage was already aborted before this call
 * started. Returns the error to throw, or null when the stage is still live.
 */
export function stageAbortGuard(options: {
  stage: string;
  stageAbort?: AbortSignal;
  stageLabel?: string;
}): StageAbortedError | null {
  if (!options.stageAbort?.aborted) return null;
  return new StageAbortedError(options.stageLabel ?? options.stage);
}

/** Minimal callModel that goes through the real fallback cascade for a fixed stage.
 *  Mirrors production's native-vs-text tool-calling branch (index.ts): resolve
 *  which agent the pool would pick for `stage`, and if it doesn't support
 *  native function calling, use the text tool-call protocol instead of the
 *  `tools` request field so cheap/free models are scored on their real
 *  tool-use behavior rather than being silently marked as tool-call-less.
 *
 *  Each successful call also reports who answered: `_modelUsed`/`_provider`
 *  are the cascade entry that produced the response (not necessarily the one
 *  requested), and `_fallbackUsed` is true when the cascade advanced or the
 *  pinned agent was not the one that answered. A caller that must name the
 *  reviewer — the harness checker — reads these instead of asserting the
 *  pinned model answered.
 *
 *  `_costUsd` carries the provider-reported spend (`or_cost` on the
 *  non-streaming response) when the provider gave a finite, non-negative
 *  amount. It is omitted otherwise: an unreported cost must stay absent rather
 *  than become a zero a ledger would record as real spend. */
export function makeCallModel(
  cfg: JarvisConfig,
  stage: string,
  modelOptions: MakeCallModelOptions = {},
): AttributedCallModelFn {
  const pinnedAgent = modelOptions.agent;
  if (pinnedAgent) assertAgentCallable(cfg, pinnedAgent);
  return async (messages, options) => {
    const tools: ToolDefinition[] = options?.tools ?? [];
    const useTextTools = tools.length > 0 && !(pinnedAgent
      ? agentSupportsNativeTools(pinnedAgent)
      : resolveModelSupportsNativeTools(cfg, stage));
    const effectiveMessages = useTextTools ? withTextToolInstructions(messages, tools) : messages;

    // Stage-local cancellation: the caller's stage signal reaches the real
    // provider request, so a stage the Conductor stopped cannot keep spending
    // provider work after the shared adapter returned nothing. It is a separate
    // domain from the turn-wide signal, which stays untouched.
    const stageAborted = stageAbortGuard({ stage, stageAbort: options?.stageAbort, stageLabel: options?.stageLabel });
    if (stageAborted) throw stageAborted;

    const primaryAgent = pinnedAgent
      ? { provider: pinnedAgent.provider as HttpProviderId, model_id: pinnedAgent.model_id }
      : undefined;
    const excludeFamilies = modelOptions.excludeFamilies?.filter((family) => family.trim().length > 0);
    const {
      response, model_used: modelUsed, provider_used: providerUsed, fallback_depth: fallbackDepth,
    } = await chatCompletionWithFallback(cfg, {
      messages: effectiveMessages,
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.max_tokens ?? 1024,
      stream: false,
      tools: useTextTools ? undefined : options?.tools,
    }, options?.stageAbort, {
      stage,
      ...(primaryAgent ? { primaryAgent } : {}),
      ...(excludeFamilies && excludeFamilies.length > 0 ? { excludeFamilies } : {}),
    });
    const json = await response.json();
    // OpenRouter reports actual spend as `or_cost` on the response (the same
    // field its SSE usage block exposes). Other providers simply omit it.
    const costUsd = reportedCostUsd(json?.or_cost);
    const choice = json.choices?.[0]?.message ?? {};
    const content: string = choice.content ?? "";

    // Normalize native OpenAI-style tool_calls into the shared ResolvedToolCall shape.
    const nativeCalls = Array.isArray(choice.tool_calls)
      ? choice.tool_calls
        .map((tc: { id?: string; function?: { name?: string; arguments?: string | Record<string, unknown> }; name?: string; arguments?: Record<string, unknown> }) => {
          const name = tc.function?.name ?? tc.name;
          if (!name) return null;
          let args: Record<string, unknown> = {};
          const rawArgs = tc.function?.arguments ?? tc.arguments;
          if (typeof rawArgs === "string") {
            try { args = JSON.parse(rawArgs || "{}"); } catch { args = {}; }
          } else if (rawArgs && typeof rawArgs === "object") {
            args = rawArgs as Record<string, unknown>;
          }
          return {
            id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
            name,
            arguments: args,
          };
        })
        .filter((c: { id: string; name: string; arguments: Record<string, unknown> } | null): c is { id: string; name: string; arguments: Record<string, unknown> } => c !== null)
      : [];

    // W3.1: same native-first + text-fallback policy as index.ts (including when
    // useTextTools is false and the model emitted DSML/bare markup in content).
    // W3.3: pass stage model id when the pool can resolve one.
    const pool = new AgentPool(cfg.orchestrator?.agents ?? []);
    const stageAgent = pinnedAgent ?? pool.pickFor(stage, "general");
    const resolved = resolveToolCallsFromTurn({
      nativeCalls,
      fullText: content,
      tools,
      useTextTools,
      modelId: stageAgent?.model_id ?? null,
    });

    const cleaned = resolved.textParseAttempted && tools.length > 0
      ? extractTextToolCalls(content, tools).cleanedText
      : content;

    return {
      content: cleaned,
      tool_calls: resolved.calls.length > 0 ? resolved.calls : undefined,
      // The cascade entry that actually answered, so a caller can attribute
      // the response to the model that produced it rather than the one it
      // asked for. With a pinned agent the entry is normally cascade[0]; if
      // the pin was dropped the used model differs even at depth 0.
      _modelUsed: modelUsed,
      _provider: providerUsed,
      _fallbackUsed: pinnedAgent
        ? modelUsed !== pinnedAgent.model_id || providerUsed !== pinnedAgent.provider
        : fallbackDepth > 0,
      ...(costUsd !== undefined ? { _costUsd: costUsd } : {}),
    };
  };
}
