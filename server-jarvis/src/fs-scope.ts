// ═══════════════════════════════════════════════════════════════
// ── Filesystem path scoping ──
// ═══════════════════════════════════════════════════════════════
// Windows↔WSL path translation plus workspace sandbox enforcement, shared by
// every filesystem tool. Ported verbatim from the legacy tools.ts so behaviour
// (and the chat model's expectations) are preserved exactly.

import { resolve, relative } from "path";
import type { JarvisConfig } from "./config";

/**
 * Translate a Windows-style path into its WSL equivalent.
 * Handles `\\wsl.localhost\<distro>\...` / `\\wsl$\<distro>\...` UNC paths and
 * `C:\...` drive paths. POSIX paths pass through unchanged.
 */
export function toWslPath(inputPath: string): string {
  let normalized = inputPath.replace(/\\/g, "/");

  // 1. Handle WSL UNC path: \\wsl.localhost\Ubuntu\home\... or \\wsl$\Ubuntu\home\...
  for (const prefix of ["//wsl.localhost/", "//wsl$/"]) {
    if (normalized.startsWith(prefix)) {
      const parts = normalized.slice(prefix.length).split("/");
      return "/" + parts.slice(1).join("/");
    }
  }

  // 2. Handle Windows absolute path with drive letter: C:/Users/ethan/...
  const driveMatch = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const subPath = driveMatch[2];
    return `/mnt/${drive}/${subPath}`;
  }

  return normalized;
}

/**
 * Resolve a user-supplied path within the workspace sandbox.
 * Throws if the resolved path escapes the workspace, unless sandbox_mode is "off".
 */
export function safePath(inputPath: string, cfg: JarvisConfig): string {
  // Only translate Windows paths to WSL when actually running in a posix
  // environment. The production Bun server runs inside WSL (linux), where
  // C:\ -> /mnt/c is needed; on a native Windows host the input is already
  // accessible as-is and translating it would break the path.
  const wslPath = process.platform === "win32" ? inputPath : toWslPath(inputPath);
  if (cfg.tools.sandbox_mode === "off") return resolve(wslPath);
  const workspace = cfg.jarvis_path || process.cwd();
  const resolved = resolve(workspace, wslPath);
  const rel = relative(workspace, resolved);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Path "${inputPath}" is outside the workspace. Sandbox mode: ${cfg.tools.sandbox_mode}`);
  }
  return resolved;
}
