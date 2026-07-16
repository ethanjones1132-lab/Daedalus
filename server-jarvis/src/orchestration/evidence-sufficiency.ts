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
// The floor also now counts DISTINCT source-file targets rather than raw call
// count, so re-reading the same file or grepping it with new patterns can't
// game it either.
// ═══════════════════════════════════════════════════════════════

import { isDuplicateToolDeflection, type ToolCallRecord } from "./stage-output";
import { hasWorkspaceSignal, hasWriteIntent, type TurnRequirement } from "./turn-requirements";

const DEEP_READ_MARKERS =
  /\b(comprehensiv\w*|thorough\w*|entire|whole|all files|full|in[- ]depth|deep\s+reads?|architecture|architectural|audit|diagnos\w*|repo|repository|codebase)\b/i;
/** Genuine file-content tools — the only ones that count toward the deep-read floor. */
const DEEP_READ_CONTENT_TOOLS = new Set(["read_file", "grep"]);
const SOURCE_FILE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".cs", ".css", ".dart", ".ex", ".exs", ".go", ".h", ".hpp",
  ".hs", ".html", ".java", ".js", ".jsx", ".kts", ".kt", ".lua", ".mjs", ".php", ".pl", ".ps1",
  ".py", ".rb", ".rs", ".scala", ".sh", ".sql", ".svelte", ".swift", ".ts", ".tsx", ".vue",
]);
/** Broader shallow-evidence set: file content OR repo metadata satisfies a shallow turn. */
const SHALLOW_EVIDENCE_TOOLS = new Set(["read_file", "grep", "git_metadata"]);
const LISTING_TOOLS = new Set(["list_directory", "glob"]);

/** Distinct tool-target key so re-calling the same read repeatedly counts once. */
function distinctTargetKeys(calls: ToolCallRecord[], tools: Set<string>): Set<string> {
  const keys = new Set<string>();
  for (const call of calls) {
    if (tools.has(call.name)) keys.add(`${call.name}:${JSON.stringify(call.arguments)}`);
  }
  return keys;
}

