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

export type TerminalRunOutcome = "success" | "degraded" | "failed" | "partial";

/** The terminal `result` option shape `StreamSession.finish` accepts. */
export interface TerminalFinishOptions {
  isError?: boolean;
  subtype?: "success" | "error" | "partial";
  code?: string;
}

export interface TerminalResultFields {
  subtype: "success" | "partial" | "error";
  code?: string;
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
}): TerminalResultFields {
  const subtype = terminalSubtypeForRunOutcome(input.outcome);
  if (input.repeated) {
    // Existing behaviour: a repeated turn is tagged with the no-progress code
    // regardless of the pipeline's own error code.
    return { subtype, code: "no_progress_repetition" };
  }
  if (input.outcome === "success") return { subtype };
  const code = typeof input.errorCode === "string" ? input.errorCode.trim() : "";
  return code ? { subtype, code } : { subtype };
}

/** Publish the terminal outcome on the stream through the single seam above. */
export async function finishWithRunOutcome(
  session: Pick<StreamSession, "finish">,
  input: {
    result: string;
    outcome: TerminalRunOutcome;
    errorCode?: string | null;
    repeated: boolean;
  },
): Promise<void> {
  await session.finish(input.result, terminalResultFields(input));
}
