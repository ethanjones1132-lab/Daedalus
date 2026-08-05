/**
 * Phase A3 — Local pre-flight verification of proposed writes.
 *
 * Before a write lands, check ground truth: path shape, old_string present
 * (via A2 repair), read-before-edit, and fabricated symbols that A1 already
 * proved absent from the project. Pure — no model call, no I/O (callers supply
 * file content / flags).
 */

import { repairEditPair, repairMultiEditPairs, type EditRepairResult } from "./edit-contract";
import { extractGroundingIdentifiers } from "./orchestration/symbol-grounding";

export const WRITE_EFFECT_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
]);

export type WritePreflightCode =
  | "ok"
  | "not_a_write"
  | "path_missing"
  | "path_out_of_scope"
  | "not_read"
  | "file_unreadable"
  | "old_string_missing"
  | "old_string_ambiguous"
  | "edit_noop"
  | "multi_edit_empty"
  | "fabricated_symbol"
  | "patch_empty";

export interface WritePreflightRepair {
  /** Mutated tool arguments safe to dispatch. */
  arguments: Record<string, unknown>;
  notes: string[];
}

export interface WritePreflightResult {
  allow: boolean;
  code: WritePreflightCode;
  reason: string;
  /** When allow && repairs applied, use these arguments instead of the model’s. */
  repair?: WritePreflightRepair;
  /** Fabricated symbols blocked (when code === fabricated_symbol). */
  fabricated?: string[];
}

export interface WritePreflightContext {
  /** Live file text when the target exists; omit for create-only write_file. */
  fileContent?: string | null;
  /** Path resolved and confirmed inside allowed roots. */
  pathInScope: boolean;
  /** Read-before-edit ledger for this resolved path. */
  hasBeenRead?: boolean;
  /**
   * Symbols A1 grepped and confirmed NOT FOUND in project source.
   * Proposed write content must not introduce them.
   */
  missingSymbols?: Iterable<string>;
  /**
   * Symbols the task explicitly asked to create (may_create). Exact-name only.
   * These are exempt from the fabricated-symbol block even if missing.
   */
  allowedNewSymbols?: Iterable<string>;
  /** When true, skip fabricated-symbol block (e.g. docs-only tasks). Default false. */
  allowFabricatedSymbols?: boolean;
}

function toolPath(args: Record<string, unknown>): string | undefined {
  const p = args.path ?? args.file_path;
  return typeof p === "string" && p.trim() ? p : undefined;
}

function proposedText(name: string, args: Record<string, unknown>): string {
  if (name === "write_file" && typeof args.content === "string") return args.content;
  if (name === "edit_file" && typeof args.new_string === "string") return args.new_string;
  if (name === "multi_edit" && Array.isArray(args.edits)) {
    return (args.edits as Array<{ new_string?: string }>)
      .map((e) => e?.new_string ?? "")
      .join("\n");
  }
  if (name === "apply_patch" && typeof args.patch === "string") return args.patch;
  return "";
}

/**
 * Detect identifiers from A1's missing set that appear in proposed write text.
 * Requires a word-ish occurrence (not a substring of a longer token when possible).
 */
export function findFabricatedSymbolsInText(
  text: string,
  missingSymbols: Iterable<string>,
  allowedNewSymbols: Iterable<string> = [],
): string[] {
  if (!text) return [];
  const allowed = new Set(allowedNewSymbols);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const symbol of missingSymbols) {
    if (!symbol || seen.has(symbol)) continue;
    if (allowed.has(symbol)) continue; // exact-name may_create exemption
    // Prefer boundary-aware check for simple identifiers; for qualified names
    // (juce::isnan) a plain includes is enough and matches C++ call sites.
    const present = symbol.includes("::") || symbol.includes(".")
      ? text.includes(symbol)
      : new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
    if (present) {
      seen.add(symbol);
      found.push(symbol);
    }
  }
  return found;
}

/**
 * Pre-flight a write-effect tool call. Pure: no disk I/O.
 */
