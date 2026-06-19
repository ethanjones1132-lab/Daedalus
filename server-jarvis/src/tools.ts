// ═══════════════════════════════════════════════════════════════
// ── Jarvis Tool System ──
// ═══════════════════════════════════════════════════════════════
// OpenAI-compatible tool definitions with parameter schemas.
// Tools are exposed to the LLM for function calling.

import { promises as fs } from "fs";
import { join, resolve, relative, dirname } from "path";
import { spawn } from "child_process";
import type { JarvisConfig } from "./config";

// ── Tool Parameter Schema ──

export interface ToolParameter {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  items?: { type: string; description?: string };
  default?: unknown;
}

// ── Tool Definition (OpenAI format) ──

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, ToolParameter>;
      required: string[];
    };
  };
  /** Whether this tool requires user approval */
  requires_approval: boolean;
  /** Whether this tool is potentially dangerous */
  dangerous: boolean;
}

// ── Tool Call ──

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// ── Tool Result ──

export interface ToolResult {
  call_id: string;
  name: string;
  output: string;
  is_error: boolean;
  error?: string;
  duration_ms: number;
}

// ── All Available Tools ──

export function getAllTools(cfg: JarvisConfig): ToolDefinition[] {
  if (!cfg.tools.enabled) return [];

  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read the contents of a file. Returns the full file content with line numbers. Use this before editing any file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative path to the file to read" },
            offset: { type: "number", description: "Line number to start reading from (1-indexed)", default: 1 },
            limit: { type: "number", description: "Maximum number of lines to read", default: 500 },
          },
          required: ["path"],
        },
      },
      requires_approval: false,
      dangerous: false,
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative path to the file" },
            content: { type: "string", description: "The full content to write to the file" },
          },
          required: ["path", "content"],
        },
      },
      requires_approval: true,
      dangerous: true,
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "Edit a file by replacing an exact string. The old_string must match exactly including whitespace. Use read_file first to get the exact content.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the file to edit" },
            old_string: { type: "string", description: "Exact string to find and replace (must match exactly)" },
            new_string: { type: "string", description: "Replacement string" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
      requires_approval: true,
      dangerous: true,
    },
    {
      type: "function",
      function: {
        name: "multi_edit",
        description: "Apply multiple edits to a single file in sequence. Each edit's old_string is applied to the result of the previous edit.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the file to edit" },
            edits: {
              type: "array",
              description: "Array of edit operations to apply sequentially",
              items: {
                type: "object",
                properties: {
                  old_string: { type: "string", description: "Exact string to replace" },
                  new_string: { type: "string", description: "Replacement string" },
                },
              },
            },
          },
          required: ["path", "edits"],
        },
      },
      requires_approval: true,
      dangerous: true,
    },
    {
      type: "function",
      function: {
        name: "bash",
        description: "Execute a shell command. Use sparingly and only when necessary. Prefer file operations over shell commands when possible.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to execute" },
            description: { type: "string", description: "Brief description of what this command does" },
            timeout_ms: { type: "number", description: "Timeout in milliseconds (max 60000)", default: 30000 },
          },
          required: ["command"],
        },
      },
      requires_approval: true,
      dangerous: true,
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: "Find files matching a glob pattern. Supports ** for recursive matching.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern (e.g. '**/*.ts', 'src/*.rs')" },
            path: { type: "string", description: "Directory to search in (defaults to workspace root)" },
          },
          required: ["pattern"],
        },
      },
      requires_approval: false,
      dangerous: false,
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search file contents using a regex pattern. Returns matching files and line numbers.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern to search for" },
            path: { type: "string", description: "Directory to search in (defaults to workspace root)" },
            output_mode: { type: "string", description: "Output mode: 'files_with_matches', 'content', or 'count'", enum: ["files_with_matches", "content", "count"], default: "files_with_matches" },
            head_limit: { type: "number", description: "Limit number of results", default: 50 },
          },
          required: ["pattern"],
        },
      },
      requires_approval: false,
      dangerous: false,
    },
    {
      type: "function",
      function: {
        name: "list_directory",
        description: "List the contents of a directory with file sizes and types.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path to list" },
          },
          required: ["path"],
        },
      },
      requires_approval: false,
      dangerous: false,
    },
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current information. Returns DuckDuckGo instant-answer results and related links.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
      },
      requires_approval: false,
      dangerous: false,
    },
    {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch content from a URL and extract relevant information.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch" },
            prompt: { type: "string", description: "What information to extract from the page (optional)" },
          },
          required: ["url"],
        },
      },
      requires_approval: false,
      dangerous: false,
    },
    {
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
              items: {
                type: "object",
                properties: {
                  content: { type: "string", description: "Task description" },
                  status: { type: "string", description: "Status: 'pending', 'in_progress', 'completed'", enum: ["pending", "in_progress", "completed"] },
                },
              },
            },
          },
          required: ["todos"],
        },
      },
      requires_approval: false,
      dangerous: false,
    },
  ];
}

