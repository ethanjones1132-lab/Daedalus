// ═══════════════════════════════════════════════════════════════
// ── Git Log Bundle ──────────────────────────────────────────────
// Read-only recent commit history for the active workspace. Mirrors
// git-metadata-bundle so every surface registers it through
// bundles-registry.

import { existsSync, statSync } from "fs";
import { resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { ToolRuntime, ExecutionContext } from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_CHARS = 8_000;

function workspaceRoot(ctx: ExecutionContext): string | null {
  const configured = ctx.workspace_path ?? ctx.config.jarvis_path;
  if (!configured || typeof configured !== "string") return null;
  const root = resolve(configured);
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  return root;
}

async function git(root: string, args: string[], timeoutMs: number): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 128 * 1024,
  });
  return String(result.stdout || "").trim();
}

function bounded(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated]`;
}

const GIT_LOG_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "git_log",
    description: "Read-only recent commits for the active workspace. Returns oneline entries with SHA, subject, author, and date.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of commits to return (default 20, max 100)", default: 20 },
        path: { type: "string", description: "Optional file path to limit history to", default: "" },
      },
      required: [],
    },
  },
  requires_approval: false,
  dangerous: false,
  capability: { class: "read", evidence: "metadata", parallel_safe: true, read_only_profile: true },
};

async function handleGitLog(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const root = workspaceRoot(ctx);
  if (!root) return "git_log_workspace_unavailable";
  if (!existsSync(resolve(root, ".git"))) return "git_log_not_a_repository";

  const requested = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 20;
  const limit = Math.min(requested, 100);
  const pathArg = typeof args.path === "string" && args.path.trim() ? args.path.trim() : "";
  const timeout = ctx.timeout_ms ?? 10_000;

  try {
    const format = "%H%x1f%an%x1f%ad%x1f%s";
    const gitArgs = ["log", "-n", String(limit), `--format=${format}`, "--date=short"];
    if (pathArg) gitArgs.push("--", pathArg);
    const output = await git(root, gitArgs, timeout);
    const entries = output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, author, date, ...subjectParts] = line.split("\x1f");
        return { sha: sha?.slice(0, 40), author, date, subject: subjectParts.join("\x1f") };
      });
    return bounded(JSON.stringify({ workspace: root, count: entries.length, commits: entries }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `git_log_error: ${message}`;
  }
}

export function registerGitLogBundle(runtime: ToolRuntime): void {
  runtime.register(GIT_LOG_DEF, handleGitLog);
}