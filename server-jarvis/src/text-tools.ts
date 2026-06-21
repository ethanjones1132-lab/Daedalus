import type { ToolCall, ToolDefinition, ToolResult } from "./tool-types";
import type { JarvisConfig } from "./config";

interface ParsedTextToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  raw: string;
}

interface Candidate {
  raw: string;
  start: number;
  end: number;
  value: unknown;
}

const TOOL_ALIASES: Record<string, string> = {
  bash: "bash",
  shell: "bash",
  run_command: "bash",
  powershell: "powershell",
  pwsh: "powershell",
  ps: "powershell",
  read: "read_file",
  read_file: "read_file",
  readfile: "read_file",
  write: "write_file",
  write_file: "write_file",
  edit: "edit_file",
  edit_file: "edit_file",
  multi_edit: "multi_edit",
  multiedit: "multi_edit",
  glob: "glob",
  find: "glob",
  find_file: "glob",
  find_files: "list_directory",
  list_files: "list_directory",
  grep: "grep",
  search: "grep",
  list_directory: "list_directory",
  list_dir: "list_directory",
  ls: "list_directory",
  web_fetch: "web_fetch",
  webfetch: "web_fetch",
  fetch_url: "web_fetch",
  web_search: "web_search",
  websearch: "web_search",
  search_web: "web_search",
  browse: "browse",
  browser: "browse",
  open_url: "browse",
  mcp_list_servers: "mcp_list_servers",
  list_mcp_servers: "mcp_list_servers",
  mcp_servers: "mcp_list_servers",
  mcp_list_tools: "mcp_list_tools",
  list_mcp_tools: "mcp_list_tools",
  mcp_call_tool: "mcp_call_tool",
  call_mcp_tool: "mcp_call_tool",
  mcp_tool: "mcp_call_tool",
  mcp_list_resources: "mcp_list_resources",
  list_mcp_resources: "mcp_list_resources",
  mcp_read_resource: "mcp_read_resource",
  read_mcp_resource: "mcp_read_resource",
  agent: "agent",
  task: "agent",
  task_create: "task_create",
  create_task: "task_create",
  task_list: "task_list",
  list_tasks: "task_list",
  task_get: "task_get",
  get_task: "task_get",
  task_output: "task_output",
  task_stop: "task_stop",
  stop_task: "task_stop",
  todo_write: "todo_write",
  todowrite: "todo_write",
  tools_enum: "tools_enum",
  list_tools: "tools_enum",
  tool_list: "tools_enum",
};

const TOOL_CALL_OPEN_TAG = "<tool_call>";
const TOOL_CALL_CLOSE_TAG = "</tool_call>";

export class TextToolCallStreamSanitizer {
  private pending = "";
  private insideToolCall = false;

  push(chunk: string): string {
    this.pending += chunk;
    return this.drain(false);
  }

  flush(): string {
    return this.drain(true);
  }

  private drain(flush: boolean): string {
    let visible = "";

    while (this.pending) {
      const expectedTag = this.insideToolCall ? TOOL_CALL_CLOSE_TAG : TOOL_CALL_OPEN_TAG;
      const tagIndex = this.pending.toLowerCase().indexOf(expectedTag);

      if (tagIndex >= 0) {
        if (!this.insideToolCall) {
          visible += this.pending.slice(0, tagIndex);
        }
        this.pending = this.pending.slice(tagIndex + expectedTag.length);
        this.insideToolCall = !this.insideToolCall;
        continue;
      }

      if (flush) {
        if (!this.insideToolCall) visible += this.pending;
        this.pending = "";
        break;
      }

      const suffixLength = matchingTagPrefixSuffixLength(this.pending, expectedTag);
      if (!this.insideToolCall) {
        visible += this.pending.slice(0, this.pending.length - suffixLength);
      }
      this.pending = this.pending.slice(this.pending.length - suffixLength);
      break;
    }

    return visible;
  }
}

export function hasExplicitWebSearchIntent(text: string): boolean {
  return /\b(?:web\s*search|search\s+(?:the\s+)?(?:web|internet)|browse\s+(?:the\s+)?(?:web|internet)|(?:internet|online)\s+search|look\s+(?:it|this|that|them)?\s*up\s+(?:online|on\s+the\s+web))\b/i.test(text);
}