// ── Tool Execution ──

export function getApiTools(cfg: JarvisConfig): Array<Pick<ToolDefinition, "type" | "function">> {
  return getAllTools(cfg).map(({ type, function: definition }) => ({
    type,
    function: definition,
  }));
}

export async function executeTool(
  call: ToolCall,
  cfg: JarvisConfig,
): Promise<ToolResult> {
  const start = Date.now();
  const tool = getAllTools(cfg).find(t => t.function.name === call.name);

  if (!tool) {
    return {
      call_id: call.id,
      name: call.name,
      output: `Unknown tool: ${call.name}`,
      is_error: true,
      duration_ms: Date.now() - start,
    };
  }

  const missingArgs = tool.function.parameters.required.filter((name) => {
    const value = call.arguments[name];
    return value === undefined || value === null || value === "";
  });
  if (missingArgs.length > 0) {
    const error = `Missing required argument(s) for "${call.name}": ${missingArgs.join(", ")}`;
    return {
      call_id: call.id,
      name: call.name,
      output: "",
      is_error: true,
      error,
      duration_ms: Date.now() - start,
    };
  }

  try {
    let output: string;

    switch (call.name) {
      case "read_file":
        output = await toolReadFile(call.arguments, cfg);
        break;
      case "write_file":
        output = await toolWriteFile(call.arguments, cfg);
        break;
      case "edit_file":
        output = await toolEditFile(call.arguments, cfg);
        break;
      case "multi_edit":
        output = await toolMultiEdit(call.arguments, cfg);
        break;
      case "bash":
        output = await toolBash(call.arguments, cfg);
        break;
      case "glob":
        output = await toolGlob(call.arguments, cfg);
        break;
      case "grep":
        output = await toolGrep(call.arguments, cfg);
        break;
      case "list_directory":
        output = await toolListDir(call.arguments, cfg);
        break;
      case "web_search":
        output = await toolWebSearch(call.arguments);
        break;
      case "web_fetch":
        output = await toolWebFetch(call.arguments);
        break;
      case "todo_write":
        output = `Todo list updated with ${(call.arguments.todos as any[]).length} items`;
        break;
      default:
        output = `Tool ${call.name} not implemented`;
    }

    return { call_id: call.id, name: call.name, output, is_error: false, duration_ms: Date.now() - start };
  } catch (e: any) {
    return { call_id: call.id, name: call.name, output: "", is_error: true, error: e.message, duration_ms: Date.now() - start };
  }
}

// ── Sandbox: resolve path within workspace ──

function toWslPath(inputPath: string): string {
  let normalized = inputPath.replace(/\\/g, "/");

  // 1. Handle WSL UNC path: \\wsl.localhost\Ubuntu\home\... or \\wsl$\Ubuntu\home\...
  for (const prefix of ["//wsl.localhost/", "//wsl$/"]) {
    if (normalized.startsWith(prefix)) {
      const parts = normalized.slice(prefix.length).split("/");
      return "/" + parts.slice(1).join("/");
    }
  }

  // 2. Handle Windows absolute path with drive letter: C:/Users/ethan/...
  const driveMatch = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const subPath = driveMatch[2];
    return `/mnt/${drive}/${subPath}`;
  }

  return normalized;
}

