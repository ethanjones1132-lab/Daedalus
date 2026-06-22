// ── ApprovalsView — pending approval requests
//    (get_approvals/approve_request/reject_request) ──

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
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
  const { success, error: toastError } = useToast();

  const fetchApprovals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setApprovals(await invoke<Approval[]>('get_approvals'));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApprovals();
  }, [fetchApprovals]);

  const decide = useCallback(
    async (a: Approval, approve: boolean) => {
      // Optimistic removal — the backend filters to pending only.
      setApprovals((prev) => prev.filter((x) => x.id !== a.id));
      try {
        await invoke<boolean>(approve ? 'approve_request' : 'reject_request', { id: a.id });
        success(`${approve ? 'Approved' : 'Rejected'} request`);
      } catch (e) {
        toastError(String(e), 'Decision failed');
        await fetchApprovals();
      }
    },
    [fetchApprovals, success, toastError],
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
        {loading ? (
          <LoadingState message="Loading approvals…" />
        ) : error ? (
          <ErrorState error={error} onRetry={fetchApprovals} />
        ) : approvals.length === 0 ? (
          <EmptyState message="Nothing waiting for approval. You're all caught up." />
        ) : (
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
                        className="px-3 py-1 rounded-md border border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10 transition-colors"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(a, false)}
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
