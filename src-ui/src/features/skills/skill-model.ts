// Skills data model + Bun/Tauri readers shared by the Skills page, detail
// panel and Candidates tab. Pure helpers only (no React).

import { invoke } from '@tauri-apps/api/core';
import type { SkillCandidateAction } from '../../domain/skill-candidate-operation-state';
import type { CandidatePerformanceResponse } from '../../domain/skill-candidate-performance';

export const BUN_URL = 'http://127.0.0.1:19877';

/** Skill relevance gate: promotion requires a passing judge decision. */
export const PROMOTE_EVAL_GATE = 0.75;

export const PROMOTE_BLOCKED_HINT = 'Run eval first — promotion requires a passing judge decision (≥0.75)';
export const PROMOTE_READY_HINT = 'Promote to live skill';

export interface Skill {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  metadata: string | null;
  body: string;
  version: number;
  last_improved_at?: string | null;
  improvement_score: number;
  created_at: string;
  updated_at: string;
}

export interface SkillRevision {
  id: string;
  skill_id: string;
  version: number;
  body_before: string;
  body_after: string;
  change_reason: string;
  source_session_id?: string | null;
  created_at: string;
}

// Distilled-skill lifecycle detail, fetched from the Bun orchestrator (the
// source of truth for distilled skills). The native `Skill` row's
// `metadata.candidate_id` links it to one of these.
export interface SkillCandidateDetail {
  id: string;
  name: string;
  description: string;
  trigger: { task_types: string[]; requirements: string[]; signals: string[] };
  body: string;
  source_run_ids: string[];
  source_session_id?: string;
  confidence: number;
  status: 'candidate' | 'staged' | 'promoted' | 'rejected' | 'rolled_back';
  lifecycle_version?: number;
  eval_score?: number;
  eval_missed?: string[];
  rejection_reason?: string;
  rejection_detail?: string;
  promoted_at?: string;
  created_at: string;
  updated_at: string;
}

export type SkillFilter = 'all' | 'enabled' | 'disabled' | 'candidates';

export type RequirementKind = 'bins' | 'env' | 'config' | 'os';
export const REQUIREMENT_KINDS: RequirementKind[] = ['bins', 'env', 'config', 'os'];

export interface SkillMeta {
  category: string | null;
  status: string | null;
  source: string | null;
  candidateId: string | null;
  emoji: string | null;
  /** Declared requirements, when the skill's metadata carries them. */
  requires: Partial<Record<RequirementKind, string[]>>;
  /** Requirements the runtime reported as unmet, when it reported any. */
  missing: Partial<Record<RequirementKind, string[]>>;
  /**
   * `true`/`false` only when the metadata says so (`eligible` or a `missing`
   * object). `null` means unknown — the UI shows no eligibility badge then.
   */
  eligible: boolean | null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

function requirementMap(value: unknown): Partial<Record<RequirementKind, string[]>> {
  if (!value || typeof value !== 'object') return {};
  const out: Partial<Record<RequirementKind, string[]>> = {};
  for (const kind of REQUIREMENT_KINDS) {
    const list = stringList((value as Record<string, unknown>)[kind]);
    if (list.length > 0) out[kind] = list;
  }
  return out;
}

const metaCache = new Map<string, SkillMeta>();

const EMPTY_META: SkillMeta = {
  category: null,
  status: null,
  source: null,
  candidateId: null,
  emoji: null,
  requires: {},
  missing: {},
  eligible: null,
};

/** Defensive metadata parse — malformed JSON never throws. */
export function skillMeta(skill: Pick<Skill, 'metadata'>): SkillMeta {
  const raw = skill.metadata;
  if (!raw) return EMPTY_META;
  const cached = metaCache.get(raw);
  if (cached) return cached;
  let md: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) md = parsed as Record<string, unknown>;
  } catch {
    /* ignore malformed metadata */
  }
  const str = (key: string) => (typeof md[key] === 'string' ? (md[key] as string) : null);
  const missing = requirementMap(md.missing);
  const hasMissingObject = md.missing !== null && typeof md.missing === 'object';
  const eligible =
    typeof md.eligible === 'boolean'
      ? md.eligible
      : hasMissingObject
        ? Object.keys(missing).length === 0
        : null;
  const meta: SkillMeta = {
    category: str('category'),
    status: str('status'),
    source: str('source'),
    candidateId: str('candidate_id'),
    emoji: str('emoji'),
    requires: requirementMap(md.requires),
    missing,
    eligible,
  };
  if (metaCache.size > 500) metaCache.clear();
  metaCache.set(raw, meta);
  return meta;
}

