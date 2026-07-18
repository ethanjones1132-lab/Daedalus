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

import { isContinuationTurn, isTrivialConversationalTurn, isWorkOrderFollowup, WORK_START_COMMAND } from "./turn-triage";

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

const COMPLEX_ANSWER_MARKER =
  /\b(compare|contrast|evaluate|analy[sz]e|design|architect|plan|research|audit|review|diagnose|derive|prove|calculate|trade-?offs?|strategy|comprehensive|detailed|deep(?:ly)?|multi-?step|step-by-step)\b/i;

/**
 * Decide whether the deterministic classifier has enough information to skip
 * the model-backed Coordinator entirely. The shortcut is intentionally narrow:
 * conversational turns and short, direct knowledge questions only. Workspace
 * authority, continuation inheritance, pasted tool payloads, and complex
 * reasoning stay on the Coordinator path.
 */
export function shouldShortCircuitCoordinator(
  message: string,
  result: TurnRequirementResult,
  isContinuation: boolean,
): boolean {
  if (isContinuation) return false;
  if (result.requirement === "conversational") return true;
  if (result.requirement !== "answer_only") return false;
  const text = (message || "").trim();
  if (!text || text.length > 280) return false;
  if (result.signals.includes("tool_call_exemplar")) return false;
  return !COMPLEX_ANSWER_MARKER.test(text);
}

/**
 * T1.2: true when the API coordinator is purely advisory for this requirement —
 * normalizeRoute rebuilds pipeline/topology/profile from the requirement
 * regardless; only task_type/worker_instructions survive from the model.
 * When true and local conductor is unavailable and the coordinator has recent
 * parse-failure strikes, skip the API coordinator entirely.
 */
export function coordinatorIsAdvisoryOnly(requirement: TurnRequirement): boolean {
  return requirement === "workspace_read";
}

/**
 * Trivial short-circuited turns carry no new task requirement. Preserve the
 * last substantive requirement so a following continuation can inherit the
 * original execution budget and capability class.
 */
export function shouldRememberRequirement(wasShortCircuited: boolean): boolean {
  return !wasShortCircuited;
}

const REQUIREMENT_RANK: Record<TurnRequirement, number> = {
  conversational: 0,
  answer_only: 1,
  workspace_read: 2,
  full_execution: 3,
};

export function inheritRequirementForContinuation(
  current: TurnRequirementResult,
  previous: TurnRequirement | undefined,
  isContinuation: boolean,
): TurnRequirementResult {
  if (!isContinuation || !previous) return current;
  if (REQUIREMENT_RANK[previous] <= REQUIREMENT_RANK[current.requirement]) return current;
  return {
    requirement: previous,
    signals: [...current.signals, `continuation_inherit:${previous}`],
  };
}

/**
 * Resolve the authoritative requirement for one session turn. Budget creation
 * and route selection must use this exact result so a continuation can never
 * inherit a heavier pipeline after a lighter turn deadline has been frozen.
 *
 * `previousActive` (2026-07-18): true when the session has an ACTIVE (not
 * completed/failed/cancelled) task run behind `previous`. During an active
 * full-execution task, authority inheritance flips polarity: any short
 * non-question work order ("re-execute", "Please apply the edits") inherits
 * the task's authority instead of being re-classified from scratch — the
 * live failure mode where each pattern-list miss silently produced a
 * tool-less pipeline mid-implementation. Once the task concludes, the
 * narrow continuation patterns are again the only inheritance path, so a
 * casual remark after finished work cannot summon a full pipeline.
 */
export function resolveTurnRequirement(
  message: string,
  previous: TurnRequirement | undefined,
  previousActive = false,
): { continuation: boolean; result: TurnRequirementResult } {
  const continuation = isContinuationTurn(message) ||
    (previousActive && previous === "full_execution" && isWorkOrderFollowup(message));
  return {
    continuation,
    result: inheritRequirementForContinuation(
      classifyTurnRequirements(message),
      previous,
      continuation,
    ),
  };
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

const TOOL_CALL_EXEMPLAR =
  /<tool_call>[\s\S]*?<\/tool_call>|\{(?=[^{}\n]{0,200}"(?:name|tool)"\s*:)[\s\S]*?\}\s*\}?/gi;

function maskToolCallExemplars(text: string): { text: string; found: boolean } {
  let found = false;
  const maskedText = text.replace(TOOL_CALL_EXEMPLAR, (match) => {
    found = true;
    return " ".repeat(match.length);
  });
  return { text: maskedText, found };
}

export function hasWorkspaceSignal(message: string): boolean {
  const masked = maskToolCallExemplars((message || "").trim());
  const intentText = masked.text;
  return Boolean(
    detectPath(intentText) ||
    STRONG_WORKSPACE.test(intentText) ||
    WEAK_WORKSPACE.test(intentText)
  );
}