function safePath(inputPath: string, cfg: JarvisConfig): string {
  const wslPath = toWslPath(inputPath);
  if (cfg.tools.sandbox_mode === "off") return resolve(wslPath);
  const workspace = cfg.jarvis_path || process.cwd();
  const resolved = resolve(workspace, wslPath);
  const rel = relative(workspace, resolved);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Path "${inputPath}" is outside the workspace. Sandbox mode: ${cfg.tools.sandbox_mode}`);
  }
  return resolved;
}

// ── Tool Implementations ──

const READ_FILES_CACHE = new Set<string>();

async function toolReadFile(args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const path = safePath(args.path as string, cfg);
  const offset = (args.offset as number) || 1;
  const limit = (args.limit as number) || 500;

  try {
    const content = await fs.readFile(path, "utf-8");
    READ_FILES_CACHE.add(path);
    const lines = content.split("\n");
    const start = Math.max(0, offset - 1);
    const end = Math.min(lines.length, start + limit);

    const numbered = lines.slice(start, end).map((line, i) => `${(start + i + 1).toString().padStart(6)} | ${line}`);
    return numbered.join("\n");
  } catch (e: any) {
    return `File not found or error reading file: ${path} (${e.message})`;
  }
}

async function toolWriteFile(args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const path = safePath(args.path as string, cfg);
  const content = args.content as string;

  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(path, content, "utf-8");
  const lines = content.split("\n").length;
  return `Wrote ${lines} lines to ${args.path}`;
}

async function toolEditFile(args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const path = safePath(args.path as string, cfg);
  const oldStr = args.old_string as string;
  const newStr = args.new_string as string;

  if (!READ_FILES_CACHE.has(path)) {
    return `Error: File "${args.path}" has not been read yet. You must use the "read_file" tool at least once before editing.`;
  }

  let content: string;
  try {
    content = await fs.readFile(path, "utf-8");
  } catch (e: any) {
    return `File not found: ${path}`;
  }

  if (!content.includes(oldStr)) {
    return `Error: old_string not found in ${args.path}. Use read_file to see the current content.`;
  }

  const occurrences = content.split(oldStr).length - 1;
  if (occurrences > 1) {
    return `Error: old_string appears ${occurrences} times in ${args.path}. Make it more specific.`;
  }

  const updated = content.replace(oldStr, newStr);
  await fs.writeFile(path, updated, "utf-8");
  return `Edited ${args.path}: replaced ${oldStr.length} chars with ${newStr.length} chars`;
}

async function toolMultiEdit(args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const path = safePath(args.path as string, cfg);
  const edits = args.edits as Array<{ old_string: string; new_string: string }>;

  if (!READ_FILES_CACHE.has(path)) {
    return `Error: File "${args.path}" has not been read yet. You must use the "read_file" tool at least once before editing.`;
  }

  let content: string;
  try {
    content = await fs.readFile(path, "utf-8");
  } catch (e: any) {
    return `File not found: ${path}`;
  }

  const results: string[] = [];

  for (const edit of edits) {
    if (!content.includes(edit.old_string)) {
      results.push(`SKIP: "${edit.old_string.slice(0, 40)}..." not found`);
      continue;
    }
    content = content.replace(edit.old_string, edit.new_string);
    results.push(`OK: replaced "${edit.old_string.slice(0, 40)}..."`);
  }

  await fs.writeFile(path, content, "utf-8");
  return `Multi-edit on ${args.path}:\n${results.join("\n")}`;
}

async function toolBash(args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const command = args.command as string;
  const timeout = Math.min((args.timeout_ms as number) || 30000, 60000);

  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", command], {
      cwd: cfg.jarvis_path || process.cwd(),
      timeout,
      env: { ...process.env, PATH: process.env.PATH },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      const output = stdout.trim();
      const err = stderr.trim();
      if (code === 0) {
        resolve(output || "(no output)");
      } else {
        resolve(`Exit code ${code}${err ? `:\n${err}` : ""}${output ? `\nOutput:\n${output}` : ""}`);
      }
    });

    proc.on("error", (e) => resolve(`Error: ${e.message}`));
  });
}

async function toolGlob(args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const pattern = args.pattern as string;
  const searchPath = args.path as string || cfg.jarvis_path || process.cwd();

  // Simple glob implementation
  const results: string[] = [];
  const isRecursive = pattern.includes("**");

  async function walk(dir: string) {
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        const full = join(dir, entry);
        const rel = relative(searchPath, full);
        const stats = await fs.stat(full);

        if (shouldMatch(rel, pattern)) {
          results.push(`${full} (${formatSize(stats.size)})`);
        }

        if (stats.isDirectory() && isRecursive && !entry.startsWith(".") && entry !== "node_modules") {
          await walk(full);
        }
      }
    } catch { /* skip */ }
  }

  await walk(resolve(searchPath));
  return results.slice(0, 100).join("\n") || "No files matched";
}

function shouldMatch(filepath: string, pattern: string): boolean {
  // Simple glob matching
  const regexPattern = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "___GLOBSTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/___GLOBSTAR___/g, ".*");
  return new RegExp(`^${regexPattern}$`).test(filepath);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function toolGrep(args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const pattern = args.pattern as string;
  const searchPath = args.path as string || cfg.jarvis_path || process.cwd();
  const outputMode = (args.output_mode as string) || "files_with_matches";
  const headLimit = (args.head_limit as number) || 50;

  const results: string[] = [];
  const regex = new RegExp(pattern);

  async function walk(dir: string) {
    if (results.length >= headLimit) return;
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (results.length >= headLimit) break;
        const full = join(dir, entry);
        const stats = await fs.stat(full);

        if (stats.isDirectory()) {
          if (!entry.startsWith(".") && entry !== "node_modules" && entry !== ".git") {
            await walk(full);
          }
        } else if (stats.isFile() && stats.size < 1_000_000) {
          try {
            const content = await fs.readFile(full, "utf-8");
            if (outputMode === "files_with_matches") {
              if (regex.test(content)) {
                results.push(relative(searchPath, full));
              }
            } else {
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  results.push(`${relative(searchPath, full)}:${i + 1}: ${lines[i].trim()}`);
                  if (results.length >= headLimit) break;
                }
              }
            }
          } catch { /* binary file */ }
        }
      }
    } catch { /* skip */ }
  }

  await walk(resolve(searchPath));
  return results.join("\n") || "No matches found";
}

async function toolListDir(args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const path = safePath(args.path as string, cfg);

  try {
    const entries = await fs.readdir(path);
    const items = await Promise.all(
      entries.map(async (entry) => {
        const full = join(path, entry);
        try {
          const stats = await fs.stat(full);
          const type = stats.isDirectory() ? "📁" : "📄";
          const size = stats.isDirectory() ? "" : ` (${formatSize(stats.size)})`;
          return `${type} ${entry}${size}`;
        } catch {
          return `❓ ${entry}`;
        }
      })
    );

    return `${entries.length} items in ${args.path}:\n${items.join("\n")}`;
  } catch (e: any) {
    return `Directory not found or error reading: ${path} (${e.message})`;
  }
}

async function toolWebFetch(args: Record<string, unknown>): Promise<string> {
  const url = normalizeWebUrl(args.url as string);
  const prompt = typeof args.prompt === "string" && args.prompt.trim()
    ? args.prompt.trim()
    : "Extract the information relevant to the user's request.";
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "Accept": "text/html, text/plain, application/json",
        "User-Agent": "Jarvis/3.0 web_fetch",
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    }
    const text = await res.text();

    // Simple extraction — strip HTML tags for text content
    const stripped = text
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 5000);

    return `Content from ${url} (extraction prompt: ${prompt}):\n\n${stripped}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function toolWebSearch(args: Record<string, unknown>): Promise<string> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("web_search requires a query.");
  return JSON.stringify(await searchWeb(query), null, 2);
}

