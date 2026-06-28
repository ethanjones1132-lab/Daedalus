// ═══════════════════════════════════════════════════════════════
// ── Deterministic Turn Requirements Classifier ──
// ═══════════════════════════════════════════════════════════════
// A PURE classifier that maps the RAW current user message to the capability
// class the turn requires. This is the authoritative, model-independent signal
// that the route-normalization layer uses to enforce route invariants — the
// coordinator MODEL output is advisory, this is not.
//
// CRITICAL: callers MUST classify the raw current user message, NOT the
// augmented `contextMessage` that prepends conversation history / memory.
// Otherwise a previous file-read request in history contaminates the intent of
// a follow-up ("hey, thanks!") and the turn is wrongly granted tool access.
//
// Capability classes (monotonic in authority):
//   conversational  — greetings, acknowledgements. No tools.
//   answer_only     — knowledge / reasoning. No external inspection REQUIRED
//                     (executor may still be used read-only if the model asks).
//   workspace_read  — read / inspect / list / search / summarize / analyze named
//                     files or directories. Executor REQUIRED, read-only tools.
//   full_execution  — explicitly requested edits, builds, commands, deployment,
//                     or other mutations. Executor REQUIRED, full tools.

import { isTrivialConversationalTurn } from "./turn-triage";

export type TurnRequirement =
  | "conversational"
  | "answer_only"
  | "workspace_read"
  | "full_execution";

export interface TurnRequirementResult {
  requirement: TurnRequirement;
  /** Human-readable signals that drove the classification (for logging). */
  signals: string[];
}

// ── Path detection ────────────────────────────────────────────────────────────
// Each pattern recognizes one shape of filesystem reference. A match in ANY of
// these means the message names a concrete path.
const PATH_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Quoted path containing a slash or backslash: "C:\foo\bar", "./src/x"
  { name: "quoted_path", re: /["'][^"']*[\\/][^"']*["']/ },
  // Windows drive-absolute: C:\... or C:/...
  { name: "windows_drive", re: /\b[a-zA-Z]:[\\/]/ },
  // UNC share: \\server\share
  { name: "unc_path", re: /\\\\[^\\\s]+\\/ },
  // POSIX absolute with at least one more segment: /usr/local, /home/x/y
  { name: "posix_abs", re: /(^|\s)\/[\w.\-]+\/[\w.\-]/ },
  // Explicit relative: ./x or ../x (slash or backslash)
  { name: "relative_dot", re: /(^|\s)\.\.?[\\/][\w.\-]/ },
  // Multi-segment relative path: src/foo, app/components/Bar.tsx
  { name: "relative_seg", re: /\b[\w.\-]+[\\/][\w.\-]+[\\/]?/ },
  // Bare filename with a known code/config extension: app.json, index.ts
  {
    name: "file_ext",
    re: /\b[\w\-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|toml|ya?ml|txt|csv|sh|ps1|bat|html|css|scss|go|java|c|cpp|cc|h|hpp|rb|php|sql|xml|lock|cfg|ini|env|conf|config|log)\b/i,
  },
];

function detectPath(text: string): string | null {
  for (const { name, re } of PATH_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}

// ── Verb / noun signals ─────────────────────────────────────────────────────
// Mutation verbs: any of these (as a whole word) signals the user wants the
// system to CHANGE something — files, builds, commits, deployments.
const MUTATION_VERB =
  /\b(write|edit|create|add|delete|remove|fix|refactor|implement|build|deploy|install|commit|patch|modif(?:y|ies)|rename|move|generate|replace|rewrite|scaffold|migrate|format|append|insert|overwrite|update|push|run)\b/i;

// Read / inspection verbs: signal the user wants to LOOK AT something.
const READ_VERB =
  /\b(read|inspect|list|search|summari[sz]e|summary|overview|analy[sz]e|show|open|view|examine|explore|cat|look|find|grep|describe|audit|review|check|scan|understand|tell\s+me\s+about|walk\s+me\s+through)\b/i;

// STRONG workspace references — these imply the user's project so directly that
// even without an explicit read verb the turn needs workspace inspection
// ("a summary of this repo"). A literal path is handled separately.
const STRONG_WORKSPACE =
  /\b(repo|repository|codebase|code\s?base)\b|\b(this|these|those|that|the|my|our|your)\s+(folder|director(?:y|ies)|project|workspace)\b/i;

// WEAK workspace references — only count as workspace inspection WHEN paired
// with a read verb. NOTE: bare "file" is intentionally excluded ("what is a
// JSON file" must stay answer_only); only a determiner + noun counts.
const WEAK_WORKSPACE =
  /\b(this|these|those|that|the|my|our|your)\s+(file|files|module|package|app|application|script|source|contents?)\b/i;

/**
 * Classify the raw current user message into the capability class the turn
 * requires. Precedence (first match wins):
 *   1. conversational  — trivial greeting/ack (delegates to turn-triage).
 *   2. full_execution  — a mutation verb is present.
 *   3. workspace_read  — a concrete path is named, OR a read verb + a workspace
 *                        noun co-occur.
 *   4. answer_only     — everything else.
 *
 * Misclassification bias is intentional: ambiguous-with-path turns land in
 * workspace_read (read-only tools), which is the SAFE side. Only an explicit
 * mutation verb unlocks full_execution.
 */
export function classifyTurnRequirements(message: string): TurnRequirementResult {
  const text = (message || "").trim();
  const signals: string[] = [];

  if (isTrivialConversationalTurn(text)) {
    return { requirement: "conversational", signals: ["trivial_conversational"] };
  }

  const pathSignal = detectPath(text);
  if (pathSignal) signals.push(`path:${pathSignal}`);
  const hasMutation = MUTATION_VERB.test(text);
  const hasReadVerb = READ_VERB.test(text);
  const hasStrongWorkspace = STRONG_WORKSPACE.test(text);
  const hasWeakWorkspace = WEAK_WORKSPACE.test(text);
  if (hasMutation) signals.push("mutation_verb");
  if (hasReadVerb) signals.push("read_verb");
  if (hasStrongWorkspace) signals.push("strong_workspace");
  if (hasWeakWorkspace) signals.push("weak_workspace");

  // Mutation intent wins outright — even with a path present, "fix C:\x.ts" is a
  // change request, not a read.
  if (hasMutation) {
    return { requirement: "full_execution", signals };
  }

  // Workspace inspection when: a concrete path is named, OR a strong workspace
  // reference is present (repo/codebase/"this folder" — implies inspection on
  // its own), OR a read verb targets a weak workspace noun ("read the file").
  if (pathSignal || hasStrongWorkspace || (hasReadVerb && hasWeakWorkspace)) {
    return { requirement: "workspace_read", signals };
  }

  return { requirement: "answer_only", signals: signals.length ? signals : ["default_answer_only"] };
}
