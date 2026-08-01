import { isStageSummaryPlaceholder } from "./stage-output";
import type { ToolCallRecord } from "./stage-output";

export type MidLoopDecisionSource =
  | "deterministic_reflex"
  | "resident_model"
  | "resident_error"
  | "no_signal"
  | "cap_exhausted"
  /** Early exploration held back so a reserved escalation remains for priority moments. */
  | "escalation_reserved"
  /** Resident answered continue without concrete progress evidence (#4 schema control). */
  | "schema_control";

export interface MidLoopDecisionMeta {
  /** Truthful origin for audit/replay; populated by LiveConductor.checkMidLoop. */
  decisionSource?: MidLoopDecisionSource;
  /** Shared with the model attribution when a resident escalation was attempted. */
  escalationId?: string;
  /**
   * Which reflex produced an `inject`. The host cannot tell inject variants
   * apart at the apply site, so a per-reflex repeat counter (e.g.
   * `planNudgesSent`) has nothing to key on without this tag.
   */
  noteKind?: "plan_remainder";
}

export type LoopIntervention = (
  | { kind: "continue" }
  | { kind: "inject"; note: string }
  | { kind: "force_write"; note: string }
  | { kind: "redirect"; tool: string; note: string }
  | { kind: "abort"; reason: string }
) & MidLoopDecisionMeta;

/** Distributive Omit so Omit<Union, K> preserves per-variant required fields. */
export type DistributiveOmit<T, K extends keyof T> = T extends T
  ? Omit<T, K>
  : never;

/** Bounded verification snapshot carried into mid-loop checkpoints. */
export interface MidLoopVerificationSnapshot {
  tier: string;
  ran: boolean;
  passed: boolean | null;
  detail?: string;
  command?: string;
}

export interface MidLoopSignal {
  writeIntent: boolean;
  successfulWrites: number;
  distinctSuccessfulReads: number;
  /** Total successful read-tool calls, including re-reads of the same target. */
  totalSuccessfulReads?: number;
  turnCount: number;
  maxTurns: number;
  /** Remaining wall-clock budget for the executor stage, ms. */
  stageRemainingMs: number;
  deadToolSuppressed: boolean;
  suppressedToolName?: string;
  /** Truncated task objective / user request. */
  taskObjective?: string;
  /** Truncated active plan item / plan summary. */
  activePlanItem?: string;
  /** Recent successful read targets (paths), newest last. */
  recentReadTargets?: string[];
  /** Recent successful write targets (paths), newest last. */
  recentWriteTargets?: string[];
  /** Bounded summaries of the most recent tool outcomes. */
  recentToolSummaries?: string[];
  /** Last known verification state, if any. */
  verification?: MidLoopVerificationSnapshot;
  /** Free-text progress delta since the previous checkpoint. */
  progressSinceLastCheckpoint?: string;
  /**
   * True when a successful write landed since the previous mid-loop call.
   * Triggers a quality-aware checkpoint even though writes already succeeded.
   */
  writeLandedSinceLastCheck?: boolean;
  /** Failed write-tool attempts so far this stage. */
  failedWriteAttempts?: number;
  /**
   * True when this checkpoint follows a deterministic conductor reroute
   * (e.g. write-effect or deep-read re-enter). Priority escalation slot.
   */
  afterReroute?: boolean;
  /**
   * Slice D — implementation phase. `quality` means correctness floor is met
   * and the resident must push one-shot product quality (not mere green checks).
   */
  implementationPhase?: MidLoopImplementationPhase;
  /** Quality pushes already issued this executor stage. */
  qualityPushesUsed?: number;
  /** Max quality pushes allowed this stage (host-enforced). */
  qualityPushBudget?: number;
  /** Host already accepted quality for this stage. */
  qualityAccepted?: boolean;
  /** Force a quality-phase checkpoint even if write did not just land. */
  forceQualityGate?: boolean;
  /**
   * Force-write nudges already pushed into the executor transcript this stage.
   * Drives escalation: a note the model has already ignored twice must not be
   * repeated a third time verbatim (2026-07-26: the same sentence was injected
   * ~22 times in run_13298c8f and the executor kept reading).
   */
  forceWriteNudgesSent?: number;
  /** Total items in the active TaskPlan ledger, when one exists. */
  planItemsTotal?: number;
  /** Items not yet `verified` in the active TaskPlan ledger. */
  planItemsRemaining?: number;
  /**
   * Plan-remainder nudges already pushed into the executor transcript this
   * stage. Same role `forceWriteNudgesSent` plays for the force-write reflex:
   * drives escalation, then a hard stop. 2026-07-31 (run_2c46d082) this note
   * was injected 66x on a single turn because nothing counted it, and 28 of 37
   * executor turns produced no tool call.
   */
  planNudgesSent?: number;
}

