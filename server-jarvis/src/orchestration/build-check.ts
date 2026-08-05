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

/**
 * Visual Studio ships CMake but does not put it on PATH. Without these, a
 * Windows C++ project ENOENTs the cmake detector and the whole build gate
 * degrades to `not_applicable` → check_tier "none" (2026-08-05, Perihelion:
 * a fully configured build/ still could not be checked).
 */
const VS_CMAKE_CANDIDATES = [
  "C:\\Program Files\\Microsoft Visual Studio\\18\\Community",
  "C:\\Program Files\\Microsoft Visual Studio\\18\\Professional",
  "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise",
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community",
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional",
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise",
  "C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Community",
  "C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools",
].map((base) =>
  `${base}\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe`,
);

export interface ResolveExecutableEnv {
  platform?: string;
  /** Whether the bare command resolves on PATH. */
  onPath?: (cmd: string) => boolean;
  exists?: (p: string) => boolean;
}

function defaultOnPath(cmd: string): boolean {
  const pathVar = process.env.PATH ?? "";
  const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
  for (const dir of pathVar.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    if (existsSync(join(dir, cmd))) return true;
    if (process.platform === "win32") {
      for (const ext of exts) {
        if (existsSync(join(dir, cmd + ext.toLowerCase()))) return true;
        if (existsSync(join(dir, cmd + ext))) return true;
      }
    }
  }
  return false;
}

/**
 * Resolve a build command to something executable. Only rewrites `cmake` on
 * win32, and only when it is absent from PATH; otherwise returns the bare
 * command so an genuinely-missing toolchain still ENOENTs honestly.
 */
export function resolveBuildExecutable(
  command: string,
  env: ResolveExecutableEnv = {},
): string {
  const platform = env.platform ?? process.platform;
  if (command !== "cmake" || platform !== "win32") return command;
  const onPath = env.onPath ?? defaultOnPath;
  if (onPath(command)) return command;
  const exists = env.exists ?? existsSync;
  for (const candidate of VS_CMAKE_CANDIDATES) {
    if (exists(candidate)) return candidate;
  }
  return command;
}

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

/** Max characters of build failure detail carried forward to the model. */
const FAILURE_DETAIL_CHARS = 2000;
/** Max distinct error lines kept — enough to fix a batch, bounded for prompts. */
const FAILURE_DETAIL_LINES = 25;

const ERROR_LINE = /(^|\s)(error)\b|:\s*error[\s:]|\berror [A-Z]+\d+/i;

/**
 * Failure detail for a non-zero build.
 *
 * 2026-08-05: this took the last 8 lines of `stderr || stdout`. MSVC writes
 * errors to stdout and warnings to stderr, so the `||` picked stderr and the
 * detail became a trailing C4530 warning while the real
 * "'isnan': is not a member of 'juce'" errors were dropped. Both streams are
 * now searched, error lines win over position, and duplicates collapse.
 */
export function extractFailureDetail(r: ExecResult): string {
  const combined = `${r.stdout ?? ""}\n${r.stderr ?? ""}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const errors: string[] = [];
  for (const line of combined) {
    if (!ERROR_LINE.test(line)) continue;
    if (errors.includes(line)) continue;
    errors.push(line);
    if (errors.length >= FAILURE_DETAIL_LINES) break;
  }
  const chosen = errors.length > 0 ? errors : combined.slice(-8);
  return chosen.join("\n").slice(0, FAILURE_DETAIL_CHARS);
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
    // Resolve before exec so a VS-bundled cmake is found even off PATH.
    const executable = resolveBuildExecutable(cmd.command);
    const r = await exec(executable, cmd.args, cmd.cwd, input.timeoutMs);
    if (r.enoent) continue;                                   // toolchain unavailable → try next
    const commandStr = `${cmd.command} ${cmd.args.join(" ")}`.trim();
    if (r.timedOut) return { kind: "not_applicable", reason: `${det.id} check timed out` };
    if (r.code === 0) return { kind: "clean", command: commandStr };
    const detail = extractFailureDetail(r);
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
