/**
 * Phase A2 — Exact-text edit contract.
 *
 * Before (or while) applying edit_file / multi_edit, verify old_string against
 * real file content and repair locally when the model reproduced the right
 * code with drifted whitespace, line endings, or a pasted read_file gutter.
 * No model call — in-process only.
 */

import { applyEditMatch, locateEditMatch } from "./edit-match";

/** Strip the `    42 | ` gutter that read_file emits (models paste it into edits). */
export function stripLineNumberGutter(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+ \| /, ""))
    .join("\n");
}

export type EditRepairResult =
  | {
    ok: true;
    old_string: string;
    new_string: string;
    /** True when old_string was rewritten to the exact on-disk span. */
    repaired: boolean;
    /** How the match was obtained. */
    matchKind: "exact" | "gutter" | "tolerant";
    note?: string;
  }
  | {
    ok: false;
    reason: "not_found" | "ambiguous" | "noop" | "empty_old";
  };

/**
 * Resolve an edit pair against live file content.
 * On success, `old_string` is the exact substring of `content` to replace
 * (so a subsequent exact replace cannot miss).
 */
export function repairEditPair(
  content: string,
  oldString: string,
  newString: string,
): EditRepairResult {
  if (typeof oldString !== "string" || oldString.length === 0) {
    return { ok: false, reason: "empty_old" };
  }
  if (typeof newString !== "string") {
    return { ok: false, reason: "not_found" };
  }

  // 1) Exact unique match.
  const exact = locateEditMatch(content, oldString);
  if (exact.kind === "match" && !exact.tolerant) {
    const exactOld = content.slice(exact.start, exact.end);
    if (exactOld === newString) return { ok: false, reason: "noop" };
    return {
      ok: true,
      old_string: exactOld,
      new_string: newString,
      repaired: exactOld !== oldString,
      matchKind: "exact",
    };
  }
  if (exact.kind === "ambiguous") {
    return { ok: false, reason: "ambiguous" };
  }

  // 2) Gutter-stripped exact match (read_file "    42 | code" paste).
  const strippedOld = stripLineNumberGutter(oldString);
  if (strippedOld !== oldString) {
    const gutterMatch = locateEditMatch(content, strippedOld);
    if (gutterMatch.kind === "match") {
      const exactOld = content.slice(gutterMatch.start, gutterMatch.end);
      const strippedNew = stripLineNumberGutter(newString);
      if (exactOld === strippedNew) return { ok: false, reason: "noop" };
      return {
        ok: true,
        old_string: exactOld,
        new_string: strippedNew,
        repaired: true,
        matchKind: "gutter",
        note: "stripped read_file line-number gutter from edit strings",
      };
    }
    if (gutterMatch.kind === "ambiguous") {
      return { ok: false, reason: "ambiguous" };
    }
  }

  // 3) Whitespace-tolerant unique match (already attempted if exact was not_found
  // with the original needle; locateEditMatch includes tolerant path).
  // If exact.kind was match+tolerant, handle here; if not_found, try stripped needle.
  if (exact.kind === "match" && exact.tolerant) {
    const exactOld = content.slice(exact.start, exact.end);
    if (exactOld === newString) return { ok: false, reason: "noop" };
    return {
      ok: true,
      old_string: exactOld,
      new_string: newString,
      repaired: true,
      matchKind: "tolerant",
      note: "whitespace-tolerant old_string repair",
    };
  }

  if (strippedOld !== oldString) {
    // Already tried above for gutter exact/tolerant via locateEditMatch(strippedOld)
  }

  return { ok: false, reason: "not_found" };
}

/** Apply a successful repair as a content rewrite. */
export function applyRepairedEdit(
  content: string,
  repair: Extract<EditRepairResult, { ok: true }>,
): string {
  const match = locateEditMatch(content, repair.old_string);
  if (match.kind !== "match") {
    // Should not happen — repair.old_string is an exact slice of content.
    const idx = content.indexOf(repair.old_string);
    if (idx < 0) return content;
    return content.slice(0, idx) + repair.new_string + content.slice(idx + repair.old_string.length);
  }
  return applyEditMatch(content, match, repair.new_string);
}

export interface MultiEditRepairItem {
  old_string: string;
  new_string: string;
  repaired: boolean;
  matchKind?: "exact" | "gutter" | "tolerant";
  skipped?: "not_found" | "ambiguous" | "noop" | "empty_old";
}

/**
 * Repair a multi_edit list against rolling content (each successful edit
 * advances content so subsequent needles match post-edit state).
 */
export function repairMultiEditPairs(
  content: string,
  edits: Array<{ old_string: string; new_string: string }>,
): { content: string; items: MultiEditRepairItem[]; applied: number } {
  let rolling = content;
  const items: MultiEditRepairItem[] = [];
  let applied = 0;
  for (const edit of edits) {
    const repair = repairEditPair(rolling, edit.old_string, edit.new_string);
    if (!repair.ok) {
      items.push({
        old_string: edit.old_string,
        new_string: edit.new_string,
        repaired: false,
        skipped: repair.reason,
      });
      continue;
    }
    rolling = applyRepairedEdit(rolling, repair);
    applied += 1;
    items.push({
      old_string: repair.old_string,
      new_string: repair.new_string,
      repaired: repair.repaired,
      matchKind: repair.matchKind,
    });
  }
  return { content: rolling, items, applied };
}
