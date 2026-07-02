// server-jarvis/src/eval/call-model.ts
// ═══════════════════════════════════════════════════════════════
// Shared CallModelFn builder, extracted from semantic-harness.ts so it can
// be reused by anything that needs to make a real model call through the
// production fallback cascade (e.g. skill-promotion.ts's judge gate)
// without pulling in the rest of the live semantic eval runner.
// ═══════════════════════════════════════════════════════════════

import { type JarvisConfig } from "../config";
import { chatCompletionWithFallback, isOpenRouterModelSupportsTools } from "../openrouter";
import { buildTextToolInstructions, extractTextToolCalls } from "../text-tools";
import { AgentPool } from "../orchestration/agent-pool";
import type { CallModelFn, ChatMessage } from "../orchestration/coordinator";
import type { ToolDefinition } from "../tool-types";

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
  if (agent.provider === "opencode_zen" || agent.provider === "opencode_go") return false;
  return isOpenRouterModelSupportsTools(agent.model_id);
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

/** Minimal callModel that goes through the real fallback cascade for a fixed stage.
 *  Mirrors production's native-vs-text tool-calling branch (index.ts): resolve
 *  which agent the pool would pick for `stage`, and if it doesn't support
 *  native function calling, use the text tool-call protocol instead of the
 *  `tools` request field so cheap/free models are scored on their real
 *  tool-use behavior rather than being silently marked as tool-call-less. */
export function makeCallModel(cfg: JarvisConfig, stage: string): CallModelFn {
  return async (messages, options) => {
    const tools: ToolDefinition[] = options?.tools ?? [];
    const useTextTools = tools.length > 0 && !resolveModelSupportsNativeTools(cfg, stage);
    const effectiveMessages = useTextTools ? withTextToolInstructions(messages, tools) : messages;

    const { response } = await chatCompletionWithFallback(cfg, {
      messages: effectiveMessages,
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.max_tokens ?? 1024,
      stream: false,
      tools: useTextTools ? undefined : options?.tools,
    }, undefined, { stage });
    const json = await response.json();
    const choice = json.choices?.[0]?.message ?? {};
    const content: string = choice.content ?? "";

    if (useTextTools) {
      const extracted = extractTextToolCalls(content, tools);
      const tool_calls = extracted.calls.length > 0
        ? extracted.calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }))
        : undefined;
      return { content: extracted.cleanedText, tool_calls };
    }

    return { content, tool_calls: choice.tool_calls };
  };
}
