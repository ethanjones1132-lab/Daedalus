import { useEffect, useState, type MouseEvent } from 'react';
import { History, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  AlertLine,
  Button,
  Chip,
  ConfirmModal,
  EmptyState,
  IconButton,
  SearchInput,
  StatusLine,
  Tabs,
  cn,
} from '../../design';
import type { JarvisSession } from '../../domain/types';
import { filterSessions, formatFilterResultCount } from '../../domain/session-filter';
import {
  RUN_NOT_RECORDED_TEXT,
  RUN_OUTCOME_PENDING_TEXT,
  RUN_OUTCOME_UNAVAILABLE_TEXT,
  RUN_ROW_UNCONFIRMED_TEXT,
  RUN_TELEMETRY_UNAVAILABLE_MESSAGE,
  sessionOutcomeView,
  type RunRecordState,
  type SessionRunTelemetry,
} from '../../domain/session-run-telemetry';
import { sessionDeleteLocked, type SessionDeleteOperation } from '../../domain/session-delete-state';
import SessionLedger from './SessionLedger';
import SessionRunsView from './SessionRunsView';
import { FeedList, type FeedReader } from './SessionFeeds';
import { outcomeTone, shortDate } from './outcome';

export type IndexTab = 'sessions' | 'ledger' | 'feeds';

