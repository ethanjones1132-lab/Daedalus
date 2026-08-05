/**
 * Total supervision directives one turn may spend.
 *
 * Measured 2026-07-20 → 08-05: mid_loop_continue fired 498 times across 46 runs
 * (10.8/run); the worst runs carry 88, 87 and 83 directives. Per-reflex caps
 * exist but nothing bounds the sum, so a capped reflex just relocates the spin
 * to an uncapped one — mid-loop-intervention.ts records that happening on
 * 2026-08-01 when the plan-remainder cap pushed the loop into force_write.
 *
 * 24 is roughly 2x the observed healthy per-run rate: generous for a real
 * multi-stage repair, decisively short of a spin.
 */

import { BASELINE_THETA, policy } from "./orchestration-policy";

/** Baseline θ. Decision sites use `policy().max_directives_per_turn`. */
export const MAX_DIRECTIVES_PER_TURN = BASELINE_THETA.max_directives_per_turn;

/** Directives that end or record a turn — never budget-refused. */
const TERMINAL_DIRECTIVES = new Set([
  "mid_loop_abort",
  "mark_verified",
  "continue",
  "delegate_skip",
]);

export class DirectiveBudget {
  private counts = new Map<string, number>();
  private spent = 0;

  claim(directiveType: string): boolean {
    if (TERMINAL_DIRECTIVES.has(directiveType)) return true;
    if (this.spent >= policy().max_directives_per_turn) return false;
    this.spent++;
    this.counts.set(directiveType, (this.counts.get(directiveType) ?? 0) + 1);
    return true;
  }

  exhausted(): boolean {
    return this.spent >= policy().max_directives_per_turn;
  }

  tally(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}
