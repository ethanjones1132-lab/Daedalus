// ═══════════════════════════════════════════════════════════════
// ── P1-09: Search Bundle ──
// ═══════════════════════════════════════════════════════════════
// Registers read_file, glob, and grep into the canonical ToolRuntime.
//
// Path scoping:
//   - If ctx.workspace_path is set AND sandbox_mode != "off":
//     only paths under workspace_path are permitted.
//   - If sandbox_mode == "off": all absolute paths are accepted.
//   - Relative paths are resolved relative to workspace_path (or cwd).
//
// All three tools:
//   - requires_approval: false
//   - dangerous: false
// → They are allowed through policy on all surfaces (chat, agent, cron, mcp).

import { promises as fsp, existsSync, statSync } from "fs";
import { join, resolve, relative, isAbsolute } from "path";
import type { ToolRuntime, ExecutionContext, ToolHandler } from "./tool-runtime";

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register the search bundle (read_file, glob, grep) into the given runtime.
 * Throws if any of those names are already registered (use a fresh runtime,
 * or call this exactly once).
 */
export function registerSearchBundle(runtime: ToolRuntime): void {
  runtime.register(READ_FILE_DEF, handleReadFile);
  runtime.register(GLOB_DEF, handleGlob);
  runtime.register(GREP_DEF, handleGrep);
}

// ── Tool Definitions ──────────────────────────────────────────────────────────

const READ_FILE_DEF = {
  type: "function" as const,
  function: {
    name: "read_file",
    description:
      "Read the contents of a file. Returns content with 1-indexed line numbers.",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Absolute or workspace-relative path to read" },
        offset: { type: "number" as const, description: "First line to return (1-indexed, default 1)", default: 1 },
        limit: { type: "number" as const, description: "Maximum lines to return (default 500)", default: 500 },
      },
      required: ["path"],
    },
  },
  requires_approval: false,
  dangerous: false,
};

const GLOB_DEF = {
  type: "function" as const,
  function: {
    name: "glob",
    description: "Find files matching a glob pattern. Supports ** for recursive matching.",
    parameters: {
      type: "object" as const,
      properties: {
        pattern: { type: "string" as const, description: "Glob pattern (e.g. '**/*.ts', 'src/*.rs')" },
        path: { type: "string" as const, description: "Directory to search (defaults to workspace root)" },
      },
      required: ["pattern"],
    },
  },
  requires_approval: false,
  dangerous: false,
};

const GREP_DEF = {
  type: "function" as const,
  function: {
    name: "grep",
    description:
      "Search file contents using a regex pattern. Returns matching files and optionally matching lines.",
    parameters: {
      type: "object" as const,
      properties: {
        pattern: { type: "string" as const, description: "Regex pattern to search for" },
        path: { type: "string" as const, description: "Directory to search (defaults to workspace root)" },
        output_mode: {
          type: "string" as const,
          description: "Output mode: 'files_with_matches' (default) or 'content'",
          enum: ["files_with_matches", "content"],
          default: "files_with_matches",
        },
        head_limit: { type: "number" as const, description: "Maximum results to return (default 50)", default: 50 },
      },
      required: ["pattern"],
    },
  },
  requires_approval: false,
  dangerous: false,
};

// ── Path Scoping ──────────────────────────────────────────────────────────────

/**
 * Resolve a user-supplied path against the execution context's workspace scope.
 *
 * When sandbox_mode is not "off" and a workspace_path is set, rejects paths
 * that resolve outside the workspace root.
 *
 * Throws with a descriptive message on policy violation.
 */
