import { describe, expect, it } from 'vitest';
import { conductorCacheVariant, formatRuntimeProvenance, formatAttemptSummary } from './SystemHealthView';

describe('conductorCacheVariant', () => {
  // The Track A-02 acceptance criterion is >80% prefix reuse on a 3-turn
  // session (see docs/issues/post-phase-4-conductor-evolution.md A-02),
  // so the "green" threshold must be 0.8 — any tightening would create
  // false-positive amber states on a healthy warm conductor.
  it('returns success for hit rates at or above the 0.8 A-02 target', () => {
    expect(conductorCacheVariant(0.8)).toBe('success');
    expect(conductorCacheVariant(0.9)).toBe('success');
    expect(conductorCacheVariant(1.0)).toBe('success');
  });

  it('returns warn for hit rates in the 0.5..0.8 band', () => {
    expect(conductorCacheVariant(0.5)).toBe('warn');
    expect(conductorCacheVariant(0.65)).toBe('warn');
    expect(conductorCacheVariant(0.79)).toBe('warn');
  });

  it('returns error for hit rates below 0.5', () => {
    expect(conductorCacheVariant(0.0)).toBe('error');
    expect(conductorCacheVariant(0.25)).toBe('error');
    expect(conductorCacheVariant(0.49)).toBe('error');
  });

  it('returns error for non-finite or negative rates (defensive)', () => {
    // The server should never emit NaN / Infinity / negative, but a
    // future refactor that computes the rate differently (e.g. dividing
    // by a zero denominator) could. The helper must not silently render
    // a green pill on a corrupt measurement.
    expect(conductorCacheVariant(Number.NaN)).toBe('error');
    expect(conductorCacheVariant(Number.POSITIVE_INFINITY)).toBe('error');
    expect(conductorCacheVariant(Number.NEGATIVE_INFINITY)).toBe('error');
    expect(conductorCacheVariant(-0.1)).toBe('error');
  });
});

describe('formatRuntimeProvenance', () => {
  it('shows version, short server SHA, and effective model', () => {
    expect(formatRuntimeProvenance({ version: '3.0.0', git_sha: '0ca584bb611fbb77e16d45c83bedf74c1d160846', model: 'openrouter/free' }))
      .toBe('3.0.0 · 0ca584bb611f · openrouter/free');
  });

  it('reports unavailable runtime health explicitly', () => {
    expect(formatRuntimeProvenance(null)).toBe('Runtime health unavailable');
  });
});

describe('formatAttemptSummary', () => {
  it('keeps the stage attempt summary compact and secret-free', () => {
    expect(formatAttemptSummary({
      stage: 'synthesizer',
      provider: 'opencode_go',
      model: 'deepseek-v4-flash',
      outcome: 'empty_completion',
      latency_ms: 21000,
    })).toBe('synthesizer Â· opencode_go/deepseek-v4-flash Â· empty_completion Â· 21000ms');
  });
});
