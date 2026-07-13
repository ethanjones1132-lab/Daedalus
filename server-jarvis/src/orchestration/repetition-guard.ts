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

export interface PreviousTurnOutcome {
  request: string;
  errorCode: string | undefined;
}

/**
 * Failure codes worth short-circuiting a near-identical retry for (Task 3.3):
 * re-running the full pipeline (~50s on the free-tier pool) would rediscover
 * the same evidence shortfall. Provider/transport failures are deliberately
 * NOT in this set — those are transient, and a retry is exactly right.
 */
const SHORT_CIRCUIT_CODES = new Set([
  "no_progress_repetition",
  "insufficient_workspace_evidence",
  "missing_workspace_evidence",
]);
const FORCE_BYPASS = /\bforce deep read\b/i;
// A concrete file/path in the retry counts as new information: an extension'd
// filename ("gateway.ts") or a path separator ("src/api", "C:\repo").
const CONCRETE_PATH = /[\w.-]+\.[a-z0-9]{1,8}\b|[\w-]+[\\/][\w./\\-]+/i;

/**
 * True when an incoming request is a near-identical retry of a request that
 * just failed for lack of evidence/progress, with nothing new to act on.
 * The caller replies instantly with the prior failure reason instead of
 * re-running the pipeline to rediscover it.
 */
export function shouldShortCircuitRepeat(
  previous: PreviousTurnOutcome | undefined,
  request: string,
): boolean {
  if (!previous?.errorCode || !SHORT_CIRCUIT_CODES.has(previous.errorCode)) return false;
  if (FORCE_BYPASS.test(request)) return false;
  // Naming a concrete file/path the previous request lacked is new signal.
  if (CONCRETE_PATH.test(request) && !CONCRETE_PATH.test(previous.request)) return false;
  return jaccard(trigramsOf(previous.request), trigramsOf(request)) >= REPETITION_SIMILARITY_THRESHOLD;
}

/** Bounded per-session store of the last turn's signature (LRU by insertion). */
export class SessionRepetitionStore {
  private signatures = new Map<string, TurnSignature>();
  private outcomes = new Map<string, PreviousTurnOutcome>();
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

  /** Record the turn's request + terminal error code for the retry memo. */
  recordOutcome(sessionId: string, request: string, errorCode: string | undefined): void {
    if (this.outcomes.has(sessionId)) this.outcomes.delete(sessionId);
    this.outcomes.set(sessionId, { request, errorCode });
    while (this.outcomes.size > this.capacity) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest === undefined) break;
      this.outcomes.delete(oldest);
    }
  }

  lastOutcome(sessionId: string): PreviousTurnOutcome | undefined {
    return this.outcomes.get(sessionId);
  }

  clear(sessionId: string): void {
    this.signatures.delete(sessionId);
    this.outcomes.delete(sessionId);
  }
}
