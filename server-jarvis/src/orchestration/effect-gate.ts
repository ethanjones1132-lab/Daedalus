import type { ExecutorStageOutput, RewriterStageOutput, ToolCallRecord } from "./stage-output";
import type { ExecutionProfile } from "./route-normalization";
import type { WriteEffectObservation } from "./content-fingerprint";
import { hasWriteIntent } from "./turn-requirements";
import { defaultCapabilityIndex } from "../tool-capabilities-default";
import type { SemanticPressureBudget } from "./executor-progress-policy";

/**
 * Tools whose success is a real workspace mutation.
 *
 * Derived from the capability taxonomy (`class: "write"`) rather than hand
 * maintained, so a newly-registered write tool earns write credit without
 * anyone remembering to edit this file. `tool-capabilities.test.ts` pins that
 * the derived set still covers every name this list used to carry.
 */
export const WRITE_EFFECT_TOOLS: ReadonlySet<string> = defaultCapabilityIndex().writeEffect;
export const MAX_FAILED_WRITE_ATTEMPTS_WITHOUT_EFFECT = 2;

/** Max times the same write-pressure note text may be injected in one run. */
export const IDENTICAL_WRITE_PRESSURE_NOTE_CAP = 2;

/**
 * Status / log documents that models invent to game the write-effect gate
 * (IMPLEMENTATION_STATUS_CURRENT.md, EXECUTION_LOG.md, …). Basename match:
 * `*_STATUS*.md` / `*_LOG*.md` (case-insensitive). Never satisfies the gate.
 */
const STATUS_OR_LOG_DOC_BASENAME_RE = /_status.*\.md$|_log.*\.md$/i;

/**
 * Path-ish tokens for plan/request target discovery. Conservative: requires a
 * slash-separated path with an extension, or a bare filename with a common
 * source/doc extension.
 */
