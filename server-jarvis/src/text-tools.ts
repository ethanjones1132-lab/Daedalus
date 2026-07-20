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

interface TextSpan {
  start: number;
  end: number;
}

export const TOOL_ALIASES: Record<string, string> = {
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
  // No `browse` tool has ever been registered; these aliases resolved to
  // nothing. web_fetch is the real capability they were reaching for.
  browse: "web_fetch",
  browser: "web_fetch",
  open_url: "web_fetch",
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
const INTERNAL_TOOL_RESULT_OPEN_PREFIX = "<jarvis_internal_tool_result";
const INTERNAL_TOOL_RESULT_CLOSE_TAG = "</jarvis_internal_tool_result>";
const LEGACY_TOOL_RESULT_LINE_PREFIX = /^\s*\[Tool Call Result \([^)]+\)\](?: FAILED)?:\s*/i;

const SUPPRESSED_STREAM_TAGS = [
  { openPrefix: TOOL_CALL_OPEN_TAG.slice(0, -1), closeTag: TOOL_CALL_CLOSE_TAG },
  { openPrefix: INTERNAL_TOOL_RESULT_OPEN_PREFIX, closeTag: INTERNAL_TOOL_RESULT_CLOSE_TAG },
] as const;

export class TextToolCallStreamSanitizer {
  private pending = "";
  private closingTag: string | null = null;

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
      const lower = this.pending.toLowerCase();
      if (this.closingTag) {
        const closeIndex = lower.indexOf(this.closingTag);
        if (closeIndex >= 0) {
          this.pending = this.pending.slice(closeIndex + this.closingTag.length);
          this.closingTag = null;
          continue;
        }
        if (flush) {
          this.pending = "";
          break;
        }
        const suffixLength = matchingTagPrefixSuffixLength(this.pending, this.closingTag);
        this.pending = this.pending.slice(this.pending.length - suffixLength);
        break;
      }

      let next: { index: number; openPrefix: string; closeTag: string } | null = null;
      for (const tag of SUPPRESSED_STREAM_TAGS) {
        const index = lower.indexOf(tag.openPrefix);
        if (index >= 0 && (!next || index < next.index)) next = { index, ...tag };
      }

      if (next) {
        visible += this.pending.slice(0, next.index);
        const openEnd = this.pending.indexOf(">", next.index + next.openPrefix.length);
        if (openEnd < 0) {
          if (flush) this.pending = "";
          else this.pending = this.pending.slice(next.index);
          break;
        }
        this.pending = this.pending.slice(openEnd + 1);
        this.closingTag = next.closeTag;
        continue;
      }

      if (flush) {
        visible += this.pending;
        this.pending = "";
        break;
      }

      let suffixLength = 0;
      for (const tag of SUPPRESSED_STREAM_TAGS) {
        suffixLength = Math.max(suffixLength, matchingTagPrefixSuffixLength(this.pending, tag.openPrefix));
      }
      visible += this.pending.slice(0, this.pending.length - suffixLength);
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
  const boundedInternalCleaned = stripBoundedInternalToolResults(text);
  const candidates = collectCandidates(boundedInternalCleaned);
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

