import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { validateSkillCandidate } from "./skill-candidate-validation";
import type { SkillCandidate, SkillCandidateStatus, SkillRejectionReason } from "./skill-types";
import { computeCandidateArtifactDigest, stableStringify } from "../self-tuning/rollout/learning-eval-types";
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
} from "../self-tuning/rollout/learning-eval-decision-store";

export type SkillCandidateReadResult =
  | { ok: true; candidate: SkillCandidate }
  | { ok: false; error: "candidate_not_found" | "invalid_candidate_record" };

export function skillCandidateLifecycleVersion(candidate: Pick<SkillCandidate, "lifecycle_version"> | null | undefined): number {
  const version = candidate?.lifecycle_version;
  return Number.isSafeInteger(version) && (version as number) >= 0 ? version as number : 0;
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

export function saveSkillCandidate(candidate: SkillCandidate): void {
  const validated = validateSkillCandidate(candidate);
  if (!validated.ok) throw new Error("invalid_candidate_record");
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

export type SkillCandidateTransitionError = "candidate_not_found" | "invalid_candidate_record" | "stale_version" | "wrong_status";
export type SkillCandidateTransitionResult =
  | { ok: true; candidate: SkillCandidate }
  | { ok: false; error: SkillCandidateTransitionError; current?: SkillCandidate };

export function transitionSkillCandidate(
  id: string,
  expectedVersion: number,
  requiredStatus: SkillCandidateStatus,
  update: (current: SkillCandidate) => Partial<SkillCandidate>,
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
  const updated = validateSkillCandidate({
    ...existing,
    ...update(existing),
    id: existing.id,
    lifecycle_version: currentVersion + 1,
    updated_at: new Date().toISOString(),
  });
  if (!updated.ok) return { ok: false, error: "invalid_candidate_record" };
  saveSkillCandidate(updated.candidate);
  return { ok: true, candidate: updated.candidate };
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
      if (status === "promoted") {
        updated.promoted_at = new Date().toISOString();
      } else {
        updated.promoted_at = undefined;
      }
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
 * Build, append, and explicitly read back the deterministic lifecycle event. A
 * raced append whose persisted bytes differ only in timestamp is reconciled by
 * deterministic identity; any other conflicting event is refused untouched.
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
    if (!raced.ok || !lifecycleEventIdentityMatches(raced.value, identity)) {
      return { ok: false, error: "event_conflict" };
    }
    return { ok: true, event: raced.value, created: false };
  }
  const readBack = readLearningEvalLifecycleEvent(created.value.eventId, options);
  if (!readBack.ok) return { ok: false, error: "ambiguous" };
  if (!lifecycleEventIdentityMatches(readBack.value, identity)) {
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

  // 3. Resolve the intended action against the frozen report decision.
  const reportDecision = durable.report.decision;
  let toStatus: LearningEvalLifecycleToStatus;
  let reasonCode: LearningEvalLifecycleReasonCode;
  if (intent.action === "stage_candidate") {
    if (reportDecision !== "accepted") return { ok: false, error: "action_not_supported" };
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
        if (
          observedPreTransitionMatches &&
          lifecycleEventIdentityMatches(eventRead.value, retryIdentity) &&
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
  const eventRead = readLearningEvalLifecycleEvent(eventId, options);
  let event: LearningEvalLifecycleEventV1;
  let eventCreated: boolean;
  if (eventRead.ok) {
    if (!lifecycleEventIdentityMatches(eventRead.value, identity)) {
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
    const appended = appendAndReadBackLifecycleEvent(identity, intent.timestamp, options);
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
