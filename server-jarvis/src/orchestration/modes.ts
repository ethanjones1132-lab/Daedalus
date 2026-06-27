import type { ToolDefinition } from "../tool-types";

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
      "bash",
      "web_search", "web_fetch",
      "agent", "run_background_command",
    ],
    temperature: 0.3,
    max_tokens: 4096,
    requires_memory: true,
    is_final: false,
    max_turns: 10,
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
    tools_filter: ["edit_file", "write_file", "multi_edit"],
    temperature: 0.3,
    max_tokens: 4096,
    requires_memory: true,
    is_final: false,
    max_turns: 5,
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

export function getToolsForMode(modeId: string, allTools: ToolDefinition[]): ToolDefinition[] {
  const mode = BUILTIN_MODES[modeId];
  if (!mode) return [];
  const filter = mode.tools_filter;
  if (filter.includes("*")) {
    return allTools;
  }
  return allTools.filter((t) => filter.includes(t.function.name));
}
