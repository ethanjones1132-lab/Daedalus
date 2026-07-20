// ═══════════════════════════════════════════════════════════════
// ── Meta Bundle ──
// ═══════════════════════════════════════════════════════════════
// Tools that operate on the runtime itself / session bookkeeping:
//   todo_write  — persist task-list items to durable storage
//   todo_list   — list persisted task items
//   tools_enum  — enumerate the registered tools (the text protocol's tools_enum,
//                 previously special-cased inside text-tools.executeTextToolCall)

import type { ToolRuntime } from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";
import { TodoStore, type TodoItem } from "./todo-store";

export interface MetaBundleOptions {
  /** Optional store for tests; defaults to the server-state SQLite DB. */
  todoStore?: TodoStore;
}

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
          description: "Array of todo items (each an object with id, text, and optional status)",
          items: { type: "object", description: "A todo with id, text, and optional status" },
        },
      },
      required: ["todos"],
    },
  },
  requires_approval: false,
  dangerous: false,
  capability: { class: "meta", evidence: "none" },
};

const TODO_LIST_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "todo_list",
    description: "List persisted task items for the current session.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  requires_approval: false,
  dangerous: false,
  capability: { class: "meta", evidence: "none" },
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
  capability: { class: "meta", evidence: "none" },
  // Hidden from native-function-calling models (they already know their tools
  // from the API schema). Only dispatched via the text-tool fallback protocol,
  // where models that can't use native tools need to discover available tools.
  text_protocol_only: true,
};

export function registerMetaBundle(rt: ToolRuntime, opts: MetaBundleOptions = {}): void {
  const store = opts.todoStore ?? new TodoStore();

  rt.register(TODO_WRITE_DEF, async (args, ctx) => {
    const items = (args.todos ?? []) as TodoItem[];
    const records = store.write(items, { session_id: ctx.session_id, source: ctx.surface });
    return `Todo list updated with ${records.length} items`;
  });

  rt.register(TODO_LIST_DEF, async (_args, ctx) => {
    const records = store.list({ session_id: ctx.session_id });
    if (records.length === 0) return "No todos.";
    return records.map((r) => `- [${r.status}] ${r.text} (${r.id})`).join("\n");
  });

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