export function preflightWriteTool(
  name: string,
  args: Record<string, unknown>,
  ctx: WritePreflightContext,
): WritePreflightResult {
  if (!WRITE_EFFECT_TOOL_NAMES.has(name)) {
    return { allow: true, code: "not_a_write", reason: "not a write-effect tool" };
  }

  const path = toolPath(args);
  if (!path) {
    return {
      allow: false,
      code: "path_missing",
      reason: "Write tool is missing a path argument.",
    };
  }
  if (!ctx.pathInScope) {
    return {
      allow: false,
      code: "path_out_of_scope",
      reason: `Path is outside the allowed workspace scope: ${path}`,
    };
  }

  // Fabricated-symbol gate on proposed payload (A1 ↔ A3).
  if (!ctx.allowFabricatedSymbols && ctx.missingSymbols) {
    const text = proposedText(name, args);
    const fabricated = findFabricatedSymbolsInText(
      text,
      ctx.missingSymbols,
      ctx.allowedNewSymbols,
    );
    if (fabricated.length > 0) {
      return {
        allow: false,
        code: "fabricated_symbol",
        reason:
          `Proposed write references symbols not found in project source: ${fabricated.join(", ")}. ` +
          `Use only verified APIs (see Runtime grounding) or read the library before writing.`,
        fabricated,
      };
    }
  }

  if (name === "write_file") {
    // Create/overwrite: no old_string. Scope + fabrication already checked.
    return { allow: true, code: "ok", reason: "write_file preflight ok" };
  }

  if (name === "apply_patch") {
    if (typeof args.patch !== "string" || !args.patch.trim()) {
      return {
        allow: false,
        code: "patch_empty",
        reason: "apply_patch requires a non-empty patch.",
      };
    }
    if (ctx.hasBeenRead === false) {
      return {
        allow: false,
        code: "not_read",
        reason: `File "${path}" has not been read yet. Call read_file first, then apply the patch.`,
      };
    }
    return { allow: true, code: "ok", reason: "apply_patch preflight ok" };
  }

  // edit_file / multi_edit need content + read ledger.
  if (ctx.hasBeenRead === false) {
    return {
      allow: false,
      code: "not_read",
      reason: `File "${path}" has not been read yet. Call read_file first, then retry the edit with the exact content you see.`,
    };
  }
  if (ctx.fileContent == null) {
    return {
      allow: false,
      code: "file_unreadable",
      reason: `File not found or unreadable: ${path}`,
    };
  }

  if (name === "edit_file") {
    const oldStr = args.old_string as string;
    const newStr = args.new_string as string;
    const repair = repairEditPair(ctx.fileContent, oldStr, newStr);
    return mapEditRepair(path, args, repair);
  }

  if (name === "multi_edit") {
    const edits = args.edits as Array<{ old_string: string; new_string: string }> | undefined;
    if (!Array.isArray(edits) || edits.length === 0) {
      return {
        allow: false,
        code: "multi_edit_empty",
        reason: "multi_edit requires a non-empty edits array.",
      };
    }
    const { items, applied } = repairMultiEditPairs(ctx.fileContent, edits);
    if (applied === 0) {
      const reasons = new Set(items.map((i) => i.skipped).filter(Boolean));
      if (reasons.has("ambiguous")) {
        return {
          allow: false,
          code: "old_string_ambiguous",
          reason: `multi_edit: every edit skipped (ambiguous or missing old_string) on ${path}`,
        };
      }
      return {
        allow: false,
        code: "multi_edit_empty",
        reason: `multi_edit has no applicable edits — every requested edit was skipped: ${path}`,
      };
    }
    const notes: string[] = [];
    const repairedEdits = items
      .filter((i) => !i.skipped)
      .map((i) => {
        if (i.repaired && i.matchKind) {
          notes.push(`repaired old_string (${i.matchKind})`);
        }
        return { old_string: i.old_string, new_string: i.new_string };
      });
    // Keep original order of successful repairs only — handler still applies
    // against live content; we rewrite args so exact match succeeds.
    return {
      allow: true,
      code: "ok",
      reason: "multi_edit preflight ok",
      repair: notes.length
        ? { arguments: { ...args, edits: repairedEdits }, notes }
        : { arguments: { ...args, edits: repairedEdits }, notes: [] },
    };
  }

  return { allow: true, code: "ok", reason: "preflight ok" };
}

function mapEditRepair(
  path: string,
  args: Record<string, unknown>,
  repair: EditRepairResult,
): WritePreflightResult {
  if (!repair.ok) {
    if (repair.reason === "ambiguous") {
      return {
        allow: false,
        code: "old_string_ambiguous",
        reason: `Error: old_string appears multiple times in ${path}. Make it more specific.`,
      };
    }
    if (repair.reason === "noop") {
      return {
        allow: false,
        code: "edit_noop",
        reason: `edit is a no-op — old_string equals new_string: ${path}`,
      };
    }
    return {
      allow: false,
      code: "old_string_missing",
      reason:
        `Error: old_string not found in "${path}". The file content may have changed. ` +
        `Call read_file on "${path}" to see current content, then use the exact text for old_string ` +
        `WITHOUT the line-number gutter ("   42 | ").`,
    };
  }

  const notes: string[] = [];
  if (repair.repaired) {
    notes.push(repair.note ?? `repaired old_string (${repair.matchKind})`);
  }
  return {
    allow: true,
    code: "ok",
    reason: "edit_file preflight ok",
    repair: {
      arguments: {
        ...args,
        old_string: repair.old_string,
        new_string: repair.new_string,
      },
      notes,
    },
  };
}

/**
 * Convenience: extract candidate symbols from proposed text that look like
 * API identifiers (for diagnostics). Uses the same extractor as A1.
 */
export function extractProposedIdentifiers(text: string): string[] {
  return extractGroundingIdentifiers(text);
}