/** Correctness = mutation floor; quality = product polish after that floor. */
export type MidLoopImplementationPhase = "correctness" | "quality";

/** Bounded quality pushes after correctness so free/local executors get coached. */
export const MAX_QUALITY_PUSHES = 2;

export const DEFAULT_QUALITY_PUSH_NOTE =
  "Correctness floor is met (write landed; verification not red). " +
  "Before finishing, raise one-shot product quality: cover edge cases and requirement gaps, " +
  "re-read the edited code for clarity/robustness, and apply a focused polish edit if needed. " +
  "Do not stop at 'tests might pass' — ship a finished-looking change.";

/** Thresholds are deliberately conservative: reflexes fire only on the
 * unambiguous cases. The middle ground (some reads, budget not yet critical)
 * is left for resident-model escalation - see conductor.ts checkMidLoop. */
const SPIRAL_READ_FLOOR = 5;
const ABORT_BUDGET_FLOOR_MS = 30_000;

/**
 * How many times the plan-remainder note may be injected in one executor
 * stage before it stops firing. Two: one statement, one escalation. A note the
 * executor has ignored twice will not work the third time, and every repeat
 * costs a full model round-trip plus a re-upload of the growing transcript —
 * live run_2c46d082 injected it 66x and 28 of 37 turns produced no tool call.
 * Stopping lets the executor loop exit instead of being held open to the turn
 * cap; the quality phase still supervises the stage (see the polarity test).
 */
const PLAN_REMAINDER_NUDGE_CAP = 2;

const EVIDENCE_TARGET_CAP = 6;
const EVIDENCE_SUMMARY_CAP = 5;
const EVIDENCE_SUMMARY_CHARS = 160;
const OBJECTIVE_CHARS = 280;

const READ_TOOL_NAMES = new Set([
  "read_file",
  "list_directory",
  "glob",
  "grep",
  "git_metadata",
]);

const WRITE_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
]);

/** Collect path-like targets from tool arguments (bounded, order-preserving). */
export function collectToolPathTargets(args: Record<string, unknown> | undefined): string[] {
  if (!args || typeof args !== "object") return [];
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || out.includes(trimmed)) return;
    out.push(trimmed);
  };
  push(args.path);
  push(args.file_path);
  push(args.filePath);
  push(args.target);
  if (Array.isArray(args.paths)) {
    for (const path of args.paths) push(path);
  }
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === "object") {
        push((edit as { path?: unknown }).path);
        push((edit as { file_path?: unknown }).file_path);
      }
    }
  }
  return out;
}

