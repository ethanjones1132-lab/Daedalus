import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname, sep } from "path";
import { homedir, tmpdir } from "os";
import { validateSkillCandidate } from "./skill-candidate-validation";
import type { SkillCandidate, SkillCandidateStatus, SkillRejectionReason } from "./skill-types";
import { computeBodyDigest, computeCandidateArtifactDigest, stableStringify } from "../self-tuning/rollout/learning-eval-types";
import {
  appendLearningEvalLifecycleEvent,
  candidateContentDigestV1,
  computeLearningEvalLifecycleEventId,
  createLearningEvalLifecycleEvent,
  decodeLearningEvalDecisionRecord,
  readLearningEvalDecision,
  readLearningEvalLifecycleEvent,
  type LearningEvalDecisionRecordV1,
  type LearningEvalLifecycleAction,
  type LearningEvalLifecycleEventV1,
  type LearningEvalLifecycleReasonCode,
  type LearningEvalLifecycleToStatus,
  type LearningEvalRollbackReasonCode,
} from "../self-tuning/rollout/learning-eval-decision-store";

export type SkillCandidateReadResult =
  | { ok: true; candidate: SkillCandidate }
  | { ok: false; error: "candidate_not_found" | "invalid_candidate_record" };

export function skillCandidateLifecycleVersion(candidate: Pick<SkillCandidate, "lifecycle_version"> | null | undefined): number {
  const version = candidate?.lifecycle_version;
  return Number.isSafeInteger(version) && (version as number) >= 0 ? version as number : 0;
}

/**
 * Canonical ISO-8601 timestamp predicate. A value is canonical only when it is
 * exactly the UTC millisecond-precision rendering that `Date.prototype.toISOString`
 * produces, so `2026-10-06T12:34:56.789Z` is accepted while offsets, missing
 * milliseconds, or any other non-canonical spelling is rejected.
 */
export function isCanonicalIsoTimestamp(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function skillCandidatesDirOverride(): string | undefined {
  return (globalThis as { __skillCandidatesDirOverride?: string }).__skillCandidatesDirOverride;
}

export function skillCandidatesDir(): string {
  const override = skillCandidatesDirOverride();
  return override ?? join(homedir(), ".openclaw", "jarvis", "skills", "candidates");
}

export function skillCandidatePath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(skillCandidatesDir(), `${safe}.json`);
}

function readCandidateFile(path: string): SkillCandidateReadResult {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const validated = validateSkillCandidate(parsed);
    if (!validated.ok) return { ok: false, error: "invalid_candidate_record" };
    return { ok: true, candidate: validated.candidate };
  } catch {
    return { ok: false, error: "invalid_candidate_record" };
  }
}

export function readSkillCandidate(id: string): SkillCandidateReadResult {
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, error: "invalid_candidate_record" };
  }
  const path = skillCandidatePath(id);
  try {
    if (!existsSync(path)) return { ok: false, error: "candidate_not_found" };
  } catch {
    return { ok: false, error: "invalid_candidate_record" };
  }
  return readCandidateFile(path);
}

/**
 * Private candidate persistence. `allowPromoted` / `allowRolledBack` are the
 * two narrow gates that separate the public candidate store (which rejects
 * promoted and rolled_back writes with `evidence_required`) from the
 * evidence-verified transitions. Neither flag is surfaced through an exported
 * generic save: public `saveSkillCandidate` hard-codes both `false`, the
 * promotion transition passes only `allowPromoted`, and the rollback transition
 * passes only `allowRolledBack`, each after every durable evidence check has
 * already passed.
 */
function persistSkillCandidate(
  candidate: SkillCandidate,
  allowPromoted: boolean,
  allowRolledBack = false,
): void {
  const validated = validateSkillCandidate(candidate);
  if (!validated.ok) throw new Error("invalid_candidate_record");
  if (!allowPromoted && validated.candidate.status === "promoted") throw new Error("evidence_required");
  if (!allowRolledBack && validated.candidate.status === "rolled_back") throw new Error("evidence_required");
  const path = skillCandidatePath(validated.candidate.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(validated.candidate, null, 2), "utf-8");
}

export function saveSkillCandidate(candidate: SkillCandidate): void {
  persistSkillCandidate(candidate, false);
}

/**
 * Evaluation-only fixture writer. It exists solely so the eval harness can
 * materialize promoted skill fixtures into a throwaway temp directory without
 * re-opening a production promotion path. It NEVER writes to the production
 * candidate directory: it hard-requires the `__skillCandidatesDirOverride`
 * global and refuses unless that directory's realpath is strictly contained
 * below the OS temp directory (realpath-resolved, so traversal/escape and a
 * symlinked override are rejected). The candidate is still fully validated
 * before the write.
 */
export function saveSkillCandidateForEvaluationFixture(candidate: SkillCandidate): void {
  const override = skillCandidatesDirOverride();
  if (typeof override !== "string" || override.length === 0) throw new Error("evidence_required");
  let overrideStat;
  try {
    overrideStat = lstatSync(override);
  } catch {
    throw new Error("evidence_required");
  }
  if (!overrideStat.isDirectory() || overrideStat.isSymbolicLink()) throw new Error("evidence_required");
  let resolvedOverride: string;
  let resolvedTempRoot: string;
  try {
    resolvedOverride = realpathSync(override);
    resolvedTempRoot = realpathSync(tmpdir());
  } catch {
    throw new Error("evidence_required");
  }
  if (resolvedOverride === resolvedTempRoot) throw new Error("evidence_required");
  if (!resolvedOverride.startsWith(resolvedTempRoot + sep)) throw new Error("evidence_required");

  const validated = validateSkillCandidate(candidate);
  if (!validated.ok) throw new Error("invalid_candidate_record");
  if (validated.candidate.status === "rolled_back") throw new Error("evidence_required");
  const path = skillCandidatePath(validated.candidate.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(validated.candidate, null, 2), "utf-8");
}

export function loadSkillCandidate(id: string): SkillCandidate | null {
  const result = readSkillCandidate(id);
  return result.ok ? result.candidate : null;
}

export function listSkillCandidates(status?: SkillCandidateStatus): SkillCandidate[] {
  const dir = skillCandidatesDir();
  let files: string[];
  try {
    if (!existsSync(dir)) return [];
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SkillCandidate[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const result = readCandidateFile(join(dir, file));
    if (!result.ok || seen.has(result.candidate.id)) continue;
    if (status && result.candidate.status !== status) continue;
    seen.add(result.candidate.id);
    out.push(result.candidate);
  }
  return out.sort((a, b) => {
    const byUpdated = b.updated_at.localeCompare(a.updated_at);
    return byUpdated || a.id.localeCompare(b.id);
  });
}

export type SkillCandidateTransitionError = "candidate_not_found" | "invalid_candidate_record" | "stale_version" | "wrong_status" | "evidence_required";
export type SkillCandidateTransitionResult =
  | { ok: true; candidate: SkillCandidate }
  | { ok: false; error: SkillCandidateTransitionError; current?: SkillCandidate };

/**
 * Private version/status transition. The callback is invoked exactly once and
 * the passed-in `existing` object is deep-cloned before invocation so an
 * in-place mutation into `promoted`/`rolled_back` is detected independently of
 * the returned patch. `allowPromoted` and `allowRolledBack` default to `false`;
 * the public exported `transitionSkillCandidate` delegates with both `false`,
 * and only the specialized evidence transitions delegate with their single
 * matching flag after their durable evidence checks. The callback guards are
 * always evaluated.
 */
function transitionSkillCandidateInternal(
  id: string,
  expectedVersion: number,
  requiredStatus: SkillCandidateStatus,
  update: (current: SkillCandidate) => Partial<SkillCandidate>,
  allowPromoted: boolean,
  allowRolledBack = false,
): SkillCandidateTransitionResult {
  const read = readSkillCandidate(id);
  if (!read.ok) return { ok: false, error: read.error };
  const existing = read.candidate;
  const currentVersion = skillCandidateLifecycleVersion(existing);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || currentVersion !== expectedVersion) {
    return { ok: false, error: "stale_version", current: existing };
  }
  if (existing.status !== requiredStatus) {
    return { ok: false, error: "wrong_status", current: existing };
  }
  const durable = JSON.parse(JSON.stringify(existing)) as SkillCandidate;
  const durableStatus = durable.status;
  const patch = update(existing);
  const returnedPromoted = patch.status === "promoted";
  const mutatedToPromoted = durableStatus !== "promoted" && existing.status === "promoted";
  if (!allowPromoted && (returnedPromoted || mutatedToPromoted)) {
    return { ok: false, error: "evidence_required", current: durable };
  }
  const returnedRolledBack = patch.status === "rolled_back";
  const mutatedToRolledBack = durableStatus !== "rolled_back" && existing.status === "rolled_back";
  if (!allowRolledBack && (returnedRolledBack || mutatedToRolledBack)) {
    return { ok: false, error: "evidence_required", current: durable };
  }
  const updated = validateSkillCandidate({
    ...existing,
    ...patch,
    id: existing.id,
    lifecycle_version: currentVersion + 1,
    updated_at: new Date().toISOString(),
  });
  if (!updated.ok) return { ok: false, error: "invalid_candidate_record" };
  persistSkillCandidate(updated.candidate, allowPromoted, allowRolledBack);
  return { ok: true, candidate: updated.candidate };
}

