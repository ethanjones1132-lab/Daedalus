// Cross-turn no-progress detection for the orchestrator (2026-07-12 incident:
// session e21d0533 produced near-identical "I haven't read the files" answers
// across three turns with zero evidence growth). A repetition is only flagged
// when BOTH hold: the finalized answer is textually similar to the previous
// turn's answer AND the successful-evidence set gained nothing new.

// Empirically calibrated against the live incident session (e21d0533):
// real consecutive incident turns score 0.315 and 0.414 trigram Jaccard;
// the condensed test fixtures score 0.346; a genuinely different answer on
// the SAME topic scores 0.092. 0.25 sits between with margin on both sides.
// Never raise above 0.30 without re-measuring against the incident snapshot
// (.hermes/incident-20260712/jarvis-incident.db). The `newEvidence` gate is
// the primary false-positive guard, not this threshold.
export const REPETITION_SIMILARITY_THRESHOLD = 0.25;

export interface TurnSignature {
  trigrams: Set<string>;
  evidenceKeys: Set<string>;
  recordedAt: number;
}

export interface RepetitionVerdict {
  repeated: boolean;
  similarity: number;
  newEvidence: boolean;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_#>\[\]()|:;,.!?"'\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function trigramsOf(text: string): Set<string> {
  const n = normalize(text);
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= n.length; i++) grams.add(n.slice(i, i + 3));
  return grams;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function assessRepetition(
  previous: TurnSignature | undefined,
  answer: string,
  evidenceKeys: string[],
): RepetitionVerdict {
  const current = new Set(evidenceKeys);
  if (!previous) return { repeated: false, similarity: 0, newEvidence: current.size > 0 };
  let newEvidence = false;
  for (const key of current) {
    if (!previous.evidenceKeys.has(key)) {
      newEvidence = true;
      break;
    }
  }
  const answerTrigrams = trigramsOf(answer);
  // jaccard() treats two empty sets as identical (similarity 1), which is the
  // right convention for the function in isolation but wrong here: two short
  // answers (e.g. "No" vs "Ok", both under 3 normalized chars) would then be
  // scored as a maximal-similarity repeat with zero signal behind it. Since
  // TurnSignature doesn't retain the original answer text, we can't fall back
  // to string equality — instead, near-empty-on-both-sides is treated as "not
  // enough signal to call it a repetition" at all. This is conservative: a
  // genuine short-answer repetition loop won't be caught, but that's out of
  // scope for this detector (built for the incident's multi-sentence
  // non-answer case, not one-word replies).
  const similarity =
    previous.trigrams.size === 0 && answerTrigrams.size === 0
      ? 0
      : jaccard(previous.trigrams, answerTrigrams);
  return {
    repeated: similarity >= REPETITION_SIMILARITY_THRESHOLD && !newEvidence,
    similarity,
    newEvidence,
  };
}

/** Bounded per-session store of the last turn's signature (LRU by insertion). */
export class SessionRepetitionStore {
  private signatures = new Map<string, TurnSignature>();
  constructor(private capacity = 200) {}

  lastSignature(sessionId: string): TurnSignature | undefined {
    return this.signatures.get(sessionId);
  }

  record(sessionId: string, answer: string, evidenceKeys: string[]): void {
    if (this.signatures.has(sessionId)) this.signatures.delete(sessionId);
    this.signatures.set(sessionId, {
      trigrams: trigramsOf(answer),
      evidenceKeys: new Set(evidenceKeys),
      recordedAt: Date.now(),
    });
    while (this.signatures.size > this.capacity) {
      const oldest = this.signatures.keys().next().value;
      if (oldest === undefined) break;
      this.signatures.delete(oldest);
    }
  }

  clear(sessionId: string): void {
    this.signatures.delete(sessionId);
  }
}