export function truncateMidLoopText(text: string | undefined, maxChars: number): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`;
}

/**
 * Build the bounded semantic evidence fields for a mid-loop checkpoint from
 * the stage tool transcript so far.
 */
export function buildMidLoopToolEvidence(
  toolCalls: readonly ToolCallRecord[],
  opts: {
    taskObjective?: string;
    activePlanItem?: string;
    verification?: MidLoopVerificationSnapshot;
    progressSinceLastCheckpoint?: string;
    writeLandedSinceLastCheck?: boolean;
    readIdentityKey?: (call: Pick<ToolCallRecord, "name" | "arguments">) => string;
  } = {},
): Pick<
  MidLoopSignal,
  | "taskObjective"
  | "activePlanItem"
  | "recentReadTargets"
  | "recentWriteTargets"
  | "recentToolSummaries"
  | "verification"
  | "progressSinceLastCheckpoint"
  | "writeLandedSinceLastCheck"
  | "failedWriteAttempts"
  | "successfulWrites"
  | "distinctSuccessfulReads"
  | "totalSuccessfulReads"
> {
  const recentReadTargets: string[] = [];
  const recentWriteTargets: string[] = [];
  const recentToolSummaries: string[] = [];
  let successfulWrites = 0;
  let totalSuccessfulReads = 0;
  let failedWriteAttempts = 0;
  const successfulReadKeys = new Set<string>();

  for (const call of toolCalls) {
    const paths = collectToolPathTargets(call.arguments);
    if (!call.is_error && READ_TOOL_NAMES.has(call.name)) {
      totalSuccessfulReads += 1;
      const key = opts.readIdentityKey?.(call)
        ?? `${call.name}:${JSON.stringify(call.arguments)}`;
      successfulReadKeys.add(key);
      for (const path of paths) {
        if (!recentReadTargets.includes(path)) recentReadTargets.push(path);
      }
    }
    if (WRITE_TOOL_NAMES.has(call.name)) {
      if (call.is_error) {
        failedWriteAttempts += 1;
      } else {
        successfulWrites += 1;
        for (const path of paths) {
          if (!recentWriteTargets.includes(path)) recentWriteTargets.push(path);
        }
      }
    }
    const summary = `${call.is_error ? "ERR" : "ok"} ${call.name}` +
      (paths[0] ? ` ${paths[0]}` : "") +
      (call.output ? `: ${call.output.replace(/\s+/g, " ").trim().slice(0, 80)}` : "");
    recentToolSummaries.push(truncateMidLoopText(summary, EVIDENCE_SUMMARY_CHARS) ?? summary);
  }

  return {
    taskObjective: truncateMidLoopText(opts.taskObjective, OBJECTIVE_CHARS),
    activePlanItem: truncateMidLoopText(opts.activePlanItem, OBJECTIVE_CHARS),
    recentReadTargets: recentReadTargets.slice(-EVIDENCE_TARGET_CAP),
    recentWriteTargets: recentWriteTargets.slice(-EVIDENCE_TARGET_CAP),
    recentToolSummaries: recentToolSummaries.slice(-EVIDENCE_SUMMARY_CAP),
    verification: opts.verification,
    progressSinceLastCheckpoint: truncateMidLoopText(opts.progressSinceLastCheckpoint, OBJECTIVE_CHARS),
    writeLandedSinceLastCheck: opts.writeLandedSinceLastCheck === true,
    failedWriteAttempts,
    successfulWrites,
    distinctSuccessfulReads: successfulReadKeys.size,
    totalSuccessfulReads,
  };
}

/** Max bounded check-runner invocations per executor stage (mid-loop path). */
export const MAX_MID_LOOP_CHECKS = 2;
/** Max resident mid-loop escalations per run (shared with historical cap). */
export const MAX_MID_LOOP_ESCALATIONS = 3;
/** Hold back at least this many slots for post-write / endgame / post-reroute. */
export const RESERVED_MID_LOOP_ESCALATIONS = 1;
/** Endgame: last 20% of turns, or stage budget under this floor. */
export const MID_LOOP_ENDGAME_BUDGET_MS = 45_000;
export const MID_LOOP_ENDGAME_TURN_RATIO = 0.8;

/**
 * Whether to invoke the check-runner before a mid-loop judgment.
 * Only after a meaningful write (or pre-completion with unchecked writes),
 * and only while under the per-stage cap.
 */
export function shouldRunMidLoopCheck(input: {
  writeLanded: boolean;
  forcePreCompletion?: boolean;
  successfulWrites: number;
  /** Successful-write count already covered by a mid-loop check; 0 = never. */
  successfulWritesAtLastCheck: number;
  checksUsed: number;
  maxChecks?: number;
}): boolean {
  const maxChecks = input.maxChecks ?? MAX_MID_LOOP_CHECKS;
  if (input.checksUsed >= maxChecks) return false;
  if (input.successfulWrites <= 0) return false;
  // New mutations since the last mid-loop check.
  if (input.successfulWrites <= input.successfulWritesAtLastCheck) return false;
  return input.writeLanded === true || input.forcePreCompletion === true;
}

/**
 * Correctness floor (Slice D): write intent has a successful mutation and
 * verification is not red. Green checks or tier=none both clear the floor;
 * only an executed failing check blocks it.
 *
 * This asks "is the correctness bar met for the work ATTEMPTED?", not "is the
 * whole plan done". Its only consumers — {@link shouldRunQualityPhase} and the
 * Slice D gate in pipeline.ts — read a `true` as permission to unlock the
 * quality push, so anything that makes this return `false` REMOVES
 * supervision. The TaskPlan ledger therefore must not live here: outstanding
 * plan items are handled by a dedicated reflex in
 * {@link decideMidLoopIntervention} that ADDS pressure instead.
 *
 * 2026-07-29 inversion incident: a ledger check was briefly added to this
 * function. Because it gates the quality push rather than completion, a
 * partially-drained ledger silently disabled the only supervision still
 * active after the first write — live run_da68c50b (5 of 6 items outstanding)
 * issued zero quality pushes where pre-change run_7e6b590f issued two.
 */
export function assessCorrectnessFloor(signal: Pick<
  MidLoopSignal,
  "writeIntent" | "successfulWrites" | "verification"
>): boolean {
  if (!signal.writeIntent) return true;
  if (signal.successfulWrites <= 0) return false;
  if (signal.verification?.ran === true && signal.verification.passed === false) {
    return false;
  }
  return true;
}

/**
 * Quality phase: correctness floor met, quality not yet accepted, and budget
 * remains for at least one more quality push (or a forced quality gate).
 */
export function shouldRunQualityPhase(signal: MidLoopSignal): boolean {
  if (!signal.writeIntent) return false;
  if (!assessCorrectnessFloor(signal)) return false;
  if (signal.qualityAccepted === true) return false;
  const used = signal.qualityPushesUsed ?? 0;
  const budget = signal.qualityPushBudget ?? MAX_QUALITY_PUSHES;
  if (used >= budget) return false;
  return (
    signal.implementationPhase === "quality" ||
    signal.forceQualityGate === true ||
    signal.writeLandedSinceLastCheck === true ||
    // Pre-completion / endgame with writes but no quality accept yet.
    (signal.successfulWrites > 0 && (signal.turnCount >= signal.maxTurns || signal.stageRemainingMs <= MID_LOOP_ENDGAME_BUDGET_MS))
  );
}

/** Whether the ambiguous middle / post-write quality case warrants resident escalation. */
export function midLoopWorthAsking(signal: MidLoopSignal): boolean {
  return classifyMidLoopEscalation(signal) !== null;
}

export type MidLoopEscalationClass = "early_exploration" | "priority_quality";

/**
 * Classify why mid-loop wants a resident call. Priority slots are reserved
 * for post-write quality, endgame, post-reroute, and Slice D quality phase.
 */
export function classifyMidLoopEscalation(signal: MidLoopSignal): MidLoopEscalationClass | null {
  if (!signal.writeIntent) return null;

  const verificationFailed =
    signal.verification?.ran === true && signal.verification.passed === false;
  const qualityPhase = shouldRunQualityPhase(signal);
  const postWriteQuality =
    signal.writeLandedSinceLastCheck === true || verificationFailed || qualityPhase;
  const turnRatio = signal.maxTurns > 0 ? signal.turnCount / signal.maxTurns : 0;
  const endgame =
    turnRatio >= MID_LOOP_ENDGAME_TURN_RATIO ||
    signal.stageRemainingMs <= MID_LOOP_ENDGAME_BUDGET_MS;
  const afterReroute = signal.afterReroute === true;

  if (postWriteQuality || endgame || afterReroute) {
    // Priority still requires some signal (not a cold empty turn).
    if (
      postWriteQuality ||
      afterReroute ||
      signal.distinctSuccessfulReads > 0 ||
      signal.successfulWrites > 0 ||
      (signal.failedWriteAttempts ?? 0) > 0
    ) {
      return "priority_quality";
    }
  }

  // Failed write attempts with zero successes: keep priority pressure so the
  // resident continues pushing correctness (not a soft continue / early replan).
  if (
    signal.successfulWrites === 0 &&
    (signal.failedWriteAttempts ?? 0) > 0
  ) {
    return "priority_quality";
  }

  // Pre-write: some reads, no successful mutation yet — classic spiral ambiguity.
  if (signal.successfulWrites === 0 && signal.distinctSuccessfulReads > 0) {
    return "early_exploration";
  }

  return null;
}

/**
 * Whether another resident mid-loop call may be spent given #5 reservation.
 * Early exploration may consume at most (max - reserved) slots; priority may
 * use any remaining slot including the reserved one.
 */
export function maySpendMidLoopEscalation(input: {
  classification: MidLoopEscalationClass;
  used: number;
  earlyUsed: number;
  max?: number;
  reserved?: number;
}): boolean {
  const max = input.max ?? MAX_MID_LOOP_ESCALATIONS;
  const reserved = input.reserved ?? RESERVED_MID_LOOP_ESCALATIONS;
  if (input.used >= max) return false;
  if (input.classification === "priority_quality") return true;
  return input.earlyUsed < Math.max(0, max - reserved);
}

/** #4: bare "continue" is not affirmative — require concrete progress evidence. */
export function hasConcreteProgressEvidence(
  text: string | undefined,
  signal: MidLoopSignal,
): boolean {
  const t = (text ?? "").trim();
  if (t.length < 12) return false;

  const targets = [
    ...(signal.recentReadTargets ?? []),
    ...(signal.recentWriteTargets ?? []),
  ];
  if (targets.some((path) => {
    if (!path) return false;
    if (t.includes(path)) return true;
    const base = path.replace(/\\/g, "/").split("/").pop();
    return Boolean(base && base.length >= 3 && t.includes(base));
  })) {
    return true;
  }

  // Concrete action / evidence language (not vague "looks fine" / "ok").
  return /\b(read|wrote|write|edit|edited|patched|applied|verified|verification|check|checked|test|tested|plan|file|line|syntax|pass(?:ed)?|fail(?:ed)?|diff|mutation|implement)\b/i
    .test(t);
}

export interface ResidentMidLoopParse {
  directive?: string;
  reason?: string;
  progress_evidence?: string;
  /** Slice D: evidence that product quality (not mere correctness) is good enough. */
  quality_evidence?: string;
}

/** Quality-phase evidence: polish language, not just "I wrote a file". */
export function hasQualityEvidence(text: string | undefined, signal: MidLoopSignal): boolean {
  const t = (text ?? "").trim();
  if (t.length < 16) return false;
  if (hasConcreteProgressEvidence(t, signal) &&
    /\b(edge|empty|boundary|robust|polish|clean|simplif|clarity|naming|structure|cover(?:age|s|ed)?|requirement|complete|harden|defensive|one-shot|product|quality|test(?:s|ed)?|handle|graceful|error case)\b/i
      .test(t)
  ) {
    return true;
  }
  return /\b(edge case|empty input|requirement gap|product quality|one-shot|polish(?:ed|ing)?|re-?read|hardened|defensive)\b/i
    .test(t);
}

/**
 * Map resident JSON to a LoopIntervention. Continue is affirmative (#4):
 * uncited continue becomes force_write (pre-write) or inject (post-write).
 * Slice D quality phase: continue/quality_accept need quality_evidence.
 */
export function resolveResidentMidLoopDirective(
  parsed: ResidentMidLoopParse,
  signal: MidLoopSignal,
): DistributiveOmit<LoopIntervention, "escalationId"> {
  const directive = (parsed.directive ?? "continue").trim();
  const reason = parsed.reason?.trim();
  const evidenceText = (parsed.progress_evidence ?? parsed.reason ?? "").trim();
  const qualityText = (parsed.quality_evidence ?? parsed.progress_evidence ?? parsed.reason ?? "").trim();
  const inQualityPhase =
    signal.implementationPhase === "quality" || shouldRunQualityPhase(signal);

  if (directive === "abort_stage") {
    return {
      kind: "abort",
      reason: reason || "resident conductor judged the turn unrecoverable",
      decisionSource: "resident_model",
    };
  }
  if (directive === "force_write") {
    return {
      kind: "force_write",
      note: reason || (inQualityPhase
        ? "resident conductor: apply a quality polish edit now"
        : "resident conductor: apply the change now"),
      decisionSource: "resident_model",
    };
  }
  if (directive === "inject" && reason) {
    return {
      kind: "inject",
      note: reason,
      decisionSource: "resident_model",
    };
  }
  if (directive === "redirect" && reason) {
    return {
      kind: "redirect",
      tool: "alternative",
      note: reason,
      decisionSource: "resident_model",
    };
  }

  // Slice D: quality_accept or continue in quality phase requires quality evidence.
  if (inQualityPhase && (directive === "quality_accept" || directive === "continue")) {
    if (hasQualityEvidence(qualityText, signal)) {
      return { kind: "continue", decisionSource: "resident_model" };
    }
    return {
      kind: "inject",
      note: reason || DEFAULT_QUALITY_PUSH_NOTE,
      decisionSource: directive === "continue" || directive === "quality_accept"
        ? "schema_control"
        : "resident_model",
    };
  }

  // continue (or unknown) — must cite concrete progress to be affirmative.
  if (hasConcreteProgressEvidence(evidenceText, signal)) {
    return { kind: "continue", decisionSource: "resident_model" };
  }

  if (signal.successfulWrites === 0) {
    return {
      kind: "force_write",
      note:
        reason ||
        "continue lacked concrete progress evidence — apply the change with a write tool now.",
      decisionSource: "schema_control",
    };
  }

  return {
    kind: "inject",
    note:
      "Continue rejected: cite concrete progress (file read/written, check result, or plan item advanced) " +
      "before treating the write as complete. Fix quality issues if verification is weak or red.",
    decisionSource: "schema_control",
  };
}

/**
 * Deterministic Slice D quality push when correctness is met but quality has
 * not been accepted and the resident is not asked (or fails open later).
 * Returns null when quality phase is not active.
 */
export function decideQualityPhaseReflex(signal: MidLoopSignal): LoopIntervention | null {
  if (!shouldRunQualityPhase(signal)) return null;
  // Prefer resident judgment; this reflex is the zero-inference floor when
  // the host wants a guaranteed quality push (forceQualityGate) without
  // waiting for a model that may fail open.
  if (signal.forceQualityGate !== true && signal.implementationPhase !== "quality") {
    return null;
  }
  // Only fire deterministic inject when we still have quality budget and
  // the caller marked this as an explicit quality gate (pre-completion).
  if (signal.forceQualityGate === true) {
    return {
      kind: "inject",
      note: DEFAULT_QUALITY_PUSH_NOTE,
      decisionSource: "deterministic_reflex",
    };
  }
  return null;
}

/** Zero-inference reflex decision for one executor turn-loop iteration. */
export function decideMidLoopIntervention(signal: MidLoopSignal): LoopIntervention {
  if (signal.deadToolSuppressed && signal.suppressedToolName) {
    return {
      kind: "redirect",
      tool: signal.suppressedToolName,
      note: `${signal.suppressedToolName} has failed structurally and will not succeed this turn - use an alternative tool.`,
    };
  }

  if (!signal.writeIntent) {
    return { kind: "continue" };
  }

  // Quality-aware post-write reflex: a red verification after a successful
  // write is unambiguous — do not treat "write landed" as task complete.
  if (
    signal.successfulWrites > 0 &&
    signal.verification?.ran === true &&
    signal.verification.passed === false
  ) {
    const detail = (signal.verification.detail || "check failed").replace(/\s+/g, " ").trim().slice(0, 200);
    return {
      kind: "inject",
      note:
        `Verification failed after write (${signal.verification.tier}` +
        `${signal.verification.command ? `: ${signal.verification.command}` : ""}): ${detail}. ` +
        "Fix the implementation before treating the write as complete.",
    };
  }

  // Failed mutations with zero success: deterministic correctness push so the
  // executor cannot spin silent failures until replan (live canary: old_string
  // not found ×2 → effect_gate_no_write without enough force_write pressure).
  if (
    signal.successfulWrites === 0 &&
    (signal.failedWriteAttempts ?? 0) >= 1 &&
    signal.stageRemainingMs > ABORT_BUDGET_FLOOR_MS
  ) {
    return {
      kind: "force_write",
      note: buildFailedWriteNote(signal),
    };
  }

  // Zero-write spiral reflexes only apply before any successful mutation.
  // Slice D quality is handled by resident escalation + schema_control inject
  // (see resolveResidentMidLoopDirective / shouldRunQualityPhase), not a
  // zero-inference shortcut that would skip Qwythos.
  // A successful but incorrect write must NOT short-circuit supervision —
  // the quality path above (or resident escalation) owns that case.
  if (signal.successfulWrites === 0 && signal.distinctSuccessfulReads >= SPIRAL_READ_FLOOR) {
    if (signal.stageRemainingMs <= ABORT_BUDGET_FLOOR_MS) {
      return {
        kind: "abort",
        reason: `write-intent turn with ${signal.distinctSuccessfulReads} reads and zero writes; ` +
          `remaining budget (${Math.round(signal.stageRemainingMs / 1000)}s) is too low to recover - ` +
          "ending now with a clean partial instead of running to the timeout.",
      };
    }
    // 2026-07-26: this used to require `stageRemainingMs <=
    // FORCE_WRITE_BUDGET_FLOOR_MS` (150s), so a spiral with a healthy budget
    // got `continue` every time. run_f5c966fc read ~10 files and never once
    // attempted a write; the first force_write arrived at the floor and the
    // next checkpoint aborted. A read spiral is a spiral at read 5 — how much
    // budget is left changes only whether recovery is still POSSIBLE (the
    // abort branch above), never whether the spiral is real.
    return {
      kind: "force_write",
      note: buildReadSpiralNote(signal),
    };
  }

  // A re-read loop can hide below the distinct-target floor: repeatedly
  // reading the same two files still burns the turn without moving toward the
  // required mutation. Keep this after the legacy distinct-read spiral so the
  // established higher-priority ordering remains intact.
  const totalSuccessfulReads = signal.totalSuccessfulReads ?? 0;
  if (
    signal.successfulWrites === 0 &&
    totalSuccessfulReads >= 6 &&
    totalSuccessfulReads >= 2 * signal.distinctSuccessfulReads
  ) {
    if (signal.stageRemainingMs <= ABORT_BUDGET_FLOOR_MS) {
      return {
        kind: "abort",
        reason: `write-intent turn with ${totalSuccessfulReads} successful reads across ` +
          `${signal.distinctSuccessfulReads} distinct targets and zero writes; ` +
          `remaining budget (${Math.round(signal.stageRemainingMs / 1000)}s) is too low to recover - ` +
          "ending now with a clean partial instead of running to the timeout.",
      };
    }
    return {
      kind: "force_write",
      note: buildReadSpiralNote(
        signal,
        `${totalSuccessfulReads} successful reads across ${signal.distinctSuccessfulReads} distinct targets`,
      ),
    };
  }

  // A plan remainder we cannot possibly finish should end as a NAMED partial,
  // not run to the stage timeout. Checked BEFORE the remaining-work push
  // below: when the budget is already gone, naming what is left and stopping
  // beats asking for more work there is no time to do.
  // (writeIntent is already true here — the top-of-function early return
  // handles !writeIntent — so it is not re-checked below, matching every
  // other branch past that point. The zero-write spiral abort above takes
  // priority when both predicates are true simultaneously: both are
  // early-returns and the spiral branch comes first.)
  if (
    (signal.planItemsRemaining ?? 0) > 0 &&
    signal.stageRemainingMs <= ABORT_BUDGET_FLOOR_MS
  ) {
    return {
      kind: "abort",
      reason:
        `${signal.planItemsRemaining} plan item(s) still unverified with only ` +
        `${Math.round(signal.stageRemainingMs / 1000)}s of stage budget left - ` +
        "ending with a clean partial that names the remaining work instead of " +
        "running to the timeout.",
    };
  }

  // The TaskPlan ledger still has unverified items, and there is budget to
  // keep going: push the executor onto the next item, even before the first
  // successful write lands.
  //
  // This is where the ledger belongs. Once the first write lands, every other
  // pressure mechanism has already switched itself off by design —
  // `shouldPressWriteEffect` and the spiral reflexes above all require
  // `successfulWrites === 0` — so without this branch a multi-item plan has
  // nothing holding the executor open after item one. That is exactly how
  // live run_7e6b590f ended 1-of-7 done. Injecting here sets `midLoopHeldOpen`
  // in the executor loop, which is the mechanism that actually keeps it
  // working; the quality push is left free to fire on its own terms.
  if (
    (signal.planItemsRemaining ?? 0) > 0 &&
    (signal.planNudgesSent ?? 0) < PLAN_REMAINDER_NUDGE_CAP
  ) {
    const remaining = signal.planItemsRemaining ?? 0;
    // 2026-07-31 (run_2c46d082): `activePlanItem` can be the stage-output
    // placeholder ("No planning stage executed.") when a turn's conductor
    // aborts into the deterministic route — no planner runs, but a PREVIOUS
    // turn's ledger still reports items remaining. Naming that placeholder as
    // "the active item" hands the model a null to act on; it was injected 56x
    // byte-identical and 28 of 37 executor turns produced no tool call. Same
    // failure shape as the 2026-07-26 read-spiral note (see buildReadSpiralNote
    // below). Supervision is preserved — only the unactionable clause is
    // dropped, so the branch still injects.
    const activeItem = signal.activePlanItem && !isStageSummaryPlaceholder(signal.activePlanItem)
      ? ` The active item is: ${signal.activePlanItem}.`
      : "";
    const progress = signal.successfulWrites > 0
      ? "A landed write is progress on ONE item, not completion of the plan."
      : "No successful write has landed yet; start by making the current item's change.";
    // Escalate rather than repeat. The first note states the situation; the
    // second one names the fact that it was already ignored and narrows the
    // ask to a single concrete call, mirroring `buildReadSpiralNote`.
    const note = (signal.planNudgesSent ?? 0) === 0
      ? `${remaining} plan item(s) are still unverified — this turn is not done.` +
        `${activeItem} ${progress} ` +
        "Continue with the next unverified item now: make its " +
        "change with edit_file/write_file, then move to the one after it. " +
        "Do not summarise or stop while items remain and budget is left."
      : `Second notice: ${remaining} plan item(s) are still unverified and the ` +
        "previous instruction to continue produced no file change." +
        `${activeItem} Stop describing the work and make ONE concrete edit now — ` +
        "your next tool call must be edit_file or write_file. If you cannot " +
        "identify the next change, say exactly what is blocking you instead of " +
        "restating the plan.";
    return { kind: "inject", noteKind: "plan_remainder", note };
  }

  return { kind: "continue" };
}

