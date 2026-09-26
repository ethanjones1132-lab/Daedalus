// ── ApprovalsView — pending approval requests
//    (get_approvals/approve_request/reject_request) ──
//    A resolved decision write is not success on its own: the row stays
//    until a later read no longer lists the request. See
//    approval-queue-state.ts for why an empty read is not an all-clear.

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { reconcileApprovalRows } from './approval-state';
import {
  classifyDecisionWrite,
  classifyReadBack,
  decodeApprovalQueue,
  decideQueueCoverage,
  LIVE_GATE_CAVEAT,
  NO_REQUESTS_LISTED,
  type ApprovalRow,
} from './approval-queue-state';
import {
  GlassCard,
  Pill,
  SectionHeader,
  LoadingState,
  ErrorState,
  EmptyState,
  useToast,
} from '../ui';

type DecisionPhase = 'writing' | 'failed' | 'confirming' | 'unverified' | 'unconfirmed';
type AlertPhase = 'failed' | 'unverified' | 'unconfirmed';

interface DecisionState {
  approve: boolean;
  phase: DecisionPhase;
  /** A native decision write is in flight for this request. */
  busy: boolean;
}

/** Fixed messages only — native error text can embed stored values. */
const DECISION_ALERTS: Record<AlertPhase, string> = {
  failed: 'Could not save this decision. The request was kept; retry or choose another decision.',
  unverified:
    'The decision was saved but this request is still listed. Re-check it before treating the tool call as unblocked.',
  unconfirmed: 'The decision was saved but could not be confirmed with a read. The request was kept.',
};

function alertPhaseOf(phase: DecisionPhase): AlertPhase | null {
  return phase === 'failed' || phase === 'unverified' || phase === 'unconfirmed' ? phase : null;
}

