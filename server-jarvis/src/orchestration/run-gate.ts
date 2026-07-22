import { execFile } from "child_process";
import { existsSync } from "fs";
import { promises as fs } from "fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import type { ToolCallRecord } from "./stage-output";

const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);
const PYTHON_PATH = /(?:[A-Za-z]:[\\/])?[A-Za-z0-9_.\\/-]+\.py\b/gi;
const TEST_FILE = /(?:^test[_-].*|.*[_-]test|_t[^.]+)\.py$/i;
const MAIN_GUARD = /if\s+__name__\s*==\s*["']__main__["']\s*:/;

export interface RunGateIssue {
  path: string;
  error: string;
}

export interface RunTarget {
  path: string;
  reason: "explicit_test" | "adjacent_test" | "standalone_script";
}

export interface RunGateResult {
  status: "passed" | "failed" | "skipped";
  target?: string;
  reason?: string;
  issues: RunGateIssue[];
}

export interface RunGateOptions {
  root: string;
  timeoutMs?: number;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => Promise<string>;
  listDirectory?: (path: string) => Promise<string[]>;
}

function writtenPythonPaths(toolCalls: readonly ToolCallRecord[] | undefined): string[] {
  const seen = new Set<string>();
  for (const call of toolCalls ?? []) {
    if (call.is_error || !WRITE_TOOL_NAMES.has(call.name)) continue;
    const path = typeof call.arguments?.path === "string" ? call.arguments.path.trim() : "";
    if (path && extname(path).toLowerCase() === ".py") seen.add(path);
  }
  return [...seen];
}

function absoluteTarget(path: string, root: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function testPathTokens(text: string): string[] {
  return [...text.matchAll(PYTHON_PATH)].map((match) => match[0].replace(/[),.;:]+$/, ""));
}

function isTestFile(path: string): boolean {
  return TEST_FILE.test(basename(path));
}

async function defaultListDirectory(path: string): Promise<string[]> {
  return (await fs.readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

/** Select a deterministic, runnable Python target without executing arbitrary files. */
export async function findRunnableTarget(
  toolCalls: readonly ToolCallRecord[] | undefined,
  request: string,
  plan: string,
  options: RunGateOptions,
): Promise<RunTarget | undefined> {
  const exists = options.exists ?? existsSync;
  const listDirectory = options.listDirectory ?? defaultListDirectory;
  const readFile = options.readFile ?? ((path: string) => fs.readFile(path, "utf8"));
  const written = writtenPythonPaths(toolCalls)
    .map((path) => absoluteTarget(path, options.root))
    .filter((path) => isWithinRoot(options.root, path));

  // Priority A: a test path named explicitly in the request or plan.
  for (const token of testPathTokens(`${request}\n${plan}`)) {
    const candidate = absoluteTarget(token, options.root);
    if (isWithinRoot(options.root, candidate) && isTestFile(candidate) && exists(candidate)) {
      return { path: candidate, reason: "explicit_test" };
    }
  }

  // Priority B: a conventional test next to a file the executor wrote.
  for (const writtenPath of written) {
    let names: string[];
    try {
      names = await listDirectory(dirname(writtenPath));
    } catch {
      continue;
    }
    const adjacent = names
      .filter((name) => TEST_FILE.test(name))
      .sort((a, b) => a.localeCompare(b))[0];
    if (adjacent) {
      const candidate = join(dirname(writtenPath), adjacent);
      if (exists(candidate)) return { path: candidate, reason: "adjacent_test" };
    }
  }

  // Priority C: only run a written script that declares an import-safe main
  // entry point. Importing arbitrary modules would make the verification gate
  // capable of triggering side effects unrelated to the requested edit.
  for (const writtenPath of written) {
    if (isTestFile(writtenPath) || !exists(writtenPath)) continue;
    try {
      if (MAIN_GUARD.test(await readFile(writtenPath))) {
        return { path: writtenPath, reason: "standalone_script" };
      }
    } catch {
      // An unreadable target is ambiguous; fail-open and let the reviewer report
      // the ordinary filesystem evidence instead of inventing an execution fail.
    }
  }
  return undefined;
}

interface PythonCommandResult {
  unavailable: boolean;
  exitCode?: number;
  detail?: string;
}

function runPythonCommand(
  program: string,
  target: string,
  root: string,
  timeoutMs: number,
): Promise<PythonCommandResult> {
  return new Promise((resolveResult) => {
    // execFile intentionally receives argv directly. Do not switch this to a
    // shell command: paths and user-controlled workspace names must not be
    // interpolated into a shell.
    execFile(program, [target], { cwd: root, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolveResult({ unavailable: false, exitCode: 0 });
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return resolveResult({ unavailable: true });
      }
      const detail = (stderr || stdout || error.message || "").trim();
      const exitCode = typeof (error as NodeJS.ErrnoException).code === "number"
        ? (error as NodeJS.ErrnoException).code as unknown as number
        : undefined;
      resolveResult({ unavailable: false, exitCode, detail: detail.slice(-1_000) });
    });
  });
}

/** Run one selected target with a bounded direct-argv Python invocation. */
export async function runWrittenCodeGate(
  toolCalls: readonly ToolCallRecord[] | undefined,
  request: string,
  plan: string,
  options: RunGateOptions,
): Promise<RunGateResult> {
  let target: RunTarget | undefined;
  try {
    target = await findRunnableTarget(toolCalls, request, plan, options);
  } catch {
    return { status: "skipped", reason: "run target could not be determined", issues: [] };
  }
  if (!target) {
    return { status: "skipped", reason: "no runnable Python target was identified", issues: [] };
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  let result = await runPythonCommand("python", target.path, options.root, timeoutMs);
  if (result.unavailable) {
    result = await runPythonCommand("py", target.path, options.root, timeoutMs);
  }
  if (result.unavailable) {
    return {
      status: "skipped",
      target: target.path,
      reason: "Python interpreter unavailable",
      issues: [],
    };
  }
  if (result.exitCode === 0) {
    return { status: "passed", target: target.path, issues: [] };
  }
  if (result.detail) {
    return {
      status: "failed",
      target: target.path,
      issues: [{ path: target.path, error: result.detail }],
    };
  }
  return {
    status: "skipped",
    target: target.path,
    reason: "Python run outcome was ambiguous",
    issues: [],
  };
}

export function renderRunIssues(result: Pick<RunGateResult, "issues">): string {
  if (result.issues.length === 0) return "";
  return [
    "REJECT — the deterministic run gate failed and the written code must be repaired before it can ship:",
    ...result.issues.map((issue) => "- [" + issue.path + "] failed to run:\n" + issue.error),
  ].join("\n");
}
