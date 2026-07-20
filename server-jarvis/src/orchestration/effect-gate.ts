import type { ExecutorStageOutput, RewriterStageOutput, ToolCallRecord } from "./stage-output";
import type { ExecutionProfile } from "./route-normalization";
import { hasWriteIntent } from "./turn-requirements";

export const WRITE_EFFECT_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

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
  if (failedCalls.length > 0) verdict = "tool_failures";
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
  if (outcome !== "success" || report.clean) return { outcome, errorCode };
  if (report.verdict === "no_write_effect") {
    return { outcome: "failed", errorCode: "effect_gate_no_write_effect" };
  }
  return { outcome: "degraded", errorCode: `effect_gate_${report.verdict}` };
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
