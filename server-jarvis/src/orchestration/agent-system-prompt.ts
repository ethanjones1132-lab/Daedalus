// T3.2: splice optional per-agent system_prompt into the leading system message.
// Shared with the empty-completion nudge splice pattern in index.ts.

export const AGENT_SYSTEM_PROMPT_HEADER = "Agent-specific directives:";

/**
 * Append agent-specific directives to the leading system message (or insert a
 * new leading system message). Never mutates the input array — returns a copy.
 * No-op when prompt is empty/undefined.
 */
export function applyAgentSystemPrompt(
  messages: Array<{ role?: string; content?: string; [k: string]: unknown }>,
  systemPrompt: string | undefined | null,
  renderedGuide?: string | undefined | null,
): Array<{ role?: string; content?: string; [k: string]: unknown }> {
  const text = typeof systemPrompt === "string" ? systemPrompt.trim() : "";
  const guide = typeof renderedGuide === "string" ? renderedGuide.trim() : "";
  if (!text && !guide) return messages;

  const blocks = [
    ...(text ? [`${AGENT_SYSTEM_PROMPT_HEADER}\n${text.slice(0, 4000)}`] : []),
    ...(guide ? [guide] : []),
  ];
  const block = blocks.join("\n\n");
  const out = messages.map((m) => ({ ...m }));
  const leadingSystemIdx = out.findIndex((m) => m?.role === "system");
  if (leadingSystemIdx >= 0) {
    out[leadingSystemIdx] = {
      ...out[leadingSystemIdx],
      content: `${out[leadingSystemIdx].content ?? ""}\n\n${block}`,
    };
  } else {
    out.unshift({ role: "system", content: block });
  }
  return out;
}