export function transitionSkillCandidate(
  id: string,
  expectedVersion: number,
  requiredStatus: SkillCandidateStatus,
  update: (current: SkillCandidate) => Partial<SkillCandidate>,
): SkillCandidateTransitionResult {
  return transitionSkillCandidateInternal(id, expectedVersion, requiredStatus, update, false);
}

export function updateSkillCandidateStatus(
  id: string,
  status: SkillCandidateStatus,
  evalScore?: number,
  rejectionReason?: SkillRejectionReason,
  rejectionDetail?: string,
  evalMissed?: string[],
  expectedVersion?: number,
): SkillCandidate | null {
  if (status === "promoted" || status === "rolled_back") return null;
  const existing = loadSkillCandidate(id);
  if (!existing) return null;
  const result = transitionSkillCandidate(
    id,
    expectedVersion ?? skillCandidateLifecycleVersion(existing),
    existing.status,
    (current) => {
      const updated: SkillCandidate = {
        ...current,
        status,
        eval_score: evalScore ?? current.eval_score,
      };
      if (status === "rejected") {
        updated.rejection_reason = rejectionReason;
        updated.rejection_detail = rejectionDetail;
      } else {
        updated.rejection_reason = undefined;
        updated.rejection_detail = undefined;
      }
      if (evalMissed !== undefined) updated.eval_missed = evalMissed;
      updated.promoted_at = undefined;
      return updated;
    },
  );
  return result.ok ? result.candidate : null;
}

export function updateSkillCandidateEval(
  id: string,
  evalScore: number,
  evalMissed: string[],
  expectedVersion?: number,
): SkillCandidate | null {
  const existing = loadSkillCandidate(id);
  if (!existing) return null;
  const result = transitionSkillCandidate(
    id,
    expectedVersion ?? skillCandidateLifecycleVersion(existing),
    existing.status,
    (current) => ({ ...current, eval_score: evalScore, eval_missed: evalMissed }),
  );
  return result.ok ? result.candidate : null;
}

export function pruneSkillCandidates(maxRows: number): number {
  if (!Number.isFinite(maxRows) || maxRows < 0) return 0;
  const limit = Math.floor(maxRows);
  const candidates = listSkillCandidates("candidate");
  if (candidates.length <= limit) return 0;
  const excess = candidates.slice(limit);
  for (const row of excess) {
    try {
      unlinkSync(skillCandidatePath(row.id));
    } catch {
    }
  }
  return excess.length;
}

// ═══════════════════════════════════════════════════════════════
// Priority 3 Phase 3.2 — bounded durable-decision lifecycle application
// ═══════════════════════════════════════════════════════════════
//
// `applyLearningEvalDecision` is the store-level entry point that turns a
// strictly decoded immutable learning-eval decision record into one bounded
// candidate lifecycle mutation. It is deliberately narrow:
//
//   * it re-decodes the supplied record, rereads the durable decision, and
//     requires exact canonical equality before doing anything else;
//   * it binds the persisted candidate to the frozen content digest and only
//     ever transitions status `candidate` -> `staged` (accepted) or
//     `candidate` -> `rejected` with reason `transfer_gate_failed` (rejected);
//   * it appends and reads back the deterministic lifecycle event BEFORE any
//     status transition (event-before-success);
//   * it never promotes, never rewrites a conflicting event, and never
//     overwrites an unrelated preexisting candidate.
//
// The candidate file and the decision/event ledger are separate plain-file
// stores, so this function is NOT atomic. A crash between the event append and
// the candidate transition is recoverable: an exact retry reconciles an
// already-appended event and a candidate already at that event's target state.

export interface ApplyLearningEvalDecisionIntent {
  /**
   * Only `stage_candidate` (requires an `accepted` report) and
   * `reject_candidate` (requires a `rejected` report) are supported. An
   * `inconclusive` report can never be applied.
   */
  action: LearningEvalLifecycleAction;
  /**
   * Lifecycle version the caller expects the persisted candidate to be at
   * before this transition. `null` means the caller expects no candidate-store
   * record yet, so the exact frozen artifact is created first.
   */
  expectedLifecycleVersion: number | null;
  /** Optional deterministic event timestamp, useful for byte-exact retries. */
  timestamp?: string;
}

export type SkillCandidateLifecycleApplyError =
  | "decision_not_found"
  | "decision_conflict"
  | "decision_invalid"
  | "action_not_supported"
  | "candidate_not_found"
  | "invalid_candidate_record"
  | "artifact_mismatch"
  | "candidate_create_conflict"
  | "stale_version"
  | "wrong_status"
  | "event_conflict"
  | "rollback_recorded"
  | "ambiguous";

export type SkillCandidateLifecycleApplyResult =
  | {
      ok: true;
      candidate: SkillCandidate;
      event: LearningEvalLifecycleEventV1;
      eventCreated: boolean;
      candidateCreated: boolean;
    }
  | {
      ok: false;
      error: SkillCandidateLifecycleApplyError;
      current?: SkillCandidate;
      detail?: string;
    };

type LifecycleEventIdentity = Pick<
  LearningEvalLifecycleEventV1,
  | "reportHash"
  | "candidateId"
  | "candidateContentDigest"
  | "priorLifecycleVersion"
  | "newLifecycleVersion"
  | "fromStatus"
  | "toStatus"
  | "action"
  | "reasonCode"
>;

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function lifecycleEventIdentityMatches(
  event: LearningEvalLifecycleEventV1,
  expected: LifecycleEventIdentity,
): boolean {
  return (
    event.reportHash === expected.reportHash &&
    event.candidateId === expected.candidateId &&
    event.candidateContentDigest === expected.candidateContentDigest &&
    event.priorLifecycleVersion === expected.priorLifecycleVersion &&
    event.newLifecycleVersion === expected.newLifecycleVersion &&
    event.fromStatus === expected.fromStatus &&
    event.toStatus === expected.toStatus &&
    event.action === expected.action &&
    event.reasonCode === expected.reasonCode
  );
}

type AppendLifecycleEventOutcome =
  | { ok: true; event: LearningEvalLifecycleEventV1; created: boolean }
  | { ok: false; error: "event_conflict" | "ambiguous" };

/**
 * Build, append, and explicitly read back the deterministic lifecycle event.
 * Success requires the decoded persisted event to be exactly the same canonical
 * event as the one created, including timestamp and eventHash; any differing
 * byte is refused as an event conflict.
 */
function appendAndReadBackLifecycleEvent(
  identity: LifecycleEventIdentity,
  timestamp: string | undefined,
  options: { root?: string } | undefined,
): AppendLifecycleEventOutcome {
  const created = createLearningEvalLifecycleEvent({ ...identity, timestamp });
  if (!created.ok) return { ok: false, error: "ambiguous" };
  const appended = appendLearningEvalLifecycleEvent(created.value, options);
  if (!appended.ok) {
    if (appended.code !== "conflict") return { ok: false, error: "ambiguous" };
    const raced = readLearningEvalLifecycleEvent(created.value.eventId, options);
    if (!raced.ok) return { ok: false, error: "ambiguous" };
    if (stableStringify(raced.value) !== stableStringify(created.value)) {
      return { ok: false, error: "event_conflict" };
    }
    return { ok: true, event: raced.value, created: false };
  }
  const readBack = readLearningEvalLifecycleEvent(created.value.eventId, options);
  if (!readBack.ok) return { ok: false, error: "ambiguous" };
  if (stableStringify(readBack.value) !== stableStringify(created.value)) {
    return { ok: false, error: "event_conflict" };
  }
  return { ok: true, event: readBack.value, created: true };
}

type FrozenCandidateCreateOutcome =
  | { ok: true; candidate: SkillCandidate; created: boolean }
  | { ok: false; error: "invalid_candidate_record" | "candidate_create_conflict" };

/**
 * Create the candidate file from the exact validated frozen artifact using
 * create-only (`wx`) semantics, then strictly read it back. An existing record
 * is only accepted when its content digest matches; an unrelated preexisting
 * candidate is never overwritten.
 */
function createSkillCandidateFromFrozenArtifact(
  artifact: SkillCandidate,
): FrozenCandidateCreateOutcome {
  const validated = validateSkillCandidate(artifact);
  if (!validated.ok) return { ok: false, error: "invalid_candidate_record" };
  const frozen = validated.candidate;
  const path = skillCandidatePath(frozen.id);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(frozen, null, 2), { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if (!isFileExistsError(error)) return { ok: false, error: "invalid_candidate_record" };
    const raced = readSkillCandidate(frozen.id);
    if (!raced.ok) return { ok: false, error: "invalid_candidate_record" };
    if (
      candidateContentDigestV1(raced.candidate) !== candidateContentDigestV1(frozen) ||
      computeCandidateArtifactDigest(raced.candidate) !== computeCandidateArtifactDigest(frozen)
    ) {
      return { ok: false, error: "candidate_create_conflict" };
    }
    return { ok: true, candidate: raced.candidate, created: false };
  }
  const readBack = readSkillCandidate(frozen.id);
  if (!readBack.ok) return { ok: false, error: "invalid_candidate_record" };
  if (
    candidateContentDigestV1(readBack.candidate) !== candidateContentDigestV1(frozen) ||
    computeCandidateArtifactDigest(readBack.candidate) !== computeCandidateArtifactDigest(frozen)
  ) {
    return { ok: false, error: "candidate_create_conflict" };
  }
  return { ok: true, candidate: readBack.candidate, created: true };
}

