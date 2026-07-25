import type { RunGateResult, RunTarget } from "./run-gate";
import type { ToolCallRecord } from "./stage-output";
import type { SyntaxIssue } from "./syntax-gate";

export type CheckTier = "existing" | "builtin" | "synth" | "none";

export interface CheckResult {
  tier: CheckTier;
  ran: boolean;
  passed: boolean | null;   // null = detected but could not run
  detail: string;           // failing assertion / compiler error, truncated
  command: string;          // what was executed / checked, for telemetry
  durationMs: number;
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
  /** Injected gates (default to the real module functions in the pipeline caller). */
  runSyntax: (toolCalls: readonly ToolCallRecord[]) => Promise<SyntaxIssue[]>;
  runTests: (toolCalls: readonly ToolCallRecord[], request: string, plan: string) => Promise<RunGateResult>;
}

/** Map a run-gate target reason to a reward tier. */
export function classifyRunGateTier(reason: RunTarget["reason"]): CheckTier {
  return reason === "standalone_script" ? "synth" : "existing";
}

/**
 * Merge the outputs of the existing syntax-gate and run-gate into a single
 * tiered CheckResult. Priority: a run-gate that actually RAN (passed/failed)
 * wins its tier; otherwise the syntax-gate is the builtin static check; if
 * neither has anything to say the result is `none`.
 */
export function mergeToCheckResult(input: {
  syntaxIssues: readonly SyntaxIssue[];
  run: RunGateResult;
  hadWrittenCode?: boolean;
  durationMs?: number;
}): CheckResult {
  const durationMs = input.durationMs ?? 0;

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

  // No test ran — fall back to the builtin static check.
  const hadWritten = input.hadWrittenCode ?? true;
  if (!hadWritten) {
    return { tier: "none", ran: false, passed: null, detail: "", command: "", durationMs };
  }
  const passed = input.syntaxIssues.length === 0;
  return {
    tier: "builtin",
    ran: true,
    passed,
    detail: passed ? "" : input.syntaxIssues.map((i) => `[${i.path}] ${i.error}`).join("\n").slice(0, 400),
    command: "syntax_check",
    durationMs,
  };
}

/**
 * Orchestration entry for verification-gated conductor: detect whether code
 * was written, run injected syntax + test gates in parallel, and merge into
 * a single tiered CheckResult.
 */
export async function runVerificationCheck(input: RunVerificationInput): Promise<CheckResult> {
  const startedAt = Date.now();
  const written = hadWrittenCode(input.toolCalls);
  if (!written) {
    return { tier: "none", ran: false, passed: null, detail: "", command: "", durationMs: Date.now() - startedAt };
  }
  const [syntaxIssues, run] = await Promise.all([
    input.runSyntax(input.toolCalls),
    input.runTests(input.toolCalls, input.request, input.plan),
  ]);
  return mergeToCheckResult({ syntaxIssues, run, hadWrittenCode: true, durationMs: Date.now() - startedAt });
}
