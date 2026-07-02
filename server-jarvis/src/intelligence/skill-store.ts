import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { SkillCandidate, SkillCandidateStatus, SkillRejectionReason } from "./skill-types";

function skillCandidatesDirOverride(): string | undefined {
  return (globalThis as { __skillCandidatesDirOverride?: string }).__skillCandidatesDirOverride;
}

export function skillCandidatesDir(): string {
  const override = skillCandidatesDirOverride();
  const p = override ?? join(homedir(), ".openclaw", "jarvis", "skills", "candidates");
  mkdirSync(p, { recursive: true });
  return p;
}

export function skillCandidatePath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(skillCandidatesDir(), `${safe}.json`);
}

export function saveSkillCandidate(candidate: SkillCandidate): void {
  const path = skillCandidatePath(candidate.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(candidate, null, 2), "utf-8");
}

export function loadSkillCandidate(id: string): SkillCandidate | null {
  const path = skillCandidatePath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SkillCandidate;
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
      const row = JSON.parse(readFileSync(join(dir, file), "utf-8")) as SkillCandidate;
      if (!status || row.status === status) out.push(row);
    } catch {
      // Skip corrupt files.
    }
  }
  return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function updateSkillCandidateStatus(
  id: string,
  status: SkillCandidateStatus,
  evalScore?: number,
  rejectionReason?: SkillRejectionReason,
  rejectionDetail?: string,
  evalMissed?: string[],
): SkillCandidate | null {
  const existing = loadSkillCandidate(id);
  if (!existing) return null;
  const updated: SkillCandidate = {
    ...existing,
    status,
    eval_score: evalScore ?? existing.eval_score,
    updated_at: new Date().toISOString(),
  };
  // Only attach rejection metadata on rejection transitions — preserve
  // a stale reason on a status change to "candidate" or "promoted"
  // (the operator can re-arm by saving a fresh candidate).
  if (status === "rejected") {
    updated.rejection_reason = rejectionReason;
    updated.rejection_detail = rejectionDetail;
  } else {
    delete updated.rejection_reason;
    delete updated.rejection_detail;
  }
  if (evalMissed !== undefined) updated.eval_missed = evalMissed;
  // promoted_at is set on promotion and cleared on any transition away from
  // "promoted" (demote back to "candidate", or a reject) — it should never
  // survive a status it no longer describes.
  if (status === "promoted") {
    updated.promoted_at = new Date().toISOString();
  } else {
    delete updated.promoted_at;
  }
  saveSkillCandidate(updated);
  return updated;
}

/** Persists a judge run's score/missed items without transitioning status —
 *  backs the `POST /skills/candidates/:id/eval` endpoint, which lets an
 *  operator preview a grounding score before committing to promote/reject. */
export function updateSkillCandidateEval(
  id: string,
  evalScore: number,
  evalMissed: string[],
): SkillCandidate | null {
  const existing = loadSkillCandidate(id);
  if (!existing) return null;
  const updated: SkillCandidate = {
    ...existing,
    eval_score: evalScore,
    eval_missed: evalMissed,
    updated_at: new Date().toISOString(),
  };
  saveSkillCandidate(updated);
  return updated;
}

export function pruneSkillCandidates(maxRows: number): number {
  const all = listSkillCandidates();
  if (all.length <= maxRows) return 0;
  const excess = all.slice(maxRows);
  for (const row of excess) {
    try {
      unlinkSync(skillCandidatePath(row.id));
    } catch {
      // Best effort.
    }
  }
  return excess.length;
}