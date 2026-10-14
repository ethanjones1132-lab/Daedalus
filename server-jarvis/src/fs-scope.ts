// Filesystem path scoping shared by every canonical filesystem tool.

import { existsSync, lstatSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, posix, relative, resolve, win32 } from "path";
import type { JarvisConfig } from "./config";

export interface SafePathOptions {
  workspaceOverride?: string;
  sessionGrants?: string[];
  forWrite?: boolean;
}

export interface SafePathResolution {
  path: string;
  canonicalPath: string;
  revalidate(): void;
}

interface AllowedRoot {
  path: string;
  canonicalPath: string;
}

interface CandidatePath {
  path: string;
}

export function effectiveWorkspaceRoot(cfg: JarvisConfig): string {
  return cfg.jarvis_path || process.cwd();
}

function expandHomeToken(inputPath: string, platform: NodeJS.Platform, home: string): string {
  const pathApi = platform === "win32" ? win32 : posix;
  if (inputPath === "~") return home;
  if (/^~[\\/]/.test(inputPath)) {
    return pathApi.join(home, ...inputPath.slice(2).split(/[\\/]+/).filter(Boolean));
  }
  return inputPath;
}

/** Expand only a leading home token; embedded tildes remain literal. */
export function expandHomePath(inputPath: string): string {
  return expandHomeToken(inputPath, process.platform, homedir());
}

/**
 * Translate a Windows-style path into its WSL equivalent.
 * Handles `\\wsl.localhost\<distro>\...` / `\\wsl$\<distro>\...` UNC paths and
 * `C:\...` drive paths. POSIX paths pass through unchanged.
 */
export function toWslPath(inputPath: string): string {
  let normalized = inputPath.replace(/\\/g, "/");

  for (const prefix of ["//wsl.localhost/", "//wsl$/"]) {
    if (normalized.startsWith(prefix)) {
      const parts = normalized.slice(prefix.length).split("/");
      return "/" + parts.slice(1).join("/");
    }
  }

  const driveMatch = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (driveMatch) {
    return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
  }

  return normalized;
}

/** Canonical user-path normalization shared by scope resolution and evidence accounting. */
export function normalizePathInput(
  inputPath: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const trimmed = inputPath.trim();
  const expanded = expandHomeToken(trimmed, platform, home);
  return platform === "win32" ? expanded : toWslPath(expanded);
}

function rootKey(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Compare path segments using the host filesystem's case semantics. */
export function pathSegmentsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function existingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function canonicalExistingPath(path: string): string | null {
  try {
    if (!statSync(path).isDirectory()) return null;
    return realpathSync(path);
  } catch {
    return null;
  }
}

function canonicalCandidatePath(path: string): string | null {
  const absolute = resolve(path);
  try {
    lstatSync(absolute);
  } catch {
    const suffix: string[] = [];
    let ancestor = absolute;
    while (true) {
      const parent = dirname(ancestor);
      if (parent === ancestor) return null;
      suffix.push(basename(ancestor));
      ancestor = parent;
      try {
        const canonicalAncestor = realpathSync(ancestor);
        return resolve(canonicalAncestor, ...suffix.reverse());
      } catch {
        continue;
      }
    }
  }

  try {
    return realpathSync(absolute);
  } catch {
    return null;
  }
}

function resolveAllowedRootEntries(
  cfg: JarvisConfig,
  options: Pick<SafePathOptions, "workspaceOverride" | "sessionGrants"> = {},
): AllowedRoot[] {
  const candidates = [
    options.workspaceOverride,
    effectiveWorkspaceRoot(cfg),
    ...(options.sessionGrants ?? []),
    ...(cfg.tools?.allowed_roots ?? []),
  ];
  const seen = new Set<string>();
  const roots: AllowedRoot[] = [];
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const normalized = resolve(normalizePathInput(candidate));
    const canonicalPath = canonicalExistingPath(normalized);
    if (!canonicalPath) continue;
    const key = rootKey(canonicalPath);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push({ path: normalized, canonicalPath });
  }
  return roots;
}

export function resolveAllowedRoots(
  cfg: JarvisConfig,
  options: Pick<SafePathOptions, "workspaceOverride" | "sessionGrants"> = {},
): string[] {
  return resolveAllowedRootEntries(cfg, options).map((root) => root.path);
}