function formatWhen(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

export default function ApprovalsView() {
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { success } = useToast();
  const [decisions, setDecisions] = useState<Map<string, DecisionState>>(new Map());
  const pendingIds = useRef(new Set<string>());
  const awaitingReadIds = useRef(new Set<string>());
  const settledIds = useRef(new Set<string>());
  const retainedRows = useRef(new Map<string, ApprovalRow>());
  const choices = useRef(new Map<string, boolean>());
  const latestFetch = useRef(0);

  const setDecision = useCallback((id: string, next: DecisionState) => {
    setDecisions((prev) => new Map(prev).set(id, next));
  }, []);

  const fetchApprovals = useCallback(async () => {
    const request = ++latestFetch.current;
    setLoading(true);
    setError(null);
    const awaiting = [...awaitingReadIds.current];
    try {
      const decoded = decodeApprovalQueue(await invoke<unknown>('get_approvals'));
      if (decoded === null) throw new Error('unreadable approval queue');
      if (request !== latestFetch.current) return;
      if (awaiting.length > 0) {
        // Only the newest read settles a decision; an obsolete one settled nothing.
        awaitingReadIds.current.clear();
        for (const id of awaiting) {
          const approve = choices.current.get(id) ?? false;
          if (classifyReadBack(decoded, id) === 'absent') {
            settledIds.current.add(id);
            retainedRows.current.delete(id);
            choices.current.delete(id);
            setDecisions((prev) => {
              const next = new Map(prev);
              next.delete(id);
              return next;
            });
            success(`${approve ? 'Approved' : 'Rejected'} request`);
          } else {
            setDecision(id, { approve, phase: 'unverified', busy: false });
          }
        }
      }
      setApprovals(reconcileApprovalRows(decoded, [...retainedRows.current.values()], settledIds.current));
    } catch {
      if (request !== latestFetch.current) return;
      if (awaiting.length > 0) {
        awaitingReadIds.current.clear();
        for (const id of awaiting) {
          setDecision(id, { approve: choices.current.get(id) ?? false, phase: 'unconfirmed', busy: false });
        }
      }
      setError('Could not load approvals. Retained requests may be stale.');
    } finally {
      if (request === latestFetch.current) setLoading(false);
    }
  }, [setDecision, success]);

  useEffect(() => {
    fetchApprovals();
    return () => { latestFetch.current += 1; };
  }, [fetchApprovals]);

  const decide = useCallback(
    async (a: ApprovalRow, approve: boolean, retrying = false) => {
      if (pendingIds.current.has(a.id) || awaitingReadIds.current.has(a.id) || settledIds.current.has(a.id)) return;
      pendingIds.current.add(a.id);
      retainedRows.current.set(a.id, a);
      choices.current.set(a.id, approve);
      setDecision(a.id, { approve, phase: retrying ? 'failed' : 'writing', busy: true });
      try {
        const written = await invoke<unknown>(approve ? 'approve_request' : 'reject_request', { id: a.id });
        if (classifyDecisionWrite(written) !== 'confirmed') {
          setDecision(a.id, { approve, phase: 'failed', busy: false });
          return;
        }
        // The write resolved, so the row stays until a read no longer lists it.
        awaitingReadIds.current.add(a.id);
        setDecision(a.id, { approve, phase: 'confirming', busy: false });
        await fetchApprovals();
      } catch {
        setDecision(a.id, { approve, phase: 'failed', busy: false });
      } finally {
        pendingIds.current.delete(a.id);
      }
    },
    [fetchApprovals, setDecision],
  );

  const retry = useCallback(
    (a: ApprovalRow, state: DecisionState) => {
      if (state.busy || awaitingReadIds.current.has(a.id) || settledIds.current.has(a.id)) return;
      if (state.phase === 'failed') {
        void decide(a, state.approve, true);
        return;
      }
      awaitingReadIds.current.add(a.id);
      setDecision(a.id, { approve: state.approve, phase: 'confirming', busy: false });
      void fetchApprovals();
    },
    [decide, fetchApprovals, setDecision],
  );

  const coverage = decideQueueCoverage({ loading, unavailable: error !== null, rows: approvals.length });

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="Approvals"
        subtitle="Actions waiting on your decision"
        count={approvals.length}
        action={
          <button
            type="button"
            onClick={fetchApprovals}
            className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-bone/60 hover:text-bone transition-colors"
          >
            Refresh
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && <div role="status"><LoadingState message="Loading approvals…" /></div>}
        {error && <div role="alert"><ErrorState error={error} onRetry={fetchApprovals} /></div>}
        {coverage === 'no_requests_listed' && (
          <div role="status" className="flex flex-col items-center gap-1 px-4">
            <EmptyState message={NO_REQUESTS_LISTED} className="pb-6" />
            <p className="max-w-md text-center text-xs text-bone/40">{LIVE_GATE_CAVEAT}</p>
          </div>
        )}
        {approvals.length > 0 && (
          <ul className="space-y-2">
            {approvals.map((a) => {
              const state = decisions.get(a.id);
              const alert = state ? alertPhaseOf(state.phase) : null;
              // Once a decision has reached Native the row belongs to the write:
              // re-reading is the only honest way to change what it says.
              const locked = state !== undefined && (state.phase !== 'failed' || state.busy);
              return (
                <li key={a.id}>
                  <GlassCard className="p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Pill variant="warn">{a.request_type}</Pill>
                      {a.tool_name && <Pill variant="default">{a.tool_name}</Pill>}
                      <span className="ml-auto text-[10px] font-mono text-bone/30">
                        {formatWhen(a.created_at)}
                      </span>
                    </div>
                    <p className="text-sm text-bone/80">{a.description}</p>
                    {state && (state.phase === 'writing' || state.phase === 'confirming') && (
                      <p role="status" className="mt-2 text-xs text-bone/60">
                        {state.phase === 'writing'
                          ? `${state.approve ? 'Approving' : 'Rejecting'}… Waiting for confirmation.`
                          : `${state.approve ? 'Approved' : 'Rejected'} the decision. Confirming with a fresh read…`}
                      </p>
                    )}
                    {state && alert !== null && (
                      <div role="alert" className="mt-2 text-xs text-red-200">
                        {DECISION_ALERTS[alert]}
                        <button
                          type="button"
                          onClick={() => retry(a, state)}
                          disabled={state.busy}
                          className="ml-2 underline"
                        >
                          Retry
                        </button>
                      </div>
                    )}
                    {a.tool_args && (
                      <pre className="mt-1.5 text-[10px] font-mono text-bone/50 bg-black/20 rounded-md px-2 py-1 overflow-x-auto">
                        {a.tool_args}
                      </pre>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-[10px] font-mono text-bone/30">agent {a.agent_id}</span>
                      <div className="ml-auto flex gap-1.5 text-[11px]">
                        <button
                          type="button"
                          onClick={() => decide(a, true)}
                          disabled={locked}
                          className="px-3 py-1 rounded-md border border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10 transition-colors"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => decide(a, false)}
                          disabled={locked}
                          className="px-3 py-1 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  </GlassCard>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
