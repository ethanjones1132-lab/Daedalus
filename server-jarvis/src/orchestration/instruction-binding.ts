// server-jarvis/src/orchestration/instruction-binding.ts
// ═══════════════════════════════════════════════════════════════
// Binds the instruction a stage's worker actually receives to the
// instruction the self-tuning A/B selector arbitrated.
//
// The selector runs once per turn, before the pipeline (index.ts), and
// expresses a baseline pick by *removing* the stage from the selected
// set. The decision that produced the original `worker_instructions`
// is therefore no longer authoritative for that stage: re-reading it
// mid-loop would send the Conductor's text to a worker whose outcome
// is attributed to the baseline arm, and the A/B loop would learn from
// a prompt it never chose.
//
// A *revised* decision is different. Replan authority is explicit: when
// the conductor re-routes and supplies fresh instructions, those are
// the ones the remaining segments must run.
// ═══════════════════════════════════════════════════════════════

import type { WorkerInstructions } from "./coordinator";
import { hashInstruction } from "./worker-prompt";

export interface InstructionRevisionReport {
  /** The exact instruction set handed to the workers. */
  instructions: WorkerInstructions | undefined;
  /**
   * True only when the executed text came from a replan decision rather than
   * from the arbitrated selection. Drives whether the turn's A/B arm
   * attribution still describes the prompt that was sent.
   */
  revised: boolean;
}

function hasInstructions(instructions: WorkerInstructions | undefined): boolean {
  return Boolean(instructions && Object.keys(instructions).length > 0);
}

export function resolveSegmentInstructions(args: {
  decisionInstructions: WorkerInstructions | undefined;
  selectedInstructions: WorkerInstructions | undefined;
  decisionRevised: boolean;
}): InstructionRevisionReport {
  if (args.decisionRevised && hasInstructions(args.decisionInstructions)) {
    return { instructions: args.decisionInstructions, revised: true };
  }
  // Unrevised (or a revision that supplied nothing): the selection is the
  // only authority. Falling back to the selection after a replan keeps the
  // recorded arm attribution true instead of withholding it for no reason.
  return { instructions: args.selectedInstructions, revised: false };
}

/**
 * Whether the text a worker received is the text the selector arbitrated for
 * that stage. Whitespace-only differences are the same instruction; a
 * baseline send is `undefined` on both sides.
 */
export function sentInstructionMatchesSelection(
  selected: string | undefined,
  sent: string | undefined,
): boolean {
  return normalizeInstruction(selected) === normalizeInstruction(sent);
}

/** The instruction text a worker actually received, or undefined for the stage baseline. */
export function normalizeInstruction(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Provenance label for a prompt the selector did not choose. The A/B selector
 * only ever reads `conductor:<hash>` and `baseline`, so this label can never be
 * picked up as a comparable arm — it records what ran without feeding the
 * bandit.
 */
export function unselectedInstructionVariant(sent: string): string {
  return `unselected:${hashInstruction(sent)}`;
}
