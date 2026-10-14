import { describe, expect, it } from 'vitest';
import { decodeContextUsage, CONTEXT_USAGE_UNAVAILABLE } from './context-usage';

describe('decodeContextUsage — a ratio this build can measure', () => {
  it('keeps a real ratio, its percentage, and a bar value', () => {
    const usage = decodeContextUsage({ totalTokens: 873, contextTokens: 1000 });
    expect(usage).toEqual({
      kind: 'measured',
      ratio: 87.3,
      percent: '87.3%',
      basis: null,
      barPercent: 87.3,
      valueText: null,
    });
  });

  it('rounds to one decimal place without changing the ratio it measured', () => {
    const usage = decodeContextUsage({ totalTokens: 999, contextTokens: 1000 });
    expect(usage.kind).toBe('measured');
    if (usage.kind !== 'measured') return;
    expect(usage.percent).toBe('99.9%');
    expect(usage.ratio).toBe(99.9);
  });

  it('reads zero tokens used inside a real window as a measured 0.0%, not as an absence', () => {
    const usage = decodeContextUsage({ totalTokens: 0, contextTokens: 1000 });
    expect(usage.kind).toBe('measured');
    if (usage.kind !== 'measured') return;
    expect(usage.percent).toBe('0.0%');
    expect(usage.barPercent).toBe(0);
  });

  it('reads a ratio of exactly 100 as measured, because a full window is a real reading', () => {
    const usage = decodeContextUsage({ totalTokens: 1000, contextTokens: 1000 });
    expect(usage.kind).toBe('measured');
    if (usage.kind !== 'measured') return;
    expect(usage.percent).toBe('100.0%');
    expect(usage.basis).toBeNull();
  });

  it('carries the ratio through for the colour thresholds to read', () => {
    expect(decodeContextUsage({ totalTokens: 410, contextTokens: 1000 })).toMatchObject({ ratio: 41 });
    expect(decodeContextUsage({ totalTokens: 600, contextTokens: 1000 })).toMatchObject({ ratio: 60 });
    expect(decodeContextUsage({ totalTokens: 800, contextTokens: 1000 })).toMatchObject({ ratio: 80 });
  });
});

describe('decodeContextUsage — a ratio above the recorded window', () => {
  it('states the real ratio instead of a clamped 100.0%', () => {
    const usage = decodeContextUsage({ totalTokens: 1264, contextTokens: 1000 });
    expect(usage.kind).toBe('over-window');
    if (usage.kind !== 'over-window') return;
    expect(usage.percent).toBe('126.4%');
    expect(usage.ratio).toBe(126.4);
    expect(usage.basis).toBe(
      'Above the context window this Session recorded, so the meter is over rather than full.',
    );
  });

  it('never reports a clamped 100.0% for a ratio that is over the window', () => {
    for (const total of [1001, 1500, 100000, 12_500_000]) {
      const usage = decodeContextUsage({ totalTokens: total, contextTokens: 1000 });
      expect(usage.kind).toBe('over-window');
      if (usage.kind !== 'over-window') continue;
      expect(usage.percent).not.toBe('100.0%');
    }
  });

  it('fills the bar to the window while keeping the over claim as its accessible value', () => {
    const usage = decodeContextUsage({ totalTokens: 2000, contextTokens: 1000 });
    expect(usage.kind).toBe('over-window');
    if (usage.kind !== 'over-window') return;
    expect(usage.barPercent).toBe(100);
    expect(usage.valueText).toBe('200.0% of the context window recorded for this Session — over the window');
  });

  it('keeps a huge ratio readable rather than overflowing the percentage', () => {
    const usage = decodeContextUsage({ totalTokens: 1e9, contextTokens: 1 });
    expect(usage.kind).toBe('over-window');
    if (usage.kind !== 'over-window') return;
    expect(usage.percent).toBe('100000000000.0%');
  });
});

describe('decodeContextUsage — a record with no context window to measure against', () => {
  it('reads an absent window as not available, never as a number', () => {
    const usage = decodeContextUsage({ totalTokens: 500, contextTokens: null });
    expect(usage).toEqual({
      kind: 'unavailable',
      reason: 'no-window',
      ratio: null,
      percent: CONTEXT_USAGE_UNAVAILABLE,
      basis: 'This Session record carries no context window, so usage cannot be measured.',
      barPercent: null,
      valueText: null,
    });
  });

  it('reads a zero window as not available, never as an empty 0.0% meter', () => {
    const usage = decodeContextUsage({ totalTokens: 500, contextTokens: 0 });
    expect(usage.kind).toBe('unavailable');
    if (usage.kind !== 'unavailable') return;
    expect(usage.reason).toBe('no-window');
    expect(usage.percent).toBe(CONTEXT_USAGE_UNAVAILABLE);
    expect(usage.percent).not.toMatch(/\d/);
    expect(usage.barPercent).toBeNull();
  });

  it('reads an undefined window the same way as a null one', () => {
    expect(decodeContextUsage({ totalTokens: 500 }).kind).toBe('unavailable');
    expect(decodeContextUsage({ totalTokens: 500, contextTokens: undefined })).toEqual(
      decodeContextUsage({ totalTokens: 500, contextTokens: null }),
    );
  });
});