function candidateLifecycleUpdate(
  current: SkillCandidate,
  toStatus: LearningEvalLifecycleToStatus,
  decision: LearningEvalDecisionRecordV1,
): Partial<SkillCandidate> {
  if (toStatus === "rejected") {
    return {
      ...current,
      status: "rejected",
      rejection_reason: "transfer_gate_failed",
      rejection_detail: decision.report.reasons.length > 0
        ? decision.report.reasons.join("; ")
        : "transfer gate failed",
      promoted_at: undefined,
    };
  }
  return {
    ...current,
    status: toStatus,
    rejection_reason: undefined,
    rejection_detail: undefined,
    promoted_at: undefined,
  };
}

function candidateMatchesPostTransitionState(
  candidate: SkillCandidate,
  frozen: SkillCandidate,
  toStatus: LearningEvalLifecycleToStatus,
  lifecycleVersion: number,
  decision: LearningEvalDecisionRecordV1,
): boolean {
  const validatedActual = validateSkillCandidate(candidate);
  if (!validatedActual.ok) return false;
  const actual = validatedActual.candidate;
  const expected = validateSkillCandidate({
    ...frozen,
    ...candidateLifecycleUpdate(frozen, toStatus, decision),
    id: frozen.id,
    lifecycle_version: lifecycleVersion,
    updated_at: actual.updated_at,
  });
  if (!expected.ok) return false;
  return stableStringify(actual) === stableStringify(expected.candidate);
}

export function applyLearningEvalDecision(
  decision: LearningEvalDecisionRecordV1,
  intent: ApplyLearningEvalDecisionIntent,
  options?: { root?: string },
): SkillCandidateLifecycleApplyResult {
  // 1. Strictly re-decode the supplied record.
  const redecoded = decodeLearningEvalDecisionRecord(decision);
  if (!redecoded.ok) {
    return { ok: false, error: "decision_invalid", detail: redecoded.error };
  }
  const incoming = redecoded.value;

  // 2. Reread the durable decision and require exact canonical equality.
  const durableRead = readLearningEvalDecision(incoming.reportHash, options);
  if (!durableRead.ok) {
    return {
      ok: false,
      error: durableRead.code === "not_found" ? "decision_not_found" : "decision_invalid",
      detail: durableRead.error,
    };
  }
  const durable = durableRead.value;
  if (
    durable.recordHash !== incoming.recordHash ||
    stableStringify(durable) !== stableStringify(incoming)
  ) {
    return { ok: false, error: "decision_conflict" };
  }

  const lifecycleTimestamp = intent.timestamp ?? durable.report.generatedAt;

  // 3. Resolve the intended action against the frozen report decision.
  const reportDecision = durable.report.decision;
  let toStatus: LearningEvalLifecycleToStatus;
  let reasonCode: LearningEvalLifecycleReasonCode;
  if (intent.action === "stage_candidate") {
    if (reportDecision !== "accepted") return { ok: false, error: "action_not_supported" };
    // A rollback permanently invalidates this accepted report+candidate: the
    // same report may never be re-staged once its exact rollback event exists.
    const rollbackEventId = computeLearningEvalLifecycleEventId({
      reportHash: durable.reportHash,
      candidateId: durable.candidateArtifact.id,
      action: "rollback_candidate",
    });
    const rollbackRead = readLearningEvalLifecycleEvent(rollbackEventId, options);
    if (rollbackRead.ok) return { ok: false, error: "rollback_recorded" };
    if (rollbackRead.code !== "not_found") {
      return { ok: false, error: "ambiguous", detail: rollbackRead.error };
    }
    toStatus = "staged";
    reasonCode = "accepted_transfer_gate";
  } else if (intent.action === "reject_candidate") {
    if (reportDecision !== "rejected") return { ok: false, error: "action_not_supported" };
    toStatus = "rejected";
    reasonCode = "transfer_gate_failed";
  } else {
    return { ok: false, error: "action_not_supported" };
  }

  const frozenCandidate = durable.candidateArtifact;
  const candidateId = frozenCandidate.id;
  const eventId = computeLearningEvalLifecycleEventId({
    reportHash: durable.reportHash,
    candidateId,
    action: intent.action,
  });

  // 4. Read the current candidate and bind it to the frozen artifact.
  const currentRead = readSkillCandidate(candidateId);
  if (!currentRead.ok && currentRead.error !== "candidate_not_found") {
    return { ok: false, error: "invalid_candidate_record" };
  }
  let current: SkillCandidate | undefined = currentRead.ok ? currentRead.candidate : undefined;
  const expectedVersion = intent.expectedLifecycleVersion;
  let priorLifecycleVersion: number;

  if (current) {
    if (candidateContentDigestV1(current) !== durable.candidateContentDigest) {
      return { ok: false, error: "artifact_mismatch", current };
    }
    if (current.status === toStatus) {
      // Idempotent retry: the candidate has already crossed this transition, so
      // its mutable lifecycle fields must never be re-hashed against the
      // pre-transition artifact digest. Bind to the stored event and the
      // caller's expected prior version instead.
      const preTransitionVersion =
        expectedVersion === null
          ? skillCandidateLifecycleVersion(frozenCandidate)
          : expectedVersion;
      if (!Number.isSafeInteger(preTransitionVersion) || preTransitionVersion < 0) {
        return { ok: false, error: "stale_version", current };
      }
      const observedPreTransitionMatches =
        expectedVersion === null
          ? durable.observedCandidateStatus === null &&
            durable.observedCandidateLifecycleVersion === null
          : durable.observedCandidateStatus === "candidate" &&
            durable.observedCandidateLifecycleVersion === expectedVersion;
      const currentVersion = skillCandidateLifecycleVersion(current);
      const eventRead = readLearningEvalLifecycleEvent(eventId, options);
      if (eventRead.ok) {
        const retryIdentity: LifecycleEventIdentity = {
          reportHash: durable.reportHash,
          candidateId,
          candidateContentDigest: durable.candidateContentDigest,
          priorLifecycleVersion: preTransitionVersion,
          newLifecycleVersion: preTransitionVersion + 1,
          fromStatus: "candidate",
          toStatus,
          action: intent.action,
          reasonCode,
        };
        const expectedEvent = createLearningEvalLifecycleEvent({
          ...retryIdentity,
          timestamp: lifecycleTimestamp,
        });
        if (!expectedEvent.ok) {
          return { ok: false, error: "ambiguous", current };
        }
        if (
          observedPreTransitionMatches &&
          stableStringify(eventRead.value) === stableStringify(expectedEvent.value) &&
          currentVersion === preTransitionVersion + 1 &&
          candidateMatchesPostTransitionState(
            current,
            frozenCandidate,
            toStatus,
            preTransitionVersion + 1,
            durable,
          )
        ) {
          return {
            ok: true,
            candidate: current,
            event: eventRead.value,
            eventCreated: false,
            candidateCreated: false,
          };
        }
      }
      return { ok: false, error: "ambiguous", current };
    }
    if (current.status !== "candidate") {
      return { ok: false, error: "wrong_status", current };
    }
    // Pre-transition: require the complete validated artifact to match, not a
    // reduced content projection, before any event append or transition.
    if (computeCandidateArtifactDigest(current) !== durable.candidateArtifactDigest) {
      return { ok: false, error: "artifact_mismatch", current };
    }
    if (expectedVersion === null) {
      // A null expected version means the decision observed no persisted
      // candidate. Resuming is only safe against the exact frozen-artifact
      // baseline while the durable record also observed absence.
      const baselineVersion = skillCandidateLifecycleVersion(frozenCandidate);
      if (
        durable.observedCandidateStatus !== null ||
        durable.observedCandidateLifecycleVersion !== null ||
        skillCandidateLifecycleVersion(current) !== baselineVersion
      ) {
        return { ok: false, error: "ambiguous", current };
      }
      priorLifecycleVersion = baselineVersion;
    } else {
      if (
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0 ||
        expectedVersion !== skillCandidateLifecycleVersion(current)
      ) {
        return { ok: false, error: "stale_version", current };
      }
      // The durable decision must have observed the same pre-transition
      // candidate state before a new event may be appended.
      if (
        durable.observedCandidateStatus !== "candidate" ||
        durable.observedCandidateLifecycleVersion !== expectedVersion
      ) {
        return { ok: false, error: "ambiguous", current };
      }
      priorLifecycleVersion = skillCandidateLifecycleVersion(current);
    }
  } else {
    // No persisted candidate yet: only the exact frozen artifact may be created.
    if (expectedVersion !== null) {
      return { ok: false, error: "ambiguous" };
    }
    // The durable record must have observed the same absence before we create.
    if (
      durable.observedCandidateStatus !== null ||
      durable.observedCandidateLifecycleVersion !== null
    ) {
      return { ok: false, error: "ambiguous" };
    }
    if (frozenCandidate.status !== "candidate") {
      return { ok: false, error: "wrong_status" };
    }
    priorLifecycleVersion = skillCandidateLifecycleVersion(frozenCandidate);
  }

  const identity: LifecycleEventIdentity = {
    reportHash: durable.reportHash,
    candidateId,
    candidateContentDigest: durable.candidateContentDigest,
    priorLifecycleVersion,
    newLifecycleVersion: priorLifecycleVersion + 1,
    fromStatus: "candidate",
    toStatus,
    action: intent.action,
    reasonCode,
  };

  // 5. Resolve the event before any status transition (event-before-success).
  const expectedEvent = createLearningEvalLifecycleEvent({
    ...identity,
    timestamp: lifecycleTimestamp,
  });
  if (!expectedEvent.ok) return { ok: false, error: "ambiguous", current };
  const eventRead = readLearningEvalLifecycleEvent(eventId, options);
  let event: LearningEvalLifecycleEventV1;
  let eventCreated: boolean;
  if (eventRead.ok) {
    if (stableStringify(eventRead.value) !== stableStringify(expectedEvent.value)) {
      return { ok: false, error: "event_conflict", current };
    }
    if (
      current &&
      expectedVersion !== null &&
      expectedVersion !== skillCandidateLifecycleVersion(current)
    ) {
      return { ok: false, error: "stale_version", current };
    }
    event = eventRead.value;
    eventCreated = false;
  } else if (eventRead.code === "not_found") {
    const appended = appendAndReadBackLifecycleEvent(identity, lifecycleTimestamp, options);
    if (!appended.ok) return { ok: false, error: appended.error, current };
    event = appended.event;
    eventCreated = appended.created;
  } else {
    return { ok: false, error: "ambiguous", current };
  }

  // 6. Ensure the candidate exists from the exact frozen artifact.
  let candidateCreated = false;
  if (!current) {
    const created = createSkillCandidateFromFrozenArtifact(frozenCandidate);
    if (!created.ok) return { ok: false, error: created.error };
    candidateCreated = created.created;
    current = created.candidate;
  }

  // 7. Transition through the existing version-checked store API.
  const transition = transitionSkillCandidate(
    candidateId,
    priorLifecycleVersion,
    "candidate",
    (existing) => candidateLifecycleUpdate(existing, toStatus, durable),
  );
  if (!transition.ok) {
    const reread = readSkillCandidate(candidateId);
    if (
      reread.ok &&
      candidateMatchesPostTransitionState(
        reread.candidate,
        frozenCandidate,
        toStatus,
        event.newLifecycleVersion,
        durable,
      )
    ) {
      return {
        ok: true,
        candidate: reread.candidate,
        event,
        eventCreated,
        candidateCreated,
      };
    }
    if (transition.error === "stale_version" || transition.error === "wrong_status") {
      return { ok: false, error: transition.error, current: transition.current ?? current };
    }
    if (transition.error === "invalid_candidate_record") {
      return { ok: false, error: "invalid_candidate_record", current: transition.current ?? current };
    }
    return { ok: false, error: "ambiguous", current: transition.current ?? current };
  }

  // 8. Authoritative readback: never acknowledge success from the write alone.
  const finalRead = readSkillCandidate(candidateId);
  if (!finalRead.ok) return { ok: false, error: "ambiguous", current: transition.candidate };
  if (
    !candidateMatchesPostTransitionState(
      finalRead.candidate,
      frozenCandidate,
      toStatus,
      event.newLifecycleVersion,
      durable,
    )
  ) {
    return { ok: false, error: "ambiguous", current: finalRead.candidate };
  }
  return {
    ok: true,
    candidate: finalRead.candidate,
    event,
    eventCreated,
    candidateCreated,
  };
}

