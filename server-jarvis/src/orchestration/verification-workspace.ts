/**
 * Bounded CMake verification workspace preparation — runs outside model loops.
 *
 * Prefers an already-configured build directory under the workspace root.
 * Only when CMakeLists.txt exists and no configured build is available does
 * this module create/reuse a Jarvis-owned cache under
 * `~/.openclaw/jarvis/build-cache/<sha256(absoluteRoot)>` and run a single
 * `cmake -S <root> -B <cacheDir>` configure.
 */
import { execFile } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

/** Candidate build dirs under the workspace root (same order as build-check). */
const CMAKE_BUILD_DIRS = ["build", "out", "cmake-build-debug", "cmake-build-release"];

export type VerificationWorkspaceResult =
  | { kind: "ready"; buildDir: string; prepared: boolean; command: string }
  | { kind: "not_applicable" }
  | { kind: "unavailable"; detail: string; command: string };

export interface VerificationExecResult {
  code: number | null;
  enoent: boolean;
  timedOut: boolean;
  stderr: string;
  stdout: string;
}

export interface VerificationExecCall {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export type VerificationExecFn = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<VerificationExecResult>;

export interface EnsureVerificationWorkspaceInput {
  /** Workspace root to prepare (absolute preferred; resolved if relative). */
  root: string;
  /**
   * Jarvis state root. Cache lives at `<stateRoot>/build-cache/<sha256(root)>`.
   * Defaults to `~/.openclaw/jarvis`.
   */
  stateRoot?: string;
  /** Bound for the configure step. Default 120_000. */
  prepareTimeoutMs?: number;
  /** When false, skip preparation entirely (not_applicable). Default true. */
  prepareEnabled?: boolean;
  exists?: (path: string) => boolean;
  mkdir?: (path: string) => void;
  exec?: VerificationExecFn;
}

/** Default jarvis state directory; build-cache is a child. */
export function defaultVerificationStateRoot(): string {
  return join(homedir(), ".openclaw", "jarvis");
}

/** Normalized absolute workspace root used for hashing and cmake -S. */
export function normalizeWorkspaceRoot(root: string): string {
  return resolve(root);
}

/** Stable cache key for a workspace root. */
export function workspaceRootHash(root: string): string {
  return createHash("sha256").update(normalizeWorkspaceRoot(root)).digest("hex");
}

/** Jarvis-owned configure/build directory for a workspace. */
export function cacheBuildDirForRoot(root: string, stateRoot?: string): string {
  const base = stateRoot ?? defaultVerificationStateRoot();
  return join(base, "build-cache", workspaceRootHash(root));
}

const defaultExec: VerificationExecFn = (cmd, args, cwd, timeoutMs) =>
  new Promise((resolveResult) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          return resolveResult({
            code: 0,
            enoent: false,
            timedOut: false,
            stderr: stderr || "",
            stdout: stdout || "",
          });
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        resolveResult({
          code: typeof e.code === "number" ? e.code : null,
          enoent: e.code === "ENOENT",
          timedOut: e.killed === true || e.signal === "SIGTERM",
          stderr: stderr || "",
          stdout: stdout || "",
        });
      },
    );
  });

function defaultMkdir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function boundDetail(text: string): string {
  return text.trim().split("\n").slice(-8).join("\n").slice(0, 400);
}

function findConfiguredWorkspaceBuild(
  root: string,
  exists: (p: string) => boolean,
): string | null {
  for (const d of CMAKE_BUILD_DIRS) {
    const dir = join(root, d);
    if (exists(join(dir, "CMakeCache.txt"))) return dir;
  }
  return null;
}

/**
 * Prepare a CMake verification build directory outside any model callback.
 * Never cold-configures into the user's source tree — only into a Jarvis cache
 * when no workspace-configured build is already available.
 */
export async function ensureVerificationWorkspace(
  input: EnsureVerificationWorkspaceInput,
): Promise<VerificationWorkspaceResult> {
  if (input.prepareEnabled === false) {
    return { kind: "not_applicable" };
  }

  const root = normalizeWorkspaceRoot(input.root);
  const exists = input.exists ?? existsSync;
  const mkdir = input.mkdir ?? defaultMkdir;
  const exec = input.exec ?? defaultExec;
  const timeoutMs = Math.max(1, input.prepareTimeoutMs ?? 120_000);
  const stateRoot = input.stateRoot ?? defaultVerificationStateRoot();

  if (!exists(join(root, "CMakeLists.txt"))) {
    return { kind: "not_applicable" };
  }

  const existing = findConfiguredWorkspaceBuild(root, exists);
  if (existing) {
    return {
      kind: "ready",
      buildDir: existing,
      prepared: false,
      command: `cmake --build ${existing}`,
    };
  }

  const cacheDir = cacheBuildDirForRoot(root, stateRoot);
  if (exists(join(cacheDir, "CMakeCache.txt"))) {
    return {
      kind: "ready",
      buildDir: cacheDir,
      prepared: false,
      command: `cmake --build ${cacheDir}`,
    };
  }

  const args = ["-S", root, "-B", cacheDir];
  const commandStr = `cmake ${args.join(" ")}`.trim();

  try {
    mkdir(cacheDir);
  } catch (e) {
    return {
      kind: "unavailable",
      detail: boundDetail(`failed to create build cache: ${e instanceof Error ? e.message : String(e)}`),
      command: commandStr,
    };
  }

  const result = await exec("cmake", args, root, timeoutMs);

  if (result.enoent) {
    return {
      kind: "unavailable",
      detail: "cmake not found on PATH (ENOENT)",
      command: commandStr,
    };
  }

  if (result.timedOut) {
    const tail = boundDetail(result.stderr || result.stdout || "");
    return {
      kind: "unavailable",
      detail: boundDetail(tail ? `configure timed out: ${tail}` : "configure timed out"),
      command: commandStr,
    };
  }

  if (result.code !== 0) {
    const tail = boundDetail(result.stderr || result.stdout || `cmake exited ${result.code}`);
    return {
      kind: "unavailable",
      detail: tail || `cmake configure failed (exit ${result.code})`,
      command: commandStr,
    };
  }

  return {
    kind: "ready",
    buildDir: cacheDir,
    prepared: true,
    command: commandStr,
  };
}

/** Process-scoped prepare results: one ensure per workspace root per process. */
const preparedByRoot = new Map<string, VerificationWorkspaceResult>();

/**
 * Process-cached prepare. Safe to call from pipeline verification paths;
 * never re-configures a workspace already prepared (or declined) this process.
 */
export async function ensureVerificationWorkspaceCached(
  input: EnsureVerificationWorkspaceInput,
): Promise<VerificationWorkspaceResult> {
  const key = normalizeWorkspaceRoot(input.root);
  const hit = preparedByRoot.get(key);
  if (hit) return hit;
  const result = await ensureVerificationWorkspace(input);
  preparedByRoot.set(key, result);
  return result;
}

/** Test-only: clear the process-level prepare cache. */
export function clearVerificationWorkspaceCache(): void {
  preparedByRoot.clear();
}
