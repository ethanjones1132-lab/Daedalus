import { describe, expect, it } from 'vitest';
import {
  SKILL_SCORE_UNAVAILABLE,
  decodeSkillScore,
  projectCandidateScores,
  projectImprovementScore,
} from './skill-score-reading';

// A key the record never returned, so a fixture can express absence that object
// spread cannot: `{ ...base, confidence: 0.9 }` always carries the key.
const ABSENT = Symbol('absent');

function candidate(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { confidence: 0.9, eval_score: 0.91, ...fields };
}

function without(key: string): Record<string, unknown> {
  const value = candidate();
  delete value[key];
  return value;
}

/** A record that is present, so its projection is never the absent one. */
function scored(fields: Record<string, unknown> = {}): NonNullable<
  ReturnType<typeof projectCandidateScores>
> {
  const view = projectCandidateScores(candidate(fields));
  if (!view) throw new Error('a candidate record projects a score view');
  return view;
}

describe('skill score readability', () => {
  // The values a drifted record actually arrives with: a half-written candidate,
  // an older build's lifecycle output, a migration between the two shapes.
  it('reads an absent operand as no record rather than as a score', () => {
    const reading = decodeSkillScore(undefined, 'confidence');
    expect(reading.kind).toBe('unavailable');
    expect(reading.kind === 'unavailable' && reading.reason).toBe('no-record');
    expect(reading.value).toBeNull();
  });

  // An explicit `null` is the throw site this slice exists for: the writer sent
  // the key, so the record says something the surface cannot show. Calling that
  // an omission would make the fix "make the null vanish".
  it('reads an explicit null as unreadable rather than as an absent field', () => {
    const reading = decodeSkillScore(null, 'confidence');
    expect(reading.kind).toBe('unavailable');
    expect(reading.kind === 'unavailable' && reading.reason).toBe('unreadable');
    expect(reading.basis).toBe(
      'The confidence in this record is not a readable score, so no score is shown.',
    );
  });

  it('reads a non-number, a non-finite number, and a negative score as unreadable', () => {
    for (const value of [ABSENT, null, '0.9', true, {}, [], NaN, Infinity, -Infinity, -0.01, -1]) {
      const reading = decodeSkillScore(value, 'confidence');
      expect(reading.kind).toBe('unavailable');
      expect(reading.kind === 'unavailable' && reading.reason).toBe('unreadable');
    }
  });

  it('never prints a number an unreadable operand could be read as', () => {
    for (const value of [ABSENT, null, undefined, '0.9', NaN, -1]) {
      const reading = decodeSkillScore(value, 'confidence');
      expect(reading.label).toBe(SKILL_SCORE_UNAVAILABLE);
      expect(reading.label).not.toMatch(/\d/);
    }
  });

  it('keeps a readable score and its two-decimal formatting', () => {
    const reading = decodeSkillScore(0.87, 'confidence');
    expect(reading.kind).toBe('measured');
    expect(reading.kind === 'measured' && reading.value).toBe(0.87);
    expect(reading.label).toBe('0.87');
    expect(reading.basis).toBeNull();
  });

  it('reads a genuine zero as a measurement, not as an absent field', () => {
    const reading = decodeSkillScore(0, 'confidence');
    expect(reading.kind).toBe('measured');
    expect(reading.kind === 'measured' && reading.value).toBe(0);
    expect(reading.label).toBe('0.00');
    expect(reading.basis).toBeNull();
  });

  it('reads a score above one as a measurement, because this build cannot know the writer’s scale', () => {
    // No upper bound is assumed: refusing a value above 1 would call a real
    // measurement unreadable, which is the lie this decoder exists to remove.
    const reading = decodeSkillScore(1.5, 'eval_score');
    expect(reading.kind).toBe('measured');
    expect(reading.label).toBe('1.50');
  });

  it('names the field it could not read, once, in one fixed sentence', () => {
    expect(decodeSkillScore(undefined, 'confidence').basis).toBe(
      'This record carries no confidence, so no score is shown.',
    );
    expect(decodeSkillScore('x', 'eval_score').basis).toBe(
      'The eval score in this record is not a readable score, so no score is shown.',
    );
    expect(decodeSkillScore(NaN, 'improvement_score').basis).toBe(
      'The improvement score in this record is not a readable score, so no score is shown.',
    );
  });

  it('keeps a fixed basis vocabulary: no caught value ever reaches a sentence', () => {
    for (const value of ['/home/op/private/eval.log', { path: '/private' }, 'NaN']) {
      expect(decodeSkillScore(value, 'confidence').basis).toBe(
        'The confidence in this record is not a readable score, so no score is shown.',
      );
    }
  });
});