// ═══════════════════════════════════════════════════════════════
// Priority 3 Phase 3.3 — exact accepted-decision promotion
// ═══════════════════════════════════════════════════════════════
//
// `promoteSkillCandidateFromAcceptedDecision` is the ONLY store path that may
// persist a `promoted` candidate. It accepts hashes/IDs only — never a report
// body, metric, or caller-authored decision — and derives every enforcement
// fact from the durable accepted decision record, the exact `stage_candidate`
// event, and the current candidate file. It is deliberately conservative:
//
//   * strictly re-decodes the durable decision and binds the caller's
//     `reportHash` / `decisionRecordHash` / `candidateId` to it exactly;
//   * requires an `accepted` report and the report/artifact/content digests to
//     match the recomputed digests of the embedded frozen candidate;
//   * requires the durable observed candidate pre-state to be exactly
//     candidate+version or absent+null, then reads the deterministic
//     `stage_candidate` event and verifies candidate -> staged with the exact
//     `accepted_transfer_gate` evidence and version;
//   * verifies the persisted staged projection against the frozen artifact
//     before promoting;
//   * appends and reads back the deterministic promotion event BEFORE the
//     mutation (event-before-success), then transitions and only returns
//     success after an exact readback;
//   * an exact retry of an already-promoted candidate is verified against the
//     same decision, stage event, promotion event, and post-state, and a crash
//     between the event append and the mutation resumes only from the exact
//     staged version.

function candidateMatchesPromotedEventState(
  candidate: SkillCandidate,
  frozen: SkillCandidate,
  lifecycleVersion: number,
  promotedAt: string,
  decision: LearningEvalDecisionRecordV1,
): boolean {
  const validatedActual = validateSkillCandidate(candidate);
  if (!validatedActual.ok) return false;
  const actual = validatedActual.candidate;
  const expected = validateSkillCandidate({
    ...frozen,
    ...candidateLifecycleUpdate(frozen, "promoted", decision),
    status: "promoted",
    rejection_reason: undefined,
    rejection_detail: undefined,
    promoted_at: promotedAt,
    id: frozen.id,
    lifecycle_version: lifecycleVersion,
    updated_at: actual.updated_at,
  });
  if (!expected.ok) return false;
  return stableStringify(actual) === stableStringify(expected.candidate);
}

export interface PromoteSkillCandidateFromAcceptedDecisionInput {
  candidateId: string;
  expectedLifecycleVersion: number;
  reportHash: string;
  decisionRecordHash: string;
}

export type SkillCandidatePromotionError =
  | "evidence_required"
  | "decision_not_accepted"
  | "candidate_binding_mismatch"
  | "stale_version"
  | "wrong_status"
  | "candidate_not_found"
  | "record_corrupt"
  | "event_conflict"
  | "rollback_recorded"
  | "ambiguous";

export type SkillCandidatePromotionResult =
  | { ok: true; candidate: SkillCandidate; event: LearningEvalLifecycleEventV1; eventCreated: boolean }
  | { ok: false; error: SkillCandidatePromotionError; current?: SkillCandidate; detail?: string };

