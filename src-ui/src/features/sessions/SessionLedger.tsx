import { decodeContextUsage } from '../../lib/context-usage';
import { useCallback, useId, useReducer, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { AlertLine, Badge, EmptyState, IconButton, KeyValue, Meter, StatusDot, StatusLine, cn, formatIsoAge, loadTone } from '../../design';
import { usePolling } from '../../hooks/usePolling';
import { initialSessionListState, reduceSessionListState } from '../../domain/session-list-state';
import type { BackendSession } from '../../types';

function formatTokens(n: number | null): string {
  if (n === null || n === undefined) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

/**
 * The native Session ledger (`list_sessions`): every backend Session with
 * token and context usage, as independent disclosures. Retrieval is
 * serialized (one read in flight; manual, 15s polling and visibility reads
 * share it). Pending is not empty, a failed first read is not empty, and a
 * failed refresh keeps the previous rows labelled as stale. Expansion is
 * keyed by Session id, so it survives polls that reorder rows.
 */
export default function SessionLedger({ className }: { className?: string }) {
  const disclosureId = useId();
  const [{ sessions, error, loading }, dispatch] = useReducer(reduceSessionListState, initialSessionListState);
  const pending = useRef(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    dispatch({ type: 'pending' });
    try {
      dispatch({ type: 'success', sessions: await invoke<BackendSession[]>('list_sessions') });
    } catch {
      dispatch({ type: 'failure' });
    } finally {
      pending.current = false;
    }
  }, []);

  usePolling(fetchData, 15000, [fetchData]);
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
        <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-ink-3">
          Native Session store{sessions ? ` · ${sessions.length}` : ''}
        </p>
        <IconButton aria-label="Refresh sessions" title="Refresh sessions" onClick={fetchData} disabled={loading} size="xs">
          <RefreshCw aria-hidden="true" className={cn(loading && 'd-spin')} />
        </IconButton>
      </div>

      <div className="flex shrink-0 flex-col gap-2 px-3 empty:hidden">
        {loading && (
          <StatusLine label="Session list">{sessions === null ? 'Loading sessions…' : 'Refreshing sessions…'}</StatusLine>
        )}
        {error && (
          <AlertLine onRetry={fetchData} retryDisabled={loading}>
            {sessions === null
              ? 'Could not load sessions.'
              : 'Could not refresh sessions. Showing previously loaded sessions; they may be stale.'}
          </AlertLine>
        )}
      </div>

      {!loading && !error && sessions?.length === 0 && (
        <EmptyState compact title="No sessions yet." description="Sessions recorded by the native store appear here." />
      )}

      <ul className="min-h-0 flex-1 space-y-px overflow-y-auto px-1.5 pb-3 pt-1">
        {(sessions ?? []).map((session) => {
          const isExpanded = expanded.has(session.id);
          const contextUsage = decodeContextUsage({ totalTokens: session.total_tokens, contextTokens: session.context_tokens });
          const percentUsed = contextUsage.barPercent;
          const regionId = `${disclosureId}-${session.id}`;
          return (
            <li key={session.id} className={cn('rounded-lg', isExpanded && 'bg-surface ring-1 ring-line')}>
              <button
                type="button"
                aria-label={`Session details: ${session.title || session.agent_id}`}
                aria-expanded={isExpanded}
                aria-controls={regionId}
                onClick={() => toggle(session.id)}
                className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-hover"
              >
                <StatusDot tone={session.archived ? 'warn' : 'ok'} className="mt-[6px]" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] text-ink">{session.title || session.agent_id}</span>
                    {session.archived && (
                      <Badge tone="warn" size="xs">
                        archived
                      </Badge>
                    )}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[10.5px] text-ink-3">
                    <span className="truncate">{session.backend}</span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{session.model}</span>
                  </span>
                  <span className="mt-0.5 block font-mono text-[10.5px] text-ink-4">{formatIsoAge(session.updated_at)}</span>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className={cn('mt-1 size-3.5 shrink-0 text-ink-4 transition-transform', isExpanded && 'rotate-90')}
                />
              </button>
              <div id={regionId} hidden={!isExpanded}>
                {isExpanded && (
                  <div className="space-y-3 px-3 pb-3 pt-1">
                    <KeyValue
                      className="grid-cols-[72px_1fr] text-[11.5px]"
                      items={[
                        ['Session', <span className="font-mono text-[10.5px]">{session.id}</span>],
                        ['Agent', session.agent_id],
                        ['Messages', session.message_count],
                        ['Tokens', `${formatTokens(session.total_tokens)} / ${formatTokens(session.context_tokens)}`],
                        ['Created', formatIsoAge(session.created_at)],
                        ['Updated', formatIsoAge(session.updated_at)],
                      ]}
                    />
                    {(
                      <div>
                        <div className="mb-1.5 flex items-center justify-between">
                          <span className="d-label text-[9.5px]">Context usage</span>
                          <span className={cn('font-mono text-[11px] tabular', percentUsed !== null && percentUsed >= 80 ? 'text-err' : percentUsed !== null && percentUsed >= 60 ? 'text-warn' : 'text-ink-2')}>
                            {contextUsage.percent}
                          </span>
                        </div>
                        {percentUsed !== null && <Meter value={percentUsed} tone={loadTone(percentUsed, 60, 80)} />}
                        {contextUsage.basis && <p className="mt-1 text-xs text-ink-3">{contextUsage.basis}</p>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
