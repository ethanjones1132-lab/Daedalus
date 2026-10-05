// ── GoalsView — durable user-owned Goals with acceptance criteria ──
//    (goal_create/goal_list/goal_get/goal_update/goal_transition/
//     goal_links_list). A Goal is never shown as complete here: completion
//    requires verified acceptance evidence that this part does not implement.

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cn,
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
  LoadingState,
  EmptyState,
  type StatusVariant,
} from '../ui';

interface Goal {
  id: string;
  objective: string;
  status: string;
  agent_id: string;
  project_root: string | null;
  objective_authority: string;
  created_at: string;
  updated_at: string;
}

interface GoalCriterion {
  id: string;
  goal_id: string;
  ordinal: number;
  text: string;
  authority: string;
  created_at: string;
}

interface GoalLink {
  id: string;
  goal_id: string;
  target_kind: string;
  target_id: string;
  created_at: string;
}

interface GoalEvent {
  id: string;
  goal_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor: string;
  reason: string;
  created_at: string;
}

interface GoalDetail {
  goal: Goal;
  criteria: GoalCriterion[];
  links: GoalLink[];
  events: GoalEvent[];
}

const TRANSITION_STATUSES = ['running', 'waiting_for_user', 'blocked', 'paused', 'failed', 'cancelled'];
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

const STATUS_VARIANT: Record<string, StatusVariant> = {
  pending: 'default',
  running: 'info',
  waiting_for_user: 'warn',
  blocked: 'error',
  paused: 'default',
  completed: 'success',
  failed: 'error',
  cancelled: 'default',
};

function statusVariant(status: string): StatusVariant {
  return STATUS_VARIANT[status] ?? 'default';
}

function allowedTransitions(status: string): string[] {
  if (TERMINAL_STATUSES.includes(status)) return [];
  return TRANSITION_STATUSES.filter((s) => s !== status);
}