function absoluteLike(path: string): boolean {
  return isAbsolute(path)
    || /^[a-zA-Z]:[\\/]/.test(path)
    || /^\\\\/.test(path)
    || /^\/\//.test(path)
    || /^\//.test(path);
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !/^[a-zA-Z]:/.test(rel));
}

/**
 * Leading path segments models hallucinate as if the sandbox root were
 * literally named this. Evidence: 2026-08-07 overnight local-model eval —
 * 5+ different local models repeatedly emitted a "workspace/" (or absolute
 * "/workspace/...") prefix that matches nothing in the actual fixture,
 * sometimes doubled ("/workspace/workspace/..."). Several otherwise-correct
 * fixes were lost entirely to this: the model landed the right diagnosis,
 * then burned its whole remaining turn budget re-verifying via a path that
 * only ever resolves to a dead end, never reaching the reviewer stage.
 *
 * Matching is case-insensitive regardless of platform — this is a
 * conceptual placeholder word a model typed, not a real filesystem entry,
 * so OS case semantics don't apply to it. Only ever consulted as a fallback
 * after the literal path has already failed to resolve (see call sites), so
 * a real directory actually named "workspace" is never shadowed: direct
 * resolution finds it first, exactly as the existing basename-dedup above
 * already does for a root's own name.
 */
const HALLUCINATED_ROOT_SEGMENTS = new Set(["workspace"]);

/**
 * Strip zero or more leading hallucinated placeholder segments.
 *
 * Exported so every consumer of a model-supplied path repairs it the same way.
 * A second copy of this rule elsewhere would drift from `HALLUCINATED_ROOT_SEGMENTS`
 * and reintroduce the writer/verifier disagreement it exists to prevent.
 */
export function stripHallucinatedRootSegments(segments: readonly string[]): string[] {
  let start = 0;
  while (start < segments.length - 1 && HALLUCINATED_ROOT_SEGMENTS.has(segments[start].toLowerCase())) {
    start++;
  }
  return segments.slice(start);
}

/** Try each root with hallucinated placeholder segments stripped; null if none resolve. */
function resolveHallucinatedRootPath(
  segments: readonly string[],
  roots: readonly AllowedRoot[],
  forWrite: boolean,
): string | null {
  const stripped = stripHallucinatedRootSegments(segments);
  if (stripped.length === 0 || stripped.length === segments.length) return null;
  for (const root of roots) {
    const candidate = resolve(root.path, ...stripped);
    if (!isContained(root.path, candidate)) continue;
    if (forWrite ? existingDirectory(dirname(candidate)) : existsSync(candidate)) return candidate;
  }
  return null;
}

export class WorkspaceSandboxDeniedError extends Error {
  readonly forWrite: boolean;

  constructor(message: string, forWrite: boolean) {
    super(message);
    this.name = "WorkspaceSandboxDeniedError";
    this.forWrite = forWrite;
  }
}

function outsideError(
  inputPath: string,
  cfg: JarvisConfig,
  roots: string[],
  forWrite: boolean,
): WorkspaceSandboxDeniedError {
  return new WorkspaceSandboxDeniedError(
    `Path "${inputPath}" is outside the workspace. Sandbox mode: ${cfg.tools.sandbox_mode}. ` +
    `Allowed roots: ${roots.length > 0 ? roots.join(", ") : "(none)"}`,
    forWrite,
  );
}

function optionsFrom(third?: string | SafePathOptions): SafePathOptions {
  return typeof third === "string" ? { workspaceOverride: third } : (third ?? {});
}

/**
 * Resolve a user path against the invocation's ordered allowed roots.
 *
 * Sandbox modes:
 * - `off` — no containment
 * - `strict` — reads and writes must stay in `allowed_roots ∪ session_grants`
 * - `permissive` — **reads** outside roots are allowed (logged); **writes**
 *   (`forWrite: true`) remain confined to roots∪grants (F4 / 2026-07-21).
 *   Effectively a permissive-reads / confined-writes policy.
 */
function addCandidate(candidates: CandidatePath[], seen: Set<string>, path: string): void {
  const absolute = resolve(path);
  const key = rootKey(absolute);
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({ path: absolute });
}