/**
 * Force-write notes must lead with the WRITE, and must escalate when ignored.
 *
 * 2026-07-26 (run_13298c8f): the single note began "Re-read the exact target
 * path ..." and was injected ~22 times byte-identical. `deepseek-v4-flash-free`
 * obeyed the leading clause every time and the turn ended with 24 reads and
 * one failed edit. A nudge that opens with an instruction to read is a nudge
 * that sustains the read loop it was written to break.
 */
function buildReadSpiralNote(
  signal: MidLoopSignal,
  readSummary = `${signal.distinctSuccessfulReads} reads`,
): string {
  const sent = signal.forceWriteNudgesSent ?? 0;
  if (sent === 0) {
    return `Call edit_file or write_file now. You have made ${readSummary} and zero writes ` +
      "on a turn whose whole purpose is to change files. You have enough context to make the " +
      "first edit — apply it, then continue.";
  }
  if (sent === 1) {
    return `Still zero writes after ${readSummary}. Stop reading and apply the change. ` +
      "Pick the single most obvious edit you already know how to make, call edit_file with an " +
      "exact old_string from the read you already did, and only then look at anything else.";
  }
  return `This is nudge ${sent + 1}: ${readSummary}, zero writes. Do not call read_file, ` +
    "list_directory, glob or grep again on this turn. Your next tool call must be edit_file or " +
    "write_file. If no exact old_string is available, use write_file with the full new contents " +
    "of the file you have already read.";
}

