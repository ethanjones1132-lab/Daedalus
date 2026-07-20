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

import { existsSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
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

const SHELL_TOOLS = new Set(["bash", "shell", "run_background_command"]);
const NETWORK_TOOLS = new Set(["web_fetch", "web_search"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

/**
 * A user-authored least-authority contract. Unlike the depth heuristic, this
 * is a hard allowlist: broad words such as "audit" never widen an explicit
 * "read only README.md" instruction.
 */
export interface WorkspaceReadScope {
  explicit: true;
  workspaceRoot: string;
  allowedPaths: string[];
  optionalPaths: string[];
  allowRootListing: boolean;
  denyShell: boolean;
  denyNetwork: boolean;
}

const PATH_TOKEN = /(?:[a-zA-Z]:[\\/][^,;\n]*?\.[a-zA-Z0-9_-]+|(?:[\w.-]+[\\/])*[\w.-]+\.[a-zA-Z0-9_-]+)/g;

function cleanScopedPathToken(value: string): string {
  return value
    .replace(/^[`'"(\[]+|[`'")\],;:]+$/g, "")
    .replace(/\s+if\s+(?:it|they)\s+exists?.*$/i, "")
    .trim();
}

/**
 * Parse narrow read language such as "read only README.md" or
 * "only read src/a.ts and src/b.ts". Returns undefined when there is no
 * concrete file allowlist; an ambiguous "read only what is relevant" must
 * not accidentally turn into a deny-everything policy.
 */
export function resolveWorkspaceReadScope(
  request: string,
  workspaceRoot = "",
): WorkspaceReadScope | undefined {
  const clauseEnd = "(?=\\s+if\\s+(?:it|they)\\s+exists?\\b|\\.\\s|[!?](?:\\s|$)|$)";
  const onlyMatch =
    new RegExp(`\\bread\\s+only\\s+([^\\n]+?)${clauseEnd}`, "i").exec(request) ??
    new RegExp(`\\bonly\\s+read\\s+([^\\n]+?)${clauseEnd}`, "i").exec(request) ??
    /\bread\s+([^\n]+?)\s+only\b/i.exec(request);
  if (!onlyMatch) return undefined;

  const rawClause = onlyMatch[1]
    .replace(/\s+if\s+(?:it|they)\s+exists?.*$/i, "")
    .replace(/\s+(?:and|but)\s+(?:do\s+not|don't)\b.*$/i, "");
  const allowedPaths = Array.from(
    new Set(
      (rawClause.match(PATH_TOKEN) ?? [])
        .map(cleanScopedPathToken)
        .filter(Boolean),
    ),
  );
  if (allowedPaths.length === 0) return undefined;

  const optionalClause = /\bif\s+(?:it|they)\s+exists?\b/i.test(
    request.slice(onlyMatch.index, onlyMatch.index + onlyMatch[0].length + 40),
  );
  return {
    explicit: true,
    workspaceRoot,
    allowedPaths,
    optionalPaths: optionalClause ? [...allowedPaths] : [],
    allowRootListing: /\b(?:top[- ]level\s+(?:structure|contents?|files?|listing)|identify\s+(?:the\s+)?top[- ]level|list\s+(?:the\s+)?top[- ]level)\b/i.test(request),
    denyShell: /\b(?:do\s+not|don't|without|no)\b[^.!?\n]*\b(?:run\s+)?(?:shell|command|bash|powershell)\b/i.test(request),
    denyNetwork: /\b(?:do\s+not|don't|without|no)\b[^.!?\n]*\b(?:network|web|internet)\b/i.test(request),
  };
}

function resolvedScopePath(rawPath: string, scope: WorkspaceReadScope): string {
  const normalized = normalizePath(rawPath);
  if (normalized.absolute || !scope.workspaceRoot) return normalized.path;
  return normalizePath(`${scope.workspaceRoot}/${rawPath}`).path;
}

function isAllowedScopePath(rawPath: string, scope: WorkspaceReadScope): boolean {
  const candidate = resolvedScopePath(rawPath, scope);
  return scope.allowedPaths.some((allowed) => resolvedScopePath(allowed, scope) === candidate);
}

/** Return a stable policy error when a tool call would exceed an explicit scope. */
export function workspaceReadScopeViolation(
  call: { name: string; arguments?: Record<string, unknown> },
  scope: WorkspaceReadScope | undefined,
): string | undefined {
  if (!scope) return undefined;
  if (scope.denyShell && SHELL_TOOLS.has(call.name)) return "shell access denied by explicit read scope";
  if (scope.denyNetwork && NETWORK_TOOLS.has(call.name)) return "network access denied by explicit read scope";
  if (WRITE_TOOLS.has(call.name)) return "write access denied by explicit read-only scope";

  if (call.name === "list_directory" || call.name === "glob") {
    const rawPath = typeof call.arguments?.path === "string" ? call.arguments.path : scope.workspaceRoot;
    const atRoot = resolvedScopePath(rawPath || scope.workspaceRoot, scope) ===
      resolvedScopePath(scope.workspaceRoot || ".", scope);
    if (!scope.allowRootListing || !atRoot) {
      return "only the requested top-level listing is allowed by explicit read scope";
    }
    return undefined;
  }

  if (call.name === "read_file" || call.name === "grep") {
    const rawPath = typeof call.arguments?.path === "string" ? call.arguments.path : "";
    if (!rawPath || !isAllowedScopePath(rawPath, scope)) {
      return `tool target is outside explicit read scope (allowed: ${scope.allowedPaths.join(", ")})`;
    }
    return undefined;
  }

  if (call.name === "git_metadata") {
    return "repository metadata is outside explicit read scope";
  }
  return undefined;
}

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

type WorkspaceRoots = string | string[] | undefined;

function rootList(workspaceRoots: WorkspaceRoots): string[] {
  return Array.isArray(workspaceRoots)
    ? workspaceRoots.filter((root) => root.trim().length > 0)
    : workspaceRoots?.trim() ? [workspaceRoots] : [];
}

function firstExistingRootCandidate(rawPath: string, roots: string[]): string | undefined {
  for (const root of roots) {
    const candidate = resolve(root, rawPath);
    const rel = relative(root, candidate);
    const contained = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    if (contained && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function sourceFileKey(rawPath: string, workspaceRoots?: WorkspaceRoots): string | undefined {
  const roots = rootList(workspaceRoots);
  const rawNormalized = normalizePath(rawPath);
  const selectedPath = rawNormalized.absolute
    ? rawPath
    : firstExistingRootCandidate(rawPath, roots) ?? rawPath;
  const normalized = normalizePath(selectedPath);
  let normalizedPath = normalized.path;
  let absolute = normalized.absolute;
  if (roots.length > 0 && !absolute) {
    const root = normalizePath(roots[0]);
    const rootPath = root.path.replace(/\/+$/, "");
    normalizedPath = normalizePath(`${rootPath}/${normalizedPath}`).path;
    absolute = true;
  }
  for (const workspaceRoot of roots) {
    const root = normalizePath(workspaceRoot);
    const rootPath = root.path.replace(/\/+$/, "");
    if (normalizedPath === rootPath || normalizedPath.startsWith(`${rootPath}/`)) {
      normalizedPath = normalizedPath.slice(rootPath.length).replace(/^\/+/, "");
      // Preserve legacy rel: keys for the primary workspace. Granted roots use
      // their normalized absolute identity so same-suffix files stay distinct.
      absolute = workspaceRoot !== roots[0];
      if (absolute) normalizedPath = `${rootPath}/${normalizedPath}`;
      break;
    }
  }
  const basename = normalizedPath.split("/").pop()?.toLowerCase() ?? "";
  const extensionStart = basename.lastIndexOf(".");
  if (extensionStart <= 0 || !SOURCE_FILE_EXTENSIONS.has(basename.slice(extensionStart))) return undefined;
  return `${absolute ? "abs:" : "rel:"}${normalizedPath}`;
}

function grepOutputSourceFileKeys(call: ToolCallRecord, workspaceRoot?: WorkspaceRoots): Set<string> {
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

function sourceContentTargetKeys(call: ToolCallRecord, workspaceRoot?: WorkspaceRoots): Set<string> {
  if (call.name === "read_file") {
    const args = call.arguments as Record<string, unknown> | undefined;
    const key = typeof args?.path === "string" ? sourceFileKey(args.path, workspaceRoot) : undefined;
    return key ? new Set([key]) : new Set();
  }
  return call.name === "grep" ? grepOutputSourceFileKeys(call, workspaceRoot) : new Set();
}

function distinctDeepReadTargetKeys(calls: ToolCallRecord[], workspaceRoot?: WorkspaceRoots): Set<string> {
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
  // Explicit least-authority instructions outrank broad lexical markers. The
  // live Perihelion audit said "audit" and "read only README.md" in the same
  // sentence; treating "audit" as permission to read three source files was
  // both wasteful and a direct scope violation.
  if (resolveWorkspaceReadScope(request)) return false;
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
  workspaceRoot?: WorkspaceRoots,
): EvidenceAssessment {
  const calls = (toolCalls ?? []).filter(
    (c) => !c.is_error && c.output.trim().length > 0 && !isDuplicateToolDeflection(c),
  );
  const listings = calls.filter((c) => LISTING_TOOLS.has(c.name)).length;
  const explicitScope = resolveWorkspaceReadScope(request, rootList(workspaceRoot)[0]);
  const deepRead = isDeepReadRequest(request);

  if (explicitScope) {
    const matched = new Set<string>();
    for (const call of calls) {
      if (call.name !== "read_file" && call.name !== "grep") continue;
      const rawPath = typeof call.arguments?.path === "string" ? call.arguments.path : "";
      for (const allowed of explicitScope.allowedPaths) {
        if (rawPath && resolvedScopePath(rawPath, explicitScope) === resolvedScopePath(allowed, explicitScope)) {
          matched.add(allowed);
        }
      }
    }

    // "if it exists" is satisfied by a successful root listing that proves
    // the named file is absent. If the listing says it exists, the read remains
    // mandatory.
    const rootListings = calls.filter((call) => {
      if (!LISTING_TOOLS.has(call.name)) return false;
      const rawPath = typeof call.arguments?.path === "string" ? call.arguments.path : explicitScope.workspaceRoot;
      return resolvedScopePath(rawPath || explicitScope.workspaceRoot, explicitScope) ===
        resolvedScopePath(explicitScope.workspaceRoot || ".", explicitScope);
    });
    for (const optional of explicitScope.optionalPaths) {
      const basename = normalizePath(optional).path.split("/").pop() ?? optional.toLowerCase();
      if (rootListings.length > 0 && rootListings.every((call) => !call.output.toLowerCase().includes(basename))) {
        matched.add(optional);
      }
    }

    const missing = explicitScope.allowedPaths.filter((path) => !matched.has(path));
    return {
      sufficient: missing.length === 0,
      contentReads: explicitScope.allowedPaths.filter((path) => matched.has(path)).length,
      listings,
      deepRead: false,
      reason: missing.length === 0
        ? `explicit scope satisfied: ${explicitScope.allowedPaths.join(", ")}`
        : `explicit scope still requires: ${missing.join(", ")}`,
    };
  }

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

/**
 * Turn a `list_directory` tool result's text into bare entry names.
 * Handles production `handleListDir` emoji rows and plain newline lists.
 */
export function parseListingEntryNames(listingText: string): string[] {
  const lines = listingText.split(/\r?\n/);
  const startIdx = /^\d+\s+items?\s+in\b.*:$/i.test(lines[0] ?? "") ? 1 : 0;
  return lines
    .slice(startIdx)
    .map((line) =>
      line
        .replace(/^[^\w.]+/, "")
        .replace(/\s+\([^)]*\)\s*$/, "")
        .trim(),
    )
    .filter((line) => line.length > 0);
}

/** Join a relative entry onto a listing path without importing node:path. */
function joinWorkspacePath(base: string, entry: string): string {
  if (!base) return entry;
  if (/^[a-zA-Z]:[\\/]/.test(entry) || entry.startsWith("/") || entry.startsWith("\\\\")) return entry;
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${entry.replace(/^[\\/]+/, "")}`;
}

/**
 * Path-like tokens with source extensions (lib/gateway/dashboard.ts, client.ts).
 * Prefer longer / more specific matches; plan order is preserved separately.
 */
const SOURCE_PATH_TOKEN =
  /(?:(?:[a-zA-Z]:)?(?:[\\/]|\b))?(?:[\w.-]+[\\/])*[\w.-]+\.(?:c|cc|cpp|cxx|cs|css|dart|ex|exs|go|h|hpp|hs|html|java|js|jsx|kts|kt|lua|mjs|php|pl|ps1|py|rb|rs|scala|sh|sql|svelte|swift|ts|tsx|vue)\b/gi;

/**
 * F8: harvest plan-named + listing-derived source files the runtime can
 * deterministically deep-read to finish the evidence floor.
 * Returns absolute-or-workspace-resolved paths in plan-order-first priority.
 * `alreadyRead` holds `sourceFileKey` values (same keys as the deep-read floor).
 */
export function extractSourceReadCandidates(
  planText: string,
  listingCalls: ToolCallRecord[],
  workspaceRoot: string,
  alreadyRead: Set<string>,
): string[] {
  const seenKeys = new Set<string>(alreadyRead);
  const ordered: string[] = [];

  const tryAdd = (rawPath: string) => {
    const key = sourceFileKey(rawPath, workspaceRoot);
    if (!key || seenKeys.has(key)) return;
    seenKeys.add(key);
    // Prefer a workspace-relative path when the key is relative; otherwise
    // keep the raw token (may already be absolute).
    const resolved = key.startsWith("rel:")
      ? joinWorkspacePath(workspaceRoot, key.slice(4))
      : rawPath;
    ordered.push(resolved);
  };

  // Plan / worker-instruction paths first (incident: dashboard.ts before listing noise).
  const planMatches = planText.match(SOURCE_PATH_TOKEN) ?? [];
  for (const token of planMatches) {
    tryAdd(token.replace(/^[\\/]+/, ""));
  }

  for (const call of listingCalls) {
    if (call.name !== "list_directory" || call.is_error) continue;
    const args = call.arguments as { path?: unknown } | undefined;
    const listPath = typeof args?.path === "string" && args.path.trim()
      ? args.path
      : workspaceRoot;
    for (const entry of parseListingEntryNames(call.output)) {
      // Skip directory-looking entries without extensions.
      if (!entry.includes(".")) continue;
      tryAdd(joinWorkspacePath(listPath, entry));
    }
  }

  return ordered;
}

/** Distinct deep-read source keys already present in tool call records. */
export function alreadyReadSourceKeys(
  toolCalls: ToolCallRecord[] | undefined,
  workspaceRoot?: WorkspaceRoots,
): Set<string> {
  const calls = (toolCalls ?? []).filter(
    (c) => !c.is_error && c.output.trim().length > 0 && !isDuplicateToolDeflection(c),
  );
  return distinctDeepReadTargetKeys(calls, workspaceRoot);
}
