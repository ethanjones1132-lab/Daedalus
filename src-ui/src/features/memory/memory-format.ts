import type { MemoryEntry } from '../../domain/memory-recall-state';

// Defensive formatters — the memory backend has drifted shape during recovery,
// so the render must never throw on a missing/oddly-typed field (that blanks
// the whole page).

function stringArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export const safeTags = stringArray;
export const safeMessageIds = stringArray;

export function displayValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return 'Not supplied';
  }
  return String(value);
}

export function fmtConfidence(c: number | undefined | null): string {
  return typeof c === 'number' && Number.isFinite(c) ? c.toFixed(2) : '—';
}

export function fmtDate(value: string | undefined | null): string {
  if (!value) return '';
  const t = Date.parse(value);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString();
}

export interface RecallMeta {
  score: number;
  matched: string[];
}

/** Reads `score` / `matched_terms` per entry from an already-validated recall envelope. */
export function recallMetaById(raw: unknown, entries: MemoryEntry[]): Record<string, RecallMeta> {
  const out: Record<string, RecallMeta> = {};
  if (!Array.isArray(raw)) return out;
  entries.forEach((entry, index) => {
    const item = raw[index] as { score?: unknown; matched_terms?: unknown } | undefined;
    if (!item) return;
    out[entry.id] = {
      score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : 0,
      matched: Array.isArray(item.matched_terms) ? item.matched_terms.filter((t): t is string => typeof t === 'string') : [],
    };
  });
  return out;
}

export type DateBucket = 'Today' | 'Yesterday' | 'This week' | 'Earlier this month' | 'Older';

export function dateBucket(value: string | undefined | null, now = Date.now()): DateBucket {
  const t = value ? Date.parse(value) : NaN;
  if (Number.isNaN(t)) return 'Older';
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const delta = startOfToday.getTime() - t;
  if (t >= startOfToday.getTime()) return 'Today';
  if (delta <= day) return 'Yesterday';
  if (delta <= 7 * day) return 'This week';
  if (delta <= 30 * day) return 'Earlier this month';
  return 'Older';
}

export const BUCKET_ORDER: DateBucket[] = ['Today', 'Yesterday', 'This week', 'Earlier this month', 'Older'];
