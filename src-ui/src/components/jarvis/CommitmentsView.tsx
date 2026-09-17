// ── CommitmentsView — agent commitments
//    (get_commitments/add_commitment/complete_commitment/delete_commitment) ──

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

interface Commitment {
  id: string;
  text: string;
  status: string;
  due: string | null;
  created_at: string;
  completed_at: string | null;
  agent_id: string | null;
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
  const { success, error: toastError } = useToast();

  const fetchCommitments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCommitments(await invoke<Commitment[]>('get_commitments'));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

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

  const complete = useCallback(
    async (c: Commitment) => {
      try {
        await invoke<boolean>('complete_commitment', { id: c.id });
        success('Marked complete');
        await fetchCommitments();
      } catch (e) {
        toastError(String(e), 'Update failed');
      }
    },
    [fetchCommitments, success, toastError],
  );

  const remove = useCallback(
    async (c: Commitment) => {
      try {
        await invoke<boolean>('delete_commitment', { id: c.id });
        success('Deleted');
        await fetchCommitments();
      } catch (e) {
        toastError(String(e), 'Delete failed');
      }
    },
    [fetchCommitments, success, toastError],
  );

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
        {loading ? (
          <LoadingState message="Loading commitments…" />
        ) : error ? (
          <ErrorState error={error} onRetry={fetchCommitments} />
        ) : filtered.length === 0 ? (
          <EmptyState message="Nothing here." />
        ) : (
          <ul className="space-y-2">
            {filtered.map((c) => {
              const done = c.status === 'completed';
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
                            onClick={() => complete(c)}
                            className="px-2 py-0.5 rounded-md border border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10 transition-colors"
                          >
                            Complete
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => remove(c)}
                          className="px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <div className="mt-1 text-[10px] font-mono text-bone/30">{formatDue(c.due)}</div>
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
