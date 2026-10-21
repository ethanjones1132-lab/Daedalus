// ═══════════════════════════════════════════════════════════════
// Pre-flight tool checks — reject doomed calls before they run
// ═══════════════════════════════════════════════════════════════
// Runs inside ToolRuntime.execute(), after required-argument validation and
// before permission policy. Catches the failure modes that are obvious from
// the arguments alone: invented paths, placeholder URLs, reads of files that
// do not exist, edits that change nothing.
//
// Every block returns repair text addressed to the model. A block that only
// says "no" costs the same round trip it was meant to save.
//
// Conservative by design: when a check cannot decide, it allows. A false
// block is worse than a false allow, because the tool would have reported
// the real error anyway. The only I/O is a synchronous existence probe; no
// network, no handler execution, no new dependency.

import { existsSync } from "fs";
import { isAbsolute, resolve } from "path";
import type { ToolCall } from "./tool-types";

export interface PreflightContext {
  /** Workspace root used to resolve relative paths. */
  workspacePath?: string;
}

export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: string; repair: string };

/**
 * Shapes that only appear when a model invented an argument instead of
 * looking one up. Kept deliberately narrow: a pattern that fires on a real
 * path is a false block, and a false block is worse than a false allow.
 */
const PLACEHOLDER_PATTERNS = [
  /path\/to\//i,
  /your[-_/]?(?:file|project|path|page|repo)/i,
  /<[^>]+>/,
  /\{\{.+\}\}/,
  // `TODO` as a whole path segment, not as a filename stem: `docs/TODO.md` is
  // a real documentation file, while a bare `TODO` or `TODO/src` is a stub.
  /(?:^|[\\/])TODO(?:[\\/]|$)/,
];

function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((p) => p.test(value));
}

/**
 * Absolute paths resolve as-is. Relative paths need a workspace root: without
 * one they would silently resolve against the process cwd, which is not the
 * directory the call meant. That is undecidable here, so the caller allows.
 */
function resolveInWorkspace(path: string, workspacePath?: string): string | undefined {
  if (isAbsolute(path)) return path;
  return workspacePath ? resolve(workspacePath, path) : undefined;
}

/** Tools whose `path` argument must already exist for the call to succeed. */
const MUST_EXIST = new Set(["read_file", "edit_file", "multi_edit", "apply_patch"]);

/** Arguments that carry a filesystem path, in priority order. */
const PATH_KEYS = ["path", "file_path", "relative_workspace_path"];

function firstStringArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * Query-bearing tools and the argument that carries the query. A value that is
 * present but not a string is left alone: a schema mismatch is the tool's
 * problem, not evidence that the search was empty.
 */
const QUERY_KEYS: Record<string, string> = {
  web_search: "query",
  grep: "pattern",
};

function isEmptyQuery(name: string, args: Record<string, unknown>): boolean {
  const key = QUERY_KEYS[name];
  if (!key) return false;
  const value = args[key];
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.trim().length === 0;
}

export function preflightCheck(call: ToolCall, ctx: PreflightContext): PreflightResult {
  const args = call.arguments ?? {};

  // ── Placeholder path ──────────────────────────────────────────────────
  const path = firstStringArg(args, PATH_KEYS);
  if (path && looksLikePlaceholder(path)) {
    return {
      ok: false,
      reason: `The path "${path}" looks like a placeholder, not a real file.`,
      repair: `Replace it with an actual path from this workspace. Use list_dir or grep to find the real one, then call ${call.name} again.`,
    };
  }

  // ── Placeholder URL ───────────────────────────────────────────────────
  const url = firstStringArg(args, ["url"]);
  if (url && looksLikePlaceholder(url)) {
    return {
      ok: false,
      reason: `The URL "${url}" contains a placeholder.`,
      repair: `Supply a complete, real URL. If you do not have one, search for the page first instead of guessing.`,
    };
  }

  // ── Read/edit of a file that is not there ─────────────────────────────
  if (path && MUST_EXIST.has(call.name)) {
    const resolved = resolveInWorkspace(path, ctx.workspacePath);
    if (resolved !== undefined && !existsSync(resolved)) {
      return {
        ok: false,
        reason: `${call.name} target does not exist: ${path}`,
        repair: `Confirm the path before acting on it — list_dir on the parent directory, or grep for the filename. If you meant to create this file, use write_file instead.`,
      };
    }
  }

  // ── Edit that changes nothing ─────────────────────────────────────────
  if (call.name === "edit_file") {
    const oldStr = args.old_string;
    const newStr = args.new_string;
    if (typeof oldStr === "string" && typeof newStr === "string" && oldStr === newStr) {
      return {
        ok: false,
        reason: `edit_file was called with identical old_string and new_string — this edit would change nothing.`,
        repair: `Set new_string to the text you actually want in the file. If no change is needed here, skip the edit and move on.`,
      };
    }
  }

  // ── Empty search ──────────────────────────────────────────────────────
  if (isEmptyQuery(call.name, args)) {
    return {
      ok: false,
      reason: `${call.name} was called with an empty query.`,
      repair: `Provide specific search terms describing what you are looking for.`,
    };
  }

  return { ok: true };
}
