// ═══════════════════════════════════════════════════════════════
// ── Git Diff Bundle ─────────────────────────────────────────────
// Read-only Git working-tree inspection beyond `git_metadata`: changed
// files, diff stats, and bounded patches. Mirrors git-metadata-bundle's
// contract so every surface can register it through bundles-registry.

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
    maxBuffer: 256 * 1024,
  });
  return String(result.stdout || "").trim();
}

function bounded(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated]`;
}

const GIT_DIFF_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "git_diff",
    description:
      "Read-only Git diff for the active workspace. mode=names lists changed files; stat returns a diffstat summary; patch returns a bounded unified diff. staged=true compares the index.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", description: "names | stat | patch (default stat)", default: "stat" },
        staged: { type: "boolean", description: "Compare staged (index) changes instead of working tree", default: false },
        max_files: { type: "number", description: "Limit the number of files in names/patch output", default: 100 },
      },
      required: [],
    },
  },
  requires_approval: false,
  dangerous: false,
  capability: { class: "read", evidence: "metadata", parallel_safe: true, read_only_profile: true },
};

async function handleGitDiff(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  let root = workspaceRoot(ctx);
  if (!root) return "git_diff_workspace_unavailable";

  // Verify git repository before running other commands.
  if (!existsSync(resolve(root, ".git"))) return "git_diff_not_a_repository";

  const mode = typeof args.mode === "string" ? args.mode.toLowerCase() : "stat";
  const staged = args.staged === true;
  const maxFiles = typeof args.max_files === "number" && args.max_files > 0 ? Math.floor(args.max_files) : 100;
  const timeout = ctx.timeout_ms ?? 10_000;
  const common = staged ? ["--cached"] : [];

  try {
    if (mode === "names") {
      const output = await git(root, ["diff", ...common, "--name-status"], timeout);
      const lines = output.split(/\r?\n/).filter(Boolean).slice(0, maxFiles);
      return bounded(JSON.stringify({ workspace: root, mode, staged, changed_files: lines, count: lines.length }));
    }
    if (mode === "patch") {
      const output = await git(root, ["diff", ...common, "--", "."], timeout);
      return bounded(JSON.stringify({ workspace: root, mode, staged, patch: output }));
    }
    // stat (default)
    const stat = await git(root, ["diff", ...common, "--stat"], timeout);
    const nameStatus = await git(root, ["diff", ...common, "--name-status"], timeout);
    const files = nameStatus.split(/\r?\n/).filter(Boolean).slice(0, maxFiles);
    return bounded(JSON.stringify({ workspace: root, mode: "stat", staged, files, stat }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `git_diff_error: ${message}`;
  }
}

export function registerGitDiffBundle(runtime: ToolRuntime): void {
  runtime.register(GIT_DIFF_DEF, handleGitDiff);
}

export { workspaceRoot as gitDiffWorkspaceRoot };