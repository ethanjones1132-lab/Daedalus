// The context-usage meter is the one quantitative claim in a Session's detail
// disclosure, and it is built from two numbers Native stores. The expression
// that used to render it clamped the ratio with `Math.min(100, …)` and validated
// nothing, so three different records all presented as a measurement: a Session
// whose token total exceeds its context window printed exactly `100.0%` in alarm
// red, indistinguishable from one that is precisely full; a NaN operand passed
// the `context_tokens > 0` guard and printed `NaN%` beside an empty track; and a
// record with no context window dropped the whole row rather than saying so.
//
// This module is where that verdict is derived. A ratio inside the window is a
// measurement and keeps its percentage, its bar, and the existing colour
// thresholds. A ratio above the window states that it is over and prints the
// real number instead of a clamp. An operand this build cannot read reads as
// not available, with a fixed sentence naming which one — never as a number and
// never as an empty bar that looks like zero.
//
// Pure: no React, no Tauri, no clock. Token counts are read as `unknown` on
// purpose; a schema-drifted record arrives at the surface exactly as Native
// serialised it, and the decoder is where that is decided.

/** Printed in place of a percentage whenever the ratio cannot be measured. */
export const CONTEXT_USAGE_UNAVAILABLE = 'Not available';

export type ContextUsageUnavailableReason =
  | 'no-window'
  | 'unreadable-total'
  | 'unreadable-window';

export type ContextUsage =
  | {
      kind: 'measured';
      /** The real ratio, unclamped, for the colour thresholds to read. */
      ratio: number;
      percent: string;
      /** A measurement carries no correction; the percentage is the whole claim. */
      basis: null;
      barPercent: number;
      valueText: null;
    }
  | {
      kind: 'over-window';
      ratio: number;
      percent: string;
      basis: string;
      /** The bar fills to the window; the real ratio is in the text and valueText. */
      barPercent: number;
      valueText: string;
    }
  | {
      kind: 'unavailable';
      reason: ContextUsageUnavailableReason;
      /** No ratio exists, so the colour thresholds fall back to the muted tone. */
      ratio: null;
      percent: string;
      basis: string;
      /** Null so no bar renders: an empty track would read as a measured zero. */
      barPercent: null;
      valueText: null;
    };

const BASIS: Record<ContextUsageUnavailableReason, string> = {
  'no-window': 'This Session record carries no context window, so usage cannot be measured.',
  'unreadable-total':
    'The token total in this Session record is not a readable count, so usage cannot be measured.',
  'unreadable-window':
    'The context window in this Session record is not a readable count, so usage cannot be measured.',
};

const OVER_BASIS =
  'Above the context window this Session recorded, so the meter is over rather than full.';

/** A count this build can divide by: finite, non-negative, and a whole count. */
function readableCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function unavailable(reason: ContextUsageUnavailableReason): ContextUsage {
  return {
    kind: 'unavailable',
    reason,
    ratio: null,
    percent: CONTEXT_USAGE_UNAVAILABLE,
    basis: BASIS[reason],
    barPercent: null,
    valueText: null,
  };
}

export function decodeContextUsage(input: {
  // Both keys are optional on purpose: a record that never carried them is one
  // of the cases this decoder exists to name rather than to divide by.
  totalTokens?: unknown;
  contextTokens?: unknown;
}): ContextUsage {
  // The window is checked first: without one there is nothing to measure
  // against, which is a different fact from a total this build cannot read.
  if (input.contextTokens === null || input.contextTokens === undefined) return unavailable('no-window');
  if (!readableCount(input.contextTokens)) return unavailable('unreadable-window');
  if (input.contextTokens === 0) return unavailable('no-window');
  if (input.totalTokens === null || input.totalTokens === undefined) return unavailable('unreadable-total');
  if (!readableCount(input.totalTokens)) return unavailable('unreadable-total');

  const ratio = (input.totalTokens / input.contextTokens) * 100;
  if (!Number.isFinite(ratio)) return unavailable('unreadable-window');
  const percent = `${ratio.toFixed(1)}%`;

  if (ratio > 100) {
    return {
      kind: 'over-window',
      ratio,
      percent,
      basis: OVER_BASIS,
      barPercent: 100,
      valueText: `${percent} of the context window recorded for this Session — over the window`,
    };
  }
  return { kind: 'measured', ratio, percent, basis: null, barPercent: ratio, valueText: null };
}
