// ─── Unified diff ────────────────────────────────────────────────────────────
// Produces a compact, UI-renderable diff for file-mutating tool calls
// (write_file / edit_file / multi_edit). The chat surface snapshots a file
// before and after a tool runs and emits this structure alongside the
// tool_result event so the user can see exactly what changed.

import { structuredPatch, applyPatch } from "diff";

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw patch lines, each prefixed with " " (context), "+" (add) or "-" (del). */
  lines: string[];
}

export interface UnifiedDiff {
  path: string;
  changed: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

/**
 * Compute a unified diff between `oldText` and `newText`.
 * `changed` is false when the contents are identical.
 */
export function buildUnifiedDiff(oldText: string, newText: string, path: string): UnifiedDiff {
  // Context of 3 lines is the conventional default and keeps hunks readable.
  const patch = structuredPatch(path, path, oldText ?? "", newText ?? "", "", "", { context: 3 });

  let additions = 0;
  let deletions = 0;
  const hunks: DiffHunk[] = patch.hunks.map((h) => {
    for (const line of h.lines) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
    return {
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
    };
  });

  return {
    path,
    changed: additions > 0 || deletions > 0,
    additions,
    deletions,
    hunks,
  };
}

/**
 * Apply a unified-diff `patch` to `original`. Returns `{ ok: true, content }`
 * when the patch applies cleanly, or `{ ok: false }` when the context does not
 * match (or the patch is malformed). Never throws.
 */
export function applyUnifiedPatch(
  original: string,
  patch: string,
): { ok: boolean; content?: string } {
  try {
    const result = applyPatch(original ?? "", patch);
    if (result === false) return { ok: false };
    return { ok: true, content: result };
  } catch {
    return { ok: false };
  }
}
