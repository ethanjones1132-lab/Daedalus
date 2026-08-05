import type { RunGateResult, RunTarget } from "./run-gate";
import type { ToolCallRecord } from "./stage-output";
import type { CheckOutcome } from "./build-check";

export type CheckTier = "existing" | "builtin" | "synth" | "none";

export interface CheckResult {
  tier: CheckTier;
  ran: boolean;
  passed: boolean | null;   // null = detected but could not run
  detail: string;           // failing assertion / compiler error, truncated
  command: string;          // what was executed / checked, for telemetry
  durationMs: number;
  /**
   * Why tier is `none` when a check was declined or skipped.
   * Distinguishes "no code written" from "no build system matched" etc.
   */
  declinedReason?: string;
}

const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

function hadWrittenCode(toolCalls: readonly ToolCallRecord[]): boolean {
  return toolCalls.some((c) => !c.is_error && WRITE_TOOL_NAMES.has(c.name));
}

export interface RunVerificationInput {
  toolCalls: readonly ToolCallRecord[];
  request: string;
  plan: string;
  workspaceRoot: string;
  timeoutMs: number;
  /** Detect + run the project's build-system check (tri-state). */
  runBuild: () => Promise<CheckOutcome>;
  runTests: (toolCalls: readonly ToolCallRecord[], request: string, plan: string) => Promise<RunGateResult>;
}

/** Map a run-gate target reason to a reward tier. */
export function classifyRunGateTier(reason: RunTarget["reason"]): CheckTier {
  return reason === "standalone_script" ? "synth" : "existing";
}

/**
 * Merge the outputs of the existing run-gate and build-check into a single
 * tiered CheckResult. Priority: a run-gate that actually RAN (passed/failed)
 * wins its tier; otherwise the build-check is the builtin static check; if
 * nothing real ran (build-check returned `not_applicable`) the result is `none`.
 * `not_applicable` is the vacuous-green guard — it maps to an honest `none`.
 */
export function mergeToCheckResult(input: {
  run: RunGateResult;
  build: CheckOutcome;
  hadWrittenCode: boolean;
  durationMs?: number;
}): CheckResult {
  const durationMs = input.durationMs ?? 0;
  if (!input.hadWrittenCode) {
    return {
      tier: "none",
      ran: false,
      passed: null,
      detail: "",
      command: "",
      durationMs,
      declinedReason: "no_code_written",
    };
  }
  if (input.run.status === "passed" || input.run.status === "failed") {
    const tier = input.run.reason
      ? classifyRunGateTier(input.run.reason as RunTarget["reason"])
      : "existing";
    const passed = input.run.status === "passed";
    return {
      tier,
      ran: true,
      passed,
      detail: passed ? "" : input.run.issues.map((i) => `[${i.path}] ${i.error}`).join("\n").slice(0, 400),
      command: `run:${input.run.target ?? "?"}`,
      durationMs,
    };
  }

  switch (input.build.kind) {
    case "clean":
      return { tier: "builtin", ran: true, passed: true, detail: "", command: input.build.command, durationMs };
    case "failed":
      return { tier: "builtin", ran: true, passed: false, detail: input.build.detail, command: input.build.command, durationMs };
    case "not_applicable":
      return {
        tier: "none",
        ran: false,
        passed: null,
        detail: "",
        command: "",
        durationMs,
        declinedReason: input.build.reason,
      };
  }
}

/**
 * Orchestration entry for verification-gated conductor: detect whether code
 * was written, run injected build + test gates in parallel, and merge into
 * a single tiered CheckResult.
 */
export async function runVerificationCheck(input: RunVerificationInput): Promise<CheckResult> {
  const startedAt = Date.now();
  const written = hadWrittenCode(input.toolCalls);
  if (!written) {
    return {
      tier: "none",
      ran: false,
      passed: null,
      detail: "",
      command: "",
      durationMs: Date.now() - startedAt,
      declinedReason: "no_code_written",
    };
  }
  const [build, run] = await Promise.all([
    input.runBuild(),
    input.runTests(input.toolCalls, input.request, input.plan),
  ]);
  return mergeToCheckResult({ run, build, hadWrittenCode: true, durationMs: Date.now() - startedAt });
}