export function isDistilledCandidate(skill: Skill): boolean {
  const meta = skillMeta(skill);
  return meta.status === 'candidate' || skill.name.startsWith('distilled-');
}

/** Distilled skills are owned by the Bun candidate store — their lifecycle
 *  moves through Promote/Reject/Demote, not the native enable/disable
 *  toggle (which the orchestrator's resolver never reads for these rows). */
export function isDistilledSkill(skill: Skill): boolean {
  return skillMeta(skill).source === 'trajectory_distillation';
}

export function candidateIdOf(skill: Skill): string | null {
  return skillMeta(skill).candidateId;
}

export function formatDate(ts?: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function canPromote(candidate: SkillCandidateDetail | null | undefined): boolean {
  return candidate?.eval_score !== undefined && candidate.eval_score >= PROMOTE_EVAL_GATE;
}

export interface SkillCandidateActionResponse {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

export async function postSkillCandidateAction(
  candidateId: string,
  action: SkillCandidateAction,
  expectedVersion: number,
  reason?: string,
): Promise<SkillCandidateActionResponse> {
  try {
    const res = await fetch(`${BUN_URL}/skills/candidates/${encodeURIComponent(candidateId)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_version: expectedVersion, ...(reason === undefined ? {} : { reason }) }),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      status: res.status,
      data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {},
    };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

/**
 * Read one promoted candidate's performance-since-promotion window. A rejected
 * request, a status the route uses to refuse the read, and an undecodable body
 * are each reported as themselves so `skill-candidate-performance` can name
 * what it could not learn; no transport or server text is carried, and the
 * `status` is normalised because a synthetic or partial response may not carry
 * one at all.
 */
export async function readCandidatePerformance(candidateId: string): Promise<CandidatePerformanceResponse> {
  let res: Response;
  try {
    res = await fetch(`${BUN_URL}/skills/candidates/${encodeURIComponent(candidateId)}/performance`);
  } catch {
    return { kind: 'transport' };
  }
  const status = typeof res.status === 'number' ? res.status : 0;
  try {
    return { kind: 'http', status, value: await res.json() };
  } catch {
    return { kind: 'body' };
  }
}

export async function readRuntimeSkills() {
  const result = await invoke<RuntimeEntry[]>('jarvis_get_skills');
  if (!Array.isArray(result)) throw new Error('Invalid skills observation');
  return result;
}

export async function readRuntimeTools() {
  const result = await invoke<RuntimeEntry[]>('jarvis_get_tools');
  if (!Array.isArray(result)) throw new Error('Invalid tools observation');
  return result;
}

export type RuntimeEntry = { name?: string } & Record<string, unknown>;

export function runtimeEntryLabel(entry: RuntimeEntry): string {
  return entry.name || JSON.stringify(entry);
}

export async function readCandidates() {
  const res = await fetch(`${BUN_URL}/skills/candidates`);
  if (!res.ok) throw new Error('Candidate observation unavailable');
  const body = await res.json();
  if (!Array.isArray(body?.candidates)) throw new Error('Invalid candidate observation');
  const byId: Record<string, SkillCandidateDetail> = {};
  for (const value of body.candidates) {
    if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') {
      throw new Error('Invalid candidate observation');
    }
    const candidate = value as SkillCandidateDetail;
    const version = candidate.lifecycle_version;
    byId[candidate.id] = {
      ...candidate,
      lifecycle_version: Number.isSafeInteger(version) && (version as number) >= 0 ? (version as number) : 0,
    };
  }
  return byId;
}

/** Leading `---` YAML frontmatter of a SKILL.md, split from the prose body. */
export function splitFrontmatter(body: string): { front: string | null; rest: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (!match) return { front: null, rest: body };
  return { front: match[1], rest: body.slice(match[0].length) };
}
