import { describe, expect, it } from 'vitest';
import {
  formatSessionTokenCount,
  formatSessionTurnCount,
  formatSessionStatsLine,
  shouldShowSessionStats,
} from './session-stats';

describe('formatSessionTokenCount', () => {
  it('formats raw token counts under 1k with no decimal', () => {
    expect(formatSessionTokenCount(0)).toBe('0 tok');
    expect(formatSessionTokenCount(1)).toBe('1 tok');
    expect(formatSessionTokenCount(423)).toBe('423 tok');
    expect(formatSessionTokenCount(999)).toBe('999 tok');
  });

  it('formats 1k–999,999 with one decimal in k', () => {
    expect(formatSessionTokenCount(1_000)).toBe('1.0k tok');
    expect(formatSessionTokenCount(1_234)).toBe('1.2k tok');
    expect(formatSessionTokenCount(12_450)).toBe('12.5k tok');
    expect(formatSessionTokenCount(99_999)).toBe('100.0k tok');
    expect(formatSessionTokenCount(999_999)).toBe('1000.0k tok');
  });

  it('formats 1M+ with two decimals in M', () => {
    expect(formatSessionTokenCount(1_000_000)).toBe('1.00M tok');
    expect(formatSessionTokenCount(1_234_567)).toBe('1.23M tok');
    expect(formatSessionTokenCount(12_500_000)).toBe('12.50M tok');
  });

  it('falls back to "0 tok" for non-finite or negative input (defensive guard)', () => {
    expect(formatSessionTokenCount(Number.NaN)).toBe('0 tok');
    expect(formatSessionTokenCount(Number.POSITIVE_INFINITY)).toBe('0 tok');
    expect(formatSessionTokenCount(Number.NEGATIVE_INFINITY)).toBe('0 tok');
    expect(formatSessionTokenCount(-1)).toBe('0 tok');
    expect(formatSessionTokenCount(-1_000)).toBe('0 tok');
  });
});

describe('formatSessionTurnCount', () => {
  it('returns empty string for 0 turns (pill hidden)', () => {
    expect(formatSessionTurnCount(0)).toBe('');
  });

  it('returns empty string for a single turn (avoids "1 turn" noise on first reply)', () => {
    expect(formatSessionTurnCount(1)).toBe('');
  });

  it('returns "<N> turns" for 2+', () => {
    expect(formatSessionTurnCount(2)).toBe('2 turns');
    expect(formatSessionTurnCount(7)).toBe('7 turns');
    expect(formatSessionTurnCount(100)).toBe('100 turns');
  });

  it('returns empty string for non-finite input', () => {
    expect(formatSessionTurnCount(Number.NaN)).toBe('');
  });
});

describe('shouldShowSessionStats', () => {
  it('is false at 0 turns (pill should not appear on a brand-new session)', () => {
    expect(shouldShowSessionStats(0)).toBe(false);
  });

  it('is true for any positive turn count', () => {
    expect(shouldShowSessionStats(1)).toBe(true);
    expect(shouldShowSessionStats(5)).toBe(true);
  });

  it('is false for non-finite turn counts', () => {
    expect(shouldShowSessionStats(Number.NaN)).toBe(false);
    expect(shouldShowSessionStats(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('formatSessionStatsLine', () => {
  it('omits the turn part entirely when turnCount is 0', () => {
    expect(formatSessionStatsLine({ tokens: 0, turnCount: 0 })).toBe('0 tok');
  });

  it('omits the separator when turnCount is 1 (avoids "12.4k tok · 1 turn" noise)', () => {
    expect(formatSessionStatsLine({ tokens: 12_400, turnCount: 1 })).toBe('12.4k tok');
  });

  it('joins with " · " when turnCount >= 2', () => {
    expect(formatSessionStatsLine({ tokens: 12_400, turnCount: 3 })).toBe('12.4k tok · 3 turns');
    expect(formatSessionStatsLine({ tokens: 1_234_567, turnCount: 7 })).toBe('1.23M tok · 7 turns');
  });

  it('falls back to "0 tok" when tokens is invalid even with valid turns', () => {
    expect(formatSessionStatsLine({ tokens: Number.NaN, turnCount: 3 })).toBe('0 tok · 3 turns');
  });
});