function collectCandidatePaths(
  inputPath: string,
  cfg: JarvisConfig,
  options: SafePathOptions,
  roots: readonly AllowedRoot[],
): CandidatePath[] {
  const normalizedInput = normalizePathInput(inputPath);
  const candidates: CandidatePath[] = [];
  const seen = new Set<string>();
  const segments = normalizedInput.split(/[\\/]+/).filter(Boolean);

  if (absoluteLike(normalizedInput)) {
    addCandidate(candidates, seen, resolve(normalizedInput));
    const hallucinated = resolveHallucinatedRootPath(segments, roots, options.forWrite === true);
    if (hallucinated) addCandidate(candidates, seen, hallucinated);
    return candidates;
  }

  for (const root of roots) {
    if (segments.length > 1 && pathSegmentsEqual(basename(root.path), segments[0])) {
      const deduplicated = resolve(root.path, ...segments.slice(1));
      if (isContained(root.path, deduplicated) && existsSync(deduplicated)) {
        addCandidate(candidates, seen, deduplicated);
      }
    }

    const candidate = resolve(root.path, normalizedInput);
    if (!isContained(root.path, candidate)) continue;
    if (options.forWrite ? existingDirectory(dirname(candidate)) : existsSync(candidate)) {
      addCandidate(candidates, seen, candidate);
    }
  }

  const hallucinated = resolveHallucinatedRootPath(segments, roots, options.forWrite === true);
  if (hallucinated) addCandidate(candidates, seen, hallucinated);

  if (roots.length > 0) {
    const fallback = resolve(roots[0].path, normalizedInput);
    addCandidate(candidates, seen, fallback);
  } else {
    const permissiveBase = resolve(normalizePathInput(effectiveWorkspaceRoot(cfg)));
    addCandidate(candidates, seen, resolve(permissiveBase, normalizedInput));
  }

  return candidates;
}

function makeResolution(
  inputPath: string,
  cfg: JarvisConfig,
  workspaceOrOptions: string | SafePathOptions | undefined,
  path: string,
  canonicalPath: string,
): SafePathResolution {
  return {
    path,
    canonicalPath,
    revalidate(): void {
      if (cfg.tools.sandbox_mode === "off") return;
      const current = resolveSafePath(inputPath, cfg, workspaceOrOptions);
      if (current.path !== path || current.canonicalPath !== canonicalPath) {
        throw new Error(`Path "${inputPath}" changed while it was being processed.`);
      }
    },
  };
}

export function resolveSafePath(
  inputPath: string,
  cfg: JarvisConfig,
  workspaceOrOptions?: string | SafePathOptions,
): SafePathResolution {
  const options = optionsFrom(workspaceOrOptions);
  const normalizedInput = normalizePathInput(inputPath);

  if (cfg.tools.sandbox_mode === "off") {
    const path = resolve(normalizedInput);
    return makeResolution(inputPath, cfg, workspaceOrOptions, path, path);
  }

  const roots = resolveAllowedRootEntries(cfg, options);
  const allowOutside = cfg.tools.sandbox_mode === "permissive" && !options.forWrite;
  const candidates = collectCandidatePaths(inputPath, cfg, options, roots);
  const rootPaths = roots.map((root) => root.path);

  for (const candidate of candidates) {
    const canonicalPath = canonicalCandidatePath(candidate.path);
    if (!canonicalPath) continue;
    if (roots.some((root) => isContained(root.canonicalPath, canonicalPath))) {
      return makeResolution(inputPath, cfg, workspaceOrOptions, candidate.path, canonicalPath);
    }
    if (allowOutside) {
      console.log(`[Sandbox] Permissive mode: allowing access to "${candidate.path}" (outside allowed roots: ${rootPaths.join(", ") || "none"})`);
      return makeResolution(inputPath, cfg, workspaceOrOptions, candidate.path, canonicalPath);
    }
  }

  throw outsideError(inputPath, cfg, rootPaths, options.forWrite === true);
}

export function safePath(
  inputPath: string,
  cfg: JarvisConfig,
  workspaceOrOptions?: string | SafePathOptions,
): string {
  return resolveSafePath(inputPath, cfg, workspaceOrOptions).path;
}
