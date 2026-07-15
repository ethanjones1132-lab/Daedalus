// server-jarvis/src/orchestration/evidence-sufficiency.ts
// ═══════════════════════════════════════════════════════════════
// Replaces the boolean workspace-evidence fence. 2026-07-12 incident: one
// successful top-level list_directory satisfied hasSuccessfulWorkspaceEvidence,
// so a "comprehensively diagnose this repo" turn was treated as grounded with
// zero file contents read. Sufficiency now scales with request depth.
//
// Plan reference:
//   docs/superpowers/plans/2026-07-12-comprehensive-performance-improvement.md
//   Phase 2 — Executor accuracy, Task 2.1
//
// 2026-07-13 live-benchmark finding: the deep-read floor originally counted
// `git_metadata` as a "content read" alongside `read_file`/`grep`. A live
// deep-read turn against a fixture with exactly one real file satisfied the
// floor by calling `read_file` once plus `git_metadata` twice — git_metadata
// reads repo HEAD/branch/dirty state, not file contents, and reveals nothing
// about the thing being "comprehensively diagnosed". `git_metadata` still
// counts for SHALLOW requests (a bare "what's the git sha" turn should pass
// on one such call — that's the whole point of the deterministic git
// preflight in pipeline.ts), but it must never satisfy the deep-read floor.
// The floor also now counts DISTINCT (tool, arguments) targets rather than
// raw call count, so re-reading the same file repeatedly can't game it either.
// ═══════════════════════════════════════════════════════════════

import { isDuplicateToolDeflection, type ToolCallRecord } from "./stage-output";
import { hasWorkspaceSignal, hasWriteIntent, type TurnRequirement } from "./turn-requirements";

const DEEP_READ_MARKERS =
  /\b(comprehensiv\w*|thorough\w*|entire|whole|all files|full|in[- ]depth|architecture|architectural|audit|diagnos\w*|repo|repository|codebase)\b/i;
/** Genuine file-content tools — the only ones that count toward the deep-read floor. */
const DEEP_READ_CONTENT_TOOLS = new Set(["read_file", "grep"]);
/** Broader shallow-evidence set: file content OR repo metadata satisfies a shallow turn. */
const SHALLOW_EVIDENCE_TOOLS = new Set(["read_file", "grep", "git_metadata"]);
const LISTING_TOOLS = new Set(["list_directory", "glob"]);

/** Distinct (tool, arguments) key so re-calling the same read repeatedly counts once. */
function distinctTargetKeys(calls: ToolCallRecord[], tools: Set<string>): Set<string> {
  const keys = new Set<string>();
  for (const call of calls) {
    if (tools.has(call.name)) keys.add(`${call.name}:${JSON.stringify(call.arguments)}`);
  }
  return keys;
}

/**
 * Deep-read requests (e.g. "comprehensively diagnose this repo") require at
 * least this many content-bearing tool results before the runtime will allow
 * synthesis. A lone `list_directory` is no longer sufficient.
 *
 * The constant is exported so the 6 unit tests in `evidence-sufficiency.test.ts`
 * can pin the floor at 3, and the wire-up in `pipeline.ts` (the post-loop
 * fence and the nudge message) can reference the same value.
 */
export const DEEP_READ_MIN_CONTENT_READS = 3;

export interface EvidenceAssessment {
  sufficient: boolean;
  contentReads: number;
  listings: number;
  deepRead: boolean;
  reason: string;
}

/**
 * Classify the raw user request as "deep" (e.g. "comprehensively diagnose
 * this repo") or shallow (e.g. "what version is in package.json?"). Deep
 * requests demand more workspace evidence before the runtime will let the
 * synthesizer fabricate repo claims.
 */
export function isDeepReadRequest(request: string): boolean {
  return DEEP_READ_MARKERS.test(request);
}

export function turnNeedsWorkspaceEvidence(
  requirement: TurnRequirement | undefined,
  intentText: string,
): boolean {
  if (requirement === "workspace_read") return true;
  if (requirement !== "full_execution") return false;
  if (hasWriteIntent(intentText)) return false;
  return isDeepReadRequest(intentText) || hasWorkspaceSignal(intentText);
}

/**
 * Decide whether the workspace tool calls the executor has produced so far
 * are enough to let synthesis proceed. Sufficiency scales with request depth
 * so a single `list_directory` can no longer pass a "comprehensively diagnose
 * this repo" turn.
 */
export function assessWorkspaceEvidence(
  toolCalls: ToolCallRecord[] | undefined,
  request: string,
): EvidenceAssessment {
  const calls = (toolCalls ?? []).filter(
    (c) => !c.is_error && c.output.trim().length > 0 && !isDuplicateToolDeflection(c),
  );
  const listings = calls.filter((c) => LISTING_TOOLS.has(c.name)).length;
  const deepRead = isDeepReadRequest(request);

  if (deepRead) {
    // Deep-read floor: only genuine file-content reads count, deduped by
    // (tool, arguments) so reading the same file 3 times can't fake it.
    const distinctContentReads = distinctTargetKeys(calls, DEEP_READ_CONTENT_TOOLS).size;
    const sufficient = distinctContentReads >= DEEP_READ_MIN_CONTENT_READS;
    return {
      sufficient,
      contentReads: distinctContentReads,
      listings,
      deepRead,
      reason: sufficient
        ? `deep read satisfied: ${distinctContentReads} distinct content reads`
        : `deep-read request needs >=${DEEP_READ_MIN_CONTENT_READS} distinct content reads (read_file/grep on different targets); got ${distinctContentReads} and ${listings} list_directory/glob calls`,
    };
  }
  // Shallow floor: any single real read (file content, repo metadata, or a
  // listing) is enough — this is the path the git/SHA preflight satisfies.
  const shallowEvidenceCount = calls.filter((c) => SHALLOW_EVIDENCE_TOOLS.has(c.name)).length;
  const sufficient = shallowEvidenceCount + listings >= 1;
  return {
    sufficient,
    contentReads: shallowEvidenceCount,
    listings,
    deepRead,
    reason: sufficient
      ? "shallow read satisfied"
      : "no successful workspace tool result",
  };
}

export interface EvidenceFailure {
  code: "missing_workspace_evidence" | "insufficient_workspace_evidence";
  message: string;
}

/**
 * Typed failure for an insufficient-evidence turn (Task 2.5). Distinguishes
 * "nothing was read at all" from "something was read but not enough for the
 * request's depth", and gives the user an actionable next step instead of a
 * synthesized apology. The message must NEVER script the user's next message
 * verbatim — the 2026-07-12 incident loop was manufactured by the assistant
 * telling the user exactly what to re-send.
 */
export function evidenceFailure(assessment: EvidenceAssessment): EvidenceFailure {
  if (assessment.contentReads + assessment.listings === 0) {
    return {
      code: "missing_workspace_evidence",
      message:
        "Workspace inspection failed: no successful workspace read tool result was produced, so Jarvis will not synthesize repository claims from ungrounded model text.",
    };
  }
  return {
    code: "insufficient_workspace_evidence",
    message:
      `I could not gather enough evidence to answer this (${assessment.reason}). ` +
      "Name a specific file or directory to start from, or say 'force deep read' to retry with extended budgets.",
  };
}