export function hasLocalWorkspaceToolIntent(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\b(?:web\s*search|search\s+(?:the\s+)?(?:web|internet)|browse|online|internet)\b/i.test(text)) {
    return /\b(?:file|folder|directory|path|workspace|project|repo|codebase|src|package\.json|tsconfig\.json|README)\b/i.test(text);
  }
  if (/\b(?:read|write|edit|list|grep|find|search)\b/i.test(text)
    && /\b(?:file|files|folder|directory|path|workspace|project|repo|codebase|src|package\.json|tsconfig\.json|README)\b/i.test(text)) {
    return true;
  }
  if (/\b(?:run|execute|invoke|call)\s+(?:a\s+)?(?:command|shell|terminal|script|test|build)\b/i.test(text)) {
    return true;
  }
  if (/(?:^|[\s(])(?:bash|shell|cmd|powershell|pwsh|node|npm|bun|cargo|pytest|git)\b/.test(lower)) {
    return true;
  }
  return /(?:[\\/][\w.-]+|[A-Za-z]:[\\/])/.test(text);
}

export function isNativeToolProtocolUnsupportedError(status: number, body: string): boolean {
  const text = `${status} ${body}`.toLowerCase();
  return (status === 400 || status === 422)
    && (
      text.includes("tool")
      && (
        text.includes("does not support")
        || text.includes("not support")
        || text.includes("unsupported")
        || text.includes("tool calls")
        || text.includes("tool calls are")
        || text.includes("tool_choice")
      )
    );
}

export function webSearchQueryFromPrompt(text: string): string {
  return text
    .replace(/^\s*please\b[:,]?\s*/i, "")
    .replace(/\b(?:please\s+)?(?:use|do|run|perform|conduct)\s+(?:a\s+)?web\s*search(?:\s+for)?\b/gi, " ")
    .replace(/\bsearch\s+(?:the\s+)?(?:web|internet)(?:\s+for)?\b/gi, " ")
    .replace(/\bbrowse\s+(?:the\s+)?(?:web|internet)(?:\s+for)?\b/gi, " ")
    .replace(/\b(?:and\s+)?(?:answer|respond|tell\s+me)[\s\S]*$/i, " ")
    .replace(/\s+/g, " ")
    .trim() || text.trim();
}

export function buildTextToolInstructions(tools: ToolDefinition[]): string {
  const toolList = tools.map((tool) => {
    const required = tool.function.parameters.required;
    const properties = Object.entries(tool.function.parameters.properties)
      .map(([name, schema]) => `${name}${required.includes(name) ? "*" : ""}: ${schema.type}`)
      .join(", ");
    return `- ${tool.function.name}: ${tool.function.description} Args: { ${properties} }`;
  }).join("\n");

  return `## Tool Protocol
Native tool calling is unavailable for this model. You MUST use this text protocol for ALL file system, shell, and web operations — NEVER fabricate results or pretend to perform these operations without calling a tool.

Emit exactly one or more tool blocks and no markdown fences:
<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>

Rules:
- You MUST emit a tool_call block whenever the task requires reading/writing files, running commands, fetching URLs, or searching the filesystem.
- NEVER invent file contents, command output, or web responses — always call the tool.
- Use only the tool names listed below.
- Put all parameters inside "arguments".
- After a tool result is provided, answer normally.
- Do not explain the tool call inside the JSON block.
- Common aliases are accepted: read/write/edit, bash/shell/powershell, find/list_files, search, browse/open_url, websearch, mcp_call_tool, agent, task_create.

Available tools:
${toolList}
- tools_enum: List all available Jarvis tools. Args: { }`;
}

