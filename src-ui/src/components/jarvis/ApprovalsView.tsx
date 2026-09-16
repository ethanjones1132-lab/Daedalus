// ── ApprovalsView — pending approval requests
//    (get_approvals/approve_request/reject_request) ──

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { reconcileApprovalRows } from './approval-state';
import {
  GlassCard,
  Pill,
  SectionHeader,
  LoadingState,
  ErrorState,
  EmptyState,
  useToast,
} from '../ui';

interface Approval {
  id: string;
  request_type: string;
  description: string;
  agent_id: string;
  created_at: string;
  status: string;
  tool_name: string | null;
  tool_args: string | null;
}

function formatWhen(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

export default function ApprovalsView() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { success } = useToast();
  const [decisions, setDecisions] = useState<Map<string, { approve: boolean; pending: boolean; failed: boolean }>>(new Map());
  const pendingIds = useRef(new Set<string>());
  const settledIds = useRef(new Set<string>());
  const retainedRows = useRef(new Map<string, Approval>());
  const latestFetch = useRef(0);

  const fetchApprovals = useCallback(async () => {
    const request = ++latestFetch.current;
    setLoading(true);
    setError(null);
    try {
      const incoming = await invoke<Approval[]>('get_approvals');
      if (request !== latestFetch.current) return;
      setApprovals(reconcileApprovalRows(incoming, [...retainedRows.current.values()], settledIds.current));
    } catch {
      if (request === latestFetch.current) setError('Could not load approvals. Retained requests may be stale.');
    } finally {
      if (request === latestFetch.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApprovals();
    return () => { latestFetch.current += 1; };
  }, [fetchApprovals]);

  const decide = useCallback(
    async (a: Approval, approve: boolean) => {
      if (pendingIds.current.has(a.id) || settledIds.current.has(a.id)) return;
      pendingIds.current.add(a.id);
      retainedRows.current.set(a.id, a);
      setDecisions((prev) => new Map(prev).set(a.id, { approve, pending: true, failed: prev.get(a.id)?.failed ?? false }));
      try {
        await invoke<boolean>(approve ? 'approve_request' : 'reject_request', { id: a.id });
        settledIds.current.add(a.id);
        retainedRows.current.delete(a.id);
        setApprovals((prev) => prev.filter((x) => x.id !== a.id));
        setDecisions((prev) => {
          const next = new Map(prev);
          next.delete(a.id);
          return next;
        });
        success(`${approve ? 'Approved' : 'Rejected'} request`);
      } catch {
        setDecisions((prev) => new Map(prev).set(a.id, { approve, pending: false, failed: true }));
      } finally {
        pendingIds.current.delete(a.id);
      }
    },
    [success],
  );

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
        {!loading && !error && approvals.length === 0 && (
          <EmptyState message="Nothing waiting for approval. You're all caught up." />
        )}
        {approvals.length > 0 && (
          <ul className="space-y-2">
            {approvals.map((a) => (
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
                  {decisions.get(a.id)?.pending && (
                    <p role="status" className="mt-2 text-xs text-bone/60">
                      {decisions.get(a.id)?.approve ? 'Approving' : 'Rejecting'}… Waiting for confirmation.
                    </p>
                  )}
                  {decisions.get(a.id)?.failed && (
                    <div role="alert" className="mt-2 text-xs text-red-200">
                      Could not save this decision. The request was kept; retry or choose another decision.
                      <button
                        type="button"
                        onClick={() => decide(a, decisions.get(a.id)!.approve)}
                        disabled={decisions.get(a.id)?.pending}
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
                        disabled={decisions.get(a.id)?.pending}
                        className="px-3 py-1 rounded-md border border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10 transition-colors"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(a, false)}
                        disabled={decisions.get(a.id)?.pending}
                        className="px-3 py-1 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                </GlassCard>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