export function promoteSkillCandidateFromAcceptedDecision(
  input: PromoteSkillCandidateFromAcceptedDecisionInput,
  options?: { root?: string },
): SkillCandidatePromotionResult {
  // 1. Public input is identifiers/hashes only.
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.candidateId !== "string" ||
    input.candidateId.length === 0 ||
    !Number.isSafeInteger(input.expectedLifecycleVersion) ||
    input.expectedLifecycleVersion < 0 ||
    typeof input.reportHash !== "string" ||
    input.reportHash.length === 0 ||
    typeof input.decisionRecordHash !== "string" ||
    input.decisionRecordHash.length === 0
  ) {
    return { ok: false, error: "evidence_required" };
  }

  // 2. Reread the durable accepted-decision record.
  const durableRead = readLearningEvalDecision(input.reportHash, options);
  if (!durableRead.ok) {
    if (durableRead.code === "not_found") {
      return { ok: false, error: "evidence_required", detail: durableRead.error };
    }
    if (durableRead.code === "corrupt_store" || durableRead.code === "invalid_record") {
      return { ok: false, error: "record_corrupt", detail: durableRead.error };
    }
    return { ok: false, error: "ambiguous", detail: durableRead.error };
  }

  // 3. Strictly re-decode the durable record.
  const redecoded = decodeLearningEvalDecisionRecord(durableRead.value);
  if (!redecoded.ok) return { ok: false, error: "record_corrupt", detail: redecoded.error };
  const record = redecoded.value;

  // 4. Bind the caller's hashes to the durable record exactly.
  if (input.reportHash !== record.reportHash || input.decisionRecordHash !== record.recordHash) {
    return { ok: false, error: "candidate_binding_mismatch" };
  }

  // 5. Only an accepted report may promote.
  if (record.report.decision !== "accepted") {
    return { ok: false, error: "decision_not_accepted" };
  }

  // 6. Bind the report and recomputed digests to the embedded frozen candidate.
  const frozen = record.candidateArtifact;
  const recomputedArtifactDigest = computeCandidateArtifactDigest(frozen);
  const recomputedContentDigest = candidateContentDigestV1(frozen);
  if (
    input.candidateId !== frozen.id ||
    record.report.candidate.id !== frozen.id ||
    record.report.candidate.artifactDigest !== recomputedArtifactDigest ||
    record.report.candidate.contentDigest !== computeBodyDigest(frozen.body) ||
    recomputedArtifactDigest !== record.candidateArtifactDigest ||
    recomputedContentDigest !== record.candidateContentDigest
  ) {
    return { ok: false, error: "candidate_binding_mismatch" };
  }

  // A durable rollback permanently invalidates this accepted report+candidate;
  // it may never be promoted again.
  const rollbackEventId = computeLearningEvalLifecycleEventId({
    reportHash: record.reportHash,
    candidateId: frozen.id,
    action: "rollback_candidate",
  });
  const rollbackRead = readLearningEvalLifecycleEvent(rollbackEventId, options);
  if (rollbackRead.ok) return { ok: false, error: "rollback_recorded" };
  if (rollbackRead.code !== "not_found") {
    if (rollbackRead.code === "corrupt_store" || rollbackRead.code === "invalid_record") {
      return { ok: false, error: "record_corrupt", detail: rollbackRead.error };
    }
    return { ok: false, error: "ambiguous", detail: rollbackRead.error };
  }

  // 7. The durable observed pre-state must be exactly candidate+version or absent.
  if (
    !(
      (record.observedCandidateStatus === "candidate" &&
        record.observedCandidateLifecycleVersion !== null) ||
      (record.observedCandidateStatus === null &&
        record.observedCandidateLifecycleVersion === null)
    )
  ) {
    return { ok: false, error: "wrong_status" };
  }
  const stagePriorVersion =
    record.observedCandidateStatus === "candidate"
      ? record.observedCandidateLifecycleVersion as number
      : skillCandidateLifecycleVersion(frozen);

  // 8. Read the exact stage_candidate event and verify every frozen binding.
  const stageEventId = computeLearningEvalLifecycleEventId({
    reportHash: record.reportHash,
    candidateId: frozen.id,
    action: "stage_candidate",
  });
  const stageRead = readLearningEvalLifecycleEvent(stageEventId, options);
  if (!stageRead.ok) {
    if (stageRead.code === "not_found") {
      return { ok: false, error: "evidence_required", detail: stageRead.error };
    }
    if (stageRead.code === "corrupt_store" || stageRead.code === "invalid_record") {
      return { ok: false, error: "record_corrupt", detail: stageRead.error };
    }
    return { ok: false, error: "ambiguous", detail: stageRead.error };
  }
  const stageIdentity: LifecycleEventIdentity = {
    reportHash: record.reportHash,
    candidateId: frozen.id,
    candidateContentDigest: record.candidateContentDigest,
    priorLifecycleVersion: stagePriorVersion,
    newLifecycleVersion: stagePriorVersion + 1,
    fromStatus: "candidate",
    toStatus: "staged",
    action: "stage_candidate",
    reasonCode: "accepted_transfer_gate",
  };
  if (!lifecycleEventIdentityMatches(stageRead.value, stageIdentity)) {
    return { ok: false, error: "event_conflict" };
  }
  if (stageRead.value.newLifecycleVersion !== input.expectedLifecycleVersion) {
    return { ok: false, error: "stale_version" };
  }

  // 9. Read the persisted candidate and bind it to the frozen artifact.
  const currentRead = readSkillCandidate(input.candidateId);
  if (!currentRead.ok) {
    return {
      ok: false,
      error: currentRead.error === "candidate_not_found" ? "candidate_not_found" : "record_corrupt",
    };
  }
  const current = currentRead.candidate;
  if (
    current.id !== frozen.id ||
    candidateContentDigestV1(current) !== record.candidateContentDigest
  ) {
    return { ok: false, error: "candidate_binding_mismatch", current };
  }
  const currentVersion = skillCandidateLifecycleVersion(current);
  if (current.status === "promoted") {
    // Exact-retry pre-state: only the version immediately after promotion is
    // admissible. Anything else is ambiguous, never a fresh promotion.
    if (currentVersion !== input.expectedLifecycleVersion + 1) {
      return { ok: false, error: "ambiguous", current };
    }
  } else if (current.status === "staged") {
    if (currentVersion !== input.expectedLifecycleVersion) {
      return { ok: false, error: "stale_version", current };
    }
  } else {
    return { ok: false, error: "wrong_status", current };
  }

  // 10. Promotion event identity: staged -> promoted.
  const promoteIdentity: LifecycleEventIdentity = {
    reportHash: record.reportHash,
    candidateId: frozen.id,
    candidateContentDigest: record.candidateContentDigest,
    priorLifecycleVersion: input.expectedLifecycleVersion,
    newLifecycleVersion: input.expectedLifecycleVersion + 1,
    fromStatus: "staged",
    toStatus: "promoted",
    action: "promote_candidate",
    reasonCode: "accepted_learning_eval",
  };
  const promoteEventId = computeLearningEvalLifecycleEventId({
    reportHash: record.reportHash,
    candidateId: frozen.id,
    action: "promote_candidate",
  });
  const promoteRead = readLearningEvalLifecycleEvent(promoteEventId, options);
  if (!promoteRead.ok && promoteRead.code !== "not_found") {
    if (promoteRead.code === "corrupt_store" || promoteRead.code === "invalid_record") {
      return { ok: false, error: "record_corrupt", detail: promoteRead.error, current };
    }
    return { ok: false, error: "ambiguous", detail: promoteRead.error, current };
  }

  // 11. Exact retry for an already-promoted candidate.
  if (current.status === "promoted") {
    if (!promoteRead.ok) return { ok: false, error: "ambiguous", current };
    if (!lifecycleEventIdentityMatches(promoteRead.value, promoteIdentity)) {
      return { ok: false, error: "event_conflict", current };
    }
    if (currentVersion !== input.expectedLifecycleVersion + 1) {
      return { ok: false, error: "ambiguous", current };
    }
    if (
      !candidateMatchesPromotedEventState(
        current,
        frozen,
        input.expectedLifecycleVersion + 1,
        promoteRead.value.timestamp,
        record,
      )
    ) {
      return { ok: false, error: "ambiguous", current };
    }
    return { ok: true, candidate: current, event: promoteRead.value, eventCreated: false };
  }

  // 12. Staged candidate: verify the exact staged projection before mutation.
  if (
    !candidateMatchesPostTransitionState(
      current,
      frozen,
      "staged",
      input.expectedLifecycleVersion,
      record,
    )
  ) {
    return { ok: false, error: "candidate_binding_mismatch", current };
  }

  // 13. Resolve the promotion event before mutation (event-before-success). A
  // crash after the append but before the transition resumes here from the
  // exact staged version.
  let event: LearningEvalLifecycleEventV1;
  let eventCreated: boolean;
  if (promoteRead.ok) {
    if (!lifecycleEventIdentityMatches(promoteRead.value, promoteIdentity)) {
      return { ok: false, error: "event_conflict", current };
    }
    event = promoteRead.value;
    eventCreated = false;
  } else {
    const appended = appendAndReadBackLifecycleEvent(promoteIdentity, undefined, options);
    if (!appended.ok) return { ok: false, error: appended.error, current };
    event = appended.event;
    eventCreated = appended.created;
  }

  // 14. Transition to promoted through the evidence-gated internal path.
  const transition = transitionSkillCandidateInternal(
    input.candidateId,
    input.expectedLifecycleVersion,
    "staged",
    (existing) => ({
      ...existing,
      status: "promoted",
      promoted_at: event.timestamp,
      rejection_reason: undefined,
      rejection_detail: undefined,
    }),
    true,
  );
  if (!transition.ok) {
    const attempted = readSkillCandidate(input.candidateId);
    if (
      attempted.ok &&
      candidateMatchesPromotedEventState(
        attempted.candidate,
        frozen,
        input.expectedLifecycleVersion + 1,
        event.timestamp,
        record,
      )
    ) {
      return { ok: true, candidate: attempted.candidate, event, eventCreated };
    }
    if (transition.error === "stale_version" || transition.error === "wrong_status") {
      return { ok: false, error: transition.error, current: transition.current ?? current };
    }
    if (transition.error === "candidate_not_found") {
      return { ok: false, error: "candidate_not_found", current: transition.current ?? current };
    }
    if (transition.error === "invalid_candidate_record") {
      return { ok: false, error: "record_corrupt", current: transition.current ?? current };
    }
    return { ok: false, error: "ambiguous", current: transition.current ?? current };
  }

  // 15. Authoritative readback: never acknowledge success from the write alone.
  const finalRead = readSkillCandidate(input.candidateId);
  if (!finalRead.ok) return { ok: false, error: "ambiguous", current: transition.candidate };
  if (
    !candidateMatchesPromotedEventState(
      finalRead.candidate,
      frozen,
      input.expectedLifecycleVersion + 1,
      event.timestamp,
      record,
    )
  ) {
    return { ok: false, error: "ambiguous", current: finalRead.candidate };
  }
  return { ok: true, candidate: finalRead.candidate, event, eventCreated };
}

