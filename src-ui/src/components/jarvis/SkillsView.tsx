// ═══════════════════════════════════════════════════════════════
// ── SkillsView — Browse, toggle, inspect, and revision-restore skills
// ═══════════════════════════════════════════════════════════════
//
// Backed by the SQLite skills surface in src-tauri/src/commands/skills.rs:
//   list_skills() -> Skill[]
//   enable_skill(name) / disable_skill(name)
//   invoke_skill(name) -> Skill        (returns the full body + metadata)
//   skill_revisions_list(skillId?, limit?) -> SkillRevision[]
//   skill_restore_revision(revisionId) -> bool

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  cn,
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
  LoadingState,
  ErrorState,
  EmptyState,
  useToast,
} from '../ui';
import MarkdownRenderer from './MarkdownRenderer';

// ── Types ──────────────────────────────────────────────────────

interface Skill {
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

interface SkillRevision {
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
// source of truth for distilled skills — see docs/superpowers/plans/
// 2026-07-02-organism-loop-implementation-spec.md D1). The native `Skill`
// row's `metadata.candidate_id` links it to one of these.
interface SkillCandidateDetail {
  id: string;
  name: string;
  description: string;
  trigger: { task_types: string[]; requirements: string[]; signals: string[] };
  body: string;
  source_run_ids: string[];
  source_session_id?: string;
  confidence: number;
  status: 'candidate' | 'promoted' | 'rejected';
  eval_score?: number;
  eval_missed?: string[];
  rejection_reason?: string;
  rejection_detail?: string;
  promoted_at?: string;
  created_at: string;
  updated_at: string;
}

interface CandidatePerformance {
  id: string;
  promoted_at: string;
  task_types: string[];
  before: { runs: number; successes: number; success_rate: number | null };
  after: { runs: number; successes: number; success_rate: number | null };
  delta: number | null;
}

type Filter = 'all' | 'enabled' | 'disabled' | 'candidates';

const BUN_URL = 'http://127.0.0.1:19877';

// ── Helpers ────────────────────────────────────────────────────

function formatDate(ts?: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function categoryOf(skill: Skill): string | null {
  if (!skill.metadata) return null;
  try {
    const md = JSON.parse(skill.metadata);
    if (typeof md.category === 'string') return md.category;
  } catch {
    /* ignore malformed metadata */
  }
  return null;
}

function distilledStatus(skill: Skill): string | null {
  if (!skill.metadata) return null;
  try {
    const md = JSON.parse(skill.metadata);
    if (typeof md.status === 'string') return md.status;
  } catch {
    /* ignore */
  }
  return null;
}

function isDistilledCandidate(skill: Skill): boolean {
  const status = distilledStatus(skill);
  return status === 'candidate' || skill.name.startsWith('distilled-');
}

function sourceOf(skill: Skill): string | null {
  if (!skill.metadata) return null;
  try {
    const md = JSON.parse(skill.metadata);
    return typeof md.source === 'string' ? md.source : null;
  } catch {
    return null;
  }
}

function candidateIdOf(skill: Skill): string | null {
  if (!skill.metadata) return null;
  try {
    const md = JSON.parse(skill.metadata);
    return typeof md.candidate_id === 'string' ? md.candidate_id : null;
  } catch {
    return null;
  }
}

/** Distilled skills are owned by the Bun candidate store — their lifecycle
 *  moves through Promote/Reject/Demote, not the native enable/disable
 *  toggle (which the orchestrator's resolver never reads for these rows). */
function isDistilledSkill(skill: Skill): boolean {
  return sourceOf(skill) === 'trajectory_distillation';
}

async function postSkillCandidateAction(
  candidateId: string,
  action: 'promote' | 'reject' | 'demote' | 'eval',
  body?: unknown,
): Promise<{ ok: boolean; data: any }> {
  try {
    const res = await fetch(`${BUN_URL}/skills/candidates/${encodeURIComponent(candidateId)}/${action}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch (e) {
    return { ok: false, data: { error: String(e) } };
  }
}

// ── Detail panel ───────────────────────────────────────────────

function SkillDetail({
  skill,
  candidateDetail,
  onClose,
  onToggle,
  onChanged,
}: {
  skill: Skill;
  candidateDetail: SkillCandidateDetail | null;
  onClose: () => void;
  onToggle: (skill: Skill) => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'body' | 'revisions'>('body');
  const [revisions, setRevisions] = useState<SkillRevision[] | null>(null);
  const [loadingRevs, setLoadingRevs] = useState(false);
  const [revError, setRevError] = useState<string | null>(null);
  const [performance, setPerformance] = useState<CandidatePerformance | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const { success, error: toastError } = useToast();
  const distilled = isDistilledSkill(skill);

  useEffect(() => {
    setPerformance(null);
    if (candidateDetail?.status === 'promoted') {
      fetch(`${BUN_URL}/skills/candidates/${encodeURIComponent(candidateDetail.id)}/performance`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => setPerformance(data))
        .catch(() => setPerformance(null));
    }
  }, [candidateDetail?.id, candidateDetail?.status]);

  const runAction = useCallback(
    async (action: 'promote' | 'reject' | 'demote' | 'eval') => {
      if (!candidateDetail) return;
      setActionBusy(true);
      try {
        const { ok, data } = await postSkillCandidateAction(candidateDetail.id, action);
        if (!ok) {
          toastError(data?.detail || data?.error || `${action} failed`, `${action} failed`);
          return;
        }
        success(`${skill.name}: ${action} -> ${data?.status ?? 'ok'}`);
        onChanged();
      } finally {
        setActionBusy(false);
      }
    },
    [candidateDetail, skill.name, onChanged, success, toastError],
  );

  const loadRevisions = useCallback(async () => {
    setLoadingRevs(true);
    setRevError(null);
    try {
      const revs = await invoke<SkillRevision[]>('skill_revisions_list', {
        skillId: skill.id,
        limit: 50,
      });
      setRevisions(revs);
    } catch (e) {
      setRevError(String(e));
    } finally {
      setLoadingRevs(false);
    }
  }, [skill.id]);

  useEffect(() => {
    if (tab === 'revisions' && revisions === null) loadRevisions();
  }, [tab, revisions, loadRevisions]);

  const restore = useCallback(
    async (rev: SkillRevision) => {
      try {
        await invoke<boolean>('skill_restore_revision', { revisionId: rev.id });
        success(`Restored ${skill.name} to v${rev.version}`, 'Revision restored');
        await loadRevisions();
        onChanged();
      } catch (e) {
        toastError(String(e), 'Restore failed');
      }
    },
    [skill.name, loadRevisions, onChanged, success, toastError],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot ok={skill.enabled} warn={!skill.enabled} />
            <h3 className="text-base font-semibold text-bone truncate">{skill.name}</h3>
            <Pill variant="default">v{skill.version}</Pill>
          </div>
          <p className="text-xs text-bone/50 mt-1">{skill.description}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-bone/40 hover:text-bone text-lg leading-none px-2"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="flex items-center gap-2 mb-3">
        {distilled ? (
          <div className="flex items-center gap-2">
            {candidateDetail && (
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => runAction('eval')}
                className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-bone/70 hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                Run eval
              </button>
            )}
            {candidateDetail?.status === 'candidate' && (
              <>
                <button
                  type="button"
                  disabled={
                    actionBusy ||
                    candidateDetail.eval_score === undefined ||
                    candidateDetail.eval_score < 0.75
                  }
                  onClick={() => runAction('promote')}
                  title={
                    candidateDetail.eval_score === undefined || candidateDetail.eval_score < 0.75
                      ? 'Run eval first — promotion requires a passing judge decision (≥0.75)'
                      : 'Promote to live skill'
                  }
                  className="px-3 py-1.5 text-xs rounded-lg border border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
                >
                  Promote
                </button>
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() => runAction('reject')}
                  className="px-3 py-1.5 text-xs rounded-lg border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                >
                  Reject
                </button>
              </>
            )}
            {candidateDetail?.status === 'promoted' && (
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => runAction('demote')}
                className="px-3 py-1.5 text-xs rounded-lg border border-amber-500/30 text-amber-200 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
              >
                Demote
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onToggle(skill)}
            className={cn(
              'px-3 py-1.5 text-xs rounded-lg border transition-colors',
              skill.enabled
                ? 'border-amber-500/30 text-amber-200 hover:bg-amber-500/10'
                : 'border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10',
            )}
          >
            {skill.enabled ? 'Disable' : 'Enable'}
          </button>
        )}
        <div
          className="ml-auto flex gap-1 text-[11px]"
          role="tablist"
          aria-label="Skill detail tabs"
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') setTab('revisions');
            else if (e.key === 'ArrowLeft') setTab('body');
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'body'}
            tabIndex={tab === 'body' ? 0 : -1}
            onClick={() => setTab('body')}
            className={cn(
              'px-2.5 py-1 rounded-md transition-colors',
              tab === 'body' ? 'bg-white/10 text-bone' : 'text-bone/40 hover:text-bone/70',
            )}
          >
            Body
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'revisions'}
            tabIndex={tab === 'revisions' ? 0 : -1}
            onClick={() => setTab('revisions')}
            className={cn(
              'px-2.5 py-1 rounded-md transition-colors',
              tab === 'revisions' ? 'bg-white/10 text-bone' : 'text-bone/40 hover:text-bone/70',
            )}
          >
            Revisions
          </button>
        </div>
      </div>

      {candidateDetail && (
        <GlassCard className="p-3 mb-3 text-xs space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-bone/50">Confidence</span>
            <Pill variant="default">{candidateDetail.confidence.toFixed(2)}</Pill>
            {candidateDetail.eval_score !== undefined && (
              <>
                <span className="text-bone/50">Eval score</span>
                <Pill variant={candidateDetail.eval_score >= 0.75 ? 'success' : 'warn'}>
                  {candidateDetail.eval_score.toFixed(2)}
                </Pill>
              </>
            )}
            {candidateDetail.status === 'rejected' && candidateDetail.rejection_reason && (
              <>
                <span className="text-bone/50">Rejected</span>
                <Pill variant="error">{candidateDetail.rejection_reason}</Pill>
              </>
            )}
            {candidateDetail.promoted_at && (
              <>
                <span className="text-bone/50">Promoted</span>
                <span className="text-bone/70">{formatDate(candidateDetail.promoted_at)}</span>
              </>
            )}
          </div>
          {candidateDetail.rejection_detail && (
            <p className="text-bone/50">{candidateDetail.rejection_detail}</p>
          )}
          {candidateDetail.eval_missed && candidateDetail.eval_missed.length > 0 && (
            <p className="text-bone/50">Missed: {candidateDetail.eval_missed.join('; ')}</p>
          )}
          <div className="flex items-center gap-3 text-bone/40 font-mono text-[10px]">
            {candidateDetail.source_session_id && <span>session {candidateDetail.source_session_id}</span>}
            {candidateDetail.source_run_ids.length > 0 && (
              <span>runs {candidateDetail.source_run_ids.join(', ')}</span>
            )}
          </div>
          {performance && (
            <div className="pt-1.5 mt-1.5 border-t border-white/10 flex items-center gap-2 flex-wrap">
              <span className="text-bone/50">Since promotion</span>
              <span className="text-bone/70">
                {performance.before.success_rate !== null ? `${(performance.before.success_rate * 100).toFixed(0)}%` : '—'}
                {' → '}
                {performance.after.success_rate !== null ? `${(performance.after.success_rate * 100).toFixed(0)}%` : '—'}
              </span>
              {performance.delta !== null && (
                <Pill variant={performance.delta >= 0 ? 'success' : 'error'}>
                  {performance.delta >= 0 ? '+' : ''}
                  {(performance.delta * 100).toFixed(0)}%
                </Pill>
              )}
            </div>
          )}
        </GlassCard>
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {tab === 'body' ? (
          skill.body ? (
            <GlassCard className="p-4">
              <MarkdownRenderer content={skill.body} />
            </GlassCard>
          ) : (
            <EmptyState message="This skill has no stored body." />
          )
        ) : loadingRevs ? (
          <LoadingState message="Loading revisions…" />
        ) : revError ? (
          <ErrorState error={revError} onRetry={loadRevisions} />
        ) : !revisions || revisions.length === 0 ? (
          <EmptyState message="No revision history for this skill yet." />
        ) : (
          <ul className="space-y-2">
            {revisions.map((rev) => (
              <li key={rev.id}>
                <GlassCard className="p-3">
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <span className="text-xs font-medium text-bone">
                      v{rev.version}
                      <span className="ml-2 text-[10px] font-mono text-bone/30">
                        {formatDate(rev.created_at)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => restore(rev)}
                      className="text-[11px] px-2 py-0.5 rounded-md border border-royal/40 text-royal-light hover:bg-royal/10 transition-colors"
                    >
                      Restore
                    </button>
                  </div>
                  <p className="text-xs text-bone/60">{rev.change_reason || 'No reason recorded.'}</p>
                </GlassCard>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────

export function SkillsView() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [candidates, setCandidates] = useState<Record<string, SkillCandidateDetail>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { success, error: toastError } = useToast();

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      try {
        await invoke<number>('sync_distilled_skill_candidates');
      } catch {
        /* Bun may not have written candidates yet */
      }
      const list = await invoke<Skill[]>('list_skills');
      setSkills(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
    // Distilled skills are owned by Bun (D1) — fetch full lifecycle detail
    // (confidence, eval score, rejection info, promoted_at) directly from
    // there rather than relying on the native metadata projection. Best
    // effort: if the Bun server is down, distilled rows just show without
    // the extra detail.
    try {
      const res = await fetch(`${BUN_URL}/skills/candidates`);
      if (res.ok) {
        const body = (await res.json()) as { candidates: SkillCandidateDetail[] };
        const byId: Record<string, SkillCandidateDetail> = {};
        for (const c of body.candidates ?? []) byId[c.id] = c;
        setCandidates(byId);
      }
    } catch {
      /* Bun server unreachable — distilled rows render without candidate detail */
    }
  }, []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const toggle = useCallback(
    async (skill: Skill) => {
      const next = !skill.enabled;
      // Optimistic update so the toggle feels instant.
      setSkills((prev) => prev.map((s) => (s.id === skill.id ? { ...s, enabled: next } : s)));
      try {
        await invoke(next ? 'enable_skill' : 'disable_skill', { name: skill.name });
        success(`${next ? 'Enabled' : 'Disabled'} ${skill.name}`);
      } catch (e) {
        // Roll back on failure.
        setSkills((prev) => prev.map((s) => (s.id === skill.id ? { ...s, enabled: !next } : s)));
        toastError(String(e), 'Toggle failed');
      }
    },
    [success, toastError],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (filter === 'enabled' && !s.enabled) return false;
      if (filter === 'disabled' && s.enabled) return false;
      if (filter === 'candidates' && !isDistilledCandidate(s)) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (categoryOf(s)?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [skills, query, filter]);

  const selected = useMemo(
    () => skills.find((s) => s.id === selectedId) ?? null,
    [skills, selectedId],
  );
  const selectedCandidate = useMemo(() => {
    if (!selected) return null;
    const cid = candidateIdOf(selected);
    return cid ? candidates[cid] ?? null : null;
  }, [selected, candidates]);

  const enabledCount = skills.filter((s) => s.enabled).length;

  const runRowAction = useCallback(
    async (skill: Skill, candidateId: string, action: 'promote' | 'reject') => {
      const { ok, data } = await postSkillCandidateAction(candidateId, action);
      if (!ok) {
        toastError(data?.detail || data?.error || `${action} failed`, `${action} failed`);
        return;
      }
      success(`${skill.name}: ${action} -> ${data?.status ?? 'ok'}`);
      await fetchSkills();
    },
    [fetchSkills, success, toastError],
  );

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="Skills"
        subtitle="Browse, toggle, inspect, and restore skill revisions"
        count={skills.length}
        action={
          <Pill variant={enabledCount > 0 ? 'success' : 'default'}>
            {enabledCount} enabled
          </Pill>
        }
      />

      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills…"
          className="flex-1 px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          className="px-2 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone"
        >
          <option value="all">All</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
          <option value="candidates">Distilled candidates</option>
        </select>
      </div>

      <div className="flex-1 flex gap-4 min-h-0">
        <div className={cn('overflow-y-auto min-h-0', selected ? 'w-1/2' : 'flex-1')}>
          {loading ? (
            <LoadingState message="Loading skills…" />
          ) : error ? (
            <ErrorState error={error} onRetry={fetchSkills} />
          ) : filtered.length === 0 ? (
            <EmptyState message="No skills match the current filter." />
          ) : (
            <ul className="space-y-2">
              {filtered.map((s) => {
                const category = categoryOf(s);
                const distilled = isDistilledSkill(s);
                const candidateId = candidateIdOf(s);
                const candidate = candidateId ? candidates[candidateId] : null;
                const candidateStatus = candidate?.status;
                const candidateEvalScore = candidate?.eval_score;
                const canPromote = candidateEvalScore !== undefined && candidateEvalScore >= 0.75;
                return (
                  <li key={s.id}>
                    <GlassCard
                      onClick={() => setSelectedId(s.id)}
                      hoverable
                      className={cn(
                        'p-3',
                        selectedId === s.id && 'border-accent/40 bg-white/[0.06]',
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <StatusDot ok={s.enabled} warn={!s.enabled} />
                        <h3 className="text-sm font-medium text-bone truncate">{s.name}</h3>
                        {category && (
                          <span className="text-[10px] rounded-full bg-white/5 border border-white/10 px-1.5 py-0.5 text-bone/50">
                            {category}
                          </span>
                        )}
                        {distilledStatus(s) && (
                          <span className="text-[10px] rounded-full bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 text-amber-200/80">
                            {distilledStatus(s)}
                          </span>
                        )}
                        {distilled && candidateId ? (
                          <div className="ml-auto flex gap-1">
                            {(candidateStatus ?? 'candidate') === 'candidate' && (
                              <>
                                <button
                                  type="button"
                                  disabled={!canPromote}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    runRowAction(s, candidateId, 'promote');
                                  }}
                                  title={
                                    canPromote
                                      ? 'Promote to live skill'
                                      : 'Run eval first — promotion requires a passing judge decision (≥0.75)'
                                  }
                                  className="text-[11px] px-2 py-0.5 rounded-md border border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
                                >
                                  Promote
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    runRowAction(s, candidateId, 'reject');
                                  }}
                                  className="text-[11px] px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors"
                                >
                                  Reject
                                </button>
                              </>
                            )}
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(s);
                            }}
                            className={cn(
                              'ml-auto text-[11px] px-2 py-0.5 rounded-md border transition-colors',
                              s.enabled
                                ? 'border-amber-500/30 text-amber-200 hover:bg-amber-500/10'
                                : 'border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10',
                            )}
                          >
                            {s.enabled ? 'Disable' : 'Enable'}
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-bone/60 line-clamp-2">{s.description}</p>
                      <div className="flex items-center gap-2 mt-1.5 text-[10px] font-mono text-bone/30">
                        <span>v{s.version}</span>
                        {s.improvement_score > 0 && (
                          <span>score {s.improvement_score.toFixed(2)}</span>
                        )}
                        <span className="ml-auto">{formatDate(s.updated_at)}</span>
                      </div>
                    </GlassCard>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {selected && (
          <div className="w-1/2 min-h-0">
            <GlassCard className="p-4 h-full">
              <SkillDetail
                key={selected.id}
                skill={selected}
                candidateDetail={selectedCandidate}
                onClose={() => setSelectedId(null)}
                onToggle={toggle}
                onChanged={fetchSkills}
              />
            </GlassCard>
          </div>
        )}
      </div>
    </div>
  );
}

export default SkillsView;
