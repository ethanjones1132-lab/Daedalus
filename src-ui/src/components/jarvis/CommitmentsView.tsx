// ── CommitmentsView — agent commitments
//    (get_commitments/add_commitment/complete_commitment/delete_commitment) ──

import { invoke } from '@tauri-apps/api/core';
import { commitmentLocked, reconcileCommitments, type CommitmentOperation } from './commitment-state';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cn,
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
  LoadingState,
  EmptyState,
  useToast,
} from '../ui';

interface Commitment {
  id: string;
  text: string;
  status: string;
  due: string | null;
  created_at: string;
  completed_at: string | null;
  agent_id: string | null;
  goal_id?: string | null;
}

type Filter = 'open' | 'completed' | 'all';

function formatDue(ts: string | null): string {
  if (!ts) return 'no due date';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `due ${d.toLocaleDateString()}`;
}

export default function CommitmentsView() {
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const createPending = useRef(false);
  const [filter, setFilter] = useState<Filter>('open');
  const { success } = useToast();
  const [operations, setOperations] = useState<Record<string, CommitmentOperation<Commitment>>>({});
  const operationsRef = useRef(operations);
  const requestId = useRef(0);
  const reading = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const publishOperations = useCallback((next: Record<string, CommitmentOperation<Commitment>>) => {
    operationsRef.current = next;
    setOperations(next);
  }, []);

  const fetchCommitments = useCallback(async () => {
    const request = ++requestId.current;
    reading.current = true;
    setLoading(true);
    try {
      const snapshot = await invoke<Commitment[]>('get_commitments');
      if (request !== requestId.current) return;
      const result = reconcileCommitments(snapshot, operationsRef.current, request);
      publishOperations(result.operations);
      setCommitments(result.rows);
      setLoaded(true);
      setError(null);
    } catch {
      if (request !== requestId.current) return;
      const next = { ...operationsRef.current };
      let rowFailure = false;
      for (const [id, operation] of Object.entries(next)) {
        if (operation.phase === 'reconciling' || operation.phase === 'read-failed') {
          next[id] = { ...operation, phase: 'read-failed' };
          rowFailure = true;
        }
      }
      publishOperations(next);
      if (!rowFailure) setError('Could not refresh commitments. Retry reloads the list only.');
    } finally {
      if (request === requestId.current) {
        reading.current = false;
        setLoading(false);
      }
    }
  }, [publishOperations]);

  const retryRead = useCallback(() => {
    if (reading.current) return;
    void fetchCommitments();
  }, [fetchCommitments]);

  useEffect(() => {
    fetchCommitments();
  }, [fetchCommitments]);

  const add = useCallback(async () => {
    if (createPending.current || !text.trim()) return;
    createPending.current = true;
    setCreating(true);
    try {
      await invoke<Commitment>('add_commitment', {
        text: text.trim(),
        due: due ? new Date(due).toISOString() : null,
      });
      success('Commitment added');
      setCreateError(false);
      setText('');
      setDue('');
      await fetchCommitments();
    } catch {
      setCreateError(true);
    } finally {
      createPending.current = false;
      setCreating(false);
    }
  }, [text, due, fetchCommitments, success]);

  const mutate = useCallback(async (c: Commitment, action: 'complete' | 'delete') => {
    if (commitmentLocked(operationsRef.current[c.id]) || (action === 'complete' && c.status === 'completed')) return;
    const operation: CommitmentOperation<Commitment> = { row: c, action, phase: 'writing', after: requestId.current };
    publishOperations({ ...operationsRef.current, [c.id]: operation });
    try {
      const saved = await invoke<boolean>(action === 'complete' ? 'complete_commitment' : 'delete_commitment', { id: c.id });
      if (saved !== true) throw new Error('Write not confirmed');
    } catch {
      publishOperations({ ...operationsRef.current, [c.id]: { ...operation, phase: 'write-failed', after: requestId.current } });
      return;
    }
    publishOperations({ ...operationsRef.current, [c.id]: { ...operation, phase: 'reconciling', after: requestId.current } });
    success(action === 'complete' ? 'Marked complete' : 'Deleted');
    await fetchCommitments();
  }, [fetchCommitments, publishOperations, success]);

  const filtered = useMemo(() => {
    if (filter === 'all') return commitments;
    if (filter === 'completed') return commitments.filter((c) => c.status === 'completed');
    return commitments.filter((c) => c.status !== 'completed');
  }, [commitments, filter]);

  const inputCls =
    'px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50';

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="Commitments"
        subtitle="Promises the agent has made and must keep"
        count={commitments.length}
        action={
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
            className="px-2 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-bone"
          >
            <option value="open">Open</option>
            <option value="completed">Completed</option>
            <option value="all">All</option>
          </select>
        }
      />

      {createError && (
        <div role="alert" className="text-sm text-red-200">
          Could not add the commitment. Your draft was kept.{' '}
          <button type="button" onClick={add} disabled={creating || !text.trim()} className="underline disabled:opacity-40">Retry</button>
        </div>
      )}

      <div className="flex gap-2">
        <input
          className={cn(inputCls, 'flex-1')}
          placeholder="What needs to be done?"
          disabled={creating}
          value={text}
          onChange={(e) => { if (!createPending.current) setText(e.target.value); }}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <input
          type="date"
          aria-label="Due date"
          disabled={creating}
          className={inputCls}
          value={due}
          onChange={(e) => { if (!createPending.current) setDue(e.target.value); }}
        />
        <button
          type="button"
          onClick={add}
          disabled={creating || !text.trim()}
          className="px-4 py-2 text-sm rounded-lg bg-accent text-bone hover:bg-accent/80 disabled:opacity-40 transition-colors"
        >
          {creating ? 'Adding…' : 'Add'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {error && (
          <div role="alert" className="text-sm text-red-200">
            {error} {loaded && 'Previously loaded rows may be stale.'}{' '}
            <button type="button" disabled={loading} onClick={retryRead} className="underline disabled:opacity-40">Retry</button>
          </div>
        )}
        {loading && loaded && <div role="status">Refreshing commitments…</div>}
        {!loaded && loading ? (
          <LoadingState message="Loading commitments…" />
        ) : !loaded ? null : filtered.length === 0 ? (
          <EmptyState message="Nothing here." />
        ) : (
          <ul className="space-y-2">
            {filtered.map((c) => {
              const done = c.status === 'completed';
              const operation = operations[c.id];
              const locked = commitmentLocked(operation);
              return (
                <li key={c.id}>
                  <GlassCard className="p-3">
                    <div className="flex items-center gap-2">
                      <StatusDot ok={done} warn={!done} />
                      <span
                        className={cn(
                          'text-sm text-bone truncate',
                          done && 'line-through text-bone/40',
                        )}
                      >
                        {c.text}
                      </span>
                      <Pill variant={done ? 'success' : 'default'}>{c.status}</Pill>
                      <div className="ml-auto flex items-center gap-1 text-[11px]">
                        {!done && (
                          <button
                            type="button"
                            onClick={() => mutate(c, 'complete')}
                            disabled={locked}
                            className="px-2 py-0.5 rounded-md border border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10 transition-colors"
                          >
                            Complete
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => mutate(c, 'delete')}
                          disabled={locked}
                          className="px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <div className="mt-1 text-[10px] font-mono text-bone/30">{formatDue(c.due)}</div>
                    {c.goal_id && (
                      <div className="mt-0.5 text-[10px] font-mono text-bone/30">
                        goal {c.goal_id}
                      </div>
                    )}
                    {operation?.phase === 'writing' && (
                      <div role="status">{operation.action === 'complete' ? 'Completing…' : 'Deleting…'}</div>
                    )}
                    {operation?.phase === 'reconciling' && <div role="status">Change saved. Reconciling commitments…</div>}
                    {operation?.phase === 'write-failed' && (
                      <div role="alert" className="text-sm text-red-200">
                        Could not {operation.action === 'complete' ? 'complete' : 'delete'} the commitment. Confirmed state was kept.{' '}
                        <button type="button" onClick={() => mutate(c, operation.action)} className="underline">Retry</button>
                      </div>
                    )}
                    {operation?.phase === 'read-failed' && (
                      <div role="alert" className="text-sm text-red-200">
                        Change saved, but readback is unavailable or does not confirm it. Previous row shown; actions are locked. Retry reloads the list only.{' '}
                        <button type="button" disabled={loading} onClick={retryRead} className="underline disabled:opacity-40">Retry</button>
                      </div>
                    )}
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
