import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { SkillCandidate, SkillCandidateStatus, SkillRejectionReason } from "./skill-types";

export function skillCandidateLifecycleVersion(candidate: Pick<SkillCandidate, "lifecycle_version"> | null | undefined): number {
  const version = candidate?.lifecycle_version;
  return Number.isSafeInteger(version) && (version as number) >= 0 ? version as number : 0;
}

function normalizeSkillCandidate(value: unknown): SkillCandidate {
  const candidate = value as SkillCandidate;
  return { ...candidate, lifecycle_version: skillCandidateLifecycleVersion(candidate) };
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

export function saveSkillCandidate(candidate: SkillCandidate): void {
  const normalized = normalizeSkillCandidate(candidate);
  const path = skillCandidatePath(normalized.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(normalized, null, 2), "utf-8");
}

export function loadSkillCandidate(id: string): SkillCandidate | null {
  const path = skillCandidatePath(id);
  if (!existsSync(path)) return null;
  try {
    return normalizeSkillCandidate(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

export function listSkillCandidates(status?: SkillCandidateStatus): SkillCandidate[] {
  const dir = skillCandidatesDir();
  if (!existsSync(dir)) return [];
  const out: SkillCandidate[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const row = normalizeSkillCandidate(JSON.parse(readFileSync(join(dir, file), "utf-8")));
      if (!status || row.status === status) out.push(row);
    } catch {
      // Skip corrupt files.
    }
  }
  return out.sort((a, b) => {
    const byUpdated = b.updated_at.localeCompare(a.updated_at);
    return byUpdated || a.id.localeCompare(b.id);
  });
}

export type SkillCandidateTransitionError = "candidate_not_found" | "stale_version" | "wrong_status";
export type SkillCandidateTransitionResult =
  | { ok: true; candidate: SkillCandidate }
  | { ok: false; error: SkillCandidateTransitionError; current?: SkillCandidate };

export function transitionSkillCandidate(
  id: string,
  expectedVersion: number,
  requiredStatus: SkillCandidateStatus,
  update: (current: SkillCandidate) => Partial<SkillCandidate>,
): SkillCandidateTransitionResult {
  const existing = loadSkillCandidate(id);
  if (!existing) return { ok: false, error: "candidate_not_found" };
  const currentVersion = skillCandidateLifecycleVersion(existing);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || currentVersion !== expectedVersion) {
    return { ok: false, error: "stale_version", current: existing };
  }
  if (existing.status !== requiredStatus) {
    return { ok: false, error: "wrong_status", current: existing };
  }
  const updated = normalizeSkillCandidate({
    ...existing,
    ...update(existing),
    id: existing.id,
    lifecycle_version: currentVersion + 1,
    updated_at: new Date().toISOString(),
  });
  saveSkillCandidate(updated);
  return { ok: true, candidate: updated };
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
      // Best effort.
    }
  }
  return excess.length;
}