// ═══════════════════════════════════════════════════════════════
// Priority 3 Phase 3.3 — read-only promotion-evidence proof
// ═══════════════════════════════════════════════════════════════
//
// `verifySkillCandidatePromotionEvidence` is a pure, read-only proof that the
// exact evidence `promoteSkillCandidateFromAcceptedDecision` requires is
// already durable. It performs NO writes and appends NO events, so a caller
// (e.g. skill-promotion.ts) can fail closed on missing/stale evidence BEFORE
// spending a grounding/judge call.
//
// Drift note: this verifier is deliberately self-contained rather than sharing
// a single read/validate helper with the mutating writer, because the writer's
// read/append/transition sequence is crash-recovery sensitive and factoring it
// would risk changing existing mutation/event behavior. The mutating writer
// therefore ALWAYS repeats this exact validation inline immediately before its
// event append and mutation, remains the authoritative final check, and never
// trusts a caller-supplied verification result. The shared pure building blocks
// (`lifecycleEventIdentityMatches`, `candidateMatchesPostTransitionState`,
// `candidateMatchesPromotedEventState`, `computeLearningEvalLifecycleEventId`)
// are reused by both paths so the identity/projection rules cannot drift.

export interface VerifySkillCandidatePromotionEvidenceInput {
  candidateId: string;
  expectedLifecycleVersion: number;
  reportHash: string;
  decisionRecordHash: string;
}

export type VerifySkillCandidatePromotionEvidenceResult =
  | { ok: true; candidate: SkillCandidate; alreadyPromoted: boolean; pendingEvent?: boolean }
  | { ok: false; error: SkillCandidatePromotionError; current?: SkillCandidate; detail?: string };

/**
 * Read-only mirror of the writer's evidence gate. Returns `ok: true` with
 * `alreadyPromoted: false, pendingEvent: false` when the candidate is staged at
 * exactly `expectedLifecycleVersion` with a full frozen-derived staged
 * projection and NO promotion event yet; `alreadyPromoted: false,
 * pendingEvent: true` when the candidate is still staged but the exact
 * deterministic promotion event is already durable (the writer appended the
 * event, then crashed or lost the response before the event-before-success
 * mutation); and `alreadyPromoted: true` only for the exact lost-response retry
 * of an already-promoted candidate (version `expectedLifecycleVersion + 1`,
 * exact matching promotion event, complete promoted post-state with
 * `promoted_at === event.timestamp`).
 *
 * A `pendingEvent: true` result is resumable, not a failure: a high-level
 * caller may continue only through its existing grounding/judge gates, and the
 * mutating writer revalidates this exact evidence and resumes
 * event-before-transition. Every other status/state, and any corrupt,
 * unreadable, or otherwise non-ok promotion-event read, is a typed fail-closed
 * failure — a non-ok read is never treated as event absence.
 */
export function verifySkillCandidatePromotionEvidence(
  input: VerifySkillCandidatePromotionEvidenceInput,
  options?: { root?: string },
): VerifySkillCandidatePromotionEvidenceResult {
  // 1. Identifier/hash-only input, identical shape to the writer.
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.candidateId !== "string" ||
    input.candidateId.length === 0 ||
    !Number.isSafeInteger(input.expectedLifecycleVersion) ||
    input.expectedLifecycleVersion < 0 ||
    typeof input.reportHash !== "string" ||
    input.reportHash.length === 0 ||
    typeof input.decisionRecordHash !== "string" ||
    input.decisionRecordHash.length === 0
  ) {
    return { ok: false, error: "evidence_required" };
  }

  // 2. Reread the durable accepted-decision record.
  const durableRead = readLearningEvalDecision(input.reportHash, options);
  if (!durableRead.ok) {
    if (durableRead.code === "not_found") {
      return { ok: false, error: "evidence_required", detail: durableRead.error };
    }
    if (durableRead.code === "corrupt_store" || durableRead.code === "invalid_record") {
      return { ok: false, error: "record_corrupt", detail: durableRead.error };
    }
    return { ok: false, error: "ambiguous", detail: durableRead.error };
  }

  // 3. Strictly re-decode the durable record.
  const redecoded = decodeLearningEvalDecisionRecord(durableRead.value);
  if (!redecoded.ok) return { ok: false, error: "record_corrupt", detail: redecoded.error };
  const record = redecoded.value;

  // 4. Bind the caller's hashes to the durable record exactly.
  if (input.reportHash !== record.reportHash || input.decisionRecordHash !== record.recordHash) {
    return { ok: false, error: "candidate_binding_mismatch" };
  }

  // 5. Only an accepted report may promote.
  if (record.report.decision !== "accepted") {
    return { ok: false, error: "decision_not_accepted" };
  }

  // 6. Bind the report and recomputed digests to the embedded frozen candidate.
  const frozen = record.candidateArtifact;
  const recomputedArtifactDigest = computeCandidateArtifactDigest(frozen);
  const recomputedContentDigest = candidateContentDigestV1(frozen);
  if (
    input.candidateId !== frozen.id ||
    record.report.candidate.id !== frozen.id ||
    record.report.candidate.artifactDigest !== recomputedArtifactDigest ||
    record.report.candidate.contentDigest !== computeBodyDigest(frozen.body) ||
    recomputedArtifactDigest !== record.candidateArtifactDigest ||
    recomputedContentDigest !== record.candidateContentDigest
  ) {
    return { ok: false, error: "candidate_binding_mismatch" };
  }

  // A durable rollback permanently invalidates this accepted report+candidate;
  // it may never be promoted again.
  const rollbackEventId = computeLearningEvalLifecycleEventId({
    reportHash: record.reportHash,
    candidateId: frozen.id,
    action: "rollback_candidate",
  });
  const rollbackRead = readLearningEvalLifecycleEvent(rollbackEventId, options);
  if (rollbackRead.ok) return { ok: false, error: "rollback_recorded" };
  if (rollbackRead.code !== "not_found") {
    if (rollbackRead.code === "corrupt_store" || rollbackRead.code === "invalid_record") {
      return { ok: false, error: "record_corrupt", detail: rollbackRead.error };
    }
    return { ok: false, error: "ambiguous", detail: rollbackRead.error };
  }

  // 7. The durable observed pre-state must be exactly candidate+version or absent.
  if (
    !(
      (record.observedCandidateStatus === "candidate" &&
        record.observedCandidateLifecycleVersion !== null) ||
      (record.observedCandidateStatus === null &&
        record.observedCandidateLifecycleVersion === null)
    )
  ) {
    return { ok: false, error: "wrong_status" };
  }
  const stagePriorVersion =
    record.observedCandidateStatus === "candidate"
      ? record.observedCandidateLifecycleVersion as number
      : skillCandidateLifecycleVersion(frozen);

  // 8. Read the exact stage_candidate event and verify every frozen binding.
  const stageEventId = computeLearningEvalLifecycleEventId({
    reportHash: record.reportHash,
    candidateId: frozen.id,
    action: "stage_candidate",
  });
  const stageRead = readLearningEvalLifecycleEvent(stageEventId, options);
  if (!stageRead.ok) {
    if (stageRead.code === "not_found") {
      return { ok: false, error: "evidence_required", detail: stageRead.error };
    }
    if (stageRead.code === "corrupt_store" || stageRead.code === "invalid_record") {
      return { ok: false, error: "record_corrupt", detail: stageRead.error };
    }
    return { ok: false, error: "ambiguous", detail: stageRead.error };
  }
  const stageIdentity: LifecycleEventIdentity = {
    reportHash: record.reportHash,
    candidateId: frozen.id,
    candidateContentDigest: record.candidateContentDigest,
    priorLifecycleVersion: stagePriorVersion,
    newLifecycleVersion: stagePriorVersion + 1,
    fromStatus: "candidate",
    toStatus: "staged",
    action: "stage_candidate",
    reasonCode: "accepted_transfer_gate",
  };
  if (!lifecycleEventIdentityMatches(stageRead.value, stageIdentity)) {
    return { ok: false, error: "event_conflict" };
  }
  if (stageRead.value.newLifecycleVersion !== input.expectedLifecycleVersion) {
    return { ok: false, error: "stale_version" };
  }

  // 9. Read the persisted candidate and bind it to the frozen artifact.
  const currentRead = readSkillCandidate(input.candidateId);
  if (!currentRead.ok) {
    return {
      ok: false,
      error: currentRead.error === "candidate_not_found" ? "candidate_not_found" : "record_corrupt",
    };
  }
  const current = currentRead.candidate;
  if (
    current.id !== frozen.id ||
    candidateContentDigestV1(current) !== record.candidateContentDigest
  ) {
    return { ok: false, error: "candidate_binding_mismatch", current };
  }
  const currentVersion = skillCandidateLifecycleVersion(current);
  if (current.status === "promoted") {
    // Exact-retry pre-state: only the version immediately after promotion is
    // admissible. Anything else is ambiguous, never a fresh promotion.
    if (currentVersion !== input.expectedLifecycleVersion + 1) {
      return { ok: false, error: "ambiguous", current };
    }
  } else if (current.status === "staged") {
    if (currentVersion !== input.expectedLifecycleVersion) {
      return { ok: false, error: "stale_version", current };
    }
  } else {
    return { ok: false, error: "wrong_status", current };
  }

  // 10. Promotion event identity: staged -> promoted.
  const promoteIdentity: LifecycleEventIdentity = {
    reportHash: record.reportHash,
    candidateId: frozen.id,
    candidateContentDigest: record.candidateContentDigest,
    priorLifecycleVersion: input.expectedLifecycleVersion,
    newLifecycleVersion: input.expectedLifecycleVersion + 1,
    fromStatus: "staged",
    toStatus: "promoted",
    action: "promote_candidate",
    reasonCode: "accepted_learning_eval",
  };
  const promoteEventId = computeLearningEvalLifecycleEventId({
    reportHash: record.reportHash,
    candidateId: frozen.id,
    action: "promote_candidate",
  });
  const promoteRead = readLearningEvalLifecycleEvent(promoteEventId, options);
  if (!promoteRead.ok && promoteRead.code !== "not_found") {
    if (promoteRead.code === "corrupt_store" || promoteRead.code === "invalid_record") {
      return { ok: false, error: "record_corrupt", detail: promoteRead.error, current };
    }
    return { ok: false, error: "ambiguous", detail: promoteRead.error, current };
  }

  // 11. Exact lost-response retry for an already-promoted candidate.
  if (current.status === "promoted") {
    if (!promoteRead.ok) return { ok: false, error: "ambiguous", current };
    if (!lifecycleEventIdentityMatches(promoteRead.value, promoteIdentity)) {
      return { ok: false, error: "event_conflict", current };
    }
    if (currentVersion !== input.expectedLifecycleVersion + 1) {
      return { ok: false, error: "ambiguous", current };
    }
    if (
      !candidateMatchesPromotedEventState(
        current,
        frozen,
        input.expectedLifecycleVersion + 1,
        promoteRead.value.timestamp,
        record,
      )
    ) {
      return { ok: false, error: "ambiguous", current };
    }
    return { ok: true, candidate: current, alreadyPromoted: true };
  }

  // 12. Verify the exact frozen-derived staged projection BEFORE accepting any
  // staged success, including the resumable pending-event state. A
  // `pendingEvent: true` result must never bypass this check: a staged
  // candidate whose projection diverges from the frozen artifact is a binding
  // mismatch regardless of whether the exact promotion event is already
  // durable.
  if (
    !candidateMatchesPostTransitionState(
      current,
      frozen,
      "staged",
      input.expectedLifecycleVersion,
      record,
    )
  ) {
    return { ok: false, error: "candidate_binding_mismatch", current };
  }

  // 13. Staged candidate with a durable promotion event already present: the
  // event identity was validated at step 10 (a corrupt/unreadable/non-ok read
  // failed closed there and never reached here as absence). The writer
  // appended the event but did not complete the event-before-success mutation,
  // so this is a distinct resumable pending-event state — not `alreadyPromoted`
  // and not generic ambiguity. A high-level caller may continue only through
  // its existing grounding/judge gates; the mutating writer revalidates this
  // exact evidence and resumes event-before-transition.
  if (promoteRead.ok) {
    if (!lifecycleEventIdentityMatches(promoteRead.value, promoteIdentity)) {
      return { ok: false, error: "event_conflict", current };
    }
    return { ok: true, candidate: current, alreadyPromoted: false, pendingEvent: true };
  }

  return { ok: true, candidate: current, alreadyPromoted: false, pendingEvent: false };
}