/**
 * Note for the "tried to write, it failed" case. Recovery genuinely needs a
 * re-read (the old_string did not match), but the write must stay the headline
 * and the instruction must not name fixture files from unrelated benchmarks.
 */
function buildFailedWriteNote(signal: MidLoopSignal): string {
  const attempts = signal.failedWriteAttempts ?? 1;
  const target = signal.recentWriteTargets?.at(-1) ?? signal.recentReadTargets?.at(-1);
  const sent = signal.forceWriteNudgesSent ?? 0;
  const where = target ? ` The last write target was \`${target}\`.` : "";
  if (sent >= 2) {
    return `${attempts} failed write attempt(s) and still zero successful mutations.` + where +
      " Stop retrying the same old_string. Call write_file with the complete new contents of " +
      "the file instead — a whole-file write cannot fail on a match.";
  }
  return `${attempts} failed write attempt(s) and zero successful mutations — the edit did NOT ` +
    "land." + where + " Re-read that exact path once to get its current text, then immediately " +
    "call edit_file with an old_string copied verbatim from what you just read. Do not explore " +
    "other files first.";
}

/** Format enriched signal fields for the resident mid-loop escalation prompt. */
export function formatMidLoopEscalationContext(signal: MidLoopSignal): string {
  const lines = [
    "Mid-loop checkpoint - the executor is still running.",
    `Turn ${signal.turnCount}/${signal.maxTurns}, stage budget remaining: ${Math.round(signal.stageRemainingMs / 1000)}s.`,
    `Write intent: ${signal.writeIntent}. Successful writes so far: ${signal.successfulWrites}. ` +
      `Distinct successful reads: ${signal.distinctSuccessfulReads}.` +
      (signal.failedWriteAttempts ? ` Failed write attempts: ${signal.failedWriteAttempts}.` : ""),
  ];
  if (signal.writeLandedSinceLastCheck) {
    lines.push("A successful write landed since the previous checkpoint — judge quality, not mere presence of a mutation.");
  }
  if (signal.taskObjective) lines.push(`Task objective: ${signal.taskObjective}`);
  if (signal.activePlanItem) lines.push(`Active plan: ${signal.activePlanItem}`);
  if (signal.recentReadTargets?.length) {
    lines.push(`Recent read targets: ${signal.recentReadTargets.join(", ")}`);
  }
  if (signal.recentWriteTargets?.length) {
    lines.push(`Recent write targets: ${signal.recentWriteTargets.join(", ")}`);
  }
  if (signal.recentToolSummaries?.length) {
    lines.push(`Recent tool results:\n- ${signal.recentToolSummaries.join("\n- ")}`);
  }
  if (signal.verification) {
    lines.push(
      `Verification: tier=${signal.verification.tier} ran=${signal.verification.ran} ` +
        `passed=${String(signal.verification.passed)}` +
        (signal.verification.detail ? ` detail=${signal.verification.detail.slice(0, 160)}` : ""),
    );
  }
  if (signal.progressSinceLastCheckpoint) {
    lines.push(`Progress since last checkpoint: ${signal.progressSinceLastCheckpoint}`);
  }
  if (signal.afterReroute) {
    lines.push("This checkpoint is immediately after a deterministic reroute — judge the new trajectory carefully.");
  }
  const phase = signal.implementationPhase
    ?? (shouldRunQualityPhase(signal) ? "quality" : "correctness");
  lines.push(`Implementation phase: ${phase}.`);
  if (phase === "quality") {
    lines.push(
      `Quality pushes used: ${signal.qualityPushesUsed ?? 0}/${signal.qualityPushBudget ?? MAX_QUALITY_PUSHES}.`,
      "CORRECTNESS FLOOR IS MET. Your job is product quality for one-shot free/local executors — " +
        "edge cases, requirement completeness, clarity, robustness — not mere 'a write happened'.",
    );
  }
  lines.push(
    "Respond with ONLY JSON (one of):",
    '{"directive":"continue","progress_evidence":"<concrete file/tool/check progress>","reason":"<optional>"}',
    '{"directive":"quality_accept","quality_evidence":"<why the change is finished-product quality>","reason":"<optional>"}',
    '{"directive":"force_write","reason":"<why write/polish now>"}',
    '{"directive":"inject","reason":"<corrective or quality note for the executor>"}',
    '{"directive":"abort_stage","reason":"<why unrecoverable>"}',
    "Rules: continue is AFFIRMATIVE — progress_evidence (or reason) MUST cite concrete progress " +
      "(path read/written, check result, plan item). Bare {\"directive\":\"continue\"} is rejected. " +
      "In quality phase, quality_accept/continue need quality_evidence (edge cases, completeness, polish). " +
      "A successful write is NOT automatically correct OR high-quality. " +
      "Prefer force_write/inject polish over abort_stage when budget remains.",
  );
  return lines.join("\n");
}