const PATH_MENTION_RE =
  /(?:^|[\s`"'(=\[])((?:\.?\.?\/)?[\w.-]+(?:\/[\w.-]+)+\.[\w.+-]+|[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|md|json|toml|yml|yaml|cpp|cc|cxx|h|hpp|java|kt|css|html|vue|svelte|sql|sh|ps1))(?=[\s`"'',\):;\]]|$)/gi;

export interface EffectGateReport {
  clean: boolean;
  verdict: "clean" | "tool_failures" | "no_write_effect";
  /** Every failed tool call this turn, for telemetry — includes recovered ones. */
  failedCalls: Array<{ name: string; detail: string }>;
  /**
   * Count of failed calls that were NOT recovered or benign — the ones that
   * actually drive the `tool_failures` verdict. A run whose only failures were
   * a retried edit or a dead-end probe (broken glob, disallowed bash) that it
   * routed around has `consequentialFailures === 0` and is not degraded for it.
   */
  consequentialFailures: number;
  writeIntent: boolean;
  /**
   * Successful write tools that count toward the write-effect gate (excludes
   * status/log docs; when `targetPaths` is set, only task-target paths).
   */
  successfulWrites: number;
  /**
   * Content deltas that count toward the write-effect gate (same filtering as
   * successfulWrites).
   */
  contentDeltas: number;
  synthesizerNotice: string;
}

/** True when the path basename is a status/log progress document. */
export function isStatusOrLogDocPath(path: string): boolean {
  const base = normBasename(path);
  if (!base) return false;
  return STATUS_OR_LOG_DOC_BASENAME_RE.test(base);
}

/** Normalize path separators and trim trailing slashes for comparison. */
export function normalizePathForGate(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Loose path match: exact, suffix, or basename equality (case-insensitive). */
export function pathMatchesTarget(path: string, target: string): boolean {
  const a = normalizePathForGate(path).toLowerCase();
  const b = normalizePathForGate(target).toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith("/" + b) || b.endsWith("/" + a)) return true;
  const ba = a.split("/").pop() ?? "";
  const bb = b.split("/").pop() ?? "";
  return ba.length > 0 && ba === bb;
}

export function pathInTargetSet(path: string, targets: readonly string[]): boolean {
  return targets.some((target) => pathMatchesTarget(path, target));
}

/**
 * Whether a mutated path earns write-effect gate credit.
 * - Status/log docs never count.
 * - When `targetPaths` is non-empty, only those paths (or plan-named targets)
 *   count.
 * - When no targets are available, any non-status path counts (backward compat).
 */
export function countsTowardWriteEffect(
  path: string | undefined,
  targetPaths?: readonly string[],
): boolean {
  if (path && isStatusOrLogDocPath(path)) return false;
  if (!targetPaths || targetPaths.length === 0) {
    // Unpathed successful writes still count when no target set is known
    // (legacy unit fixtures and delegate markers without path args).
    return true;
  }
  if (!path) return false;
  return pathInTargetSet(path, targetPaths);
}

/** Extract path-like mentions from free text (request / plan item prose). */
export function extractPathMentions(text: string): string[] {
  if (!text.trim()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  PATH_MENTION_RE.lastIndex = 0;
  for (const match of text.matchAll(PATH_MENTION_RE)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const key = normalizePathForGate(raw).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/**
 * Build the task target set from explicit paths plus plan/request mentions.
 * Returns `undefined` when nothing usable was found (gate stays path-agnostic
 * except for always-on status/log exclusion).
 */
export function resolveTaskTargetPaths(input: {
  explicit?: readonly string[];
  request?: string;
  planTexts?: readonly string[];
}): string[] | undefined {
  const collected: string[] = [];
  const seen = new Set<string>();
  const push = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed || isStatusOrLogDocPath(trimmed)) return;
    const key = normalizePathForGate(trimmed).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    collected.push(trimmed);
  };
  for (const path of input.explicit ?? []) push(path);
  for (const text of [input.request, ...(input.planTexts ?? [])]) {
    if (!text) continue;
    for (const path of extractPathMentions(text)) push(path);
  }
  return collected.length > 0 ? collected : undefined;
}

export function toolCallWritePath(call: ToolCallRecord): string | undefined {
  const raw = call.arguments?.path ?? call.arguments?.file_path;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/**
 * Claim one injection of a specific write-pressure note. Returns false when
 * the identical text has already been injected `cap` times (default 2) so the
 * host must escalate wording or stop rather than replaying the same sentence.
 */
export function claimIdenticalWritePressureNote(
  tracker: Map<string, number>,
  note: string,
  cap: number = IDENTICAL_WRITE_PRESSURE_NOTE_CAP,
): boolean {
  const key = note.trim();
  if (!key) return false;
  const used = tracker.get(key) ?? 0;
  if (used >= cap) return false;
  tracker.set(key, used + 1);
  return true;
}

export function evaluateEffectGate(input: {
  profile: ExecutionProfile;
  executor?: ExecutorStageOutput;
  rewriter?: RewriterStageOutput;
  request?: string;
  /**
   * 2026-07-18: sticky task-run write intent. Mid-task follow-ups
   * ("re-execute", "continue") carry the task's write contract even though
   * the follow-up text itself names no mutation — without this the gate
   * declared such turns clean and a zero-write "re-execute" shipped as
   * success.
   */
  assumeWriteIntent?: boolean;
  /** Pre/post hashes captured by filesystem handlers during this pipeline run. */
  contentEffects?: readonly WriteEffectObservation[];
  /**
   * W5: task target paths (plan/request-discovered or explicit). When present,
   * only writes to these paths satisfy the write-effect gate. Status/log docs
   * are always excluded regardless.
   */
  targetPaths?: readonly string[];
}): EffectGateReport {
  const calls: ToolCallRecord[] = [
    ...(input.executor?.toolCalls ?? []),
    ...(input.rewriter?.toolCalls ?? []),
  ];
  const failedCalls = calls
    .filter((call) => call.is_error)
    .map((call) => ({ name: call.name, detail: (call.output || "").slice(0, 160) }));
  // When the raw request is available, write intent comes from the request
  // TEXT alone — not from whether an executor happened to run. 2026-07-17
  // incident: "Begin implementing phase 1" was routed synthesizer-only
  // (profile "none", no executor), the old profile/executor precondition kept
  // the gate "clean", and the synthesizer fabricated a completion claim with
  // invented diffs. A change request that produced zero mutations must be
  // reported as such no matter how the turn was routed. The profile-based
  // fallback survives only for legacy callers that cannot supply the request.
  const writeIntent = input.assumeWriteIntent === true || (
    input.request !== undefined
      ? hasWriteIntent(input.request)
      : (input.profile === "full" && input.executor !== undefined)
  );
  const targetPaths = input.targetPaths && input.targetPaths.length > 0
    ? input.targetPaths
    : undefined;
  // W5: gate credit only for non-status writes that land on task targets when
  // a target set is known. Status/log docs never count.
  const successfulWrites = calls.filter(
    (call) =>
      !call.is_error
      && WRITE_EFFECT_TOOLS.has(call.name)
      && countsTowardWriteEffect(toolCallWritePath(call), targetPaths),
  ).length;
  // The delegate reports canonical write tool names but mutates outside the
  // native ToolRuntime, so it has no handler-side observation. Preserve the
  // call-level success in that case. Native write calls always append an
  // observation, including a zero-delta observation for an unchanged patch.
  // Raw (pre-filter) success drives whether content effects are authoritative:
  // a status-doc-only write still produces observations that must be filtered.
  const rawWriteSuccessCount = calls.filter(
    (call) => !call.is_error && WRITE_EFFECT_TOOLS.has(call.name),
  ).length;
  const canUseContentEffects = input.contentEffects !== undefined
    && (input.contentEffects.length > 0 || rawWriteSuccessCount === 0);
  const contentDeltas = canUseContentEffects
    ? input.contentEffects!.filter(
      (effect) => effect.changed && countsTowardWriteEffect(effect.path, targetPaths),
    ).length
    : successfulWrites;
  // A single failed tool call used to flip an otherwise-successful run to
  // `degraded`. On the 2026-07-24 tier-2B run that mislabeled every correct
  // A/C/D run: they were downgraded by a broken glob/grep, a disallowed bash,
  // a probe read, or an edit miss the model then recovered — none of which
  // affected the delivered result. Only *consequential* failures (not recovered
  // by a later same-file write, not a benign probe on a verified-mutation turn)
  // drive the verdict now. no_write_effect / repeated-write-failure protections
  // are evaluated separately and are unchanged.
  const consequentialFailed = calls.filter(
    (call) => call.is_error && !isForgivableFailure(call, calls, contentDeltas, writeIntent),
  );
  let verdict: EffectGateReport["verdict"] = "clean";
  if (hasRepeatedWriteFailureWithoutEffect(calls, writeIntent, targetPaths)) {
    verdict = "no_write_effect";
  } else if (consequentialFailed.length > 0) {
    verdict = "tool_failures";
  } else if (writeIntent && contentDeltas === 0) {
    verdict = "no_write_effect";
  }
  const clean = verdict === "clean";
  const consequentialForNotice = consequentialFailed.map(
    (call) => ({ name: call.name, detail: (call.output || "").slice(0, 160) }),
  );
  return {
    clean,
    verdict,
    failedCalls,
    consequentialFailures: consequentialFailed.length,
    writeIntent,
    successfulWrites,
    contentDeltas,
    synthesizerNotice: clean ? "" : buildNotice(verdict, consequentialForNotice, successfulWrites, contentDeltas),
  };
}

function normBasename(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return (cleaned.split("/").pop() ?? "").toLowerCase();
}

/**
 * A failed call should not, by itself, flip an otherwise-successful run to
 * `degraded` when it was recovered or is inconsequential:
 *   1. a failed write/edit whose target file was later written successfully
 *      (same basename) — the model retried and the file did change; or
 *   2. a failed read/search/shell probe on a turn that still produced a
 *      verified mutation (writeIntent && contentDeltas > 0) — the model routed
 *      around a dead-end tool (broken glob/grep, disallowed bash) and still
 *      delivered the effect.
 * Write failures with no same-file recovery stay consequential, so a failed
 * write to the REAL target is never masked by an unrelated file's success.
 */
function isForgivableFailure(
  failed: ToolCallRecord,
  calls: ToolCallRecord[],
  contentDeltas: number,
  writeIntent: boolean,
): boolean {
  if (WRITE_EFFECT_TOOLS.has(failed.name)) {
    const target = normBasename(failed.arguments?.path);
    if (!target) return false;
    return calls.some(
      (candidate) => candidate !== failed
        && !candidate.is_error
        && WRITE_EFFECT_TOOLS.has(candidate.name)
        && normBasename(candidate.arguments?.path) === target,
    );
  }
  return writeIntent && contentDeltas > 0;
}

function buildNotice(
  verdict: string,
  failed: Array<{ name: string; detail: string }>,
  successfulWrites = 0,
  contentDeltas = 0,
): string {
  return [
    "Execution Verification (authoritative — do NOT contradict this):",
    verdict === "tool_failures"
      ? `- ${failed.length} tool call(s) FAILED: ${failed.map((failure) => failure.name).join(", ")}.`
      : successfulWrites > 0 && contentDeltas === 0
        ? "- Write tool calls completed, but your edits did not change any file content."
      : "- This was a change request but ZERO file mutations succeeded.",
    "- Do not state or imply that the task completed successfully.",
    "- Report what actually happened and what failed.",
  ].join("\n");
}

export function applyEffectGate(
  outcome: "success" | "degraded" | "failed",
  errorCode: string | undefined,
  report: EffectGateReport,
): { outcome: "success" | "degraded" | "failed"; errorCode?: string } {
  // Repeated verified write failures are terminal even when the executor is
  // already degraded. A fresh zero-write result keeps the historical recovery
  // path, and a pre-existing hard failure remains authoritative.
  if (
    report.verdict === "no_write_effect"
    && (outcome === "success" || isTerminalNoWriteEffect(report))
  ) {
    return { outcome: "failed", errorCode: "effect_gate_no_write_effect" };
  }
  if (outcome !== "success" || report.clean) return { outcome, errorCode };
  return { outcome: "degraded", errorCode: `effect_gate_${report.verdict}` };
}

/**
 * Two failed mutation attempts with no *gate-credit* success exhaust bounded
 * recovery. Status-doc / off-target successes do not cancel the terminal path.
 */
export function hasRepeatedWriteFailureWithoutEffect(
  calls: ToolCallRecord[],
  writeIntent: boolean,
  targetPaths?: readonly string[],
): boolean {
  if (!writeIntent) return false;
  const writes = calls.filter((call) => WRITE_EFFECT_TOOLS.has(call.name));
  const gateSuccess = writes.some(
    (call) => !call.is_error && countsTowardWriteEffect(toolCallWritePath(call), targetPaths),
  );
  return !gateSuccess
    && writes.filter((call) => call.is_error).length >= MAX_FAILED_WRITE_ATTEMPTS_WITHOUT_EFFECT;
}

export function isTerminalNoWriteEffect(report: EffectGateReport): boolean {
  return report.verdict === "no_write_effect"
    && report.successfulWrites === 0
    && report.failedCalls.filter((call) => WRITE_EFFECT_TOOLS.has(call.name)).length
      >= MAX_FAILED_WRITE_ATTEMPTS_WITHOUT_EFFECT;
}

/**
 * In-loop write pressure for the executor (2026-07-17 incident): on live
 * write-intent turns the executor read a couple of files and then narrated
 * the change as prose — the only mid-loop nudge in the runtime was the
 * READ-evidence rubric, which actively steers toward read-only tools. When
 * the model is about to end a full-profile write turn with zero successful
 * mutations, the loop sends a bounded write nudge instead of accepting the
 * prose.
 *
 * Run-level bound: `SemanticPressureBudget.claim("write_effect")` is once per
 * agent run (shared with mid-loop force_write). The local `nudgesSent < 3`
 * cap remains a safety net for callers that have not wired the budget.
 */
export const WRITE_EFFECT_NUDGE =
  "This turn is a CHANGE request. You have write tools available " +
  "(write_file, edit_file, multi_edit, apply_patch). Apply the requested " +
  "change by CALLING one of them now — code or diffs written as prose do " +
  "not modify any file and do not count. After writing, read the file back " +
  "to verify, then finish.";

/** Safe fallback when no non-status write target is known. */
export const GENERIC_WRITE_TARGET_LABEL = "the requested workspace file";

/**
 * Resolve a path safe to name in a write-pressure nudge. Status/log basenames
 * are never returned — they would steer the model into the gaming path.
 */
export function resolveNamedWriteTarget(
  expectedTarget?: string,
  taskTargets?: readonly string[],
): string {
  const preferred = (taskTargets ?? []).find((path) => path && !isStatusOrLogDocPath(path));
  if (preferred) return preferred;
  const evidence = expectedTarget?.trim();
  if (
    evidence
    && evidence !== GENERIC_WRITE_TARGET_LABEL
    && !isStatusOrLogDocPath(evidence)
  ) {
    return evidence;
  }
  return GENERIC_WRITE_TARGET_LABEL;
}

/**
 * Build a write-pressure note. Prefer a concrete task target when known
 * (W5.2); fall back to the evidence-derived path. Never names status/log docs.
 */
export function buildWriteEffectNudge(
  writeTools: string[],
  expectedTarget: string,
  taskTargets?: readonly string[],
): string {
  const available = writeTools.length > 0 ? writeTools.join(", ") : "no write tools exposed";
  const preferred = (taskTargets ?? []).find((path) => path && !isStatusOrLogDocPath(path));
  const target = resolveNamedWriteTarget(expectedTarget, taskTargets);
  const targetClause = preferred
    ? `Required write target from the task/plan: ${preferred}. Apply the requested edit there — status or log docs do not count.`
    : `Expected write target based on the gathered evidence: ${target}.`;
  return [
    "This turn is a CHANGE request and the executor is still in a read loop.",
    `Available write tools: ${available}.`,
    targetClause,
    "Call an available write tool now; prose or an unexecuted diff does not modify the workspace. Read the target back after writing to verify it.",
  ].join(" ");
}

/**
 * Spend the run-level `write_effect` pressure slot. Returns true only when the
 * caller may inject write-pressure text. Without a budget, always allows
 * (legacy callers keep the local nudge cap only).
 */
export function claimWriteEffectPressure(budget?: SemanticPressureBudget): boolean {
  if (!budget) return true;
  return budget.claim("write_effect");
}

/**
 * Select the file with the most genuine successful content reads.
 * Status/log docs are ignored so they cannot become the named write target.
 */
export function mostReadSuccessfulFile(calls: ToolCallRecord[]): string | undefined {
  const counts = new Map<string, number>();
  for (const call of calls) {
    if (
      call.name !== "read_file"
      || call.is_error
      || call.output.trim().length === 0
      || call.output.includes("[duplicate call deflected]")
    ) {
      continue;
    }
    const path = typeof call.arguments.path === "string" ? call.arguments.path.trim() : "";
    if (path && !isStatusOrLogDocPath(path)) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  let target: string | undefined;
  let max = 0;
  for (const [path, count] of counts) {
    if (count > max) {
      target = path;
      max = count;
    }
  }
  return target;
}

export function shouldPressWriteEffect(input: {
  writeIntent: boolean;
  profile: ExecutionProfile;
  successfulWrites: number;
  toolCallsEmitted: boolean;
  duplicateReadDeflections: number;
  distinctSuccessfulReads: number;
  nudgesSent: number;
  turnCount: number;
  maxTurns: number;
  /**
   * When false, the run-level write_effect slot is already spent — do not
   * press again (caller may still record `semantic_pressure_suppressed`).
   * Omit/true = available.
   */
  writeEffectPressureAvailable?: boolean;
}): boolean {
  if (input.writeEffectPressureAvailable === false) return false;
  const readLoopEscalation = input.toolCallsEmitted && (
    input.duplicateReadDeflections >= 2
    || (
      input.turnCount >= input.maxTurns - 2
      && input.distinctSuccessfulReads >= 4
    )
  );
  return input.writeIntent
    && input.profile === "full"
    && input.successfulWrites === 0
    && input.nudgesSent < 3
    && input.turnCount < input.maxTurns
    && (!input.toolCallsEmitted || readLoopEscalation);
}
