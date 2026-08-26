import { execFile } from "child_process";
import { existsSync } from "fs";
import { promises as fs } from "fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import type { ToolCallRecord } from "./stage-output";
import { stripHallucinatedRootSegments } from "../fs-scope";

const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);
const PYTHON_PATH = /(?:[A-Za-z]:[\\/])?[A-Za-z0-9_.\\/-]+\.py\b/gi;
// Include bare `_t.py` (tier-2B fixture) — `_t[^.]+` alone required chars after `_t`.
const TEST_FILE = /(?:^test[_-].*|.*[_-]test|^_t(?:[^.]+)?)\.py$/i;
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
    // `file_path` is the same argument under a different name — every other
    // write-path consumer accepts both (see effect-gate.toolCallWritePath).
    // Reading only `path` here made the gate blind to writes the reward
    // function had already credited.
    const raw = call.arguments?.path ?? call.arguments?.file_path;
    const path = typeof raw === "string" ? raw.trim() : "";
    if (path && extname(path).toLowerCase() === ".py") seen.add(path);
  }
  return [...seen];
}

function absoluteTarget(path: string, root: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

/**
 * Resolve a model-supplied write path to where the file actually landed.
 *
 * Models sometimes prefix a path with a conceptual `workspace/` segment that
 * is not a real directory. `fs-scope.safePath` repairs that so the WRITE
 * succeeds — but this gate read the raw path, looked for an adjacent test in
 * a directory that never existed, and returned no target. The run then scored
 * a B2 hard zero (`tier: "none"`) even though the fix was correct and already
 * credited by the write-effect accounting. Writer and verifier have to agree
 * on where the file is.
 *
 * Repair is a fallback only, after the literal path fails to resolve, so a
 * directory genuinely named `workspace` is never shadowed — mirroring the
 * ordering `fs-scope` itself uses.
 */
function resolveWrittenTarget(
  raw: string,
  root: string,
  exists: (path: string) => boolean,
): string {
  const literal = absoluteTarget(raw, root);
  if (exists(literal) || exists(dirname(literal))) return literal;

  const segments = raw.split(/[\\/]+/).filter(Boolean);
  const stripped = stripHallucinatedRootSegments(segments);
  if (stripped.length > 0 && stripped.length !== segments.length) {
    const repaired = resolve(root, ...stripped);
    if (exists(repaired) || exists(dirname(repaired))) return repaired;
  }
  return literal;
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
    .map((path) => resolveWrittenTarget(path, options.root, exists))
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

/**
 * Run one EXPLICIT Python target, bounded, with no discovery step.
 *
 * Split out from `runWrittenCodeGate` so a caller that already knows its
 * target (e.g. a fixture harness holding the graded test) can execute it
 * without routing through tool-call inference — discovery is exactly the part
 * that can silently decline, and a scorer must not depend on it.
 */
export async function runPythonTarget(
  target: string,
  root: string,
  timeoutMs = 10_000,
): Promise<RunGateResult> {
  let result = await runPythonCommand("python", target, root, timeoutMs);
  if (result.unavailable) {
    result = await runPythonCommand("py", target, root, timeoutMs);
  }
  if (result.unavailable) {
    return { status: "skipped", target, reason: "Python interpreter unavailable", issues: [] };
  }
  if (result.exitCode === 0) {
    return { status: "passed", target, issues: [] };
  }
  if (result.detail) {
    return { status: "failed", target, issues: [{ path: target, error: result.detail }] };
  }
  return { status: "skipped", target, reason: "Python run outcome was ambiguous", issues: [] };
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
  // Deliberately does NOT attach `target.reason` to a passed/failed result:
  // mergeToCheckResult reads `reason` to pick the tier, so surfacing it here
  // would silently reclassify standalone_script runs from `existing` to
  // `synth` and change reward credit. Preserving the established behaviour.
  return runPythonTarget(target.path, options.root, options.timeoutMs ?? 10_000);
}

export function renderRunIssues(result: Pick<RunGateResult, "issues">): string {
  if (result.issues.length === 0) return "";
  return [
    "REJECT — the deterministic run gate failed and the written code must be repaired before it can ship:",
    ...result.issues.map((issue) => "- [" + issue.path + "] failed to run:\n" + issue.error),
  ].join("\n");
}
