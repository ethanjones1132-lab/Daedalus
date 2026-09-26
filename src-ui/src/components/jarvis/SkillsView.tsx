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
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
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
import { initialRegistryState, reduceRegistryState, type RegistrySnapshotState } from './action-registry-state';
import { applySkillListRead, confirmSkillToggle, type SkillToggleProtection } from './skill-toggle-state';
import {
  skillCandidateMutationConfirmed,
  skillCandidateMutationLocked,
  startSkillCandidateMutation,
  transitionSkillCandidateMutation,
  type SkillCandidateAction,
  type SkillCandidateMutation,
} from './skill-candidate-operation-state';
import {
  candidatePerformanceView,
  initialCandidatePerformanceState,
  reduceCandidatePerformance,
  type CandidatePerformanceResponse,
  type CandidatePerformanceState,
} from './skill-candidate-performance';

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
  lifecycle_version?: number;
  eval_score?: number;
  eval_missed?: string[];
  rejection_reason?: string;
  rejection_detail?: string;
  promoted_at?: string;
  created_at: string;
  updated_at: string;
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

interface SkillCandidateActionResponse {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

async function postSkillCandidateAction(
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
      data: data && typeof data === 'object' ? data as Record<string, unknown> : {},
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
async function readCandidatePerformance(candidateId: string): Promise<CandidatePerformanceResponse> {
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

// ── Detail panel ───────────────────────────────────────────────

function SkillDetail({
  skill,
  candidateDetail,
  candidateCurrent,
  candidateMutation,
  onCandidateAction,
  onRetryCandidate,
  onClose,
  onToggle,
  togglePending,
  toggleError,
  onChanged,
}: {
  skill: Skill;
  candidateDetail: SkillCandidateDetail | null;
  candidateCurrent: boolean;
  candidateMutation: SkillCandidateMutation | null;
  onCandidateAction: (action: SkillCandidateAction) => void;
  onRetryCandidate: () => void;
  onClose: () => void;
  onToggle: (skill: Skill) => void;
  togglePending: boolean;
  toggleError: boolean;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'body' | 'revisions'>('body');
  const [revisions, setRevisions] = useState<SkillRevision[] | null>(null);
  const [loadingRevs, setLoadingRevs] = useState(false);
  const [revError, setRevError] = useState<string | null>(null);
  const { success, error: toastError } = useToast();
  const distilled = isDistilledSkill(skill);
  const candidateActionLocked = skillCandidateMutationLocked(candidateMutation);

  const performanceCandidateId = candidateDetail?.status === 'promoted' ? candidateDetail.id : null;
  const [performanceState, setPerformanceState] = useState<CandidatePerformanceState>(initialCandidatePerformanceState);
  const performanceRequestId = useRef(0);
  const performancePending = useRef(false);
  const readPerformance = useCallback(async (retry: boolean) => {
    if (retry && performancePending.current) return;
    const requestId = ++performanceRequestId.current;
    performancePending.current = true;
    if (!performanceCandidateId) {
      setPerformanceState((prev) => reduceCandidatePerformance(prev, { type: 'invalidate', requestId }));
      performancePending.current = false;
      return;
    }
    setPerformanceState((prev) => reduceCandidatePerformance(prev, { type: 'start', requestId }));
    const response = await readCandidatePerformance(performanceCandidateId);
    setPerformanceState((prev) => reduceCandidatePerformance(prev, { type: 'settle', requestId, response }));
    if (requestId === performanceRequestId.current) performancePending.current = false;
  }, [performanceCandidateId]);

  useEffect(() => {
    void readPerformance(false);
  }, [readPerformance]);

  const performanceView = candidatePerformanceView(performanceState);

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
                disabled={candidateActionLocked || !candidateCurrent}
                onClick={() => onCandidateAction('eval')}
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
                    candidateActionLocked || !candidateCurrent ||
                    candidateDetail.eval_score === undefined ||
                    candidateDetail.eval_score < 0.75
                  }
                  onClick={() => onCandidateAction('promote')}
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
                  disabled={candidateActionLocked || !candidateCurrent}
                  onClick={() => onCandidateAction('reject')}
                  className="px-3 py-1.5 text-xs rounded-lg border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                >
                  Reject
                </button>
              </>
            )}
            {candidateDetail?.status === 'promoted' && (
              <button
                type="button"
                disabled={candidateActionLocked || !candidateCurrent}
                onClick={() => onCandidateAction('demote')}
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
            disabled={togglePending}
            className={cn(
              'px-3 py-1.5 text-xs rounded-lg border transition-colors',
              skill.enabled
                ? 'border-amber-500/30 text-amber-200 hover:bg-amber-500/10'
                : 'border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10',
            )}
          >
            {togglePending ? (skill.enabled ? 'Disabling…' : 'Enabling…') : skill.enabled ? 'Disable' : 'Enable'}
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

      {candidateMutation?.phase === 'write-failed' && (
        <div role="status" aria-label="Candidate lifecycle status" className="mb-3 text-xs text-red-200">
          Could not update candidate lifecycle. Showing the last confirmed state.{' '}
          <button type="button" onClick={onRetryCandidate} className="underline">Retry</button>
        </div>
      )}
      {candidateMutation?.phase === 'read-failed' && (
        <div role="status" aria-label="Candidate lifecycle status" className="mb-3 text-xs text-amber-200">
          The lifecycle write completed, but its status could not be confirmed. Showing the last confirmed state.{' '}
                           <button type="button" onClick={onRetryCandidate} className="underline">Retry</button>
        </div>
      )}

      {!distilled && toggleError && (
        <div role="alert" className="mb-3 text-xs text-red-200">
          Could not update skill enablement. Showing last confirmed state: {skill.enabled ? 'enabled' : 'disabled'}.{' '}
          <button type="button" disabled={togglePending} onClick={() => onToggle(skill)} className="underline disabled:opacity-40">Retry</button>
        </div>
      )}

      {candidateDetail && (
        <GlassCard className="p-3 mb-3 text-xs space-y-1.5">
          {!candidateCurrent && <p className="text-amber-200">Previous lifecycle observation; it may be stale. Actions are unavailable.</p>}
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
          {candidateDetail.status === 'promoted' && performanceView && (
            <div
              role="group"
              aria-label="Skill performance since promotion"
              className="pt-1.5 mt-1.5 border-t border-white/10 space-y-1"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-bone/50">Since promotion</span>
                {performanceView.measured && (
                  <>
                    <span className="text-bone/70">
                      {performanceView.measured.before.rate}
                      {' → '}
                      {performanceView.measured.after.rate}
                    </span>
                    {performanceView.measured.delta ? (
                      <Pill variant={performanceView.measured.delta.positive ? 'success' : 'error'}>
                        {performanceView.measured.delta.text}
                      </Pill>
                    ) : (
                      <span className="text-bone/50">delta —</span>
                    )}
                  </>
                )}
              </div>
              {performanceView.measured && <p className="text-bone/40">{performanceView.measured.text}</p>}
              {performanceView.kind === 'pending' && <p role="status" className="text-bone/50">{performanceView.text}</p>}
              {performanceView.failureText && (
                <div role="alert" className="text-amber-200">
                  {performanceView.failureText}{' '}
                  <button
                    type="button"
                    disabled={performanceView.kind === 'pending'}
                    onClick={() => void readPerformance(true)}
                    className="underline disabled:opacity-40"
                  >
                    Retry
                  </button>
                </div>
              )}
              {performanceView.kind === 'unmeasured' && <p className="text-bone/50">{performanceView.text}</p>}
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

// Optional observations never own the native list's loading lifetime. Refreshes
// supersede older reads; Retry is guarded and only repeats this resource's read.
function useSkillObservation<S>(read: () => Promise<S>) {
  const [state, setState] = useState(initialRegistryState<S>);
  const requestId = useRef(0);
  const pending = useRef(false);
  const current = useRef(false);
  const refresh = useCallback(async (retry = false): Promise<S | null> => {
    if (retry && pending.current) return null;
    const id = ++requestId.current;
    pending.current = true;
    current.current = false;
    setState((prev) => reduceRegistryState(prev, { type: 'pending', requestId: id }));
    try {
      const snapshot = await read();
      if (id === requestId.current) current.current = true;
      setState((prev) => reduceRegistryState(prev, { type: 'success', requestId: id, snapshot }));
      return snapshot;
    } catch {
      setState((prev) => reduceRegistryState(prev, { type: 'failure', requestId: id }));
      return null;
    } finally {
      if (id === requestId.current) pending.current = false;
    }
  }, [read]);
  return { state, refresh, current };
}

async function readRuntimeSkills() {
  const result = await invoke<any[]>('jarvis_get_skills');
  if (!Array.isArray(result)) throw new Error('Invalid skills observation');
  return result;
}

async function readRuntimeTools() {
  const result = await invoke<any[]>('jarvis_get_tools');
  if (!Array.isArray(result)) throw new Error('Invalid tools observation');
  return result;
}

async function readCandidates() {
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
      lifecycle_version: Number.isSafeInteger(version) && (version as number) >= 0 ? version as number : 0,
    };
  }
  return byId;
}

function ObservationFeedback<S>({ label, state, onRetry }: {
  label: string;
  state: RegistrySnapshotState<S>;
  onRetry: () => void;
}) {
  return (
    <>
      {state.loading && <div role="status">Loading {label}…</div>}
      {state.error && (
        <div role="alert" className="text-amber-200">
          Could not load {label}.{' '}
          {state.snapshot !== null && 'Showing previous observations; they may be stale. '}
          <button type="button" disabled={state.loading} onClick={onRetry} className="underline disabled:opacity-40">Retry</button>
        </div>
      )}
      {state.loading && !state.error && state.snapshot !== null && <p>Showing previous observations; they may be stale.</p>}
    </>
  );
}

// ── Main view ──────────────────────────────────────────────────

export function SkillsView() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const pendingToggles = useRef(new Set<string>());
  const [togglePending, setTogglePending] = useState<Record<string, boolean>>({});
  const [toggleError, setToggleError] = useState<Record<string, boolean>>({});
  const protections = useRef<Record<string, SkillToggleProtection<boolean>>>({});
  const candidateMutationRef = useRef<Record<string, SkillCandidateMutation | undefined>>({});
  const [candidateMutations, setCandidateMutations] = useState<Record<string, SkillCandidateMutation | undefined>>({});
  const nextCandidateMutationToken = useRef(0);
  const listReadId = useRef(0);
  const { state: runtimeSkills, refresh: refreshRuntimeSkills } = useSkillObservation(readRuntimeSkills);
  const { state: runtimeTools, refresh: refreshRuntimeTools } = useSkillObservation(readRuntimeTools);
  const { state: candidateState, refresh: refreshCandidates, current: candidatesCurrent } = useSkillObservation(readCandidates);
  const candidates = candidateState.snapshot;
  const candidateCurrent = candidates !== null && !candidateState.loading && !candidateState.error;
  const canUseCandidate = useCallback(() => candidatesCurrent.current, [candidatesCurrent]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailId = useId();
  const inspectionButtons = useRef(new Map<string, HTMLButtonElement>());
  const searchInput = useRef<HTMLInputElement>(null);
  const { success } = useToast();

  const publishCandidateMutation = useCallback((candidateId: string, mutation: SkillCandidateMutation | null) => {
    candidateMutationRef.current[candidateId] = mutation ?? undefined;
    setCandidateMutations((previous) => {
      const next = { ...previous };
      if (mutation) next[candidateId] = mutation;
      else delete next[candidateId];
      return next;
    });
  }, []);

  const closeInspection = () => {
    const opener = selectedId ? inspectionButtons.current.get(selectedId) : null;
    setSelectedId(null);
    // Filtering or a refreshed list may have removed the selected row.
    if (opener?.isConnected) opener.focus();
    else searchInput.current?.focus();
  };

  const fetchSkills = useCallback(async (includeCandidates = true) => {
    const readId = ++listReadId.current;
    void refreshRuntimeSkills();
    void refreshRuntimeTools();
    if (includeCandidates) void refreshCandidates();
    setLoading(true);
    setError(null);
    try {
      try {
        await invoke<number>('sync_distilled_skill_candidates');
      } catch {
        /* Bun may not have written candidates yet */
      }
      const list = await invoke<Skill[]>('list_skills');
      if (readId !== listReadId.current) return;
      const reconciled = applySkillListRead(list, protections.current, readId);
      protections.current = reconciled.protections;
      setSkills(reconciled.skills);

    } catch (e) {
      if (readId === listReadId.current) setError(String(e));
    } finally {
      if (readId === listReadId.current) setLoading(false);
    }
  }, [refreshRuntimeSkills, refreshRuntimeTools, refreshCandidates]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const toggle = useCallback(
    async (skill: Skill) => {
      if (isDistilledSkill(skill) || pendingToggles.current.has(skill.id)) return;
      pendingToggles.current.add(skill.id);
      setTogglePending((prev) => ({ ...prev, [skill.id]: true }));
      const next = !skill.enabled;
      // Concurrent reads must not publish an in-flight write as confirmed.
      protections.current[skill.id] = { target: skill.enabled, barrierReadId: Infinity };
      try {
        await invoke<void>(next ? 'enable_skill' : 'disable_skill', { name: skill.name });
        protections.current[skill.id] = { target: next, barrierReadId: listReadId.current };
        setSkills((prev) => confirmSkillToggle(prev, skill.id, next));
        setToggleError((prev) => ({ ...prev, [skill.id]: false }));
        success(`${next ? 'Enabled' : 'Disabled'} ${skill.name}`);
      } catch {
        protections.current[skill.id] = { target: skill.enabled, barrierReadId: listReadId.current };
        setToggleError((prev) => ({ ...prev, [skill.id]: true }));
      } finally {
        pendingToggles.current.delete(skill.id);
        setTogglePending((prev) => ({ ...prev, [skill.id]: false }));
      }
    },
    [success],
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
     return cid ? candidates?.[cid] ?? null : null;
   }, [selected, candidates]);
   const selectedCandidateId = selected ? candidateIdOf(selected) : null;
   const selectedCandidateMutation = selectedCandidateId ? candidateMutations[selectedCandidateId] ?? null : null;

   const enabledCount = skills.filter((s) => s.enabled).length;

  const runCandidateAction = useCallback(
    async (skill: Skill, candidateId: string, action: SkillCandidateAction) => {
      if (!canUseCandidate()) return;
      const observed = candidates?.[candidateId];
      if (!observed) return;
      const existing = candidateMutationRef.current[candidateId];
      if (skillCandidateMutationLocked(existing)) return;
      const token = ++nextCandidateMutationToken.current;
      const mutation = startSkillCandidateMutation(
        candidateId,
        action,
        observed.lifecycle_version ?? 0,
        token,
        observed.status,
      );
      publishCandidateMutation(candidateId, mutation);
      const isCurrent = () => candidateMutationRef.current[candidateId]?.token === token;
      const response = await postSkillCandidateAction(candidateId, action, mutation.expectedVersion);
      if (!isCurrent()) return;
      if (!response.ok) {
        if (response.status === 400) {
          publishCandidateMutation(candidateId, transitionSkillCandidateMutation(mutation, 'write-failed'));
          return;
        }
        const reconciling = transitionSkillCandidateMutation(mutation, 'conflict');
        if (!reconciling) return;
        publishCandidateMutation(candidateId, reconciling);
        const snapshot = await refreshCandidates();
        if (!isCurrent()) return;
        const authoritative = snapshot?.[candidateId];
        if (snapshot && authoritative && skillCandidateMutationConfirmed(reconciling, authoritative)) {
          publishCandidateMutation(candidateId, null);
          success(`${authoritative.status === 'promoted' ? 'Promoted' : authoritative.status === 'rejected' ? 'Rejected' : action === 'eval' ? 'Evaluated' : 'Updated'} ${skill.name}`);
        } else {
          publishCandidateMutation(candidateId, transitionSkillCandidateMutation(reconciling, 'read-failed'));
        }
        return;
      }
      const reconciling = transitionSkillCandidateMutation(mutation, 'write-succeeded');
      if (!reconciling) return;
      publishCandidateMutation(candidateId, reconciling);
      const snapshot = await refreshCandidates();
      if (!isCurrent()) return;
      const authoritative = snapshot?.[candidateId];
      if (!snapshot || !authoritative || !skillCandidateMutationConfirmed(reconciling, authoritative)) {
        publishCandidateMutation(candidateId, transitionSkillCandidateMutation(reconciling, 'read-failed'));
        return;
      }
      publishCandidateMutation(candidateId, null);
      const outcome = authoritative.status === 'promoted' ? 'Promoted' : authoritative.status === 'rejected' ? 'Rejected' : 'Evaluated';
      success(`${outcome} ${skill.name}`);
      void fetchSkills(false);
    },
    [candidates, canUseCandidate, fetchSkills, publishCandidateMutation, refreshCandidates, success],
  );

  const retryCandidateMutation = useCallback(
    async (skill: Skill, candidateId: string) => {
      const mutation = candidateMutationRef.current[candidateId];
      if (!mutation) return;
      if (mutation.phase === 'write-failed') {
        await runCandidateAction(skill, candidateId, mutation.action);
        return;
      }
      if (mutation.phase !== 'read-failed') return;
      const reconciling = transitionSkillCandidateMutation(mutation, 'retry-read');
      if (!reconciling) return;
      publishCandidateMutation(candidateId, reconciling);
      const token = reconciling.token;
      const snapshot = await refreshCandidates();
      if (candidateMutationRef.current[candidateId]?.token !== token) return;
      const authoritative = snapshot?.[candidateId];
      if (!snapshot || !authoritative || !skillCandidateMutationConfirmed(reconciling, authoritative)) {
        publishCandidateMutation(candidateId, transitionSkillCandidateMutation(reconciling, 'read-failed'));
        return;
      }
      publishCandidateMutation(candidateId, null);
      const outcome = authoritative.status === 'promoted' ? 'Promoted' : authoritative.status === 'rejected' ? 'Rejected' : 'Evaluated';
      success(`${outcome} ${skill.name}`);
      void fetchSkills(false);
    },
    [fetchSkills, publishCandidateMutation, refreshCandidates, runCandidateAction, success],
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
          ref={searchInput}
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs max-h-40 overflow-y-auto shrink-0">
        <section aria-label="Runtime skills" className="p-3 rounded-lg border border-white/10">
          <h3 className="font-semibold text-cyan-200">Runtime skills</h3>
          <ObservationFeedback label="runtime skills" state={runtimeSkills} onRetry={() => { void refreshRuntimeSkills(true); }} />
          {runtimeSkills.snapshot !== null && (
            runtimeSkills.snapshot.length > 0
              ? <p>{runtimeSkills.snapshot.map((skill: any) => skill.name || JSON.stringify(skill)).join(', ')}</p>
              : !runtimeSkills.loading && !runtimeSkills.error && <p>No runtime skills observed.</p>
          )}
        </section>
        <section aria-label="Runtime tools" className="p-3 rounded-lg border border-white/10">
          <h3 className="font-semibold text-cyan-200">Runtime tools</h3>
          <ObservationFeedback label="runtime tools" state={runtimeTools} onRetry={() => { void refreshRuntimeTools(true); }} />
          {runtimeTools.snapshot !== null && (
            runtimeTools.snapshot.length > 0
              ? <p>{runtimeTools.snapshot.map((tool: any) => tool.name || JSON.stringify(tool)).join(', ')}</p>
              : !runtimeTools.loading && !runtimeTools.error && <p>No runtime tools observed.</p>
          )}
        </section>
        <section aria-label="Skill candidates" className="p-3 rounded-lg border border-white/10">
          <h3 className="font-semibold text-cyan-200">Skill candidates</h3>
          <ObservationFeedback label="skill candidates" state={candidateState} onRetry={() => { void refreshCandidates(true); }} />
          {candidates !== null && (
            Object.keys(candidates).length > 0
              ? <p>{Object.keys(candidates).length} candidate observations</p>
              : candidateCurrent && <p>No skill candidates observed.</p>
          )}
        </section>
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
                const candidate = candidateId ? candidates?.[candidateId] : null;
                 const candidateStatus = candidate?.status;
                 const candidateEvalScore = candidate?.eval_score;
                 const candidateMutation = candidateId ? candidateMutations[candidateId] ?? null : null;
                 const candidateActionLocked = skillCandidateMutationLocked(candidateMutation);
                 const canPromote = candidateCurrent && !candidateActionLocked && candidateEvalScore !== undefined && candidateEvalScore >= 0.75;
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
                        <h3 className="text-sm font-medium text-bone truncate">
                          <button
                            type="button"
                            ref={(node) => {
                              if (node) inspectionButtons.current.set(s.id, node);
                              else inspectionButtons.current.delete(s.id);
                            }}
                            aria-label={`Inspect skill: ${s.name}`}
                            aria-pressed={selectedId === s.id}
                            aria-controls={`${detailId}-${s.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedId(s.id);
                            }}
                            className="max-w-full truncate text-left rounded cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-neon focus-visible:outline-offset-2"
                          >
                            {s.name}
                          </button>
                        </h3>
                        {category && (
                          <span className="text-[10px] rounded-full bg-white/5 border border-white/10 px-1.5 py-0.5 text-bone/50">
                            {category}
                          </span>
                        )}
                        {distilled && (
                          <span className="text-[10px] rounded-full bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 text-amber-200/80">
                            {candidateStatus ? `${candidateStatus}${candidateCurrent ? '' : ' (previous observation; may be stale)'}` : 'Lifecycle observation unavailable.'}
                          </span>
                        )}
                        {distilled && candidateId ? (
                          <div className="ml-auto flex gap-1">
                            {candidateStatus === 'candidate' && (
                              <>
                                <button
                                  type="button"
                                  disabled={!canPromote}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                     runCandidateAction(s, candidateId, 'promote');
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
                                   disabled={!candidateCurrent || candidateActionLocked}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                     runCandidateAction(s, candidateId, 'reject');
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
                            disabled={distilled || togglePending[s.id] === true}
                            className={cn(
                              'ml-auto text-[11px] px-2 py-0.5 rounded-md border transition-colors',
                              s.enabled
                                ? 'border-amber-500/30 text-amber-200 hover:bg-amber-500/10'
                                : 'border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10',
                            )}
                          >
                            {togglePending[s.id] ? (s.enabled ? 'Disabling…' : 'Enabling…') : s.enabled ? 'Disable' : 'Enable'}
                          </button>
                        )}
                      </div>
                       <p className="text-xs text-bone/60 line-clamp-2">{s.description}</p>
                       {candidateMutation?.phase === 'write-failed' && (
                         <div role="alert" aria-label={`Candidate lifecycle: ${s.name}`} className="mt-1 text-xs text-red-200">
                           Could not update candidate lifecycle. Showing the last confirmed state.{' '}
                           <button type="button" onClick={(e) => { e.stopPropagation(); void retryCandidateMutation(s, candidateId!); }} className="underline">Retry</button>
                         </div>
                       )}
                       {candidateMutation?.phase === 'read-failed' && (
                         <div role="alert" aria-label={`Candidate lifecycle: ${s.name}`} className="mt-1 text-xs text-amber-200">
                           The lifecycle write completed, but its status could not be confirmed. Showing the last confirmed state.{' '}
                           <button type="button" onClick={(e) => { e.stopPropagation(); void retryCandidateMutation(s, candidateId!); }} className="underline">Retry</button>
                         </div>
                       )}
                      {!distilled && toggleError[s.id] && (
                        <div role="alert" className="mt-1 text-xs text-red-200">
                          Could not update skill enablement. Showing last confirmed state: {s.enabled ? 'enabled' : 'disabled'}.{' '}
                          <button type="button" disabled={togglePending[s.id] === true} onClick={(e) => { e.stopPropagation(); toggle(s); }} className="underline disabled:opacity-40">Retry</button>
                        </div>
                      )}
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
          <div
            id={`${detailId}-${selected.id}`}
            role="region"
            aria-label={`Skill details: ${selected.name}`}
            className="w-1/2 min-h-0"
          >
            <GlassCard className="p-4 h-full">
              <SkillDetail
                key={selected.id}
                skill={selected}
                 candidateDetail={selectedCandidate}
                 candidateCurrent={candidateCurrent}
                 candidateMutation={selectedCandidateMutation}
                 onCandidateAction={(action) => {
                   if (selectedCandidate) void runCandidateAction(selected, selectedCandidate.id, action);
                 }}
                 onRetryCandidate={() => {
                   if (selectedCandidateId) void retryCandidateMutation(selected, selectedCandidateId);
                 }}
                 onClose={closeInspection}
                onToggle={toggle}
                togglePending={togglePending[selected.id] === true}
                toggleError={toggleError[selected.id] === true}
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
