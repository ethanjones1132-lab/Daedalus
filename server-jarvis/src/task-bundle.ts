// ═══════════════════════════════════════════════════════════════
// ── Task Bundle ──
// ═══════════════════════════════════════════════════════════════
// Wires the (previously orphaned) agent-tools.ts capabilities into the
// ToolRuntime: background commands and sub-agent tasks. Tool names match the
// aliases already present in text-tools.ts so the text protocol routes to them.
//
// Process-spawning tools (run_background_command, agent, task_create) are
// dangerous + approval-required. Read/control tools are safe.

import type { ToolRuntime } from "./tool-runtime";
import type { ToolCapability, ToolDefinition, ToolParameter } from "./tool-types";
import {
  toolRunBackgroundCommand, toolAgent, toolTaskCreate,
  toolTaskList, toolTaskGet, toolTaskOutput, toolTaskStop,
} from "./agent-tools";

function def(
  name: string,
  description: string,
  properties: Record<string, ToolParameter>,
  required: string[],
  dangerous = false,
  capability: ToolCapability = { class: "meta", evidence: "none" },
): ToolDefinition {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
    requires_approval: dangerous,
    dangerous,
    capability,
  };
}

const RUN_BG_DEF = def("run_background_command",
  "Run a shell command in the background and return a task id to poll later.",
  {
    command: { type: "string", description: "Shell command to run" },
    powershell: { type: "boolean", description: "Run via PowerShell instead of bash" },
    cwd: { type: "string", description: "Working directory" },
    description: { type: "string", description: "Short label for the task" },
  }, ["command"], true, { class: "shell", evidence: "execution" });

const AGENT_DEF = def("agent",
  "Run a sub-agent to completion and return its final output (blocking).",
  {
    prompt: { type: "string", description: "Task for the sub-agent" },
    description: { type: "string", description: "Short label" },
    subagent_type: { type: "string", description: "Agent type (default: general)" },
    timeout_ms: { type: "number", description: "Max run time in milliseconds" },
  }, ["prompt"], true, { class: "delegate", evidence: "execution" });

const TASK_CREATE_DEF = def("task_create",
  "Start a background sub-agent task and return its id.",
  {
    prompt: { type: "string", description: "Task for the sub-agent" },
    description: { type: "string", description: "Short label" },
    subagent_type: { type: "string", description: "Agent type (default: general)" },
    cwd: { type: "string", description: "Working directory" },
  }, ["prompt"], true, { class: "delegate", evidence: "none" });

const TASK_LIST_DEF = def("task_list",
  "List background tasks, optionally filtered by status.",
  { status: { type: "string", description: "Filter by status (running/completed/failed/stopped)" } }, []);

const TASK_GET_DEF = def("task_get",
  "Get a background task's status and metadata.",
  { id: { type: "string", description: "Task id" } }, ["id"]);

const TASK_OUTPUT_DEF = def("task_output",
  "Read a background task's accumulated output.",
  {
    id: { type: "string", description: "Task id" },
    limit: { type: "number", description: "Max characters to return" },
    offset: { type: "number", description: "Start character offset (negative = from end)" },
    pattern: { type: "string", description: "Only return lines matching this regex" },
  }, ["id"]);

const TASK_STOP_DEF = def("task_stop",
  "Stop a running background task.",
  { id: { type: "string", description: "Task id" } }, ["id"]);

export function registerTaskBundle(rt: ToolRuntime): void {
  rt.register(RUN_BG_DEF, (a, c) => toolRunBackgroundCommand(a, c.config));
  rt.register(AGENT_DEF, (a, c) => toolAgent(a, c.config));
  rt.register(TASK_CREATE_DEF, (a, c) => toolTaskCreate(a, c.config));
  rt.register(TASK_LIST_DEF, (a) => toolTaskList(a));
  rt.register(TASK_GET_DEF, (a) => toolTaskGet(a));
  rt.register(TASK_OUTPUT_DEF, (a) => toolTaskOutput(a));
  rt.register(TASK_STOP_DEF, (a) => toolTaskStop(a));
}