describe('candidate score projection', () => {
  it('projects both scores for a readable record and states no basis', () => {
    const view = scored();
    expect(view.confidence.kind).toBe('measured');
    expect(view.confidence.label).toBe('0.90');
    expect(view.evalScore?.kind).toBe('measured');
    expect(view.evalScore?.label).toBe('0.91');
    expect(view.bases).toEqual([]);
  });

  it('keeps the omission rule for a candidate whose eval has not run', () => {
    // "No eval score" is an expected state, not a fault: the Promote control
    // already says `Run eval first`, so a sentence here would be clutter.
    const view = projectCandidateScores(without('eval_score'))!;
    expect(view.evalScore).toBeNull();
    expect(view.bases).toEqual([]);
    expect(view.confidence.kind).toBe('measured');
  });

  it('still names a present-but-unreadable eval score rather than omitting it', () => {
    const view = scored({ eval_score: null });
    // A returned-but-unreadable score is not an omission: it is a reading with
    // no number in it, and the Promote threshold cannot read a value from it.
    expect(view.evalScore).toMatchObject({ kind: 'unavailable', value: null, label: SKILL_SCORE_UNAVAILABLE });
    expect(view.bases).toEqual([
      'The eval score in this record is not a readable score, so no score is shown.',
    ]);
  });

  it('names a required field the record does not carry at all', () => {
    const view = projectCandidateScores(without('confidence'))!;
    expect(view.confidence.kind).toBe('unavailable');
    expect(view.confidence.label).toBe(SKILL_SCORE_UNAVAILABLE);
    expect(view.bases).toEqual(['This record carries no confidence, so no score is shown.']);
  });

  it('reports both unreadable fields in a fixed order so two readers cannot disagree', () => {
    const view = scored({ confidence: null, eval_score: 'high' });
    expect(view.bases).toEqual([
      'The confidence in this record is not a readable score, so no score is shown.',
      'The eval score in this record is not a readable score, so no score is shown.',
    ]);
  });

  it('projects nothing at all for a surface with no candidate record', () => {
    for (const value of [null, undefined]) {
      expect(projectCandidateScores(value)).toBeNull();
    }
  });

  it('lets a measured score reach the promotion threshold unchanged', () => {
    expect(scored({ eval_score: 0.75 }).evalScore).toMatchObject({
      kind: 'measured',
      value: 0.75,
    });
    expect(scored({ eval_score: 0.74 }).evalScore).toMatchObject({
      kind: 'measured',
      value: 0.74,
    });
  });
});

describe('improvement score projection', () => {
  // `improvement_score` is a count of improvement passes, not a 0-1 ratio:
  // `improvement_score = improvement_score + 1.0` on every pass, over a column
  // declared `REAL NOT NULL DEFAULT 0.0`. A genuine zero therefore means "no
  // improvement yet" and carries no information, which is why it stays hidden —
  // and it must not be dressed up as a fault either.
  it('keeps a real count, with its existing two-decimal formatting', () => {
    const view = projectImprovementScore(2);
    expect(view).toEqual({ kind: 'improved', text: '2.00', basis: null });
  });

  it('withholds a genuine zero without calling it unreadable', () => {
    const view = projectImprovementScore(0);
    expect(view).toEqual({ kind: 'none-yet', text: null, basis: null });
  });

  it('distinguishes an unreadable field from a genuine zero', () => {
    for (const value of [ABSENT, null, undefined, '1', NaN, -1]) {
      const view = projectImprovementScore(value);
      expect(view.kind).toBe('unavailable');
      expect(view.text).toBe(SKILL_SCORE_UNAVAILABLE);
      expect(view.basis).toBeTruthy();
      expect(view.basis).toContain('improvement score');
    }
  });

  it('names an absent improvement count and an unreadable one differently', () => {
    expect(projectImprovementScore(undefined).basis).toBe(
      'This record carries no improvement score, so no score is shown.',
    );
    expect(projectImprovementScore('1').basis).toBe(
      'The improvement score in this record is not a readable score, so no score is shown.',
    );
  });

  it('never prints a number for an unreadable improvement score', () => {
    for (const value of [null, '1', NaN]) {
      const view = projectImprovementScore(value);
      expect(view.text).not.toMatch(/\d/);
      expect(view.basis).not.toContain(String(value));
    }
  });
});
