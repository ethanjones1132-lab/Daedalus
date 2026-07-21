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

/**
 * Notice for a stage whose tools are supplied by an external HOST (the stock
 * Claude Code CLI, for the executor delegate) rather than the Jarvis registry.
 * The delegate genuinely has tools (Write/Edit/Read/Bash, etc.) — it must never
 * be told "no tools available" (that literally happened via `injectToolGuidelines(
 * prompt, [])`, which was built for stages with NO tools at all, like the
 * planner/synthesizer, and is FALSE for the delegate). Every observed
 * delegate_no_write failure showed the model reading a file and then stopping
 * without writing, consistent with a model that concluded it had no write
 * capability — most likely from this exact contradiction (executor.md's own
 * "You have ALL available tools" opening line, immediately followed by "this
 * stage has no tools available", immediately followed by behavioral guidance
 * naming tools like `write_file` by their canonical name, which does not
 * literally exist in the delegate's own toolset).
 */
export const HOST_PROVIDED_TOOLS_NOTICE =
  "Tools for this stage are provided directly by your execution environment " +
  "(e.g. Write, Edit, Read, Bash) under ITS OWN names — not the canonical names " +
  "used in the guidance below. When the guidance names `write_file`, `edit_file`, " +
  "`read_file`, `bash`, etc., treat that as shorthand for the equivalent operation " +
  "in your own toolset. Use your environment's real tools to read, write, and edit " +
  "files and run commands as needed. Do NOT conclude you lack a capability just " +
  "because its exact name differs from the guidance below.";

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
 *
 * `"host_provided"` is a DISTINCT mode from passing `[]`: `[]` means the stage
 * genuinely has no tools (planner, synthesizer) and renders the real
 * "no tools available" notice; `"host_provided"` means tools exist but are
 * supplied by an external host under different names (the CLI delegate) and
 * must never render that false claim.
 */
export function injectToolGuidelines(
  prompt: string,
  stageTools: readonly ToolDefinition[] | "host_provided",
): string {
  if (!prompt.includes(TOOL_GUIDELINES_MARKER)) return prompt;
  const rendered = stageTools === "host_provided"
    ? HOST_PROVIDED_TOOLS_NOTICE
    : renderToolGuidelines(stageTools);
  return prompt.split(TOOL_GUIDELINES_MARKER).join(rendered);
}
