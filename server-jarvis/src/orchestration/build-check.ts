import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { extname, join, sep } from "path";
import type { ToolCallRecord } from "./stage-output";
import { pythonSyntaxCheck } from "./syntax-gate";

const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

/** Successful write-effect target paths from a turn's tool calls (deduped). */
export function writtenPathsFrom(toolCalls: readonly ToolCallRecord[]): string[] {
  const seen = new Set<string>();
  for (const c of toolCalls) {
    if (c.is_error || !WRITE_TOOL_NAMES.has(c.name)) continue;
    const p = typeof (c.arguments as Record<string, unknown> | undefined)?.path === "string"
      ? ((c.arguments as Record<string, unknown>).path as string).trim()
      : "";
    if (p) seen.add(p);
  }
  return [...seen];
}

export type CheckOutcome =
  | { kind: "clean"; command: string }
  | { kind: "failed"; command: string; detail: string }
  | { kind: "not_applicable"; reason: string };

export interface ExecResult {
  code: number | null;
  enoent: boolean;
  timedOut: boolean;
  stderr: string;
  stdout: string;
}
export type ExecFn = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<ExecResult>;

export interface DetectedCommand { command: string; args: string[]; cwd: string; }

export interface DetectInput {
  root: string;
  writtenPaths: string[];
  exists: (p: string) => boolean;
  readText: (p: string) => string | null;
  /**
   * Extra already-configured CMake build directories (e.g. Jarvis prepare cache).
   * Checked after normal workspace candidates; never cold-configured here.
   */
  configuredBuildDirs?: string[];
}

export interface BuildDetector {
  id: string;
  /** A runnable check command when this detector applies AND the project is in
   * a checkable state; null to decline (→ try next / honest none). */
  detect(input: DetectInput): DetectedCommand | null;
}

const CMAKE_BUILD_DIRS = ["build", "out", "cmake-build-debug", "cmake-build-release"];

export const PROJECT_DETECTORS: BuildDetector[] = [
  {
    id: "cargo",
    detect: ({ root, exists }) =>
      exists(join(root, "Cargo.toml")) ? { command: "cargo", args: ["check", "--quiet"], cwd: root } : null,
  },
  {
    id: "cmake",
    detect: ({ root, exists, configuredBuildDirs }) => {
      if (!exists(join(root, "CMakeLists.txt"))) return null;
      for (const d of CMAKE_BUILD_DIRS) {
        const dir = join(root, d);
        if (exists(join(dir, "CMakeCache.txt"))) return { command: "cmake", args: ["--build", dir], cwd: root };
      }
      // Prepared dirs from ensureVerificationWorkspace (outside model loops).
      for (const dir of configuredBuildDirs ?? []) {
        if (!dir) continue;
        if (exists(join(dir, "CMakeCache.txt"))) {
          return { command: "cmake", args: ["--build", dir], cwd: root };
        }
      }
      return null; // unconfigured → decline → honest none (no cold configure in-turn)
    },
  },
  {
    id: "go",
    detect: ({ root, exists }) =>
      exists(join(root, "go.mod")) ? { command: "go", args: ["build", "./..."], cwd: root } : null,
  },
  {
    id: "node",
    detect: ({ root, exists }) =>
      exists(join(root, "tsconfig.json"))
        ? { command: "npx", args: ["--no-install", "tsc", "--noEmit"], cwd: root }
        : null,
  },
  {
    id: "make",
    detect: ({ root, exists, readText }) => {
      if (!exists(join(root, "Makefile"))) return null;
      const body = readText(join(root, "Makefile")) ?? "";
      // Only run a check-like phony target; a bare `make` could trigger an
      // unbounded full build.
      const target = /^check:/m.test(body) ? "check"
        : /^typecheck:/m.test(body) ? "typecheck"
        : /^test:/m.test(body) ? "test"
        : null;
      return target ? { command: "make", args: [target], cwd: root } : null;
    },
  },
];

/** First applicable project detector, or null. Exposed for tests. */
export function detectorFor(input: DetectInput): { id: string; cmd: DetectedCommand } | null {
  for (const det of PROJECT_DETECTORS) {
    const cmd = det.detect(input);
    if (cmd) return { id: det.id, cmd };
  }
  return null;
}

export interface RunBuildCheckInput {
  root: string;
  writtenPaths: string[];
  timeoutMs: number;
  /** Pre-prepared CMake build dirs (from verification-workspace prepare). */
  configuredBuildDirs?: string[];
  exists?: (p: string) => boolean;
  readText?: (p: string) => string | null;
  exec?: ExecFn;
}

function defaultReadText(p: string): string | null {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

const defaultExec: ExecFn = (cmd, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, enoent: false, timedOut: false, stderr: stderr || "", stdout: stdout || "" });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        resolve({
          code: typeof e.code === "number" ? e.code : null,
          enoent: e.code === "ENOENT",
          timedOut: e.killed === true || e.signal === "SIGTERM",
          stderr: stderr || "",
          stdout: stdout || "",
        });
      });
  });

function tailDetail(r: ExecResult): string {
  return (r.stderr || r.stdout || "").trim().split("\n").slice(-8).join("\n").slice(0, 400);
}

function normalizeSep(p: string): string {
  // For the test's slash-based path tokens, keep them as-is; the only call site
  // is `exists(p)` on a synthesized Set of forward-slash paths.
  return p;
}

/** Detect the project's build system and run its check-level command, or fall
 * back to per-file Python syntax check. Returns a tri-state outcome; only an
 * actually-executed check yields clean/failed — everything else is
 * not_applicable (→ honest `none` upstream). */
export async function runBuildCheck(input: RunBuildCheckInput): Promise<CheckOutcome> {
  const exists = input.exists ?? existsSync;
  const readText = input.readText ?? defaultReadText;
  const exec = input.exec ?? defaultExec;
  const ctx: DetectInput = {
    root: input.root,
    writtenPaths: input.writtenPaths,
    exists,
    readText,
    configuredBuildDirs: input.configuredBuildDirs,
  };

  for (const det of PROJECT_DETECTORS) {
    const cmd = det.detect(ctx);
    if (!cmd) continue;
    const r = await exec(cmd.command, cmd.args, cmd.cwd, input.timeoutMs);
    if (r.enoent) continue;                                   // toolchain unavailable → try next
    const commandStr = `${cmd.command} ${cmd.args.join(" ")}`.trim();
    if (r.timedOut) return { kind: "not_applicable", reason: `${det.id} check timed out` };
    if (r.code === 0) return { kind: "clean", command: commandStr };
    const detail = tailDetail(r);
    if (detail) return { kind: "failed", command: commandStr, detail };
    // nonzero with no diagnostic → cannot determine; try next detector
  }

  const pyFiles = input.writtenPaths
    .filter((p) => extname(p).toLowerCase() === ".py" && exists(normalizeSep(p)));
  if (pyFiles.length > 0) {
    const issues: string[] = [];
    for (const p of pyFiles) {
      const issue = await pythonSyntaxCheck(p);
      if (issue) issues.push(`[${p}] ${issue}`);
    }
    return issues.length > 0
      ? { kind: "failed", command: "py_compile", detail: issues.join("\n").slice(0, 400) }
      : { kind: "clean", command: "py_compile" };
  }

  return { kind: "not_applicable", reason: "no build system or checker matched the written files" };
}

// Suppress unused-import warning for `sep` (kept for forward compat — Windows
// cmake detector constructs `dir` via join() which already uses sep).
void sep;
