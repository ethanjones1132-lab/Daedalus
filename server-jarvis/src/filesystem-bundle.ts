// ═══════════════════════════════════════════════════════════════
// ── Filesystem Bundle ──
// ═══════════════════════════════════════════════════════════════
// Canonical filesystem + search tools registered into the ToolRuntime:
// read_file, write_file, edit_file, multi_edit, apply_patch, glob, grep,
// list_directory.
//
// Handlers are ported verbatim from the legacy tools.ts so the chat model's
// behaviour is preserved exactly. Path scoping (fs-scope) and the
// read-before-edit guard (fs-read-cache) are shared so every surface agrees.
//
// Two registration entry points:
//   registerFilesystemBundle — all 7 tools (chat/agent surfaces)
//   registerSearchBundle     — read_file/glob/grep only (cron/mcp read-only)

import { promises as fs } from "fs";
import { join, resolve, relative, dirname } from "path";
import type { ToolRuntime, ExecutionContext } from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";
import { safePath } from "./fs-scope";
import { markFileRead, hasFileBeenRead } from "./fs-read-cache";
import { applyUnifiedPatch, buildUnifiedDiff } from "./diff";

// ── Tool Definitions (copied byte-for-byte from legacy getAllTools) ──────────────

const READ_FILE_DEF: ToolDefinition = {
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
};

const WRITE_FILE_DEF: ToolDefinition = {
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
};

const EDIT_FILE_DEF: ToolDefinition = {
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
};

const MULTI_EDIT_DEF: ToolDefinition = {
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
            description: "An edit with old_string and new_string",
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  requires_approval: true,
  dangerous: true,
};

const APPLY_PATCH_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "apply_patch",
    description: "Apply a unified diff (patch) to an existing file. Read the file first, then provide a standard unified-diff patch. Fails cleanly (without writing) if the patch context no longer matches the file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to patch" },
        patch: { type: "string", description: "Unified diff text to apply to the file" },
      },
      required: ["path", "patch"],
    },
  },
  requires_approval: true,
  dangerous: true,
};

const GLOB_DEF: ToolDefinition = {
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
};

const GREP_DEF: ToolDefinition = {
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
};

const LIST_DIR_DEF: ToolDefinition = {
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
};

// ── Handlers (ported from tools.ts) ─────────────────────────────────────────────

async function handleReadFile(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const cfg = ctx.config;
  const path = safePath(args.path as string, cfg);
  const offset = (args.offset as number) || 1;
  const limit = (args.limit as number) || 500;

  try {
    const stat = await fs.stat(path);
    if (stat.isDirectory()) {
      return `Error: "${args.path}" is a directory, not a file. Use list_directory to see its contents, then read_file on a specific file inside it.`;
    }
  } catch {
    // stat failed (path missing) — fall through to readFile's not-found message.
  }

  try {
    const content = await fs.readFile(path, "utf-8");
    markFileRead(path);
    const lines = content.split("\n");
    const start = Math.max(0, offset - 1);
    const end = Math.min(lines.length, start + limit);

    const numbered = lines.slice(start, end).map((line, i) => `${(start + i + 1).toString().padStart(6)} | ${line}`);
    return numbered.join("\n");
  } catch (e: any) {
    return `File not found: ${path}. Use glob with pattern to find the correct path before retrying.`;
  }
}

async function handleWriteFile(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const cfg = ctx.config;
  const path = safePath(args.path as string, cfg);
  const content = args.content as string;

  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(path, content, "utf-8");
  const lines = content.split("\n").length;
  return `Wrote ${lines} lines to ${args.path}`;
}

