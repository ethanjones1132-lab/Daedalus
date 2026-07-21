// ═══════════════════════════════════════════════════════════════
// ── Prompt truth — render tool guidelines from the live registry ──
// ═══════════════════════════════════════════════════════════════
// Stage prompts used to hand-transcribe each tool's name, purpose, and
// parameters. That text drifted from the registry: executor.md documented a
// `bash` timeout cap and forbade `workdir`/`background` params, reviewer.md
// named a `search_files` tool that does not exist, rewriter.md referred to a
// `patch` tool — all the registry's job to define, none the prose could keep
// in sync. A prompt that names a tool the stage cannot call, omits one it can,
// or lists a parameter that does not exist actively misleads the model.
//
// The `{{TOOL_GUIDELINES}}` marker in a stage prompt is replaced at render time
// with a block generated from the ToolDefinitions that stage will actually be
// given. tool-guidelines.test.ts pins the two invariants that matter: every
// stage-exposed tool appears in the rendered prompt, and no rendered prompt
// names a tool the stage cannot call.

import type { ToolDefinition } from "../tool-types";

export const TOOL_GUIDELINES_MARKER = "{{TOOL_GUIDELINES}}";

/** One line per parameter: `name (type, required|optional) — description`. */
function renderParams(def: ToolDefinition): string {
  const props = def.function.parameters.properties ?? {};
  const required = new Set(def.function.parameters.required ?? []);
  const names = Object.keys(props);
  if (names.length === 0) return "    (no parameters)";
  return names
    .map((name) => {
      const p = props[name];
      const req = required.has(name) ? "required" : "optional";
      const desc = p.description ? ` — ${p.description}` : "";
      return `    - \`${name}\` (${p.type}, ${req})${desc}`;
    })
    .join("\n");
}

function renderTool(def: ToolDefinition): string {
  const flags: string[] = [];
  if (def.dangerous) flags.push("dangerous");
  if (def.requires_approval) flags.push("approval-required");
  const flagSuffix = flags.length ? ` _(${flags.join(", ")})_` : "";
  return [
    `- \`${def.function.name}\`${flagSuffix} — ${def.function.description}`,
    renderParams(def),
  ].join("\n");
}

/**
 * Render the guidelines block for a set of stage-exposed tools. Sorted by name
 * so the block is stable across runs (registration order is not a contract).
 */
export function renderToolGuidelines(stageTools: readonly ToolDefinition[]): string {
  if (stageTools.length === 0) {
    return "This stage has no tools available; produce your output from the provided context only.";
  }
  const sorted = [...stageTools].sort((a, b) => a.function.name.localeCompare(b.function.name));
  return [
    "You have exactly these tools available this stage — no others exist, and every parameter is listed:",
    "",
    ...sorted.map(renderTool),
  ].join("\n");
}

/**
 * Substitute the `{{TOOL_GUIDELINES}}` marker in a prompt with the rendered
 * block for `stageTools`. A prompt without the marker is returned unchanged, so
 * this is safe to call on every stage.
 */
export function injectToolGuidelines(prompt: string, stageTools: readonly ToolDefinition[]): string {
  if (!prompt.includes(TOOL_GUIDELINES_MARKER)) return prompt;
  return prompt.split(TOOL_GUIDELINES_MARKER).join(renderToolGuidelines(stageTools));
}