export default function GoalsView() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [detail, setDetail] = useState<GoalDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);

  const [objective, setObjective] = useState('');
  const [criteria, setCriteria] = useState<string[]>(['']);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createPending = useRef(false);
  const requestId = useRef(0);
  const detailRequestId = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const transitionPending = useRef(false);

  const fetchGoals = useCallback(async () => {
    const request = ++requestId.current;
    setLoading(true);
    try {
      const rows = await invoke<Goal[]>('goal_list');
      if (request !== requestId.current) return;
      setGoals(rows);
      setError(null);
    } catch {
      if (request !== requestId.current) return;
      setError('Could not load goals.');
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    // Bind this read to the selection generation. A response for an older
    // selection is discarded so it can never replace a newer selected Goal.
    const request = ++detailRequestId.current;
    selectedIdRef.current = id;
    setSelectedId(id);
    setTransitionError(null);
    // Clear any detail that belongs to a different Goal so the panel and the
    // list selection never disagree; re-selecting the shown Goal is preserved.
    setDetail((prev) => (prev && prev.goal.id === id ? prev : null));
    try {
      const next = await invoke<GoalDetail>('goal_get', { id });
      if (request !== detailRequestId.current) return;
      setDetail(next);
      setError(null);
    } catch {
      if (request !== detailRequestId.current) return;
      setDetail(null);
      setError(`Could not load goal ${id}.`);
    }
  }, []);

  useEffect(() => {
    void fetchGoals();
  }, [fetchGoals]);

  const create = useCallback(async () => {
    if (createPending.current) return;
    const trimmedCriteria = criteria.map((c) => c.trim()).filter((c) => c.length > 0);
    if (!objective.trim() || trimmedCriteria.length === 0) {
      setCreateError('An objective and at least one acceptance criterion are required.');
      return;
    }
    createPending.current = true;
    setCreating(true);
    try {
      const created = await invoke<GoalDetail>('goal_create', {
        objective: objective.trim(),
        criteria: trimmedCriteria,
      });
      setCreateError(null);
      setObjective('');
      setCriteria(['']);
      await fetchGoals();
      void loadDetail(created.goal.id);
    } catch {
      setCreateError('Could not create the goal. Your draft was kept.');
    } finally {
      createPending.current = false;
      setCreating(false);
    }
  }, [objective, criteria, fetchGoals, loadDetail]);

  const transition = useCallback(async (to: string) => {
    if (!detail || transitionPending.current) return;
    const goalId = detail.goal.id;
    transitionPending.current = true;
    setTransitioning(true);
    setTransitionError(null);
    try {
      const next = await invoke<GoalDetail>('goal_transition', {
        id: goalId,
        toStatus: to,
      });
      // A mutation supersedes any in-flight detail read.
      detailRequestId.current++;
      if (selectedIdRef.current !== goalId) return;
      setDetail(next);
      await fetchGoals();
    } catch (err) {
      if (selectedIdRef.current !== goalId) return;
      setTransitionError(typeof err === 'string' ? err : `Could not move goal to ${to}.`);
    } finally {
      transitionPending.current = false;
      setTransitioning(false);
    }
  }, [detail, fetchGoals]);

  const inputCls =
    'px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50';

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="Goals"
        subtitle="User-owned objectives and the acceptance criteria they must meet"
        count={goals.length}
      />

      <GlassCard className="p-3">
        <div className="flex flex-col gap-2">
          <input
            className={inputCls}
            placeholder="What is the objective?"
            aria-label="Goal objective"
            disabled={creating}
            value={objective}
            onChange={(e) => {
              if (!createPending.current) setObjective(e.target.value);
            }}
          />
          <div className="flex flex-col gap-1.5">
            {criteria.map((criterion, index) => (
              <div key={index} className="flex gap-2">
                <input
                  className={cn(inputCls, 'flex-1')}
                  placeholder={`Acceptance criterion ${index + 1}`}
                  aria-label={`Acceptance criterion ${index + 1}`}
                  disabled={creating}
                  value={criterion}
                  onChange={(e) => {
                    if (createPending.current) return;
                    setCriteria((prev) => prev.map((v, i) => (i === index ? e.target.value : v)));
                  }}
                />
                {criteria.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove acceptance criterion ${index + 1}`}
                    disabled={creating}
                    onClick={() => setCriteria((prev) => prev.filter((_, i) => i !== index))}
                    className="px-2 text-bone/40 hover:text-red-200 transition-colors"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              disabled={creating}
              onClick={() => setCriteria((prev) => [...prev, ''])}
              className="self-start text-xs text-bone/50 hover:text-bone transition-colors"
            >
              + Add criterion
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={create}
              disabled={creating || !objective.trim()}
              className="px-4 py-2 text-sm rounded-lg bg-accent text-bone hover:bg-accent/80 disabled:opacity-40 transition-colors"
            >
              {creating ? 'Creating…' : 'Create goal'}
            </button>
            <span className="text-[11px] text-bone/40">
              Goals start pending. Completion requires verified evidence and is not available yet.
            </span>
          </div>
          {createError && (
            <div role="alert" className="text-sm text-red-200">
              {createError}
            </div>
          )}
        </div>
      </GlassCard>

      <div className="flex-1 flex gap-4 min-h-0">
        <div className="w-80 shrink-0 overflow-y-auto min-h-0">
          {error && (
            <div role="alert" className="text-sm text-red-200 mb-2">
              {error}{' '}
              <button type="button" disabled={loading} onClick={() => void fetchGoals()} className="underline disabled:opacity-40">
                Retry
              </button>
            </div>
          )}
          {loading && goals.length === 0 ? (
            <LoadingState message="Loading goals…" />
          ) : goals.length === 0 ? (
            <EmptyState message="No goals yet. Create one above." />
          ) : (
            <ul className="space-y-2">
              {goals.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => void loadDetail(g.id)}
                    aria-current={g.id === selectedId ? 'true' : undefined}
                    className={cn(
                      'w-full text-left rounded-xl border p-3 transition-colors',
                      g.id === selectedId
                        ? 'border-accent/50 bg-white/5'
                        : 'border-white/10 hover:bg-white/5',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <StatusDot variant={statusVariant(g.status)} />
                      <span className="text-sm text-bone truncate">{g.objective}</span>
                    </div>
                    <div className="mt-1">
                      <Pill variant={statusVariant(g.status)}>{g.status}</Pill>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {!detail ? (
            <EmptyState message="Select a goal to review its criteria and state." />
          ) : (
            <div className="flex flex-col gap-3">
              <GlassCard className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-base font-semibold text-bone">{detail.goal.objective}</h3>
                  <Pill variant={statusVariant(detail.goal.status)}>{detail.goal.status}</Pill>
                </div>
                <div className="mt-2 text-[11px] text-bone/40 font-mono">
                  {detail.goal.agent_id}
                  {detail.goal.project_root ? ` · ${detail.goal.project_root}` : ''} · objective:{' '}
                  {detail.goal.objective_authority}
                </div>
                <div className="mt-4">
                  <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-bone/40">
                    Acceptance criteria
                  </div>
                  {detail.criteria.length === 0 ? (
                    <div className="text-sm text-bone/40 mt-1">No criteria recorded.</div>
                  ) : (
                    <ol className="mt-2 space-y-1.5">
                      {detail.criteria.map((criterion, index) => (
                        <li key={criterion.id} className="flex gap-2 text-sm text-bone/80">
                          <span className="text-bone/40 font-mono">{index + 1}.</span>
                          <span>{criterion.text}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                <div className="mt-4">
                  <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-bone/40">
                    Move state
                  </div>
                  {allowedTransitions(detail.goal.status).length === 0 ? (
                    <div className="text-sm text-bone/40 mt-1">
                      {TERMINAL_STATUSES.includes(detail.goal.status)
                        ? `This goal is ${detail.goal.status}; terminal states do not change.`
                        : 'No transitions available.'}
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {allowedTransitions(detail.goal.status).map((to) => (
                        <button
                          key={to}
                          type="button"
                          disabled={transitioning}
                          onClick={() => void transition(to)}
                          className="px-2 py-0.5 rounded-md border border-white/15 text-xs text-bone/80 hover:bg-white/10 disabled:opacity-40 transition-colors"
                        >
                          {to}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="mt-1 text-[11px] text-bone/40">
                    Marking complete is withheld until accepted evidence exists.
                  </div>
                  {transitionError && (
                    <div role="alert" className="text-sm text-red-200 mt-1">
                      {transitionError}
                    </div>
                  )}
                </div>
              </GlassCard>

              <GlassCard className="p-4">
                <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-bone/40">
                  Linked records
                </div>
                {detail.links.length === 0 ? (
                  <div className="text-sm text-bone/40 mt-1">
                    No linked records yet. TaskRuns, commitments, schedules, runs, and evidence are
                    associated in later parts.
                  </div>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {detail.links.map((link) => (
                      <li key={link.id} className="text-sm text-bone/70 font-mono">
                        {link.target_kind}: {link.target_id}
                      </li>
                    ))}
                  </ul>
                )}
              </GlassCard>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