describe('decodeContextUsage — a record whose token counts cannot be read', () => {
  it.each([
    ['a missing total', { totalTokens: null, contextTokens: 1000 }],
    ['a missing total key', { contextTokens: 1000 }],
    ['a string total', { totalTokens: '250', contextTokens: 1000 }],
    ['a NaN total', { totalTokens: Number.NaN, contextTokens: 1000 }],
    ['an infinite total', { totalTokens: Number.POSITIVE_INFINITY, contextTokens: 1000 }],
    ['a negative total', { totalTokens: -250, contextTokens: 1000 }],
    ['a fractional total', { totalTokens: 250.5, contextTokens: 1000 }],
    ['a boolean total', { totalTokens: true, contextTokens: 1000 }],
  ])('reads %s as not available with the total named as unreadable', (_label, input) => {
    const usage = decodeContextUsage(input as { totalTokens?: unknown; contextTokens?: unknown });
    expect(usage.kind).toBe('unavailable');
    if (usage.kind !== 'unavailable') return;
    expect(usage.reason).toBe('unreadable-total');
    expect(usage.basis).toBe(
      'The token total in this Session record is not a readable count, so usage cannot be measured.',
    );
    expect(usage.percent).toBe(CONTEXT_USAGE_UNAVAILABLE);
    expect(usage.barPercent).toBeNull();
  });

  it.each([
    ['a string window', { totalTokens: 250, contextTokens: '1000' }],
    ['a NaN window', { totalTokens: 250, contextTokens: Number.NaN }],
    ['an infinite window', { totalTokens: 250, contextTokens: Number.POSITIVE_INFINITY }],
    ['a negative window', { totalTokens: 250, contextTokens: -1000 }],
    ['a fractional window', { totalTokens: 250, contextTokens: 1000.5 }],
  ])('reads %s as not available with the window named as unreadable', (_label, input) => {
    const usage = decodeContextUsage(input as { totalTokens?: unknown; contextTokens?: unknown });
    expect(usage.kind).toBe('unavailable');
    if (usage.kind !== 'unavailable') return;
    expect(usage.reason).toBe('unreadable-window');
    expect(usage.basis).toBe(
      'The context window in this Session record is not a readable count, so usage cannot be measured.',
    );
    expect(usage.percent).toBe(CONTEXT_USAGE_UNAVAILABLE);
    expect(usage.barPercent).toBeNull();
  });

  it('never prints NaN% for an operand that cannot be read', () => {
    for (const input of [
      { totalTokens: Number.NaN, contextTokens: Number.NaN },
      { totalTokens: 0, contextTokens: 0 },
      { totalTokens: 'x', contextTokens: 'y' },
      {},
    ]) {
      expect(decodeContextUsage(input).percent).not.toContain('NaN');
    }
  });
});

describe('decodeContextUsage — defensive contracts', () => {
  it('never exposes a bar value for a verdict that is not a measurement', () => {
    const unavailable = decodeContextUsage({ totalTokens: Number.NaN, contextTokens: 1000 });
    expect(unavailable.barPercent).toBeNull();
    expect(unavailable.ratio).toBeNull();
  });

  it('leaves its input untouched', () => {
    const input = { totalTokens: 250, contextTokens: 1000 };
    decodeContextUsage(input);
    expect(input).toEqual({ totalTokens: 250, contextTokens: 1000 });
  });

  it('never returns an unbounded ratio as a measured value', () => {
    for (const total of [0, 1, 999, 1000, 1001, 5000]) {
      const usage = decodeContextUsage({ totalTokens: total, contextTokens: 1000 });
      if (usage.kind === 'measured') expect(usage.ratio).toBeLessThanOrEqual(100);
      expect(usage.barPercent).not.toBeNull();
      expect(usage.barPercent as number).toBeGreaterThanOrEqual(0);
      expect(usage.barPercent as number).toBeLessThanOrEqual(100);
    }
  });

  it('prints one fixed sentence per unavailable reason and no native text', () => {
    const reasons = [
      decodeContextUsage({ totalTokens: 1, contextTokens: 0 }),
      decodeContextUsage({ totalTokens: Number.NaN, contextTokens: 1000 }),
      decodeContextUsage({ totalTokens: 250, contextTokens: Number.NaN }),
    ];
    expect(new Set(reasons.map((r) => (r.kind === 'unavailable' ? r.basis : ''))).size).toBe(3);
    for (const usage of reasons) {
      expect(usage.kind).toBe('unavailable');
      if (usage.kind !== 'unavailable') continue;
      expect(usage.basis).toMatch(/^This Session record|^The /);
      expect(usage.basis).not.toMatch(/NaN|undefined|null|synthetic/);
    }
  });
});
