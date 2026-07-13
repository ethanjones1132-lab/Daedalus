import type { ToolDefinition } from "../tool-types";
import type { ExecutionProfile } from "./route-normalization";

/**
 * Tools permitted under the `read_only` execution profile. A `workspace_read`
 * turn (and an `answer_only` turn that opts into the executor) is capped to
 * these — so a misclassified read can never mutate the workspace.
 */
export const READ_ONLY_TOOLS: readonly string[] = ["read_file", "list_directory", "glob", "grep", "git_metadata"];

export interface AgentMode {
  id: string;
  name: string;
  tools_filter: string[]; // "*" matches all, specific names, or empty
  temperature: number;
  max_tokens: number;
  requires_memory: boolean;
  is_final: boolean;
  max_turns: number;
}

export const BUILTIN_MODES: Record<string, AgentMode> = {
  planner: {
    id: "planner",
    name: "Planner",
    tools_filter: [],
    temperature: 0.2,
    max_tokens: 1024,
    requires_memory: true,
    is_final: false,
    max_turns: 1,
  },
  executor: {
    id: "executor",
    name: "Executor",
    tools_filter: [
      "read_file", "write_file", "edit_file", "multi_edit", "apply_patch",
      "glob", "grep", "list_directory",
      "git_metadata",
      "bash",
      "web_search", "web_fetch",
      "agent", "run_background_command",
    ],
    temperature: 0.3,
    max_tokens: 4096,
    requires_memory: true,
    is_final: false,
    max_turns: 4,
  },
  reviewer: {
    id: "reviewer",
    name: "Reviewer",
    tools_filter: ["read_file", "grep", "glob", "list_directory"],
    temperature: 0.2,
    max_tokens: 2048,
    requires_memory: true,
    is_final: false,
    max_turns: 1,
  },
  rewriter: {
    id: "rewriter",
    name: "Rewriter",
    tools_filter: ["read_file", "grep", "glob", "list_directory", "edit_file", "write_file", "multi_edit"],
    temperature: 0.3,
    max_tokens: 4096,
    requires_memory: true,
    is_final: false,
    max_turns: 3,
  },
  synthesizer: {
    id: "synthesizer",
    name: "Synthesizer",
    tools_filter: [],
    temperature: 0.3,
    max_tokens: 2048,
    requires_memory: true,
    is_final: true,
    max_turns: 1,
  },
};

/**
 * Read-only inspection previously capped at 2 turns (one tool attempt plus
 * one correction/final pass) — combined with the 25s workspace_read stage
 * budget, that structurally starved deep reads (2026-07-12 incident). The
 * cap now matches the standard executor limit; the progress-scaled turn
 * budget (turn-budget.ts, Task 2.4) is the binding constraint instead of
 * an arbitrary turn count, so a stalled read-only executor still exits
 * quickly while a progressing one can keep reading.
 */
export function executorTurnLimit(profile: ExecutionProfile): number {
  return profile === "read_only" ? 4 : BUILTIN_MODES.executor.max_turns;
}

export function getToolsForMode(
  modeId: string,
  allTools: ToolDefinition[],
  profile: ExecutionProfile = "full",
): ToolDefinition[] {
  const mode = BUILTIN_MODES[modeId];
  if (!mode) return [];
  // `none` profile removes ALL tools regardless of the mode's own filter.
  if (profile === "none") return [];
  const filter = mode.tools_filter;
  let selected = filter.includes("*") ? allTools : allTools.filter((t) => filter.includes(t.function.name));
  // `read_only` caps the mode's tools to the read-only allowlist. This is the
  // least-authority intersection: a mode can never gain a tool it lacks, and the
  // read-only cap can only remove mutating tools it would otherwise have.
  if (profile === "read_only") {
    selected = selected.filter((t) => READ_ONLY_TOOLS.includes(t.function.name));
  }
  return selected;
}
