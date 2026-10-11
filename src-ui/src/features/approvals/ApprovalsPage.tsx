import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Info, RefreshCw, X } from 'lucide-react';
import {
  AlertLine,
  Badge,
  Button,
  Chip,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  RowList,
  Stat,
  StatusLine,
  formatIsoAge,
  useToast,
} from '../../design';
import { reconcileApprovalRows } from '../../domain/approval-state';
import {
  classifyDecisionWrite,
  classifyReadBack,
  decodeApprovalQueue,
  decideQueueCoverage,
  LIVE_GATE_CAVEAT,
  NO_REQUESTS_LISTED,
  type ApprovalRow,
} from '../../domain/approval-queue-state';

type DecisionPhase = 'writing' | 'failed' | 'confirming' | 'unverified' | 'unconfirmed';
type AlertPhase = 'failed' | 'unverified' | 'unconfirmed';

interface DecisionState {
  approve: boolean;
  phase: DecisionPhase;
  /** A native decision write is in flight for this request. */
  busy: boolean;
}

/** A request whose decision a later read confirmed, kept for this visit only. */
interface DecidedEntry {
  row: ApprovalRow;
  approve: boolean;
  decidedAt: number;
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

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { success } = useToast();
  const [decisions, setDecisions] = useState<Map<string, DecisionState>>(new Map());
  const [history, setHistory] = useState<DecidedEntry[]>([]);
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
            const decidedRow = retainedRows.current.get(id);
            if (decidedRow) {
              setHistory((prev) => [{ row: decidedRow, approve, decidedAt: Date.now() }, ...prev]);
            }
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
    <Page>
      <PageHeader
        eyebrow="Automate"
        title="Approvals"
        description="Requests waiting on your decision in the legacy approval store. This is not the live approval gate: a tool call that needs your approval during a Session turn is decided inside that Session."
        actions={
          <Button variant="ghost" icon={<RefreshCw aria-hidden="true" />} onClick={fetchApprovals}>
            Refresh
          </Button>
        }
      />

      <Panel ticks className="mb-6">
        <div className="flex flex-wrap items-start gap-x-10 gap-y-5">
          <Stat
            label="Awaiting decision"
            value={approvals.length > 0 || coverage === 'no_requests_listed' ? approvals.length : '—'}
            sub="listed in the last read"
            tone={approvals.length > 0 ? 'warn' : undefined}
          />
          <Stat label="Decided this visit" value={history.length} sub="confirmed by a fresh read" tone={history.length > 0 ? 'ok' : undefined} />
          <p className="flex min-w-64 max-w-md flex-1 items-start gap-2 self-center text-[12.5px] leading-relaxed text-ink-3">
            <Info aria-hidden="true" className="mt-[3px] size-3.5 shrink-0 text-info" />
            <span>
              Legacy store. Nothing in Jarvis writes to it today, so an empty list here says nothing about
              tool calls waiting inside a Session. Decided requests leave the store, so this visit&rsquo;s
              decisions are kept below until you navigate away.
            </span>
          </p>
        </div>
      </Panel>

      <div className="space-y-3">
        {loading && <StatusLine>Loading approvals…</StatusLine>}
        {error && (
          <AlertLine onRetry={fetchApprovals}>{error}</AlertLine>
        )}
      </div>

      {coverage === 'no_requests_listed' && (
        <Panel className="mt-3">
          <div role="status" className="flex flex-col items-center gap-1 px-4">
            <EmptyState title={NO_REQUESTS_LISTED} className="pb-4" />
            <p className="max-w-md text-center text-[12.5px] leading-relaxed text-ink-3">{LIVE_GATE_CAVEAT}</p>
          </div>
        </Panel>
      )}

      {approvals.length > 0 && (
        <section aria-label="Awaiting decision" className="mt-3">
          <ul className="space-y-3">
            {approvals.map((a) => {
              const state = decisions.get(a.id);
              const alert = state ? alertPhaseOf(state.phase) : null;
              // Once a decision has reached Native the row belongs to the write:
              // re-reading is the only honest way to change what it says.
              const locked = state !== undefined && (state.phase !== 'failed' || state.busy);
              return (
                <li key={a.id}>
                  <Panel as="article" className="d-rise">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="warn" dot>{a.request_type}</Badge>
                      {a.tool_name && <Chip>{a.tool_name}</Chip>}
                      <span className="ml-auto font-mono text-[10.5px] text-ink-3">
                        {a.created_at ? `${formatWhen(a.created_at)} · ${formatIsoAge(a.created_at)}` : ''}
                      </span>
                    </div>
                    <p className="mt-3 text-[14px] leading-snug text-ink">{a.description}</p>
                    {a.tool_args && (
                      <pre className="mt-3 max-h-40 overflow-auto rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink-2">
                        {a.tool_args}
                      </pre>
                    )}
                    {state && (state.phase === 'writing' || state.phase === 'confirming') && (
                      <StatusLine className="mt-3">
                        {state.phase === 'writing'
                          ? `${state.approve ? 'Approving' : 'Rejecting'}… Waiting for confirmation.`
                          : `${state.approve ? 'Approved' : 'Rejected'} the decision. Confirming with a fresh read…`}
                      </StatusLine>
                    )}
                    {state && alert !== null && (
                      <AlertLine className="mt-3" onRetry={() => retry(a, state)} retryDisabled={state.busy}>
                        {DECISION_ALERTS[alert]}
                      </AlertLine>
                    )}
                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                      <span className="font-mono text-[10.5px] text-ink-3">agent {a.agent_id}</span>
                      <div className="ml-auto flex gap-2">
                        <Button
                          variant="danger"
                          icon={<X aria-hidden="true" />}
                          onClick={() => decide(a, false)}
                          disabled={locked}
                        >
                          Reject
                        </Button>
                        <Button
                          variant="primary"
                          icon={<Check aria-hidden="true" />}
                          onClick={() => decide(a, true)}
                          disabled={locked}
                        >
                          Approve
                        </Button>
                      </div>
                    </div>
                  </Panel>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {history.length > 0 && (
        <section aria-label="Decided this visit" className="mt-8">
          <header className="mb-2 flex items-baseline gap-3">
            <h2 className="d-label">Decided this visit</h2>
            <span className="text-[12px] text-ink-3">Kept in this view only; the store lists pending requests.</span>
          </header>
          <Panel flush>
            <RowList>
              {history.map((entry) => (
                <li key={entry.row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <Badge tone={entry.approve ? 'ok' : 'error'} dot>{entry.approve ? 'Approved' : 'Rejected'}</Badge>
                  <Chip>{entry.row.tool_name ?? entry.row.request_type}</Chip>
                  <span className="font-mono text-[10.5px] text-ink-3">agent {entry.row.agent_id}</span>
                  <span className="ml-auto font-mono text-[10.5px] text-ink-4">{formatIsoAge(new Date(entry.decidedAt).toISOString())}</span>
                </li>
              ))}
            </RowList>
          </Panel>
        </section>
      )}
    </Page>
  );
}
