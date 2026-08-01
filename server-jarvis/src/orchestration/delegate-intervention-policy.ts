/**
 * Mid-loop intervention policy for the Claude CLI delegate stream.
 *
 * The stock Claude CLI cannot accept mid-stream user notes, so historical
 * behavior aborted the process on every force_write and handed off to native.
 * That aborts productive exploration (reads before the write) and races the
 * native fallback before a write can land.
 *
 * Policy order (first match wins):
 *   1. explicit abort → abort
 *   2. verified write → observe (never discard landed mutation)
 *   3. policy denial / repeated failed writes → handoff
 *   4. nearly exhausted native-fallback reserve → handoff
 *   5. exploration deadline → handoff
 *   6. otherwise → defer (keep CLI alive; persist deferred directive only)
 */

import type { LoopIntervention } from "./mid-loop-intervention";

export type DelegateInterventionAction = "observe" | "defer" | "handoff" | "abort";

export interface DelegateInterventionInput {
  intervention: LoopIntervention;
  successfulReads: number;
  successfulWrites: number;
  failedWrites: number;
  policyDenied: boolean;
  elapsedMs: number;
  stageRemainingMs: number;
  explorationLimitMs: number;
  nativeFallbackReserveMs: number;
}

/** How many failed write attempts count as "repeated" for handoff. */
export const REPEATED_FAILED_WRITES_THRESHOLD = 2;

/**
 * Decide how the host should enact a mid-loop intervention against a live
 * Claude CLI delegate process.
 */
export function decideDelegateIntervention(
  input: DelegateInterventionInput,
): DelegateInterventionAction {
  // 1. Explicit abort is always terminal.
  if (input.intervention.kind === "abort") {
    return "abort";
  }

  // 2. Never discard a verified write — only record (observe).
  if (input.successfulWrites > 0) {
    return "observe";
  }

  // 3. Policy denial or repeated failed writes → hand off to native.
  if (input.policyDenied || input.failedWrites >= REPEATED_FAILED_WRITES_THRESHOLD) {
    return "handoff";
  }

  // 4. Stage budget nearly exhausted — preserve reserve for native fallback.
  if (
    Number.isFinite(input.stageRemainingMs) &&
    input.stageRemainingMs <= input.nativeFallbackReserveMs
  ) {
    return "handoff";
  }

  // 5. Exploration window closed without a write → hand off.
  if (input.elapsedMs > input.explorationLimitMs) {
    return "handoff";
  }

  // 6. Productive exploration still in window — defer pressure, keep CLI alive.
  return "defer";
}
