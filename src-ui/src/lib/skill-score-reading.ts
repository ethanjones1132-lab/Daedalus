// A skill's scores are the one quantitative claim the Skills surface makes about
// a candidate, and three of them are read straight off `invoke` with no decoder
// while a fourth in the same object is correctly guarded. The unguarded ones
// decided what to print by calling `toFixed` on whatever arrived, so one `null`
// in one optional field — a half-written candidate, an older build's lifecycle
// output, a migration between the two shapes — threw inside the render and took
// the whole route with it: the list, the search, the detail card, the revision
// history and every lifecycle action, replaced by a boundary message whose Retry
// re-ran the same read and hit the same `null`.
//
// This module is where each operand's verdict is derived, so the two places that
// read one field cannot disagree about it. Three rules, and each is a fact about
// the record rather than a mood:
//
//   * A readable score keeps its number and its `.toFixed(2)` formatting. A
//     genuine `0` is a measurement, not an absence, and is never dressed up as
//     a fault. No upper bound is assumed: this build has no evidence of a
//     writer on another scale, and refusing a value above 1 would call a real
//     measurement unreadable.
//   * An operand this build cannot vouch for — a non-number, a non-finite
//     number, a negative score — reads as absent, with one fixed sentence naming
//     the field, and never as a number. No caught value reaches a sentence.
//   * Absence and unreadability are different facts and read differently. A
//     required field the record does not carry is named. An optional field that
//     was never filled in stays omitted, because "no eval has run yet" is an
//     expected state the Promote control already states in its own title. A
//     field the writer emitted as `null` is neither: it is named, because the
//     record said something the surface cannot show.
//
// `improvement_score` is the exception, and the module says why: Native stores a
// count of improvement passes, not a ratio — `improvement_score REAL NOT NULL
// DEFAULT 0.0` in the migration, incremented by 1.0 on every pass in
// `engine.rs` — so a genuine zero means "no improvement yet" and carries no
// information worth a line on a card. A real zero therefore stays hidden, and an
// unreadable count now says so instead of being indistinguishable from it.
//
// Pure: no React, no Tauri, no clock. Fields are read as `unknown` on purpose —
// a drifted record arrives at the surface exactly as the writer serialised it,
// and this is where that is decided.

/** Printed in place of a score whenever the operand cannot be read. */
export const SKILL_SCORE_UNAVAILABLE = 'Not available';

export type SkillScoreField = 'confidence' | 'eval_score' | 'improvement_score';

export type SkillScoreUnavailableReason =
  /** The key was never in the record: the field has not been filled in. */
  | 'no-record'
  /**
   * The field is there and this build cannot read it as a score. An explicit
   * `null` is here rather than in `no-record`: the writer emitted the key, so
   * the record says something the surface cannot show, and saying so is the
   * difference between an honest omission and a silent one.
   */
  | 'unreadable';

export type SkillScoreReading =
  | {
      kind: 'measured';
      reason: null;
      /** The real score, for a surface's own threshold to read. */
      value: number;
      /** The score as the surface prints it, unchanged from before. */
      label: string;
      /** A measurement carries no correction; the number is the whole claim. */
      basis: null;
    }
  | {
      kind: 'unavailable';
      reason: SkillScoreUnavailableReason;
      /** Null so no threshold can read a score out of a field nobody could read. */
      value: null;
      label: string;
      basis: string;
    };

/** How each field is named in a sentence. The key is the record's own name. */
const FIELD_NAMES: Record<SkillScoreField, string> = {
  confidence: 'confidence',
  eval_score: 'eval score',
  improvement_score: 'improvement score',
};

const BASIS: Record<SkillScoreUnavailableReason, (field: string) => string> = {
  'no-record': (field) => `This record carries no ${field}, so no score is shown.`,
  'unreadable': (field) =>
    `The ${field} in this record is not a readable score, so no score is shown.`,
};

/** A score this build can print: finite and non-negative, whatever its scale. */
function readableScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function decodeSkillScore(value: unknown, field: SkillScoreField): SkillScoreReading {
  const name = FIELD_NAMES[field];
  const reason: SkillScoreUnavailableReason = value === undefined ? 'no-record' : 'unreadable';
  if (!readableScore(value)) {
    return {
      kind: 'unavailable',
      reason,
      value: null,
      label: SKILL_SCORE_UNAVAILABLE,
      basis: BASIS[reason](name),
    };
  }
  return { kind: 'measured', reason: null, value, label: value.toFixed(2), basis: null };
}

export type CandidateScoreView = {
  /** The candidate's confidence. Always present, measured or not. */
  confidence: SkillScoreReading;
  /**
   * The eval score, or `null` when the record carries none — the omission rule
   * this surface has always had, kept because an unevaluated candidate is a
   * normal state rather than a fault.
   */
  evalScore: SkillScoreReading | null;
  /** Every fixed sentence to print, in a fixed order, so two readers agree. */
  bases: string[];
};

/** `null` for a surface with no candidate record, which has no scores to read. */
export function projectCandidateScores(
  candidate: { confidence?: unknown; eval_score?: unknown } | null | undefined,
): CandidateScoreView | null {
  if (!candidate) return null;
  const confidence = decodeSkillScore(candidate.confidence, 'confidence');
  const evalScore = decodeSkillScore(candidate.eval_score, 'eval_score');
  const bases: string[] = [];
  if (confidence.basis) bases.push(confidence.basis);
  // An absent eval score is an omission, not a sentence. A score that arrived
  // and could not be read is a different fact, and is named.
  if (evalScore.reason === 'unreadable' && evalScore.basis) bases.push(evalScore.basis);
  return { confidence, evalScore: evalScore.reason === 'no-record' ? null : evalScore, bases };
}

export type ImprovementScoreView = {
  kind: 'improved' | 'none-yet' | 'unavailable';
  /** The count as the card prints it, or `null` when there is nothing to print. */
  text: string | null;
  /** The fixed sentence, for an operand nobody could read. */
  basis: string | null;
};

/**
 * Native stores an improvement *count*, so a genuine zero is not information and
 * is not a fault: it stays hidden, exactly as it always was. An unreadable count
 * is a different fact and now says so, instead of vanishing into the same
 * comparison that hides the zero.
 */
export function projectImprovementScore(value: unknown): ImprovementScoreView {
  const reading = decodeSkillScore(value, 'improvement_score');
  if (reading.kind === 'measured') {
    return reading.value > 0
      ? { kind: 'improved', text: reading.label, basis: null }
      : { kind: 'none-yet', text: null, basis: null };
  }
  return { kind: 'unavailable', text: reading.label, basis: reading.basis };
}