export async function searchWeb(query: string): Promise<Record<string, unknown>> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new Error("web_search requires a query.");
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10000);
  try {
    const [instantResult, htmlResult] = await Promise.allSettled([
      fetchDuckDuckGoInstantAnswer(normalizedQuery, ctrl.signal),
      fetchDuckDuckGoHtmlResults(normalizedQuery, ctrl.signal),
    ]);
    const instant = instantResult.status === "fulfilled" ? instantResult.value : {};
    const results = htmlResult.status === "fulfilled" ? htmlResult.value : [];
    const related = flattenDuckDuckGoTopics(instant.RelatedTopics || []).slice(0, 8);

    if (
      htmlResult.status === "rejected"
      && !instant.Answer
      && !instant.AbstractText
      && related.length === 0
    ) {
      throw htmlResult.reason;
    }

    return {
      query: normalizedQuery,
      answer: instant.Answer || "",
      abstract: instant.AbstractText || "",
      abstract_url: instant.AbstractURL || "",
      related_topics: related,
      results,
      results_count: results.length,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDuckDuckGoInstantAnswer(query: string, signal: AbortSignal): Promise<Record<string, any>> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
  const res = await fetch(url, {
    signal,
    headers: {
      "Accept": "application/json",
      "User-Agent": "Jarvis/3.0 web_search",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  }
  const json = await res.json();
  return json && typeof json === "object" ? json as Record<string, any> : {};
}

async function fetchDuckDuckGoHtmlResults(
  query: string,
  signal: AbortSignal,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal,
    headers: {
      "Accept": "text/html",
      "User-Agent": "Mozilla/5.0 (compatible; Jarvis/3.0 web_search)",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  }

  const html = await res.text();
  const matches = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  return matches.slice(0, 8).map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? html.length;
    const block = html.slice(start, end);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    return {
      title: stripWebHtml(match[2]),
      url: unwrapDuckDuckGoUrl(match[1]),
      snippet: stripWebHtml(snippetMatch?.[1] || ""),
    };
  });
}

function flattenDuckDuckGoTopics(topics: any[]): Array<{ text: string; url: string }> {
  const flattened: Array<{ text: string; url: string }> = [];
  for (const topic of topics) {
    if (Array.isArray(topic?.Topics)) {
      flattened.push(...flattenDuckDuckGoTopics(topic.Topics));
      continue;
    }
    if (topic?.Text || topic?.FirstURL) {
      flattened.push({
        text: topic.Text || "",
        url: topic.FirstURL || "",
      });
    }
  }
  return flattened;
}

function unwrapDuckDuckGoUrl(rawUrl: string): string {
  const decoded = decodeWebHtml(rawUrl);
  const absolute = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  try {
    return new URL(absolute).searchParams.get("uddg") || absolute;
  } catch {
    return absolute;
  }
}

function stripWebHtml(value: string): string {
  return decodeWebHtml(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeWebHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function normalizeWebUrl(rawUrl: string): string {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!trimmed) throw new Error("web_fetch requires a URL.");
  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = new URL(withProtocol);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  return url.toString();
}