function normalizePath(rawPath: string): { path: string; absolute: boolean } {
  let slashPath = rawPath.replace(/\\/g, "/");
  const extendedPrefix = slashPath.match(/^\/\/\?\//);
  const absolute = Boolean(extendedPrefix) || /^\/?[a-z]:\//i.test(slashPath) || slashPath.startsWith("/");
  if (extendedPrefix) {
    slashPath = slashPath.slice(4);
    if (/^unc\//i.test(slashPath)) slashPath = `/${slashPath.slice(4)}`;
  } else if (/^\/[a-z]:\//i.test(slashPath)) {
    slashPath = slashPath.slice(1);
  }
  const prefix = /^[a-z]:\//i.test(slashPath)
    ? slashPath.slice(0, 3).toLowerCase()
    : slashPath.startsWith("/")
      ? "/"
      : "";
  const body = slashPath.slice(prefix.length);
  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") segments.pop();
      else if (!absolute) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  return { path: `${prefix}${segments.join("/")}`.toLowerCase(), absolute };
}

function sourceFileKey(rawPath: string, workspaceRoot?: string): string | undefined {
  const normalized = normalizePath(rawPath);
  let normalizedPath = normalized.path;
  let absolute = normalized.absolute;
  if (workspaceRoot) {
    const root = normalizePath(workspaceRoot);
    const rootPath = root.path.replace(/\/+$/, "");
    if (!absolute) {
      normalizedPath = normalizePath(`${rootPath}/${normalizedPath}`).path;
      absolute = true;
    }
    if (normalizedPath === rootPath || normalizedPath.startsWith(`${rootPath}/`)) {
      normalizedPath = normalizedPath.slice(rootPath.length).replace(/^\/+/, "");
      absolute = false;
    }
  }
  const basename = normalizedPath.split("/").pop()?.toLowerCase() ?? "";
  const extensionStart = basename.lastIndexOf(".");
  if (extensionStart <= 0 || !SOURCE_FILE_EXTENSIONS.has(basename.slice(extensionStart))) return undefined;
  return `${absolute ? "abs:" : "rel:"}${normalizedPath}`;
}

function grepOutputSourceFileKeys(call: ToolCallRecord, workspaceRoot?: string): Set<string> {
  const args = call.arguments as Record<string, unknown> | undefined;
  const grepPath = typeof args?.path === "string" ? args.path : undefined;
  const grepPathIsFile = grepPath ? sourceFileKey(grepPath, workspaceRoot) !== undefined : false;
  const normalizedGrepPath = grepPath ? normalizePath(grepPath).path.replace(/^\.\/+/, "") : "";
  const keys = new Set<string>();
  for (const rawLine of call.output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Grep/rg output begins with the matched file path and a line/column
    // location. Parse only that prefix; filenames mentioned in the matched
    // source text are evidence about content, not additional file reads.
    const location = line.match(/^(.*?):\d+(?::\d+)?(?::|$)/);
    const candidate = (location?.[1] ?? line.split(/\s+/)[0])
      .replace(/^[([{\"'`]+/g, "")
      .replace(/[,:;"'`]+$/g, "");
    const normalizedCandidate = normalizePath(candidate);
    const normalizedCandidatePath = normalizedCandidate.path.replace(/^\.\/+/, "");
    const candidateAlreadyUnderGrepPath = !normalizedGrepPath
      || normalizedCandidatePath === normalizedGrepPath
      || normalizedCandidatePath.startsWith(`${normalizedGrepPath}/`);
    const rawCandidate = grepPath
      && !grepPathIsFile
      && !normalizedCandidate.absolute
      && !candidateAlreadyUnderGrepPath
      && !/[?*]/.test(grepPath)
      ? `${grepPath.replace(/[\\/]+$/, "")}/${candidate}`
      : candidate;
    const key = sourceFileKey(rawCandidate, workspaceRoot);
    if (key) keys.add(key);
  }
  return keys;
}

function sourceContentTargetKeys(call: ToolCallRecord, workspaceRoot?: string): Set<string> {
  if (call.name === "read_file") {
    const args = call.arguments as Record<string, unknown> | undefined;
    const key = typeof args?.path === "string" ? sourceFileKey(args.path, workspaceRoot) : undefined;
    return key ? new Set([key]) : new Set();
  }
  return call.name === "grep" ? grepOutputSourceFileKeys(call, workspaceRoot) : new Set();
}

function distinctDeepReadTargetKeys(calls: ToolCallRecord[], workspaceRoot?: string): Set<string> {
  const paths = new Set<string>();
  for (const call of calls) {
    if (DEEP_READ_CONTENT_TOOLS.has(call.name)) {
      for (const key of sourceContentTargetKeys(call, workspaceRoot)) paths.add(key);
    }
  }
  return paths;
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
  workspaceRoot?: string,
): EvidenceAssessment {
  const calls = (toolCalls ?? []).filter(
    (c) => !c.is_error && c.output.trim().length > 0 && !isDuplicateToolDeflection(c),
  );
  const listings = calls.filter((c) => LISTING_TOOLS.has(c.name)).length;
  const deepRead = isDeepReadRequest(request);

  if (deepRead) {
    // Deep-read floor: only genuine file-content reads count, deduped by
    // (tool, arguments) so reading the same file 3 times can't fake it.
    const distinctContentReads = distinctDeepReadTargetKeys(calls, workspaceRoot).size;
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
  // F6: never script the user's next message (e.g. "say force deep read") and
  // never promise budgets the runtime does not grant on that phrase alone.
  return {
    code: "insufficient_workspace_evidence",
    message:
      `Workspace evidence was incomplete for the depth of this request (${assessment.reason}). ` +
      "The answer below is limited to what was actually read. Naming a specific file or directory will let me go deeper.",
  };
}
