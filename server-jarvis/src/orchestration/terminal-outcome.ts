// ═══════════════════════════════════════════════════════════════
// ── Terminal run-outcome reporting ──
// ═══════════════════════════════════════════════════════════════
// One seam for the terminal `result` frame's `subtype` / `code`.
//
// Audit item 2 (2026-10-29): a complete-looking answer was displayed, the
// turn then settled as `partial`, and the client recorded/displayed
// `inference_partial`. The original live run's cause was NEVER established, so
// this seam does not assume one. What the source did establish: the terminal
// frame dropped the run's own `error_code` for `degraded` outcomes (only
// `partial` forwarded it), and the client invented `inference_partial` when a
// partial frame carried no code. The outcome vocabulary is unchanged — success
// still maps to success, failed to error, degraded/partial to partial — but a
// non-success terminal now carries the run's own `error_code` when the server
// produced one, and carries no code (rather than a fabricated one) when it did
// not.
//
// Repetition keeps its existing precedence: the no-progress tag wins over the
// pipeline's own code, exactly as the inline call site did before.
import type { StreamSession } from "../stream-emitter";
import { terminalSubtypeForRunOutcome } from "./task-run";
import type { RoutePlanSummary } from "./route-plan";

export type TerminalRunOutcome = "success" | "degraded" | "failed" | "partial";

/** The terminal `result` option shape `StreamSession.finish` accepts. */
export interface TerminalFinishOptions {
  isError?: boolean;
  subtype?: "success" | "error" | "partial";
  code?: string;
  route?: RoutePlanSummary;
}

export interface TerminalResultFields {
  subtype: "success" | "partial" | "error";
  code?: string;
  /**
   * The completion policy's own reason for a non-success outcome (for example
   * `task_plan_open` or `pipeline_partial`). Sent separately from `code` so a
   * `partial` turn never arrives with no reason at all, while `code` keeps its
   * existing meaning (pipeline error codes, some of which are terminal errors).
   */
  reason?: string;
}

/**
 * Decide the terminal frame's subtype/code for one verified run outcome.
 *
 * A code is reported only when the run was not a success AND the server
 * actually produced one. Nothing here promotes a non-success outcome to
 * success, and nothing invents a reason.
 */
export function terminalResultFields(input: {
  outcome: TerminalRunOutcome;
  errorCode?: string | null;
  repeated: boolean;
  reason?: string | null;
}): TerminalResultFields {
  const subtype = terminalSubtypeForRunOutcome(input.outcome);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (input.repeated) {
    // Existing behaviour: a repeated turn is tagged with the no-progress code
    // regardless of the pipeline's own error code.
    return { subtype, code: "no_progress_repetition", ...(reason ? { reason } : {}) };
  }
  if (input.outcome === "success") return { subtype };
  const code = typeof input.errorCode === "string" ? input.errorCode.trim() : "";
  return { subtype, ...(code ? { code } : {}), ...(reason ? { reason } : {}) };
}

/** Publish the terminal outcome on the stream through the single seam above. */
export async function finishWithRunOutcome(
  session: Pick<StreamSession, "finish">,
  input: {
    result: string;
    outcome: TerminalRunOutcome;
    errorCode?: string | null;
    repeated: boolean;
    reason?: string | null;
    route?: RoutePlanSummary;
    /** Fatal text that the UI must show as an error banner, not a chat answer. */
    isError?: boolean;
  },
): Promise<void> {
  await session.finish(input.result, {
    ...terminalResultFields(input),
    ...(input.isError ? { isError: true } : {}),
    ...(input.route ? { route: input.route } : {}),
  });
}
