// ═══════════════════════════════════════════════════════════════
// ── memory-injectability — read-only per-row admission verdicts
// ═══════════════════════════════════════════════════════════════
//
// The Overview lists stored memories; it is not a statement that a turn will
// recall them. The native `memory_injectability` command evaluates the SAME
// admission predicate recall uses (scope, status, tier, authority, expiry) for
// the visible ids against one chosen Session scope. A verdict of "recallable"
// means the row survives admission for a matching query — never that the
// current turn's query matches it, and never that it was recalled.

export const INJECTION_REASONS = [
  'status_not_active',
  'tier_filtered',
  'authority_filtered',
  'malformed_timestamp',
  'out_of_scope',
  'expired',
  'not_found',
] as const;

export type InjectionReason = (typeof INJECTION_REASONS)[number];

export interface InjectionVerdict {
  id: string;
  admitted: boolean;
  stale: boolean;
  reason: InjectionReason | null;
}

const REASONS = new Set<string>(INJECTION_REASONS);

/** Fixed display words; no native error text ever reaches the surface. */
export const INJECTION_REASON_LABELS: Record<InjectionReason, string> = {
  status_not_active: 'inactive',
  tier_filtered: 'cold tier',
  authority_filtered: 'legacy or derived authority',
  malformed_timestamp: 'unreadable date',
  out_of_scope: 'other scope',
  expired: 'expired',
  not_found: 'not found',
};

export const INJECTION_BASIS =
  "Evaluated against this Session's recall admission predicate (scope, status, tier, authority and expiry). It does not mean the current query matches.";

/**
 * Strict-enough decode of the read-only projection. A malformed read returns
 * null so the surface shows "not observed" rather than guessing a verdict.
 */
export function decodeInjectability(value: unknown): Record<string, InjectionVerdict> | null {
  if (!Array.isArray(value)) return null;
  const byId: Record<string, InjectionVerdict> = {};
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.admitted !== 'boolean') return null;
    const stale = row.stale === undefined ? false : row.stale;
    if (typeof stale !== 'boolean') return null;
    const reason = row.reason ?? null;
    if (reason !== null && (typeof reason !== 'string' || !REASONS.has(reason))) return null;
    byId[row.id] = { id: row.id, admitted: row.admitted, stale, reason: reason as InjectionReason | null };
  }
  return byId;
}

/** The one display sentence for a verdict. */
export function injectionLabel(verdict: InjectionVerdict): string {
  if (verdict.admitted) return verdict.stale ? 'recallable here · review due' : 'recallable here';
  const reason = verdict.reason ? INJECTION_REASON_LABELS[verdict.reason] : 'filtered';
  return `filtered: ${reason}`;
}