// ── Verb / noun signals ─────────────────────────────────────────────────────
// Mutation verbs: any of these (as a whole word) signals the user wants the
// system to CHANGE something — files, builds, commits, deployments.
// Gerund (-ing) forms are matched deliberately (2026-07-17 incident: "Begin
// implementing phase 1" matched nothing and routed to a tool-less
// synthesizer). Past/-s forms are deliberately EXCLUDED — they read as status
// questions or nouns ("what are the latest changes?", "is the server
// running?"), so "running" and "changes" must never grant write authority.
const MUTATION_VERB =
  /\b(writ(?:e|ing)|edit(?:ing)?|creat(?:e|ing)|add(?:ing)?|delet(?:e|ing)|remov(?:e|ing)|fix(?:ing)?|refactor(?:ing)?|implement(?:ing)?|execut(?:e|ing)|build(?:ing)?|deploy(?:ing)?|install(?:ing)?|commit(?:ting)?|patch(?:ing)?|chang(?:e|ing)|modif(?:y|ies|ying)|renam(?:e|ing)|mov(?:e|ing)|generat(?:e|ing)|replac(?:e|ing)|rewrit(?:e|ing)|scaffold(?:ing)?|migrat(?:e|ing)|format(?:ting)?|append(?:ing)?|insert(?:ing)?|overwrit(?:e|ing)|updat(?:e|ing)|push(?:ing)?|appl(?:y|ies|ying)|land|ship(?:ping)?|wir(?:e|ing)|integrat(?:e|ing)|run)\b/gi;

const NEGATED_MUTATION_NOUN =
  /\b(?:no\s+(?:(?:file|code)\s+)?|without\s+(?:any\s+)?)(?:modifications?|edits?|changes?)\b|\bwithout\s+(?:writing|editing|creating|adding|deleting|removing|fixing|refactoring|implementing|building|deploying|installing|committing|patching|modifying|renaming|moving|generating|replacing|rewriting|scaffolding|migrating|formatting|appending|inserting|overwriting|updating|pushing|running)\b|\bdo\s+not\s+(?:make|apply)\s+(?:any\s+)?(?:modifications?|edits?|changes?)\b/i;

