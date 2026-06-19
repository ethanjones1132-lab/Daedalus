// ═══════════════════════════════════════════════════════════════
// ── Filesystem Path Scope ──
// ═══════════════════════════════════════════════════════════════
// Centralized path normalization and workspace scoping for all filesystem
// tools. This is the single place where WSL <-> Windows path conversion and
// sandbox boundary checks live.

import { posix } from "path";
import type { JarvisConfig } from "./config";

const { resolve, relative, isAbsolute } = posix;

/** Convert a Windows or WSL-UNC path into a POSIX-style WSL path. */
export function toWslPath(inputPath: string): string {
  let normalized = inputPath.replace(/\\/g, "/");

  // 1. WSL UNC paths: \\wsl.localhost\Distro\home\... or \\wsl$\Distro\...
  for (const prefix of ["//wsl.localhost/", "//wsl$/"]) {
    if (normalized.startsWith(prefix)) {
      const parts = normalized.slice(prefix.length).split("/");
      return "/" + parts.slice(1).join("/");
    }
  }

  // 2. Windows drive-letter paths: C:/Users/...
  const driveMatch = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    return `/mnt/${drive}/${driveMatch[2]}`;
  }

  // 3. Already POSIX
  return normalized;
}

/**
 * Convert a POSIX WSL path back to a native Windows path when running on
 * Windows. This lets filesystem tools do real I/O on the Windows host while
 * still reasoning about paths in WSL terms internally.
 *
 * Examples:
 *   "/mnt/c/Users/ethan/x" -> "C:/Users/ethan/x"
 *   "/home/ethan/x"        -> "//wsl.localhost/Ubuntu/home/ethan/x"
 */
export function fromWslPath(wslPath: string): string {
  if (process.platform !== "win32") return wslPath;

  const normalized = wslPath.replace(/\\/g, "/");

  const mntMatch = normalized.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mntMatch) {
    return `${mntMatch[1].toUpperCase()}:/${mntMatch[2]}`;
  }

  const distro = process.env.WSL_DISTRO_NAME || "Ubuntu";
  return `//wsl.localhost/${distro}${normalized}`;
}

/**
 * Resolve a user-supplied path relative to the workspace and enforce sandbox
 * boundaries.
 *
 * - `sandbox_mode === "off"`: any absolute path is allowed.
 * - Otherwise: relative paths resolve against the workspace root, and paths
 *   escaping the workspace throw.
 *
 * Uses POSIX resolution because Jarvis paths are WSL-centric.
 */
export function safePath(inputPath: string, cfg: JarvisConfig): string {
  const sandboxMode = cfg.tools.sandbox_mode;
  const wslPath = toWslPath(inputPath);

  if (sandboxMode === "off") {
    return resolve(wslPath);
  }

  const workspace = resolve(toWslPath(cfg.jarvis_path && cfg.jarvis_path.trim() ? cfg.jarvis_path : process.cwd()));
  const resolved = isAbsolute(wslPath) ? resolve(wslPath) : resolve(workspace, wslPath);
  const rel = relative(workspace, resolved);

  if (sandboxMode === "permissive") {
    if (rel.startsWith("..") || isAbsolute(rel)) {
      console.log(`[Sandbox] Permissive mode: allowing access to "${resolved}" (outside workspace)`);
    }
    return resolved;
  }

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Path "${inputPath}" is outside the workspace. Sandbox mode: ${sandboxMode}`,
    );
  }

  return resolved;
}
