// Filesystem path scoping shared by every canonical filesystem tool.

import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import type { JarvisConfig } from "./config";

export interface SafePathOptions {
  workspaceOverride?: string;
  sessionGrants?: string[];
  forWrite?: boolean;
}

export function effectiveWorkspaceRoot(cfg: JarvisConfig): string {
  return cfg.jarvis_path || process.cwd();
}

/** Expand only a leading home token; embedded tildes remain literal. */
export function expandHomePath(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (/^~[\\/]/.test(inputPath)) {
    return join(homedir(), inputPath.slice(2));
  }
  return inputPath;
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

function platformPath(inputPath: string): string {
  const expanded = expandHomePath(inputPath.trim());
  return process.platform === "win32" ? expanded : toWslPath(expanded);
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

/** Ordered, normalized filesystem authority for one invocation. */
export function resolveAllowedRoots(
  cfg: JarvisConfig,
  options: Pick<SafePathOptions, "workspaceOverride" | "sessionGrants"> = {},
): string[] {
  const candidates = [
    options.workspaceOverride,
    effectiveWorkspaceRoot(cfg),
    ...(options.sessionGrants ?? []),
    ...(cfg.tools?.allowed_roots ?? []),
  ];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const normalized = resolve(platformPath(candidate));
    const key = rootKey(normalized);
    if (seen.has(key) || !existingDirectory(normalized)) continue;
    seen.add(key);
    roots.push(normalized);
  }
  return roots;
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

function outsideError(inputPath: string, cfg: JarvisConfig, roots: string[]): Error {
  return new Error(
    `Path "${inputPath}" is outside the workspace. Sandbox mode: ${cfg.tools.sandbox_mode}. ` +
    `Allowed roots: ${roots.length > 0 ? roots.join(", ") : "(none)"}`,
  );
}

function optionsFrom(third?: string | SafePathOptions): SafePathOptions {
  return typeof third === "string" ? { workspaceOverride: third } : (third ?? {});
}

/** Resolve a user path against the invocation's ordered allowed roots. */
export function safePath(
  inputPath: string,
  cfg: JarvisConfig,
  workspaceOrOptions?: string | SafePathOptions,
): string {
  const options = optionsFrom(workspaceOrOptions);
  const normalizedInput = platformPath(inputPath);

  if (cfg.tools.sandbox_mode === "off") return resolve(normalizedInput);

  const roots = resolveAllowedRoots(cfg, options);
  const inputIsAbsolute = absoluteLike(normalizedInput);
  if (inputIsAbsolute) {
    const candidate = resolve(normalizedInput);
    if (roots.some((root) => isContained(root, candidate))) return candidate;
    if (cfg.tools.sandbox_mode === "permissive") {
      console.log(`[Sandbox] Permissive mode: allowing access to "${candidate}" (outside allowed roots: ${roots.join(", ") || "none"})`);
      return candidate;
    }
    throw outsideError(inputPath, cfg, roots);
  }

  for (const root of roots) {
    const segments = normalizedInput.split(/[\\/]+/).filter(Boolean);
    if (segments.length > 1 && pathSegmentsEqual(basename(root), segments[0])) {
      const deduplicated = resolve(root, ...segments.slice(1));
      if (isContained(root, deduplicated) && existsSync(deduplicated)) return deduplicated;
    }

    const candidate = resolve(root, normalizedInput);
    if (!isContained(root, candidate)) continue;
    if (options.forWrite ? existingDirectory(dirname(candidate)) : existsSync(candidate)) return candidate;
  }

  if (roots.length > 0) {
    const fallback = resolve(roots[0], normalizedInput);
    if (isContained(roots[0], fallback)) return fallback;
  }

  const permissiveBase = roots[0] ?? resolve(platformPath(effectiveWorkspaceRoot(cfg)));
  const permissiveCandidate = resolve(permissiveBase, normalizedInput);
  if (cfg.tools.sandbox_mode === "permissive") {
    console.log(`[Sandbox] Permissive mode: allowing access to "${permissiveCandidate}" (outside allowed roots: ${roots.join(", ") || "none"})`);
    return permissiveCandidate;
  }
  throw outsideError(inputPath, cfg, roots);
}
