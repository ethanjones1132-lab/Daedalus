import type { ExecutorStageOutput, RewriterStageOutput, ToolCallRecord } from "./stage-output";
import type { ExecutionProfile } from "./route-normalization";
import { hasWriteIntent } from "./turn-requirements";
import { defaultCapabilityIndex } from "../tool-capabilities-default";

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

export interface EffectGateReport {
  clean: boolean;
  verdict: "clean" | "tool_failures" | "no_write_effect";
  failedCalls: Array<{ name: string; detail: string }>;
  writeIntent: boolean;
  successfulWrites: number;
  synthesizerNotice: string;
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
  const successfulWrites = calls.filter(
    (call) => !call.is_error && WRITE_EFFECT_TOOLS.has(call.name),
  ).length;
  let verdict: EffectGateReport["verdict"] = "clean";
  if (hasRepeatedWriteFailureWithoutEffect(calls, writeIntent)) verdict = "no_write_effect";
  else if (failedCalls.length > 0) verdict = "tool_failures";
  else if (writeIntent && successfulWrites === 0) verdict = "no_write_effect";
  const clean = verdict === "clean";
  return {
    clean,
    verdict,
    failedCalls,
    writeIntent,
    successfulWrites,
    synthesizerNotice: clean ? "" : buildNotice(verdict, failedCalls),
  };
}

function buildNotice(verdict: string, failed: Array<{ name: string; detail: string }>): string {
  return [
    "Execution Verification (authoritative — do NOT contradict this):",
    verdict === "tool_failures"
      ? `- ${failed.length} tool call(s) FAILED: ${failed.map((failure) => failure.name).join(", ")}.`
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

/** Two failed mutation attempts with no success exhaust bounded recovery. */
export function hasRepeatedWriteFailureWithoutEffect(
  calls: ToolCallRecord[],
  writeIntent: boolean,
): boolean {
  if (!writeIntent) return false;
  const writes = calls.filter((call) => WRITE_EFFECT_TOOLS.has(call.name));
  return !writes.some((call) => !call.is_error)
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
 * prose. Bounded at 3 so a refusing/incapable model still exits predictably.
 */
export const WRITE_EFFECT_NUDGE =
  "This turn is a CHANGE request. You have write tools available " +
  "(write_file, edit_file, multi_edit, apply_patch). Apply the requested " +
  "change by CALLING one of them now — code or diffs written as prose do " +
  "not modify any file and do not count. After writing, read the file back " +
  "to verify, then finish.";

export function buildWriteEffectNudge(writeTools: string[], expectedTarget: string): string {
  const available = writeTools.length > 0 ? writeTools.join(", ") : "no write tools exposed";
  return [
    "This turn is a CHANGE request and the executor is still in a read loop.",
    `Available write tools: ${available}.`,
    `Expected write target based on the gathered evidence: ${expectedTarget}.`,
    "Call an available write tool now; prose or an unexecuted diff does not modify the workspace. Read the target back after writing to verify it.",
  ].join(" ");
}

/** Select the file with the most genuine successful content reads. */
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
    if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
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
}): boolean {
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