  let cleanedText = boundedInternalCleaned;
  const spansToRemove: TextSpan[] = [];
  if (calls.length > 0) {
    for (const candidate of candidates) {
      if (callsFromValue(candidate.value, candidate.raw, availableNames).length > 0) {
        spansToRemove.push(candidate);
      }
    }
  }
  // Stages with no tools offered (synthesizer, planner, reviewer): strip
  // tool-shaped JSON the model echoed from executor context even though
  // nothing can be executed — 2026-07-02 live incident (bare read_file lines).
  if (availableNames.size === 0) {
    spansToRemove.push(...findCosmeticToolEchoLineSpans(cleanedText, candidates));
  }
  const legacyToolResultSpans = findLegacyToolResultTranscriptSpans(cleanedText, candidates);
  spansToRemove.push(...legacyToolResultSpans);
  const uniqueSpans = dedupeTextSpans(spansToRemove);
  if (uniqueSpans.length > 0) {
    const sorted = [...uniqueSpans].sort((a, b) => b.start - a.start);
    for (const span of sorted) {
      cleanedText = `${cleanedText.slice(0, span.start)}${cleanedText.slice(span.end)}`;
    }
  }
  const strippedInternal = boundedInternalCleaned !== text || legacyToolResultSpans.length > 0;
  const strippedCosmetic = availableNames.size === 0 && uniqueSpans.length > 0;
  if (calls.length > 0 || strippedInternal || strippedCosmetic || /<\/?tool_call>/i.test(cleanedText)) {
    cleanedText = cleanedText
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
      // An UNCLOSED <tool_call> suppresses everything after it, mirroring
      // TextToolCallStreamSanitizer (which never emits inside an open block
      // and drops the pending region on flush). Without this, the lone-tag
      // cleanup below "un-mixes" a `<tool_call>{json}` line — the line-span
      // strip skips it (removing the JSON leaves the tag as a non-empty
      // remainder), then the tag strip deletes the tag and leaves the naked
      // JSON as the user-visible answer (2026-07-03 live leak, session
      // 1d4727cf / run_81091960).
      .replace(/<tool_call>[\s\S]*$/i, "")
      .replace(/<\/?tool_call>/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    // Tag removal can turn a mixed line (e.g. `</tool_call>{json}`) into a
    // pure tool-echo line — re-run the cosmetic strip on the result so the
    // streaming and post-turn layers agree on what survives.
    if (availableNames.size === 0 && cleanedText) {
      const rerunSpans = findCosmeticToolEchoLineSpans(cleanedText, collectCandidates(cleanedText));
      if (rerunSpans.length > 0) {
        for (const span of [...rerunSpans].sort((a, b) => b.start - a.start)) {
          cleanedText = `${cleanedText.slice(0, span.start)}${cleanedText.slice(span.end)}`;
        }
        cleanedText = cleanedText.replace(/\n{3,}/g, "\n\n").trim();
      }
    }
  }

  return { cleanedText, calls };
}

/** Stream sanitizer for user-visible answers (synthesizer): tags + bare tool JSON lines. */
export class VisibleAnswerStreamSanitizer {
  private tagSanitizer = new TextToolCallStreamSanitizer();
  private pendingLine = "";
  private lineAlreadyEmitted = false;
  private inFence = false;
  private suppressingLegacyJson = false;
  private legacyJsonDepth = 0;
  private legacyJsonInString = false;
  private legacyJsonEscaped = false;

  push(chunk: string): string {
    const tagCleaned = this.tagSanitizer.push(chunk);
    return this.drainLines(tagCleaned, false);
  }

  flush(): string {
    const tagCleaned = this.tagSanitizer.flush();
    return this.drainLines(tagCleaned, true);
  }

  private drainLines(text: string, flush: boolean): string {
    this.pendingLine += text;
    let visible = "";

    let newlineIndex = this.pendingLine.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.pendingLine.slice(0, newlineIndex);
      this.pendingLine = this.pendingLine.slice(newlineIndex + 1);

      // `line` may be only the buffered suffix after prose was already
      // emitted. It still needs the same cosmetic-JSON decision; otherwise a
      // split `Result: {tool-json}` line leaks the JSON suffix verbatim.
      visible += this.decideLine(line, "\n");
      this.lineAlreadyEmitted = false;
      newlineIndex = this.pendingLine.indexOf("\n");
    }

    if (flush) {
      if (this.pendingLine) {
        if (this.suppressingLegacyJson) {
          this.consumeLegacyJson(this.pendingLine);
        } else if (this.pendingLine.trim()) {
          visible += this.decideLine(this.pendingLine, "");
        }
      }
      this.pendingLine = "";
      this.lineAlreadyEmitted = false;
      this.inFence = false;
      return visible;
    }

    if (this.pendingLine) {
      // Hold from the first object opener until line completion. We cannot
      // know whether it is ordinary JSON or a cosmetic tool echo until the
      // object closes, but prose before it can continue streaming.
      const objectStart = this.inFence ? -1 : this.pendingLine.indexOf("{");
      let emitCandidate = objectStart >= 0
        ? this.pendingLine.slice(0, objectStart)
        : this.pendingLine;
      if (!this.inFence) {
        // Keep trailing horizontal whitespace buffered while the line is
        // incomplete. Once a tool object begins, that whitespace belongs to
        // the removable suffix; ordinary text receives it on the next chunk.
        emitCandidate = emitCandidate.replace(/[ \t]+$/g, "");
      }
      const pending = emitCandidate.trimStart();
      const canEmit = pending
        && !this.suppressingLegacyJson
        && !couldBeLegacyToolResultLine(pending)
        && (this.lineAlreadyEmitted || (!pending.startsWith("{") && !pending.startsWith("`")));
      if (canEmit) {
        visible += emitCandidate;
        this.pendingLine = objectStart >= 0
          ? this.pendingLine.slice(objectStart)
          : this.pendingLine.slice(emitCandidate.length);
        this.lineAlreadyEmitted = true;
      }
    }
    return visible;
  }

