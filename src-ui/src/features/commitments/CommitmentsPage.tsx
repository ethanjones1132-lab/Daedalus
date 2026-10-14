import RecordIdBadge from '../system/RecordIdBadge';
import { decideCreateReadback, createFailureSentence, type CreateFailure } from '../../domain/create-readback';
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  AlertLine,
  Badge,
  Button,
  EmptyState,
  IconButton,
  Input,
  Page,
  PageHeader,
  Panel,
  RowList,
  Select,
  Skeleton,
  StatusDot,
  StatusLine,
  cn,
  formatIsoAge,
  useToast,
} from '../../design';
import { commitmentLocked, reconcileCommitments, type CommitmentOperation } from '../../domain/commitment-state';

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

function isOverdue(c: Commitment): boolean {
  if (c.status === 'completed' || !c.due) return false;
  const t = Date.parse(c.due);
  return !Number.isNaN(t) && t < Date.now();
}

const EMPTY_DESCRIPTION: Record<Filter, string> = {
  open: 'No open commitments. Add one above and it will wait here until it is kept.',
  completed: 'No commitment has been marked complete yet.',
  all: 'No commitments have been recorded yet.',
};

export default function CommitmentsPage() {
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const [creating, setCreating] = useState(false);
  const [createFailure, setCreateFailure] = useState<CreateFailure | null>(null);
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
      if (request !== requestId.current) return null;
      const result = reconcileCommitments(snapshot, operationsRef.current, request);
      publishOperations(result.operations);
      setCommitments(result.rows);
      setLoaded(true);
      setError(null);
      return snapshot;
    } catch {
      if (request !== requestId.current) return null;
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
      return null;
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
      const returned = await invoke<Commitment>('add_commitment', {
        text: text.trim(),
        due: due ? new Date(due).toISOString() : null,
      });
      const verdict = decideCreateReadback<Commitment>(returned, await fetchCommitments());
      if (verdict.status !== 'confirmed') { setCreateFailure(verdict.status); return; }
      success('Commitment added');
      setCreateFailure(null);
      setText('');
      setDue('');
    } catch {
      setCreateFailure('write-failed');
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

  const openCount = useMemo(() => commitments.filter((c) => c.status !== 'completed').length, [commitments]);

  return (
    <Page>
      <PageHeader
        eyebrow="Automate"
        title="Commitments"
        description="Promises an Agent has made and must keep. Each one stays open on the ledger until it is completed or struck off."
        actions={
          <Button
            variant="ghost"
            icon={<RefreshCw aria-hidden="true" />}
            onClick={retryRead}
            disabled={loading}
          >
            Refresh
          </Button>
        }
      />

      <Panel className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="min-w-56 flex-1"
            aria-label="Commitment text"
            placeholder="What needs to be done?"
            disabled={creating}
            value={text}
            onChange={(e) => { if (!createPending.current) setText(e.target.value); }}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <Input
            type="date"
            aria-label="Due date"
            disabled={creating}
            className="w-40"
            value={due}
            onChange={(e) => { if (!createPending.current) setDue(e.target.value); }}
          />
          <Button
            variant="primary"
            size="md"
            icon={<Plus aria-hidden="true" />}
            busy={creating}
            onClick={add}
            disabled={creating || !text.trim()}
          >
            {creating ? 'Adding…' : 'Add'}
          </Button>
        </div>
        {createFailure && (
          <AlertLine
            className="mt-3"
            onRetry={createFailure === 'write-failed' ? add : undefined}
            retryLabel="Retry adding the commitment"
            retryDisabled={creating || !text.trim()}
          >
            {createFailureSentence('commitment', createFailure)}
          </AlertLine>
        )}
      </Panel>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Select
            aria-label="Filter commitments"
            className="w-36"
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
          >
            <option value="open">Open</option>
            <option value="completed">Completed</option>
            <option value="all">All</option>
          </Select>
          {loaded && (
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 tabular">
              {openCount} to keep · {commitments.length} on the ledger
            </span>
          )}
        </div>
        <div className="min-h-5">
          {loading && loaded && <StatusLine>Refreshing commitments…</StatusLine>}
        </div>
      </div>

      {error && (
        <AlertLine className="mb-3" onRetry={retryRead} retryDisabled={loading}>
          {error} {loaded && 'Previously loaded rows may be stale.'}
        </AlertLine>
      )}

      {!loaded && loading ? (
        <>
          <StatusLine className="mb-3">Loading commitments…</StatusLine>
          <Panel flush aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 border-b border-line px-4 py-4 last:border-b-0">
                <Skeleton className="size-2 rounded-full" />
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="ml-auto h-3 w-24" />
              </div>
            ))}
          </Panel>
        </>
      ) : !loaded ? null : filtered.length === 0 ? (
        <Panel>
          <EmptyState title="Nothing here." description={EMPTY_DESCRIPTION[filter]} />
        </Panel>
      ) : (
        <Panel flush>
          <RowList>
            {filtered.map((c) => (
              <CommitmentRow
                key={c.id}
                commitment={c}
                operation={operations[c.id]}
                loading={loading}
                onMutate={mutate}
                onRetryRead={retryRead}
              />
            ))}
          </RowList>
        </Panel>
      )}
    </Page>
  );
}

