import { posix, win32 } from "path";
import { normalizePathInput } from "../fs-scope";

export interface PathIdentityOptions {
  workspaceRoot?: string;
  platform?: NodeJS.Platform;
}

function normalizeSeparators(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.replace(/\//g, "\\") : value.replace(/\\/g, "/");
}

function trimTrailingSeparators(value: string, platform: NodeJS.Platform): string {
  if (value.length <= 1) return value;
  const trimmed = value.replace(/[\\/]+$/, "");
  if (trimmed.length > 0) return trimmed;
  return platform === "win32" ? value.match(/^[a-z]:[\\/]/i)?.[0] ?? value : "/";
}

export function resolveWorkspacePathIdentity(
  pathValue: string,
  options: PathIdentityOptions = {},
): string | undefined {
  const trimmed = pathValue.trim();
  if (!trimmed) return undefined;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const rootInput = options.workspaceRoot?.trim() || ".";
  const root = normalizeSeparators(normalizePathInput(rootInput, platform), platform);
  const candidate = normalizeSeparators(normalizePathInput(trimmed, platform), platform);
  const resolved = pathApi.isAbsolute(candidate)
    ? pathApi.normalize(candidate)
    : pathApi.resolve(root, candidate);
  const normalized = trimTrailingSeparators(pathApi.normalize(resolved), platform);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathsHaveSameIdentity(
  left: string,
  right: string,
  options: PathIdentityOptions = {},
): boolean {
  const leftIdentity = resolveWorkspacePathIdentity(left, options);
  const rightIdentity = resolveWorkspacePathIdentity(right, options);
  return leftIdentity !== undefined && leftIdentity === rightIdentity;
}