function resolveScopedPath(inputPath: string, ctx: ExecutionContext): string {
  const sandboxMode = ctx.config.tools.sandbox_mode;

  // No scoping in sandbox-off mode
  if (sandboxMode === "off") {
    return resolve(inputPath);
  }

  // Determine workspace root: prefer ctx.workspace_path, fall back to config
  const workspaceRoot = ctx.workspace_path ?? ctx.config.jarvis_path;
  if (!workspaceRoot) {
    // No workspace configured — allow only absolute paths
    return resolve(inputPath);
  }

  const workspace = resolve(workspaceRoot);
  // For absolute input, resolve directly; for relative, resolve relative to workspace
  const resolved = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(workspace, inputPath);

  const rel = relative(workspace, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Path "${inputPath}" is outside the workspace scope ("${workspace}"). Sandbox mode: ${sandboxMode}`,
    );
  }

  return resolved;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

const handleReadFile: ToolHandler = async (args, ctx) => {
  const rawPath = args.path as string;
  const offset = Math.max(1, (args.offset as number | undefined) ?? 1);
  const limit = Math.max(1, (args.limit as number | undefined) ?? 500);

  let resolvedPath: string;
  try {
    resolvedPath = resolveScopedPath(rawPath, ctx);
  } catch (e: any) {
    throw e; // propagate scoping violations as errors
  }

  let content: string;
  try {
    content = await fsp.readFile(resolvedPath, "utf-8");
  } catch {
    throw new Error(`File not found or unreadable: ${rawPath}`);
  }

  const lines = content.split("\n");
  const start = offset - 1; // convert to 0-indexed
  const end = Math.min(lines.length, start + limit);
  const slice = lines.slice(start, end);

  const numbered = slice.map(
    (line, i) => `${String(start + i + 1).padStart(6)} | ${line}`,
  );
  return numbered.join("\n");
};

// Directories excluded from recursive search
const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", ".next", ".svelte-kit",
  "venv", ".venv", ".tauri", "out", "bin", "obj", ".cache", "tmp", ".gemini",
  ".claude", ".kilo",
]);

const handleGlob: ToolHandler = async (args, ctx) => {
  const pattern = args.pattern as string;
  const searchRoot = args.path != null
    ? resolveScopedPath(args.path as string, ctx)
    : resolveScopedPath(ctx.workspace_path ?? ctx.config.jarvis_path ?? ".", ctx);

  const results: string[] = [];
  const isRecursive = pattern.includes("**");

  async function walk(dir: string): Promise<void> {
    if (results.length >= 200) return;
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= 200) break;
      const full = join(dir, entry);
      const rel = relative(searchRoot, full);
      let stats;
      try { stats = await fsp.stat(full); } catch { continue; }

      if (matchesGlob(rel, pattern) || (pattern.startsWith("**/") && matchesGlob(entry, pattern.slice(3)))) {
        results.push(full);
      }

      if (stats.isDirectory() && isRecursive && !entry.startsWith(".") && !EXCLUDE_DIRS.has(entry)) {
        await walk(full);
      }
    }
  }

  await walk(searchRoot);
  return results.length > 0 ? results.join("\n") : "No files matched";
};

const handleGrep: ToolHandler = async (args, ctx) => {
  const pattern = args.pattern as string;
  const searchRoot = args.path != null
    ? resolveScopedPath(args.path as string, ctx)
    : resolveScopedPath(ctx.workspace_path ?? ctx.config.jarvis_path ?? ".", ctx);
  const outputMode = (args.output_mode as string | undefined) ?? "files_with_matches";
  const headLimit = Math.max(1, (args.head_limit as number | undefined) ?? 50);

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    throw new Error(`Invalid regex pattern: "${pattern}"`);
  }

  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= headLimit) return;
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= headLimit) break;
      const full = join(dir, entry);
      let stats;
      try { stats = await fsp.stat(full); } catch { continue; }

      if (stats.isDirectory()) {
        if (!entry.startsWith(".") && !EXCLUDE_DIRS.has(entry)) {
          await walk(full);
        }
      } else if (stats.isFile() && stats.size < 1_000_000) {
        let content: string;
        try {
          content = await fsp.readFile(full, "utf-8");
        } catch {
          continue;
        }

        const rel = relative(searchRoot, full);

        if (outputMode === "files_with_matches") {
          if (regex.test(content)) {
            results.push(rel);
          }
        } else {
          // "content" mode: emit matching lines with line numbers
          const lines = content.split("\n");
          for (let i = 0; i < lines.length && results.length < headLimit; i++) {
            if (regex.test(lines[i])) {
              results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
            }
          }
        }
      }
    }
  }

  await walk(searchRoot);
  return results.length > 0 ? results.join("\n") : "No matches found";
};

// ── Glob Matching ─────────────────────────────────────────────────────────────

function matchesGlob(filepath: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "\x00GLOBSTAR\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/\x00GLOBSTAR\x00/g, ".*");
  return new RegExp(`^${regexStr}$`).test(filepath);
}