const NEGATION_MARKER = /\b(do\s+not|don(?:'|\u2019)t|never|without)\b/gi;
const CONTRAST_MARKER = /\b(but|however|instead|except|yet)\b/gi;

function lastMatchEnd(text: string, re: RegExp): number {
  let end = -1;
  for (const match of text.matchAll(re)) {
    end = Math.max(end, (match.index ?? 0) + match[0].length);
  }
  return end;
}

/** Whether a mutation verb at `index` is governed by a nearby negation. */
function isNegatedMutation(text: string, index: number): boolean {
  const windowStart = Math.max(0, index - 120);
  const prefix = text.slice(windowStart, index);
  const punctuationBoundary = Math.max(
    prefix.lastIndexOf("."),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf("\n"),
  );
  const contrastBoundary = lastMatchEnd(prefix, CONTRAST_MARKER);
  const clause = prefix.slice(Math.max(punctuationBoundary + 1, contrastBoundary));
  const markers = [...clause.matchAll(NEGATION_MARKER)];
  const marker = markers.at(-1);
  if (!marker) return false;

  const markerEnd = (marker.index ?? 0) + marker[0].length;
  const governedText = clause.slice(markerEnd);
  // `without modifying files, create ...` ends at the comma; coordinated
  // `do not edit, delete, or rename ...` remains governed by the negation.
  if (marker[1].toLowerCase() === "without" && governedText.includes(",")) return false;

  const interveningWords = governedText.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return interveningWords.length <= 8;
}

const ABSTRACT_DELIVERABLE =
  /\b(plan|report|summary|analysis|roadmap|proposal|assessment|overview|recommendation|strategy|outline|write[- ]?up)\b/i;
// Work-item nouns (phase/task/step/...) are concrete: "implement phase 1"
// means "do the work of phase 1", which in an implementation session means
// mutating files. (2026-07-17 incident: "Begin implementing phase 1" carried
// no write intent, so no gate demanded actual mutations.)
// Mutation-artifact nouns (changes/edits/patch/diff/...) are concrete write
// targets: "apply the Phase 1 smoothing changes to X.h" routed READ-ONLY on
// 2026-07-18 because nothing in this list matched the object.
const CONCRETE_WRITE_TARGET =
  /\b(file|repo(?:sitory)?|path|workspace|code|source|doc(?:ument)?|config(?:uration)?|test|script|directory|folder|module|package|app(?:lication)?|project|table|database|schema|target|phase|task|step|item|milestone|feature|functionality|fix|bug|crash|issue|chang(?:e|es)|edit(?:s)?|modification(?:s)?|patch(?:es)?|diff(?:s)?|update(?:s)?|improvement(?:s)?)\b/i;

/**
 * Decide whether a raw user message actually asks Jarvis to mutate something.
 * This is deliberately narrower than `classifyTurnRequirements`: producing an
 * abstract deliverable such as a plan or report is not a write, even though
 * those verbs may still route through a full-capability pipeline.
 */
export function hasWriteIntent(message: string): boolean {
  const masked = maskToolCallExemplars((message || "").trim());
  const intentText = masked.text;
  const mutationMatches = [...intentText.matchAll(MUTATION_VERB)];
  const hasNegatedMutation = mutationMatches.some((match) =>
    isNegatedMutation(intentText, match.index ?? 0)
  ) || NEGATED_MUTATION_NOUN.test(intentText);

  for (const match of mutationMatches) {
    const index = match.index ?? 0;
    if (isNegatedMutation(intentText, index)) continue;

    const objectStart = index + match[0].length;
    const objectWindow = intentText
      .slice(objectStart, objectStart + 90)
      .split(/[!?;\n]|\.(?=\s+[A-Z]|\s*$)/, 1)[0];
    const hasConcreteTarget = Boolean(detectPath(objectWindow)) || CONCRETE_WRITE_TARGET.test(objectWindow);
    if (!hasConcreteTarget) continue;

    // A plan/report/etc. is normally an answer artifact, not a file mutation.
    // A compound such as "plan file" remains concrete and is intentionally
    // accepted by the target check above.
    if (ABSTRACT_DELIVERABLE.test(objectWindow)) {
      const compoundTarget = /\b(?:plan|report|summary|analysis|roadmap|proposal|assessment|overview|recommendation|strategy|outline|write[- ]?up)\s+(?:file|document|doc|path)\b/i.test(objectWindow);
      if (!compoundTarget && hasNegatedMutation) continue;
    }

    return true;
  }

  return false;
}

// Read / inspection verbs: signal the user wants to LOOK AT something.
const READ_VERB =
  /\b(read(?:s|ing)?|read_file|inspect|list|search|summari[sz]e|summary|overview|analy[sz]e|show|open|view|examine|explore|cat|look|find|grep|describe|audit|review|check|scan|understand|verif(?:y|ies|ying)|validat(?:e|ing)|confirm(?:ing)?|tell\s+me\s+about|walk\s+me\s+through)\b/i;

// The evidence-failure response advertises this phrase as the retry escape
// hatch. Keep it explicitly read-only, even when the surrounding sentence says
// "perform" or "execute read_file".
const DEEP_READ_INTENT = /\b(?:force\s+)?deep\s+reads?\b|\bread_file\b/i;

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
 *   2. full_execution  — an unnegated mutation verb is present.
 *   3. workspace_read  — a concrete path is named, OR a read verb + a workspace
 *                        noun co-occur.
 *   4. answer_only     — everything else.
 *
 * Misclassification bias is intentional: ambiguous-with-path turns land in
 * workspace_read (read-only tools), which is the SAFE side. Only an explicit,
 * unnegated mutation verb unlocks full_execution.
 */
export function classifyTurnRequirements(message: string): TurnRequirementResult {
  const text = (message || "").trim();
  const signals: string[] = [];

  if (isTrivialConversationalTurn(text)) {
    return { requirement: "conversational", signals: ["trivial_conversational"] };
  }

  // Pasted tool-call JSON is quoted DATA to analyze, not an instruction to run
  // the tool and not proof that the surrounding turn targets its embedded path.
  // Authority is derived only from the user's language outside the exemplar.
  const masked = maskToolCallExemplars(text);
  const intentText = masked.text;
  if (masked.found) signals.push("tool_call_exemplar");

  const pathSignal = detectPath(intentText);
  if (pathSignal) signals.push(`path:${pathSignal}`);
  const mutationMatches = [...intentText.matchAll(MUTATION_VERB)];
  const negatedMutationMatches = mutationMatches.filter((match) =>
    isNegatedMutation(intentText, match.index ?? 0)
  );
  const hasMutation = mutationMatches.some((match) =>
    !isNegatedMutation(intentText, match.index ?? 0)
  );
  const hasNegatedMutation = negatedMutationMatches.length > 0 || NEGATED_MUTATION_NOUN.test(intentText);
  const hasReadVerb = READ_VERB.test(intentText);
  const hasDeepReadIntent = DEEP_READ_INTENT.test(intentText);
  const hasStrongWorkspace = STRONG_WORKSPACE.test(intentText);
  const hasWeakWorkspace = WEAK_WORKSPACE.test(intentText);
  const hasWorkStartCommand = WORK_START_COMMAND.test(intentText);
  if (hasNegatedMutation) signals.push("negated_mutation");
  if (hasMutation) signals.push("mutation_verb");
  if (hasReadVerb) signals.push("read_verb");
  if (hasDeepReadIntent) signals.push("deep_read_intent");
  if (hasStrongWorkspace) signals.push("strong_workspace");
  if (hasWeakWorkspace) signals.push("weak_workspace");
  if (hasWorkStartCommand) signals.push("work_start_command");

  // The deep-read escape hatch is checked FIRST: it is advertised as
  // explicitly read-only even when the sentence says "perform" or "executing
  // read_file" — and with gerund mutation verbs now matched, "executing"
  // would otherwise steal the hatch into full_execution.
  if (hasDeepReadIntent) {
    return { requirement: "workspace_read", signals };
  }

  // Unnegated mutation intent wins outright — even with a path present,
  // "fix C:\x.ts" is a change request, not a read. Negated mutation language
  // remains observable in signals but cannot grant write/command authority.
  if (hasMutation) {
    return { requirement: "full_execution", signals };
  }

  if (hasWorkStartCommand) {
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