  private decideLine(line: string, terminator: string): string {
    if (this.suppressingLegacyJson) {
      this.consumeLegacyJson(line + terminator);
      return "";
    }
    const legacyPrefix = line.match(LEGACY_TOOL_RESULT_LINE_PREFIX);
    if (legacyPrefix) {
      const payload = line.slice(legacyPrefix[0].length).trimStart();
      if (payload.startsWith("{") || payload.startsWith("[")) {
        this.suppressingLegacyJson = true;
        this.consumeLegacyJson(payload + terminator);
      }
      return "";
    }
    const isFenceBoundary = line.trimStart().startsWith("```");
    if (isFenceBoundary) {
      this.inFence = !this.inFence;
      return line + terminator;
    }
    if (this.inFence) return line + terminator;
    if (isCosmeticToolEchoLine(line)) return "";
    const cleaned = stripCosmeticToolEchoesFromLine(line);
    if (cleaned === null) return line + terminator;
    return cleaned.trim() ? cleaned + terminator : "";
  }

  private consumeLegacyJson(text: string): void {
    for (const char of text) {
      if (this.legacyJsonInString) {
        if (this.legacyJsonEscaped) this.legacyJsonEscaped = false;
        else if (char === "\\") this.legacyJsonEscaped = true;
        else if (char === '"') this.legacyJsonInString = false;
        continue;
      }
      if (char === '"') {
        this.legacyJsonInString = true;
      } else if (char === "{" || char === "[") {
        this.legacyJsonDepth += 1;
      } else if (char === "}" || char === "]") {
        this.legacyJsonDepth -= 1;
        if (this.legacyJsonDepth <= 0) {
          this.suppressingLegacyJson = false;
          this.legacyJsonDepth = 0;
          this.legacyJsonInString = false;
          this.legacyJsonEscaped = false;
          return;
        }
      }
    }
  }
}

/**
 * Choose the stream sanitizer by protocol, not by whether the stage is the
 * final answer. Non-tool planner/reviewer activity can hallucinate the same
 * bare tool JSON as a synthesizer and must be cleaned before it reaches SSE.
 */
