import { describe, expect, test } from 'vitest';
import {
  filterSessions,
  formatFilterResultCount,
  MAX_RESULTS,
  MIN_QUERY_LENGTH,
  type FilterableSession,
} from './session-filter';

function makeSession(over: Partial<FilterableSession> = {}): FilterableSession {
  // Use synthetic ids that contain letters only — otherwise an id like
  // 'a1b2c3d4-...' silently includes digits that turn a subsequence query
  // (e.g. 'g3') into an id match on sessions the test author didn't intend.
  // All defaults use unique letter sets that don't contain 'l' (used by
  // single-character tests), 'g' (used by model-test), or other letters
  // that show up in other tests' queries — so a test can override just the
  // fields it cares about and rely on the rest being inert noise.
  return {
    id: 'sess-qq',     // no 'l', no 'g', no 'm', no 'k'
    name: 'rrow bbb',   // no 'l', no 'g', no 'm', no 'k'
    title: 'ttt nnn',   // no 'l', no 'g', no 'm', no 'k'
    model: 'jjj-x',     // no 'l', no 'g', no 'm', no 'k'
    backend: 'pprr',    // no 'l', no 'g', no 'm', no 'k'
    ...over,
  };
}

describe('session-filter (SessionsPanel search input)', () => {
  // ── 1. empty / whitespace query is a no-op ──
  test('empty query returns the input array verbatim (reference-equal)', () => {
    const sessions = [makeSession()];
    const out = filterSessions(sessions, '');
    expect(out).toBe(sessions);
  });

  test('whitespace-only query returns the input array verbatim', () => {
    const sessions = [makeSession()];
    expect(filterSessions(sessions, '   ')).toBe(sessions);
  });

  test('tab + newline query is treated as whitespace and is a no-op', () => {
    const sessions = [makeSession()];
    expect(filterSessions(sessions, '\t\n  \n')).toBe(sessions);
  });

  // ── 2. subsequence match by name / title / id / model / backend ──
  test('matches by name (case-insensitive)', () => {
    const sessions = [
      makeSession({ name: 'Refactor orchestrator' }),
      makeSession({ name: 'Benchmark tier-2b' }),
    ];
    const out = filterSessions(sessions, 'refactor');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Refactor orchestrator');
  });

  test('matches by title when name is absent', () => {
    const sessions = [
      // Override model so it doesn't accidentally match the query.
      makeSession({ name: undefined, title: 'Untitled', model: 'qwen' }),
      makeSession({ name: 'foo', title: 'gemma tuning', model: 'qwen' }),
    ];
    const out = filterSessions(sessions, 'gemma');
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('gemma tuning');
  });

  test('matches by id prefix (case-insensitive)', () => {
    const a = makeSession({ id: 'abc12345-rest-of-uuid' });
    const b = makeSession({ id: 'def67890-rest-of-uuid' });
    const out = filterSessions([a, b], 'abc');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(a.id);
  });

  test('matches by model (case-insensitive subsequence)', () => {
    const sessions = [
      makeSession({ model: 'gemma4:e2b' }),
      makeSession({ model: 'qwen3.5:9b' }),
    ];
    // "gm4" is a subsequence of "gemma4:e2b" (g,m,4) but not of "qwen3.5:9b".
    // Case-insensitive: "GM4" must hit the same row.
    expect(filterSessions(sessions, 'gm4')).toHaveLength(1);
    expect(filterSessions(sessions, 'GM4')).toHaveLength(1);
  });

  test('matches by backend', () => {
    const sessions = [
      makeSession({ backend: 'openrouter' }),
      makeSession({ backend: 'ollama' }),
    ];
    const out = filterSessions(sessions, 'open');
    expect(out).toHaveLength(1);
    expect(out[0].backend).toBe('openrouter');
  });

  // ── 3. case-insensitive across all fields ──
  test('case-insensitive match on name', () => {
    const sessions = [makeSession({ name: 'GEMMA TUNING' })];
    expect(filterSessions(sessions, 'gemma')).toHaveLength(1);
  });

  // ── 4. MIN_QUERY_LENGTH / MAX_RESULTS thresholds ──
  test('single-character query is honored (MIN_QUERY_LENGTH=1)', () => {
    const sessions = [
      makeSession({ name: 'alpha', id: 'sess-one' }),
      makeSession({ name: 'beta', id: 'sess-two' }),
    ];
    // 'l' is in 'alpha' only, so a single-char query narrows the list to 1.
    expect(filterSessions(sessions, 'l')).toHaveLength(1);
    expect(MIN_QUERY_LENGTH).toBe(1);
  });

  test('result count is capped at MAX_RESULTS', () => {
    const sessions = Array.from({ length: MAX_RESULTS + 5 }, (_, i) =>
      makeSession({ name: `session-${i}` }),
    );
    const out = filterSessions(sessions, 'session');
    expect(out).toHaveLength(MAX_RESULTS);
  });

  // ── 5. no-match and edge cases ──
  test('returns empty array when nothing matches', () => {
    const sessions = [makeSession({ name: 'alpha' })];
    expect(filterSessions(sessions, 'zulu')).toEqual([]);
  });

  test('handles empty sessions array', () => {
    expect(filterSessions([], 'anything')).toEqual([]);
  });

  test('preserves input order (no sort)', () => {
    const a = makeSession({ name: 'a-name' });
    const b = makeSession({ name: 'b-name' });
    const c = makeSession({ name: 'c-name' });
    const out = filterSessions([a, b, c], 'name');
    expect(out.map((s) => s.id)).toEqual([a.id, b.id, c.id]);
  });

  test('does not mutate the input array', () => {
    const sessions = [
      makeSession({ name: 'alpha' }),
      makeSession({ name: 'beta' }),
    ];
    const snapshot = [...sessions];
    filterSessions(sessions, 'a');
    expect(sessions).toEqual(snapshot);
  });

  test('subsequence match: a query char that has no match in the target returns empty', () => {
    // Pins the "subsequence" behavior — a single char that does not appear
    // in either session's haystack should reject both rows, not just one.
    const a = makeSession({ name: 'gemma 3 mini' });
    const b = makeSession({ name: 'gemma 4' });
    // 'k' appears in neither, so the filtered list is empty.
    expect(filterSessions([a, b], 'k')).toHaveLength(0);
    // 'gmk' would need k too — same result.
    expect(filterSessions([a, b], 'gmk')).toHaveLength(0);
    // 'g3' hits 'gemma 3 mini' only.
    expect(filterSessions([a, b], 'g3')).toHaveLength(1);
  });

  // ── 6. formatFilterResultCount ──
  test('formatFilterResultCount omits total when filtered equals total', () => {
    expect(formatFilterResultCount(5, 5)).toBe('(5)');
  });

  test('formatFilterResultCount shows "X of Y" when filtered < total', () => {
    expect(formatFilterResultCount(3, 12)).toBe('(3 of 12)');
  });

  test('formatFilterResultCount shows "0 of N" when filter eliminates everything', () => {
    expect(formatFilterResultCount(0, 8)).toBe('(0 of 8)');
  });
});
