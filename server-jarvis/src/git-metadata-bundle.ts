import { existsSync, statSync } from "fs";
import { resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { ToolRuntime, ExecutionContext } from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";

const execFileAsync = promisify(execFile);
const ALL_FIELDS = ["head", "branch", "dirty"] as const;
type GitMetadataField = (typeof ALL_FIELDS)[number];

function workspaceRoot(ctx: ExecutionContext): string | null {
  const configured = ctx.workspace_path ?? ctx.config.jarvis_path;
  if (!configured || typeof configured !== "string") return null;
  const root = resolve(configured);
  if (!existsSync(root) || !statSync(root).isDirectory()) return null;
  return root;
}

async function git(root: string, args: string[], timeoutMs: number): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  return String(result.stdout).trim();
}

export async function readGitMetadata(
  root: string,
  include: GitMetadataField[] = [...ALL_FIELDS],
  timeoutMs = 5_000,
): Promise<Record<string, string | boolean>> {
  const gitDir = resolve(root, ".git");
  if (!existsSync(gitDir)) throw new Error("not_a_git_repository");

  const output: Record<string, string | boolean> = {};
  if (include.includes("head")) output.head = await git(root, ["rev-parse", "HEAD"], timeoutMs);
  if (include.includes("branch")) output.branch = await git(root, ["branch", "--show-current"], timeoutMs);
  if (include.includes("dirty")) output.dirty = (await git(root, ["status", "--porcelain"], timeoutMs)).length > 0;
  return output;
}

const GIT_METADATA_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "git_metadata",
    description: "Read Git HEAD, branch, and dirty status for the active workspace. This is read-only and accepts no shell command.",
    parameters: {
      type: "object",
      properties: {
        include: {
          type: "array",
          description: "Metadata fields to return: head, branch, and/or dirty.",
          items: { type: "string", description: "One of head, branch, dirty" },
          default: [...ALL_FIELDS],
        },
      },
      required: [],
    },
  },
  requires_approval: false,
  dangerous: false,
  capability: { class: "read", evidence: "metadata", parallel_safe: true, read_only_profile: true },
};

async function handleGitMetadata(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const unexpected = Object.keys(args).filter((key) => key !== "include");
  if (unexpected.length > 0) return `git_metadata_invalid_arguments: unsupported fields ${unexpected.join(", ")}`;

  const rawInclude = args.include === undefined ? [...ALL_FIELDS] : args.include;
  if (!Array.isArray(rawInclude) || rawInclude.length === 0 || rawInclude.some((value) => !ALL_FIELDS.includes(value as GitMetadataField))) {
    return "git_metadata_invalid_include: expected a non-empty list containing only head, branch, or dirty";
  }
  const root = workspaceRoot(ctx);
  if (!root) return "git_metadata_workspace_unavailable";

  try {
    const metadata = await readGitMetadata(root, [...new Set(rawInclude as GitMetadataField[])], ctx.timeout_ms ?? 5_000);
    return JSON.stringify({ workspace: root, ...metadata });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `git_metadata_error: ${message}`;
  }
}

export function registerGitMetadataBundle(runtime: ToolRuntime): void {
  runtime.register(GIT_METADATA_DEF, handleGitMetadata);
}