export function createStageStreamSanitizer(useTextTools: boolean): TextToolCallStreamSanitizer | VisibleAnswerStreamSanitizer {
  return useTextTools
    ? new TextToolCallStreamSanitizer()
    : new VisibleAnswerStreamSanitizer();
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
      // Wrap in the bounded <jarvis_internal_tool_result> tags so both the
      // streaming sanitizer (SUPPRESSED_STREAM_TAGS) and the post-turn
      // stripper (stripBoundedInternalToolResults) recognize and remove
      // any verbatim echo the model might reproduce in its next response.
      // Without this wrapper the line would render as a free-form
      // `Tool result (status) for X [id]: body` that the legacy
      // `[Tool Call Result (...)]` stripper does NOT match — same gap
      // the 2026-07-05 fix closed for the orchestrator path, mirrored
      // here for the text-tool / agent-loop path.
      return `<jarvis_internal_tool_result name="${result.name}" call_id="${result.call_id ?? ""}" status="${status}">\nTool result (${status}) for ${result.name} [${result.call_id}]:\n${body}\n</jarvis_internal_tool_result>`;
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

function stripBoundedInternalToolResults(text: string): string {
  return text
    .replace(/<jarvis_internal_tool_result\b[^>]*>[\s\S]*?<\/jarvis_internal_tool_result>/gi, "")
    .replace(/<jarvis_internal_tool_result\b[^>]*>[\s\S]*$/gi, "");
}

function findLegacyToolResultTranscriptSpans(text: string, candidates: Candidate[]): TextSpan[] {
  const spans: TextSpan[] = [];
  const prefix = new RegExp(LEGACY_TOOL_RESULT_LINE_PREFIX.source, "gim");
  for (const match of text.matchAll(prefix)) {
    const start = match.index ?? 0;
    let payloadStart = start + match[0].length;
    while (payloadStart < text.length && /\s/.test(text[payloadStart])) payloadStart += 1;
    const json = candidates.find((candidate) => candidate.start === payloadStart);
    if (!json || (text[payloadStart] !== "{" && text[payloadStart] !== "[")) continue;
    let end = json.end;
    if (text[end] === "\r") end += 1;
    if (text[end] === "\n") end += 1;
    spans.push({ start, end });
  }
  return spans;
}

function couldBeLegacyToolResultLine(text: string): boolean {
  const lower = text.toLowerCase();
  const marker = "[tool call result (";
  return marker.startsWith(lower) || lower.startsWith(marker);
}

function isCosmeticToolEchoLine(line: string): boolean {
  const objects = findJsonObjects(line);
  if (objects.length === 0) return false;

  const allToolEchoes = objects.every((object) => {
    const value = parseJsonLike(object.raw);
    return value !== null && isCosmeticToolEchoPayload(value);
  });
  if (!allToolEchoes) return false;

  let remainder = line;
  for (const object of [...objects].sort((a, b) => b.start - a.start)) {
    remainder = `${remainder.slice(0, object.start)}${remainder.slice(object.end)}`;
  }
  return remainder.trim() === "";
}

/** Remove cosmetic tool-echo JSON embedded in a prose line; null = nothing strippable. */
function stripCosmeticToolEchoesFromLine(line: string): string | null {
  const spans = findJsonObjects(line).filter((object) => {
    const value = parseJsonLike(object.raw);
    return value !== null && isCosmeticToolEchoPayloadStrict(value);
  });
  if (spans.length === 0) return null;

  let out = line;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, span.start)}${out.slice(span.end)}`;
  }
  return out.replace(/[ \t]+$/g, "");
}

function isCosmeticToolEchoPayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((item) => isCosmeticToolEchoPayload(item));
  }
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  const nestedCalls = record.tool_calls ?? record.tools ?? record.calls;
  if (Array.isArray(nestedCalls)) {
    return nestedCalls.length > 0 && nestedCalls.every((item) => isCosmeticToolEchoPayload(item));
  }

  const rawTool = stringValue(record.tool);
  const rawToolName = stringValue(record.tool_name);
  const rawName = stringValue(record.name ?? record.function) ?? rawToolName ?? rawTool;
  if (!rawName) return false;

  const key = rawName.trim().replace(/\s+/g, "_").toLowerCase();
  if (!TOOL_ALIASES[key]) return false;

  if (record.arguments !== undefined || record.args !== undefined || record.input !== undefined) {
    return true;
  }
  // Legacy flat blocks: {"tool":"find_files","path":"."}
  const legacyName = rawToolName ?? rawTool;
  if (!legacyName) return false;
  const legacyKey = legacyName.trim().replace(/\s+/g, "_").toLowerCase();
  if (!TOOL_ALIASES[legacyKey]) return false;
  const controlKeys = new Set(["id", "name", "tool", "tool_name", "function", "type"]);
  const payloadKeys = Object.keys(record).filter((k) => !controlKeys.has(k));
  return payloadKeys.length > 0;
}

// ── Shared strict predicate for cosmetic tool echo detection ────────────
// Used by BOTH the streaming sanitizer and the post-turn extractTextToolCalls
// cosmetic strip so the two layers agree on what is "hallucinated tool JSON".
//
// The looser isCosmeticToolEchoPayload (above) was correct for the streaming
// path where we want to err on the side of dropping clearly-tool-shaped JSON,
// but in the post-turn cosmetic strip a too-loose predicate risks swallowing
// genuine JSON in prose (e.g. `{"name":"search","query":"x"}` in a status line
// about a search). The strict variant requires EITHER an explicit args field
// (arguments/args/input) OR a legacy flat block with at least one payload key
// beyond the control keys (id/name/tool/tool_name/function/type).
function isCosmeticToolEchoPayloadStrict(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((item) => isCosmeticToolEchoPayloadStrict(item));
  }
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  const nestedCalls = record.tool_calls ?? record.tools ?? record.calls;
  if (Array.isArray(nestedCalls)) {
    return nestedCalls.length > 0 && nestedCalls.every((item) => isCosmeticToolEchoPayloadStrict(item));
  }

  const rawName = stringValue(record.name ?? record.tool ?? record.tool_name ?? record.function);
  if (!rawName) return false;

  const key = rawName.trim().replace(/\s+/g, "_").toLowerCase();
  if (!TOOL_ALIASES[key]) return false;

  // Require at least one of the explicit arguments keys — a generic
  // {"name":"search","query":"x"} in prose has no arguments/args/input
  // and is therefore KEPT by the strict predicate. Only genuine tool-call
  // shapes (with arguments) or legacy flat blocks keyed by tool/tool_name
  // are stripped.
  const hasExplicitArgs =
    record.arguments !== undefined ||
    record.args !== undefined ||
    record.input !== undefined;

  const legacyToolName = stringValue(record.tool ?? record.tool_name);
  if (legacyToolName && TOOL_ALIASES[legacyToolName.trim().replace(/\s+/g, "_").toLowerCase()]) {
    // Legacy flat block: {"tool":"find_files","path":"."} — require at
    // least one payload key beyond the control keys to avoid matching
    // bare {"tool":"read_file"} in prose.
    const controlKeys = new Set(["id", "name", "tool", "tool_name", "function", "type"]);
    const payloadKeys = Object.keys(record).filter((k) => !controlKeys.has(k));
    return payloadKeys.length > 0;
  }

  return hasExplicitArgs;
}

function findCosmeticToolEchoLineSpans(text: string, candidates: Candidate[]): TextSpan[] {
  const fencedLines = findFencedLineSpans(text);
  const groups = new Map<string, { start: number; end: number; candidates: Candidate[] }>();

  for (const candidate of candidates) {
    if (!isCosmeticToolEchoPayloadStrict(candidate.value)) continue;
    // Never strip inside fenced code blocks
    if (fencedLines.some((span) => candidate.start < span.end && candidate.end > span.start)) continue;

    const lineStart = text.lastIndexOf("\n", candidate.start - 1) + 1;
    const nextNewline = text.indexOf("\n", candidate.end);
    const lineEnd = nextNewline >= 0 ? nextNewline + 1 : text.length;
    const key = `${lineStart}:${lineEnd}`;
    const group = groups.get(key) ?? { start: lineStart, end: lineEnd, candidates: [] };
    group.candidates.push(candidate);
    groups.set(key, group);
  }

  const spans: TextSpan[] = [];
  for (const group of groups.values()) {
    let remainder = text.slice(group.start, group.end);
    for (const candidate of [...group.candidates].sort((a, b) => b.start - a.start)) {
      const start = candidate.start - group.start;
      const end = candidate.end - group.start;
      remainder = `${remainder.slice(0, start)}${remainder.slice(end)}`;
    }
    if (remainder.trim() === "") {
      spans.push({ start: group.start, end: group.end });
    } else {
      // Mixed prose + cosmetic JSON: keep the prose and remove only the
      // strict tool-shaped object spans. Fenced candidates were excluded
      // above, preserving code examples verbatim.
      spans.push(...group.candidates.map(({ start, end }) => ({ start, end })));
    }
  }
  return spans;
}

function findFencedLineSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let lineStart = 0;
  let inFence = false;

  while (lineStart < text.length) {
    const newlineIndex = text.indexOf("\n", lineStart);
    const lineEnd = newlineIndex >= 0 ? newlineIndex + 1 : text.length;
    const line = text.slice(lineStart, newlineIndex >= 0 ? newlineIndex : text.length);
    const isFenceBoundary = line.trimStart().startsWith("```");
    if (inFence || isFenceBoundary) spans.push({ start: lineStart, end: lineEnd });
    if (isFenceBoundary) inFence = !inFence;
    lineStart = lineEnd;
  }

  return spans;
}

function dedupeTextSpans(spans: TextSpan[]): TextSpan[] {
  const unique = new Map<string, TextSpan>();
  for (const span of spans) unique.set(`${span.start}:${span.end}`, span);
  return [...unique.values()].sort((a, b) => a.start - b.start);
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