async function handleEditFile(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const cfg = ctx.config;
  const path = safePath(args.path as string, cfg);
  const oldStr = args.old_string as string;
  const newStr = args.new_string as string;

  if (!hasFileBeenRead(path)) {
    return `Error: File "${args.path}" has not been read yet in this conversation. Call read_file on "${args.path}" first, then retry your edit with the exact content you see.`;
  }

  let content: string;
  try {
    content = await fs.readFile(path, "utf-8");
  } catch (e: any) {
    return `File not found: ${path}`;
  }

  if (!content.includes(oldStr)) {
    return `Error: old_string not found in "${args.path}". The file content may have changed. Call read_file on "${args.path}" to see current content, then use the exact text for old_string.`;
  }

  const occurrences = content.split(oldStr).length - 1;
  if (occurrences > 1) {
    return `Error: old_string appears ${occurrences} times in ${args.path}. Make it more specific.`;
  }

  const updated = content.replace(oldStr, newStr);
  await fs.writeFile(path, updated, "utf-8");
  return `Edited ${args.path}: replaced ${oldStr.length} chars with ${newStr.length} chars`;
}

async function handleMultiEdit(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const cfg = ctx.config;
  const path = safePath(args.path as string, cfg);
  const edits = args.edits as Array<{ old_string: string; new_string: string }>;

  if (!hasFileBeenRead(path)) {
    return `Error: File "${args.path}" has not been read yet in this conversation. Call read_file on "${args.path}" first, then retry your edit with the exact content you see.`;
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

async function handleApplyPatch(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const cfg = ctx.config;
  const path = safePath(args.path as string, cfg);
  const patch = args.patch as string;

  if (!hasFileBeenRead(path)) {
    return `Error: File "${args.path}" has not been read yet in this conversation. Call read_file on "${args.path}" first, then apply the patch.`;
  }

  let content: string;
  try {
    content = await fs.readFile(path, "utf-8");
  } catch (e: any) {
    return `File not found: ${path}`;
  }

  const result = applyUnifiedPatch(content, patch);
  if (!result.ok || result.content === undefined) {
    return `Error: patch did not apply cleanly to "${args.path}". The file may have changed since it was read — call read_file again and regenerate the patch against the current content.`;
  }

  await fs.writeFile(path, result.content, "utf-8");
  const diff = buildUnifiedDiff(content, result.content, args.path as string);
  return `Patched ${args.path}: +${diff.additions}/-${diff.deletions}`;
}

async function handleGlob(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const cfg = ctx.config;
  const pattern = args.pattern as string;
  const searchPath = args.path as string || cfg.jarvis_path || cfg.jarvis_path;

  // Simple glob implementation
  const results: string[] = [];
  const isRecursive = pattern.includes("**");

  async function walk(dir: string) {
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        const full = join(dir, entry);
        const rel = relative(searchPath, full).replace(/\\/g, "/");
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

async function handleGrep(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const cfg = ctx.config;
  const pattern = args.pattern as string;
  const searchPath = args.path as string || cfg.jarvis_path || cfg.jarvis_path;
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

async function handleListDir(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const cfg = ctx.config;
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
    return `Directory not found: ${path}. Use glob with pattern "**" from the workspace root to find the correct directory path.`;
  }
}

// ── Registration ────────────────────────────────────────────────────────────────

/** Register all 7 filesystem tools (chat/agent surfaces). */
export function registerFilesystemBundle(rt: ToolRuntime): void {
  rt.register(READ_FILE_DEF, (a, c) => handleReadFile(a, c));
  rt.register(WRITE_FILE_DEF, (a, c) => handleWriteFile(a, c));
  rt.register(EDIT_FILE_DEF, (a, c) => handleEditFile(a, c));
  rt.register(MULTI_EDIT_DEF, (a, c) => handleMultiEdit(a, c));
  rt.register(APPLY_PATCH_DEF, (a, c) => handleApplyPatch(a, c));
  rt.register(GLOB_DEF, (a, c) => handleGlob(a, c));
  rt.register(GREP_DEF, (a, c) => handleGrep(a, c));
  rt.register(LIST_DIR_DEF, (a, c) => handleListDir(a, c));
}

/** Register the read-only search triad (read_file/glob/grep) for cron/mcp. */
export function registerSearchBundle(rt: ToolRuntime): void {
  rt.register(READ_FILE_DEF, (a, c) => handleReadFile(a, c));
  rt.register(GLOB_DEF, (a, c) => handleGlob(a, c));
  rt.register(GREP_DEF, (a, c) => handleGrep(a, c));
}