// ═══════════════════════════════════════════════════════════════
// Priority 3 Phase 3.4 — exact accepted-decision rollback
// ═══════════════════════════════════════════════════════════════
//
// `rollbackSkillCandidateFromAcceptedDecision` is the ONLY store path that may
// persist a `rolled_back` candidate. It is symmetric to the Phase 3.3 promotion
// writer: it accepts hashes/IDs and a bounded reason code only — never a report
// body or caller-authored state — and re-derives every enforcement fact from
// the durable accepted decision plus the exact `stage_candidate` and
// `promote_candidate` events and the current promoted candidate file.
//
//   * strictly re-decodes the durable decision and binds the caller's
//     `reportHash` / `decisionRecordHash` / `candidateId` to it exactly;
//   * requires an `accepted` report and the report/artifact/content digests to
//     match the recomputed digests of the embedded frozen candidate;
//   * requires the durable observed pre-state to be exactly candidate+version
//     or absent, then reads the deterministic `stage_candidate` and
//     `promote_candidate` events and verifies the exact candidate -> staged ->
//     promoted chain at the exact versions;
//   * requires the persisted candidate to be the exact promoted projection at
//     the caller's `expectedLifecycleVersion` before rolling back;
//   * appends and reads back the deterministic rollback event BEFORE the
//     mutation (event-before-success), then transitions promoted -> rolled_back
//     through the version-checked internal path and only returns success after
//     an exact readback;
//   * an exact retry of an already rolled-back candidate is verified against
//     the same decision, stage and promotion events, rollback event, and
//     post-state; a crash between the event append and the mutation resumes
//     only from the exact promoted version.

function candidateMatchesRolledBackEventState(
  candidate: SkillCandidate,
  frozen: SkillCandidate,
  lifecycleVersion: number,
  promotedAt: string,
): boolean {
  const validatedActual = validateSkillCandidate(candidate);
  if (!validatedActual.ok) return false;
  const actual = validatedActual.candidate;
  const expected = validateSkillCandidate({
    ...frozen,
    status: "rolled_back",
    promoted_at: promotedAt,
    rejection_reason: undefined,
    rejection_detail: undefined,
    id: frozen.id,
    lifecycle_version: lifecycleVersion,
    updated_at: actual.updated_at,
  });
  if (!expected.ok) return false;
  return stableStringify(actual) === stableStringify(expected.candidate);
}

export interface RollbackSkillCandidateFromAcceptedDecisionInput {
  candidateId: string;
  expectedLifecycleVersion: number;
  reportHash: string;
  decisionRecordHash: string;
  reasonCode: LearningEvalRollbackReasonCode;
  /**
   * Required canonical ISO-8601 timestamp for the rollback lifecycle event. The
   * caller generates it once for a new rollback and replays the exact same value
   * on retries so the persisted event bytes are deterministic.
   */
  eventTimestamp: string;
}

export type SkillCandidateRollbackResult =
  | { ok: true; candidate: SkillCandidate; event: LearningEvalLifecycleEventV1; eventCreated: boolean }
  | { ok: false; error: SkillCandidatePromotionError; current?: SkillCandidate; detail?: string };

