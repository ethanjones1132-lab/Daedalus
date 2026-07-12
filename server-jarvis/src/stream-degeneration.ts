// Detects decoding degeneration (a unit of text repeating verbatim) in a
// growing stream buffer. Checks only a bounded tail so it can run on every
// few chunks without cost. Distinct from orchestration/repetition-guard.ts,
// which compares ACROSS turns; this catches loops WITHIN one generation.

const TAIL_WINDOW = 480; // chars inspected
const MIN_BUFFER = 240; // don't judge tiny outputs
const MIN_REPEATS = 5; // unit must repeat at least this often in the tail
const MIN_UNIT = 8; // ignore ultra-short periods (whitespace, table pipes)

/** Smallest period of s via KMP failure function; s.length if aperiodic. */
export function smallestPeriod(s: string): number {
  const n = s.length;
  const fail = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    let j = fail[i - 1];
    while (j > 0 && s[i] !== s[j]) j = fail[j - 1];
    if (s[i] === s[j]) j++;
    fail[i] = j;
  }
  const period = n - fail[n - 1];
  return n % period === 0 ? period : n;
}

export function detectDegenerateTail(buffer: string): boolean {
  if (buffer.length < MIN_BUFFER) return false;
  const tail = buffer.slice(-TAIL_WINDOW);
  const period = smallestPeriod(tail);
  if (period >= MIN_UNIT && period <= tail.length / MIN_REPEATS) return true;
  // Fallback for a long unit that repeats but the tail isn't unit-aligned:
  // check whether the last quarter of the tail appears at least MIN_REPEATS
  // times inside the tail.
  const probe = tail.slice(-Math.floor(TAIL_WINDOW / 4));
  if (probe.trim().length < MIN_UNIT) return false;
  let count = 0;
  let idx = tail.indexOf(probe);
  while (idx !== -1) {
    count++;
    idx = tail.indexOf(probe, idx + 1);
  }
  return count >= MIN_REPEATS;
}