export function extractTextToolCalls(text: string, tools: ToolDefinition[]): {
  cleanedText: string;
  calls: ParsedTextToolCall[];
} {
  const availableNames = new Set(tools.map((tool) => tool.function.name));
  const candidates = collectCandidates(text);
  const calls: ParsedTextToolCall[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    for (const call of callsFromValue(candidate.value, candidate.raw, availableNames)) {
      const key = `${call.name}:${JSON.stringify(call.arguments)}:${candidate.start}`;
      if (!seen.has(key)) {
        seen.add(key);
        calls.push(call);
      }
    }
  }

  let cleanedText = text;
  if (calls.length > 0) {
    const spans = candidates
      .filter((candidate) => callsFromValue(candidate.value, candidate.raw, availableNames).length > 0)
      .sort((a, b) => b.start - a.start);
    for (const span of spans) {
      cleanedText = `${cleanedText.slice(0, span.start)}${cleanedText.slice(span.end)}`;
    }
  }
  if (calls.length > 0 || /<\/?tool_call>/i.test(cleanedText)) {
    cleanedText = cleanedText
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
      .replace(/<\/?tool_call>/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return { cleanedText, calls };
}

export async function executeTextToolCall(
  call: ToolCall,
  cfg: JarvisConfig,
  tools: ToolDefinition[],
  executeTool: (call: ToolCall, cfg: JarvisConfig) => Promise<ToolResult>,
): Promise<ToolResult> {
  if (call.name === "tools_enum") {
    const output = tools
      .map((tool) => {
        const required = tool.function.parameters.required;
        const args = Object.keys(tool.function.parameters.properties)
          .map((name) => `${name}${required.includes(name) ? "*" : ""}`)
          .join(", ");
        return `${tool.function.name}(${args}) - ${tool.function.description}`;
      })
      .join("\n");
    return {
      call_id: call.id,
      name: call.name,
      output,
      is_error: false,
      duration_ms: 0,
    };
  }

  return executeTool(call, cfg);
}

export function textToolResultsPrompt(results: ToolResult[]): string {
  return [
    "Tool results are available below. Use them to answer the original user request.",
    "If another tool is required, emit another <tool_call>{...}</tool_call> block.",
    "",
    ...results.map((result) => {
      const status = result.is_error ? "error" : "success";
      const body = result.is_error ? (result.error || result.output) : result.output;
      return `Tool result (${status}) for ${result.name} [${result.call_id}]:\n${body}`;
    }),
  ].join("\n\n");
}

function collectCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const addCandidate = (raw: string, start: number, end: number) => {
    const value = parseJsonLike(raw);
    if (value !== null) candidates.push({ raw, start, end, value });
  };

  for (const match of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) {
    addCandidate(match[1], match.index ?? 0, (match.index ?? 0) + match[0].length);
  }

  for (const match of text.matchAll(/(^|[\r\n])\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi)) {
    const start = (match.index ?? 0) + match[1].length;
    addCandidate(match[2], start, (match.index ?? 0) + match[0].length);
  }

  for (const object of findJsonObjects(text)) {
    addCandidate(object.raw, object.start, object.end);
  }

  return dedupeCandidates(candidates);
}

function matchingTagPrefixSuffixLength(text: string, tag: string): number {
  const lowerText = text.toLowerCase();
  for (let length = Math.min(lowerText.length, tag.length - 1); length > 0; length--) {
    if (lowerText.endsWith(tag.slice(0, length))) return length;
  }
  return 0;
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    const key = `${candidate.start}:${candidate.end}:${candidate.raw}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const selected: Candidate[] = [];
  for (const candidate of unique.sort((a, b) => (b.end - b.start) - (a.end - a.start))) {
    const overlaps = selected.some((other) => candidate.start < other.end && candidate.end > other.start);
    if (!overlaps) selected.push(candidate);
  }
  return selected.sort((a, b) => a.start - b.start);
}

function callsFromValue(value: unknown, raw: string, availableNames: Set<string>): ParsedTextToolCall[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => callsFromValue(item, raw, availableNames));
  }
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const nestedCalls = record.tool_calls ?? record.tools ?? record.calls;
  if (Array.isArray(nestedCalls)) {
    return nestedCalls.flatMap((item) => callsFromValue(item, raw, availableNames));
  }

  const rawName = stringValue(record.name ?? record.tool ?? record.tool_name ?? record.function);
  if (!rawName) return [];

  const normalizedName = normalizeToolName(rawName, availableNames);
  if (!normalizedName) return [];

  const topLevelArgs = stripToolKeys(record);
  if (normalizedName === "mcp_call_tool" && typeof record.tool_name === "string" && record.tool_name !== rawName) {
    topLevelArgs.tool = record.tool_name;
  }
  const explicitRawArgs = record.arguments ?? record.args ?? record.input;

  if (normalizedName === "mcp_call_tool") {
    const normalizedTopLevel = normalizeToolArguments(normalizedName, rawName, topLevelArgs);
    const toolArgs = explicitRawArgs !== undefined
      ? parseArguments(explicitRawArgs)
      : stripMcpControlArgs(normalizedTopLevel);
    const callArgs: Record<string, unknown> = {
      server: normalizedTopLevel.server,
      tool: normalizedTopLevel.tool,
    };
    if (Object.keys(toolArgs).length > 0) {
      callArgs.arguments = toolArgs;
    }
    return [{
      id: stringValue(record.id) || `call_${crypto.randomUUID().slice(0, 8)}`,
      name: normalizedName,
      arguments: callArgs,
      raw,
    }];
  }

  delete topLevelArgs.arguments;
  delete topLevelArgs.args;
  const rawArgs = explicitRawArgs ?? stripToolKeys(record);
  const parsedArgs = normalizeToolArguments(normalizedName, rawName, {
    ...topLevelArgs,
    ...parseArguments(rawArgs),
  });

  return [{
    id: stringValue(record.id) || `call_${crypto.randomUUID().slice(0, 8)}`,
    name: normalizedName,
    arguments: parsedArgs,
    raw,
  }];
}

function normalizeToolName(rawName: string, availableNames: Set<string>): string | null {
  const key = rawName.trim().replace(/\s+/g, "_").toLowerCase();
  const aliased = TOOL_ALIASES[key] ?? key;
  if (aliased === "tools_enum") return aliased;
  return availableNames.has(aliased) ? aliased : null;
}

function normalizeToolArguments(
  name: string,
  rawName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...args };
  const aliasKey = rawName.trim().replace(/\s+/g, "_").toLowerCase();

  if ("file_path" in normalized && !("path" in normalized)) normalized.path = normalized.file_path;
  if ("filename" in normalized && !("path" in normalized)) normalized.path = normalized.filename;
  if ("file" in normalized && !("path" in normalized)) normalized.path = normalized.file;
  if ("cmd" in normalized && !("command" in normalized)) normalized.command = normalized.cmd;
  if ("server_name" in normalized && !("server" in normalized)) normalized.server = normalized.server_name;
  if ("tool_name" in normalized && !("tool" in normalized)) normalized.tool = normalized.tool_name;
  if ("task_id" in normalized && !("id" in normalized)) normalized.id = normalized.task_id;

  if (name === "glob" && ["find", "find_file"].includes(aliasKey)) {
    normalized.pattern = normalized.pattern ?? "**/*";
    normalized.path = normalized.path ?? ".";
  }

  if (name === "list_directory") {
    normalized.path = normalized.path ?? ".";
  }

  if (name === "web_search" && !("query" in normalized)) {
    normalized.query = normalized.url ?? normalized.q ?? normalized.input;
  }

  if (name === "agent" || name === "task_create") {
    normalized.prompt = normalized.prompt ?? normalized.task ?? normalized.input ?? normalized.description;
  }

  delete normalized.file_path;
  delete normalized.filename;
  delete normalized.file;
  delete normalized.cmd;
  delete normalized.server_name;
  delete normalized.tool_name;
  delete normalized.task_id;
  delete normalized.task;
  if (name !== "mcp_call_tool") delete normalized.tool;
  delete normalized.name;

  return normalized;
}

function stripToolKeys(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record };
  delete copy.id;
  delete copy.name;
  delete copy.tool;
  delete copy.tool_name;
  delete copy.function;
  return copy;
}

function stripMcpControlArgs(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record };
  delete copy.id;
  delete copy.name;
  delete copy.tool;
  delete copy.tool_name;
  delete copy.server;
  delete copy.server_name;
  delete copy.function;
  delete copy.arguments;
  delete copy.args;
  delete copy.input;
  return copy;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    const parsed = parseJsonLike(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  }
  return typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseJsonLike(raw: string): unknown | null {
  const trimmed = raw.trim().replace(/^```(?:json|tool|tool_call)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstObject = findJsonObjects(trimmed)[0];
    if (!firstObject) return null;
    try {
      return JSON.parse(firstObject.raw);
    } catch {
      return null;
    }
  }
}

function findJsonObjects(text: string): Array<{ raw: string; start: number; end: number }> {
  const objects: Array<{ raw: string; start: number; end: number }> = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        const end = i + 1;
        objects.push({ raw: text.slice(start, end), start, end });
        start = -1;
      }
    }
  }

  return objects;
}