function CommitmentRow({
  commitment: c,
  operation,
  loading,
  onMutate,
  onRetryRead,
}: {
  commitment: Commitment;
  operation: CommitmentOperation<Commitment> | undefined;
  loading: boolean;
  onMutate: (c: Commitment, action: 'complete' | 'delete') => void;
  onRetryRead: () => void;
}) {
  const done = c.status === 'completed';
  const locked = commitmentLocked(operation);
  const overdue = isOverdue(c);
  const created = c.created_at ? formatIsoAge(c.created_at) : 'unknown';
  return (
    <li className="group px-4 py-3.5">
      <div className="flex items-start gap-3">
        <span className="mt-[7px]">
          <StatusDot tone={done ? 'ok' : overdue ? 'warn' : 'accent'} />
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn('text-[13.5px] leading-snug', done ? 'text-ink-3 line-through decoration-ink-4' : 'text-ink')}>
            {c.text}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-ink-3">
            <RecordIdBadge id={c.id} label="commitment" />
            <span className={cn(overdue && 'text-warn')}>{formatDue(c.due)}{overdue && ' · overdue'}</span>
            {c.goal_id && <span>Goal {c.goal_id}</span>}
            <span>{c.agent_id ? `owner ${c.agent_id}` : 'owner unassigned'}</span>
            {created !== 'unknown' && <span className="text-ink-4">added {created}</span>}
            {done && c.completed_at && <span className="text-ink-4">completed {formatIsoAge(c.completed_at)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge tone={done ? 'ok' : 'neutral'}>{c.status}</Badge>
          {!done && (
            <Button
              size="xs"
              variant="secondary"
              icon={<Check aria-hidden="true" />}
              onClick={() => onMutate(c, 'complete')}
              disabled={locked}
            >
              Complete
            </Button>
          )}
          <IconButton
            variant="danger"
            size="xs"
            aria-label="Delete"
            title="Delete"
            className="opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
            onClick={() => onMutate(c, 'delete')}
            disabled={locked}
          >
            <Trash2 aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      {operation?.phase === 'writing' && (
        <StatusLine className="mt-2 pl-5">{operation.action === 'complete' ? 'Completing…' : 'Deleting…'}</StatusLine>
      )}
      {operation?.phase === 'reconciling' && (
        <StatusLine className="mt-2 pl-5">Change saved. Reconciling commitments…</StatusLine>
      )}
      {operation?.phase === 'write-failed' && (
        <AlertLine className="mt-2.5" onRetry={() => onMutate(c, operation.action)}>
          Could not {operation.action === 'complete' ? 'complete' : 'delete'} the commitment. Confirmed state was kept.
        </AlertLine>
      )}
      {operation?.phase === 'read-failed' && (
        <AlertLine className="mt-2.5" onRetry={onRetryRead} retryDisabled={loading}>
          Change saved, but readback is unavailable or does not confirm it. Previous row shown; actions are locked. Retry reloads the list only.
        </AlertLine>
      )}
    </li>
  );
}
