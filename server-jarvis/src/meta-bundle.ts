// ═══════════════════════════════════════════════════════════════
// ── Meta Bundle ──
// ═══════════════════════════════════════════════════════════════
// Tools that operate on the runtime itself / session bookkeeping:
//   todo_write  — task-list bookkeeping (no-op acknowledgement, as in tools.ts)
//   tools_enum  — enumerate the registered tools (the text protocol's tools_enum,
//                 previously special-cased inside text-tools.executeTextToolCall)

import type { ToolRuntime } from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";

const TODO_WRITE_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "todo_write",
    description: "Create or update a task list for tracking progress on complex tasks.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Array of todo items",
          items: { type: "object", description: "A todo with content and status" },
        },
      },
      required: ["todos"],
    },
  },
  requires_approval: false,
  dangerous: false,
};

const TOOLS_ENUM_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "tools_enum",
    description: "List all available Jarvis tools.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  requires_approval: false,
  dangerous: false,
  // Hidden from native-function-calling models (they already know their tools
  // from the API schema). Only dispatched via the text-tool fallback protocol,
  // where models that can't use native tools need to discover available tools.
  text_protocol_only: true,
};

export function registerMetaBundle(rt: ToolRuntime): void {
  rt.register(TODO_WRITE_DEF, async (args) =>
    `Todo list updated with ${(args.todos as any[]).length} items`);

  // Closes over the runtime so it can enumerate whatever is registered.
  rt.register(TOOLS_ENUM_DEF, async () =>
    rt.listTools().map((tool) => {
      const required = tool.function.parameters.required;
      const argList = Object.keys(tool.function.parameters.properties)
        .map((name) => `${name}${required.includes(name) ? "*" : ""}`)
        .join(", ");
      return `${tool.function.name}(${argList}) - ${tool.function.description}`;
    }).join("\n"));
}
