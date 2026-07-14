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
}): EffectGateReport {
  const calls: ToolCallRecord[] = [
    ...(input.executor?.toolCalls ?? []),
    ...(input.rewriter?.toolCalls ?? []),
  ];
  const failedCalls = calls
    .filter((call) => call.is_error)
    .map((call) => ({ name: call.name, detail: (call.output || "").slice(0, 160) }));
  const writeIntent = input.profile === "full" && input.executor !== undefined
    && (input.request === undefined ? true : hasWriteIntent(input.request));
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
