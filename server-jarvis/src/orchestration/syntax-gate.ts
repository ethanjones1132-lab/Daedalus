// ═══════════════════════════════════════════════════════════════
// ── Post-write syntax gate ──
// ═══════════════════════════════════════════════════════════════
// The 2026-07-21 benchmark showed weak models doing surgical edit_file edits
// corrupt simple fixes: an is_leap_year edit left an orphaned token
// (`... == 0) rule`) that shipped as a SyntaxError, and a no-op edit left the
// file unchanged — both because nothing verified the WRITTEN file actually
// parses. This gate parse-checks the files a stage wrote so a broken write is a
// real, catchable failure instead of a shipped bug. It drives the review/repair
// loop deterministically (see runReviewerRewriterLoop) rather than hoping the
// reviewer model notices.
//
// Safety-first: only languages with a reliable, no-false-positive syntax check
// are gated (Python via py_compile today). Unsupported extensions and an
// unavailable checker return "cannot determine" — never a false failure that
// would break a legitimate turn.

import { execFile } from "child_process";
import { existsSync } from "fs";
import { extname } from "path";
import type { ToolCallRecord } from "./stage-output";

const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

export interface SyntaxIssue {
  path: string;
  error: string;
}

/** A checker returns an error string (syntax invalid), or null (valid / cannot determine). */
export type SyntaxChecker = (path: string) => Promise<string | null>;

/**
 * Absolute/whatever paths a stage's tool calls wrote to, deduped, filtered to
 * extensions we can check. Pure — no I/O — so it is trivially testable.
 */
export function writtenCodePaths(
  toolCalls: readonly ToolCallRecord[] | undefined,
  supported: ReadonlySet<string> = new Set(DEFAULT_CHECKERS.keys()),
): string[] {
  const seen = new Set<string>();
  for (const call of toolCalls ?? []) {
    if (call.is_error) continue;
    if (!WRITE_TOOL_NAMES.has(call.name)) continue;
    const path = typeof call.arguments?.path === "string" ? call.arguments.path : "";
    if (!path) continue;
    if (!supported.has(extname(path).toLowerCase())) continue;
    seen.add(path);
  }
  return [...seen];
}

/** Default per-extension checkers. Spawn a real parser; fail-open on tool absence. */
export const DEFAULT_CHECKERS = new Map<string, SyntaxChecker>([
  [".py", pythonSyntaxCheck],
]);

function runSyntaxCommand(program: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(program, args, { timeout: 10_000, windowsHide: true }, (err, _stdout, stderr) => {
      if (!err) return resolve(null); // parsed clean
      // ENOENT / spawn failure → checker unavailable → cannot determine (fail-open).
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return resolve(null);
      const detail = (stderr || err.message || "").trim();
      // A non-zero exit with no diagnostic is treated as "cannot determine".
      resolve(detail ? detail.split("\n").slice(-4).join("\n").slice(0, 400) : null);
    });
  });
}

/** py_compile is a pure-parse check (no execution). Tries `python`, then `py`. */
export async function pythonSyntaxCheck(path: string): Promise<string | null> {
  const first = await runSyntaxCommand("python", ["-m", "py_compile", path]);
  if (first === null) {
    // `python` may be absent on Windows where the launcher is `py`; retry once.
    return runSyntaxCommand("py", ["-m", "py_compile", path]);
  }
  return first;
}

/**
 * Parse-check every written file we can. Missing files and unavailable checkers
 * are skipped (fail-open). Returns only confirmed syntax errors.
 */
export async function checkWrittenFilesSyntax(
  toolCalls: readonly ToolCallRecord[] | undefined,
  opts: { checkers?: Map<string, SyntaxChecker>; exists?: (p: string) => boolean } = {},
): Promise<SyntaxIssue[]> {
  const checkers = opts.checkers ?? DEFAULT_CHECKERS;
  const exists = opts.exists ?? existsSync;
  const issues: SyntaxIssue[] = [];
  for (const path of writtenCodePaths(toolCalls, new Set(checkers.keys()))) {
    if (!exists(path)) continue;
    const checker = checkers.get(extname(path).toLowerCase());
    if (!checker) continue;
    const error = await checker(path);
    if (error) issues.push({ path, error });
  }
  return issues;
}

/** Render syntax issues as reviewer feedback that forces (and guides) a repair. */
export function renderSyntaxIssues(issues: readonly SyntaxIssue[]): string {
  if (issues.length === 0) return "";
  const lines = issues.map((i) => `- \`${i.path}\` does not parse:\n${i.error}`);
  return (
    "REJECT — a written file has a SYNTAX ERROR and must be fixed before it can ship. " +
    "Rewrite the whole affected file cleanly (do not attempt a surgical edit):\n" +
    lines.join("\n")
  );
}