export interface SessionIndexProps {
  sessions: JarvisSession[];
  loading: boolean;
  error: string | null;
  runTelemetry: SessionRunTelemetry;
  runRecord: RunRecordState | null;
  activeSession: string | null;
  deleteOperations: Record<string, SessionDeleteOperation<JarvisSession>>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (session: JarvisSession) => void;
  onRetryDeleteRead: (id: string) => void;
  onRefresh: () => void;
  tab: IndexTab;
  onTabChange: (tab: IndexTab) => void;
  feeds: FeedReader;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

const displayName = (s: JarvisSession) => s.name || s.title || s.id;

function SessionRow({
  session,
  active,
  operation,
  runTelemetry,
  runRecord,
  expandedRuns,
  loading,
  onSelect,
  onOpenDelete,
  onRetryDelete,
  onRetryDeleteRead,
  onToggleRuns,
}: {
  session: JarvisSession;
  active: boolean;
  operation: SessionDeleteOperation<JarvisSession> | undefined;
  runTelemetry: SessionRunTelemetry;
  runRecord: RunRecordState | null;
  expandedRuns: boolean;
  loading: boolean;
  onSelect: () => void;
  onOpenDelete: (e: MouseEvent) => void;
  onRetryDelete: () => void;
  onRetryDeleteRead: () => void;
  onToggleRuns: () => void;
}) {
  const deleteLocked = sessionDeleteLocked(operation);
  const outcome = sessionOutcomeView(runTelemetry, session.id);
  // A turn whose run record was never confirmed must not read as a Session
  // that ran cleanly, even when the durable read is honest about finding no
  // run for it.
  const unconfirmedRun = runRecord?.intent.sessionId === session.id && runRecord.phase !== 'confirmed';
  const busy = operation?.phase === 'writing' || operation?.phase === 'reconciling';

  return (
    <li className={cn('group/row relative rounded-lg transition-colors', active ? 'bg-raised shadow-card' : 'hover:bg-hover', busy && 'opacity-70')}>
      {active && <span aria-hidden="true" className="absolute inset-y-2.5 left-0 w-[2px] rounded-full bg-accent" />}
      <div className="flex items-start">
        <button
          type="button"
          onClick={onSelect}
          aria-label={`Select session ${displayName(session)}`}
          aria-pressed={active}
          aria-current={active ? 'true' : undefined}
          className="flex min-w-0 flex-1 rounded-lg py-2.5 pl-3.5 pr-1 text-left"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={cn('truncate text-[13px] leading-snug', active ? 'font-medium text-ink' : 'text-ink')}>
                {session.name || session.title || 'Untitled'}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-ink-3">
              <Chip className="max-w-[120px] py-0 text-[10px]">{session.model}</Chip>
              <span className="truncate font-mono text-[10.5px] tabular">
                {session.message_count} msgs · {shortDate(session.created_at)}
              </span>
            </div>
            <div className="mt-1 font-mono text-[10.5px] leading-snug text-ink-4">
              {outcome.kind === 'recorded' && (
                <span className="[&>span]:whitespace-nowrap">
                  <span className={outcomeTone(outcome.run.outcome)}>{outcome.run.outcome}</span>
                  {outcome.run.selected_model && outcome.run.selected_model !== session.model && (
                    <>
                      {' '}
                      <span>({outcome.run.selected_model})</span>
                    </>
                  )}{' '}
                  <span>· run {outcome.run.run_id}</span>
                  {outcome.olderCount > 0 && (
                    <>
                      {' '}
                      <span>
                        · {outcome.olderCount} older {outcome.olderCount === 1 ? 'run' : 'runs'}
                      </span>
                    </>
                  )}
                </span>
              )}
              {outcome.kind === 'not_recorded' && <span>{RUN_NOT_RECORDED_TEXT}</span>}
              {outcome.kind === 'unavailable' && <span className="text-warn">{RUN_OUTCOME_UNAVAILABLE_TEXT}</span>}
              {outcome.kind === 'pending' && <span>{RUN_OUTCOME_PENDING_TEXT}</span>}
              {unconfirmedRun && (
                <>
                  {' · '}
                  <span className="text-warn">{RUN_ROW_UNCONFIRMED_TEXT}</span>
                </>
              )}
            </div>
          </div>
        </button>
        <div
          className={cn(
            'mr-1.5 mt-1.5 flex flex-col items-center gap-0.5 transition-opacity',
            active || expandedRuns ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100',
          )}
        >
          <IconButton
            aria-label={`Delete session ${displayName(session)}`}
            title="Delete Session"
            variant="danger"
            size="xs"
            onClick={onOpenDelete}
            disabled={deleteLocked}
          >
            <Trash2 aria-hidden="true" />
          </IconButton>
          <IconButton
            aria-label={expandedRuns ? 'Hide recorded runs' : 'Show recorded runs'}
            title={expandedRuns ? 'Hide recorded runs' : 'Show recorded runs'}
            aria-expanded={expandedRuns}
            active={expandedRuns}
            size="xs"
            onClick={(e) => {
              e.stopPropagation();
              onToggleRuns();
            }}
          >
            <History aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      <div className="px-3.5 pb-2 empty:hidden">
        {operation?.phase === 'writing' && (
          <StatusLine className="text-[11.5px]">Deleting session…</StatusLine>
        )}
        {operation?.phase === 'reconciling' && (
          <StatusLine className="text-[11.5px]">Deletion saved. Confirming session removal…</StatusLine>
        )}
        {operation?.phase === 'write-failed' && (
          <AlertLine className="px-2.5 py-1.5 text-[11.5px]" onRetry={onRetryDelete}>
            Could not delete the Session. The previous row was kept.
          </AlertLine>
        )}
        {operation?.phase === 'read-failed' && (
          <AlertLine className="px-2.5 py-1.5 text-[11.5px]" onRetry={onRetryDeleteRead} retryDisabled={loading}>
            Deletion was saved, but the Session list could not confirm removal. Showing the previous row; it may be stale. Retry
            reloads the list only.
          </AlertLine>
        )}
      </div>

      {/* Per-Session run history through Native's per-Session read. */}
      {expandedRuns && (
        <div className="mx-3.5 mb-3 rounded-md border border-line bg-canvas/60 px-3 py-2.5">
          <div className="d-label mb-2 text-[9px]">Recorded runs</div>
          <SessionRunsView sessionId={session.id} />
        </div>
      )}
    </li>
  );
}

/**
 * The Session index: every Jarvis Session with its durable run outcome,
 * filter, deletion (with reconciliation against the authoritative list), and
 * two secondary views of the native store — the Ledger and read-only Feeds.
 */
export function SessionIndex(props: SessionIndexProps) {
  const {
    sessions,
    loading,
    error,
    runTelemetry,
    runRecord,
    activeSession,
    deleteOperations,
    onSelect,
    onNew,
    onDelete,
    onRetryDeleteRead,
    onRefresh,
    tab,
    onTabChange,
    feeds,
    collapsed,
    onToggleCollapsed,
  } = props;
  const [filterQuery, setFilterQuery] = useState('');
  const [expandedRuns, setExpandedRuns] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const filteredSessions = filterSessions(sessions, filterQuery);
  const isFiltering = filterQuery.trim().length > 0;
  const pendingDelete = sessions.find((session) => session.id === pendingDeleteId);

  useEffect(() => {
    if (pendingDeleteId && !pendingDelete) setPendingDeleteId(null);
  }, [pendingDelete, pendingDeleteId]);

  const openDelete = (session: JarvisSession, e: MouseEvent) => {
    e.stopPropagation();
    if (sessionDeleteLocked(deleteOperations[session.id])) return;
    setPendingDeleteId(session.id);
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    setPendingDeleteId(null);
    onDelete(pendingDelete);
  };

  if (collapsed) {
    return (
      <nav aria-label="Session index" className="flex w-12 shrink-0 flex-col items-center gap-1.5 border-r border-line bg-sunken py-3">
        <IconButton aria-label="Show session index" title="Show session index" onClick={onToggleCollapsed}>
          <PanelLeftOpen aria-hidden="true" />
        </IconButton>
        <IconButton aria-label="New session" title="New session" onClick={onNew}>
          <Plus aria-hidden="true" />
        </IconButton>
        <span className="mt-2 font-mono text-[10px] text-ink-4 [writing-mode:vertical-rl]">{sessions.length} Sessions</span>
      </nav>
    );
  }

  return (
    <nav aria-label="Session index" className="flex w-[264px] shrink-0 flex-col border-r border-line bg-sunken min-[1440px]:w-[288px]">
      <ConfirmModal
        open={pendingDelete !== undefined}
        message={`Delete session "${pendingDelete?.name || pendingDelete?.title || pendingDelete?.id}"?`}
        detail="Its transcript and recorded runs are removed from the Session store."
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeleteId(null)}
      />

      <div className="flex shrink-0 items-center gap-2 px-4 pb-2.5 pt-4">
        <h2 className="d-display text-[22px] leading-none text-ink">Sessions</h2>
        <span className="mt-1 font-mono text-[11px] text-ink-3 tabular">{formatFilterResultCount(filteredSessions.length, sessions.length)}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton aria-label="Refresh sessions" title="Refresh sessions" onClick={onRefresh} disabled={loading} size="xs">
            <RefreshCw aria-hidden="true" className={cn(loading && 'd-spin')} />
          </IconButton>
          <IconButton aria-label="Hide session index" title="Hide session index" onClick={onToggleCollapsed} size="xs">
            <PanelLeftClose aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <div className="shrink-0 px-4 pb-3">
        <Button variant="primary" size="sm" className="w-full" icon={<Plus aria-hidden="true" />} onClick={onNew} aria-label="New session">
          New session
        </Button>
      </div>

      <Tabs
        aria-label="Session index views"
        idBase="session-index"
        size="sm"
        value={tab}
        onChange={onTabChange}
        className="shrink-0 px-3"
        items={[
          { id: 'sessions', label: 'Sessions' },
          { id: 'ledger', label: 'Ledger' },
          { id: 'feeds', label: 'Feeds' },
        ]}
      />

      <div
        role="tabpanel"
        id={`session-index-panel-${tab}`}
        aria-labelledby={`session-index-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col pt-3"
      >
        {tab === 'ledger' && <SessionLedger className="min-h-0 flex-1" />}
        {tab === 'feeds' && <FeedList reader={feeds} />}
        {tab === 'sessions' && (
          <>
            {sessions.length > 0 && (
              <div className="shrink-0 px-3 pb-2">
                <SearchInput
                  value={filterQuery}
                  onChange={setFilterQuery}
                  placeholder="Filter by name, model, or id…"
                  aria-label="Filter sessions"
                  data-testid="sessions-filter-input"
                  clearLabel="Clear filter"
                />
              </div>
            )}

            <div className="flex shrink-0 flex-col gap-2 px-3 empty:hidden">
              {loading && <StatusLine>{sessions.length > 0 ? 'Refreshing sessions…' : 'Loading sessions…'}</StatusLine>}
              {error && (
                <AlertLine onRetry={onRefresh} retryText="Retry">
                  {`Could not load sessions. ${sessions.length > 0 ? 'Showing previously loaded sessions; they may be out of date. ' : ''}${error}`}
                </AlertLine>
              )}
              {runTelemetry.state === 'unavailable' && !loading && sessions.length > 0 && (
                <AlertLine tone="warn" onRetry={onRefresh} retryText="Retry run outcomes" retryLabel="Retry run outcomes" retryDisabled={loading}>
                  {RUN_TELEMETRY_UNAVAILABLE_MESSAGE}
                </AlertLine>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4 pt-1">
              {sessions.length === 0 && (loading || error) ? (
                loading && (
                  <div aria-hidden="true" className="space-y-4 px-3.5 pt-3">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="space-y-1.5">
                        <div className="d-skeleton h-3 w-3/4" />
                        <div className="d-skeleton h-2.5 w-1/2" />
                      </div>
                    ))}
                  </div>
                )
              ) : sessions.length === 0 ? (
                <EmptyState compact title="No sessions yet" description="Start a chat to create one" />
              ) : filteredSessions.length === 0 ? (
                <EmptyState
                  compact
                  title={`No sessions match "${filterQuery}"`}
                  description="Try a different name, model, or id prefix"
                />
              ) : (
                <ul className="space-y-0.5" aria-label={isFiltering ? 'Filtered Sessions' : 'Sessions'}>
                  {filteredSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      active={activeSession === session.id}
                      operation={deleteOperations[session.id]}
                      runTelemetry={runTelemetry}
                      runRecord={runRecord}
                      expandedRuns={expandedRuns === session.id}
                      loading={loading}
                      onSelect={() => onSelect(session.id)}
                      onOpenDelete={(e) => openDelete(session, e)}
                      onRetryDelete={() => setPendingDeleteId(session.id)}
                      onRetryDeleteRead={() => onRetryDeleteRead(session.id)}
                      onToggleRuns={() => setExpandedRuns((current) => (current === session.id ? null : session.id))}
                    />
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </nav>
  );
}