export function rollbackSkillCandidateFromAcceptedDecision(
  input: RollbackSkillCandidateFromAcceptedDecisionInput,
  options?: { root?: string },
): SkillCandidateRollbackResult {
  // 1. Public input is identifiers/hashes plus a bounded reason code.
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.candidateId !== "string" ||
    input.candidateId.length === 0 ||
    !Number.isSafeInteger(input.expectedLifecycleVersion) ||
    input.expectedLifecycleVersion < 0 ||
    typeof input.reportHash !== "string" ||
    input.reportHash.length === 0 ||
    typeof input.decisionRecordHash !== "string" ||
    input.decisionRecordHash.length === 0 ||
    typeof input.reasonCode !== "string" ||
    typeof input.eventTimestamp !== "string" ||
    !isCanonicalIsoTimestamp(input.eventTimestamp)
  ) {
    return { ok: false, error: "evidence_required" };
  }

  // 2. Reread the durable accepted-decision record.
  const durableRead = readLearningEvalDecision(input.reportHash, options);
  if (!durableRead.ok) {
    if (durableRead.code === "not_found") {
      return { ok: false, error: "evidence_required", detail: durableRead.error };
    }
    if (durableRead.code === "corrupt_store" || durableRead.code === "invalid_record") {
      return { ok: false, error: "record_corrupt", detail: durableRead.error };
    }
    return { ok: false, error: "ambiguous", detail: durableRead.error };
  }

  // 3. Strictly re-decode the durable record.
  const redecoded = decodeLearningEvalDecisionRecord(durableRead.value);
  if (!redecoded.ok) return { ok: false, error: "record_corrupt", detail: redecoded.error };
  const record = redecoded.value;

  // 4. Bind the caller's hashes to the durable record exactly.
  if (input.reportHash !== record.reportHash || input.decisionRecordHash !== record.recordHash) {
    return { ok: false, error: "candidate_binding_mismatch" };
  }

  // 5. Only an accepted report may roll back.
  if (record.report.decision !== "accepted") {
    return { ok: false, error: "decision_not_accepted" };
  }

  // 6. Bind the report and recomputed digests to the embedded frozen candidate.
  const frozen = record.candidateArtifact;
  const recomputedArtifactDigest = computeCandidateArtifactDigest(frozen);
  const recomputedContentDigest = candidateContentDigestV1(frozen);
  if (
    input.candidateId !== frozen.id ||
    record.report.candidate.id !== frozen.id ||
    record.report.candidate.artifactDigest !== recomputedArtifactDigest ||
    record.report.candidate.contentDigest !== computeBodyDigest(frozen.body) ||
    recomputedArtifactDigest !== record.candidateArtifactDigest ||
    recomputedContentDigest !== record.candidateContentDigest
  ) {
    return { ok: false, error: "candidate_binding_mismatch" };
  }

  // 7. The durable observed pre-state must be exactly candidate+version or absent.
  if (
    !(
      (record.observedCandidateStatus === "candidate" &&
        record.observedCandidateLifecycleVersion !== null) ||
      (record.observedCandidateStatus === null &&
        record.observedCandidateLifecycleVersion === null)
    )
  ) {
    return { ok: false, error: "wrong_status" };
  }
  const stagePriorVersion =
    record.observedCandidateStatus === "candidate"
      ? record.observedCandidateLifecycleVersion as number
      : skillCandidateLifecycleVersion(frozen);

  // 8. Read the exact stage_candidate event and verify every frozen binding.
  const stageEventId = computeLearningEvalLifecycleEventId({
    reportHash: record.reportHash,
    candidateId: frozen.id,
    action: "stage_candidate",
  });
  const stageRead = readLearningEvalLifecycleEvent(stageEventId, options);
  if (!stageRead.ok) {
    if (stageRead.code === "not_found") {
      return { ok: false, error: "evidence_required", detail: stageRead.error };
    }
    if (stageRead.code === "corrupt_store" || stageRead.code === "invalid_record") {
      return { ok: false, error: "record_corrupt", detail: stageRead.error };
    }
    return { ok: false, error: "ambiguous", detail: stageRead.error };
  }
  const stageIdentity: LifecycleEventIdentity = {
    reportHash: record.reportHash,
    candidateId: frozen.id,
    candidateContentDigest: record.candidateContentDigest,
    priorLifecycleVersion: stagePriorVersion,
    newLifecycleVersion: stagePriorVersion + 1,
    fromStatus: "candidate",
    toStatus: "staged",
    action: "stage_candidate",
    reasonCode: "accepted_transfer_gate",
  };
  if (!lifecycleEventIdentityMatches(stageRead.value, stageIdentity)) {
    return { ok: false, error: "event_conflict" };
  }
  const stagedVersion = stageRead.value.newLifecycleVersion;

  // 9. Read the exact promote_candidate event and verify every frozen binding.
  const promoteEventId = computeLearningEvalLifecycleEventId({
    reportHash: record.reportHash,
    candidateId: frozen.id,
    action: "promote_candidate",
  });
  const promoteRead = readLearningEvalLifecycleEvent(promoteEventId, options);
  if (!promoteRead.ok) {
    if (promoteRead.code === "not_found") {
      return { ok: false, error: "evidence_required", detail: promoteRead.error };
    }
    if (promoteRead.code === "corrupt_store" || promoteRead.code === "invalid_record") {
      return { ok: false, error: "record_corrupt", detail: promoteRead.error };
    }
    return { ok: false, error: "ambiguous", detail: promoteRead.error };
  }
  const promoteIdentity: LifecycleEventIdentity = {
    reportHash: record.reportHash,
    candidateId: frozen.id,
    candidateContentDigest: record.candidateContentDigest,
    priorLifecycleVersion: stagedVersion,
    newLifecycleVersion: stagedVersion + 1,
    fromStatus: "staged",
    toStatus: "promoted",
    action: "promote_candidate",
    reasonCode: "accepted_learning_eval",
  };
  if (!lifecycleEventIdentityMatches(promoteRead.value, promoteIdentity)) {
    return { ok: false, error: "event_conflict" };
  }
  const promotedVersion = promoteRead.value.newLifecycleVersion;
  if (promotedVersion !== input.expectedLifecycleVersion) {
    return { ok: false, error: "stale_version" };
  }

  // 10. Rollback event identity: promoted -> rolled_back.
  const rollbackIdentity: LifecycleEventIdentity = {
    reportHash: record.reportHash,
    candidateId: frozen.id,
    candidateContentDigest: record.candidateContentDigest,
    priorLifecycleVersion: promotedVersion,
    newLifecycleVersion: promotedVersion + 1,
    fromStatus: "promoted",
    toStatus: "rolled_back",
    action: "rollback_candidate",
    reasonCode: input.reasonCode,
  };
  // The exact full expected rollback event, including timestamp and eventHash.
  // Every persisted rollback event path must byte-match this canonical event;
  // a different timestamp or any differing byte is a conflict.
  const expectedEventResult = createLearningEvalLifecycleEvent({
    ...rollbackIdentity,
    timestamp: input.eventTimestamp,
  });
  if (!expectedEventResult.ok) return { ok: false, error: "ambiguous" };
  const expectedEvent = expectedEventResult.value;
  const rollbackEventId = computeLearningEvalLifecycleEventId({
    reportHash: record.reportHash,
    candidateId: frozen.id,
    action: "rollback_candidate",
  });
  const rollbackRead = readLearningEvalLifecycleEvent(rollbackEventId, options);
  if (!rollbackRead.ok && rollbackRead.code !== "not_found") {
    if (rollbackRead.code === "corrupt_store" || rollbackRead.code === "invalid_record") {
      return { ok: false, error: "record_corrupt", detail: rollbackRead.error };
    }
    return { ok: false, error: "ambiguous", detail: rollbackRead.error };
  }

  // 11. Read the persisted candidate and bind it to the frozen artifact.
  const currentRead = readSkillCandidate(input.candidateId);
  if (!currentRead.ok) {
    return {
      ok: false,
      error: currentRead.error === "candidate_not_found" ? "candidate_not_found" : "record_corrupt",
    };
  }
  const current = currentRead.candidate;
  if (
    current.id !== frozen.id ||
    candidateContentDigestV1(current) !== record.candidateContentDigest
  ) {
    return { ok: false, error: "candidate_binding_mismatch", current };
  }
  const currentVersion = skillCandidateLifecycleVersion(current);

  // 12. Exact-retry / lost-response retry for an already rolled-back candidate.
  if (current.status === "rolled_back") {
    if (currentVersion !== promotedVersion + 1) {
      return { ok: false, error: "ambiguous", current };
    }
    if (!rollbackRead.ok) return { ok: false, error: "ambiguous", current };
    if (stableStringify(rollbackRead.value) !== stableStringify(expectedEvent)) {
      return { ok: false, error: "event_conflict", current };
    }
    if (
      !candidateMatchesRolledBackEventState(
        current,
        frozen,
        promotedVersion + 1,
        promoteRead.value.timestamp,
      )
    ) {
      return { ok: false, error: "ambiguous", current };
    }
    return { ok: true, candidate: current, event: rollbackRead.value, eventCreated: false };
  }

  // 13. Pre-transition candidate must be the exact promoted projection/version.
  if (current.status !== "promoted") {
    return { ok: false, error: "wrong_status", current };
  }
  if (currentVersion !== promotedVersion) {
    return { ok: false, error: "stale_version", current };
  }
  if (
    !candidateMatchesPromotedEventState(
      current,
      frozen,
      promotedVersion,
      promoteRead.value.timestamp,
      record,
    )
  ) {
    return { ok: false, error: "candidate_binding_mismatch", current };
  }

  // 14. Resolve the rollback event before mutation (event-before-success). A
  // crash after the append but before the transition resumes here from the
  // exact promoted version.
  let event: LearningEvalLifecycleEventV1;
  let eventCreated: boolean;
  if (rollbackRead.ok) {
    if (stableStringify(rollbackRead.value) !== stableStringify(expectedEvent)) {
      return { ok: false, error: "event_conflict", current };
    }
    event = rollbackRead.value;
    eventCreated = false;
  } else {
    const appended = appendAndReadBackLifecycleEvent(rollbackIdentity, input.eventTimestamp, options);
    if (!appended.ok) return { ok: false, error: appended.error, current };
    event = appended.event;
    eventCreated = appended.created;
  }

  // 15. Transition to rolled_back through the evidence-gated internal path.
  const transition = transitionSkillCandidateInternal(
    input.candidateId,
    promotedVersion,
    "promoted",
    (existing) => ({
      ...existing,
      status: "rolled_back",
      promoted_at: existing.promoted_at,
      rejection_reason: undefined,
      rejection_detail: undefined,
    }),
    false,
    true,
  );
  if (!transition.ok) {
    const attempted = readSkillCandidate(input.candidateId);
    if (
      attempted.ok &&
      candidateMatchesRolledBackEventState(
        attempted.candidate,
        frozen,
        promotedVersion + 1,
        promoteRead.value.timestamp,
      )
    ) {
      return { ok: true, candidate: attempted.candidate, event, eventCreated };
    }
    if (transition.error === "stale_version" || transition.error === "wrong_status") {
      return { ok: false, error: transition.error, current: transition.current ?? current };
    }
    if (transition.error === "candidate_not_found") {
      return { ok: false, error: "candidate_not_found", current: transition.current ?? current };
    }
    if (transition.error === "invalid_candidate_record") {
      return { ok: false, error: "record_corrupt", current: transition.current ?? current };
    }
    return { ok: false, error: "ambiguous", current: transition.current ?? current };
  }

  // 16. Authoritative readback: never acknowledge success from the write alone.
  const finalRead = readSkillCandidate(input.candidateId);
  if (!finalRead.ok) return { ok: false, error: "ambiguous", current: transition.candidate };
  if (
    !candidateMatchesRolledBackEventState(
      finalRead.candidate,
      frozen,
      promotedVersion + 1,
      promoteRead.value.timestamp,
    )
  ) {
    return { ok: false, error: "ambiguous", current: finalRead.candidate };
  }
  return { ok: true, candidate: finalRead.candidate, event, eventCreated };
}
