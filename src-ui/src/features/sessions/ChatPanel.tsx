import { useCallback, useEffect, useState } from 'react';
import { PanelRightClose, PanelRightOpen, Plus, ShieldCheck } from 'lucide-react';
import { Chip, IconButton, StatusDot, cn } from '../../design';
import type { JarvisSession } from '../../domain/types';
import { formatSessionStatsLine, shouldShowSessionStats } from '../../domain/session-stats';
import { ApprovalModal } from './ApprovalModal';
import { Composer } from './Composer';
import { Inspector } from './Inspector';
import { Transcript } from './Transcript';
import WorkspaceGrantsChip from './WorkspaceGrantsChip';
import { MemoryTurnControls } from './MemoryTurnControls';
import { useSessionTurn, type SessionTurn, type SessionTurnProps } from './useSessionTurn';

export const INSPECTOR_STORAGE_KEY = 'jarvis-inspector-open';
const RECENT_LIMIT = 6;

function readInspectorOpen(): boolean {
  try {
    return localStorage.getItem(INSPECTOR_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export const sessionLabel = (s: Pick<JarvisSession, 'id' | 'name' | 'title'>) => (s.name || s.title || s.id.slice(0, 8)) as string;

export interface ChatPanelProps extends SessionTurnProps {
  /** Sessions for the sticky recent-session switcher (first six shown). */
  recentSessions?: JarvisSession[];
  /** Display title of the active Session. */
  title?: string;
  /** Told whenever a Session turn starts or stops streaming. */
  onStreamingChange?: (streaming: boolean) => void;
}

/**
 * Sticky recent-Session switcher. "New" starts a fresh Session (cancelling
 * any turn in flight); chips mirror the current selection with aria-pressed.
 * Every Session stays reachable beyond these six via the Session index.
 */
function RecentSessions({
  sessions,
  activeSession,
  onNew,
  onSelect,
}: {
  sessions: JarvisSession[];
  activeSession: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
}) {
  const recent = sessions.slice(0, RECENT_LIMIT);
  const chip =
    'inline-flex h-6 max-w-[168px] shrink-0 items-center gap-1 truncate rounded-full border px-2.5 text-[11.5px] transition-colors';
  return (
    <div
      data-testid="jarvis-persistent-nav"
      className="sticky top-0 z-10 flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-sunken/50 px-8 [mask-image:linear-gradient(90deg,#000_calc(100%-48px),transparent)] [scrollbar-width:none]"
    >
      <span className="d-label mr-1 shrink-0 text-[9.5px] text-ink-4">Recent</span>
      <button
        type="button"
        onClick={onNew}
        aria-label="New chat"
        aria-pressed={activeSession === null}
        aria-current={activeSession === null ? 'true' : undefined}
        className={cn(
          chip,
          activeSession === null
            ? 'border-accent-line bg-accent-wash text-accent-hot'
            : 'border-line text-ink-3 hover:border-line-strong hover:text-ink',
        )}
      >
        <Plus aria-hidden="true" className="size-3" /> New
      </button>
      {recent.map((s) => {
        const selected = activeSession === s.id;
        const label = sessionLabel(s);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            aria-pressed={selected}
            aria-current={selected ? 'true' : undefined}
            title={label}
            className={cn(
              chip,
              'block leading-[22px]',
              selected
                ? 'border-accent-line bg-raised text-ink'
                : 'border-transparent text-ink-3 hover:border-line hover:text-ink-2',
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Turn-level scope (from `scope_notice`) and Session-level workspace grants. */
function ScopeStrip({ turn }: { turn: SessionTurn }) {
  const { scopeNotice, selectedSessionId, isStreaming } = turn;
  return (
    <div className="flex flex-col gap-1.5">
      {scopeNotice && (
        <div aria-label="Explicit workspace scope" className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] text-ink-2">
          <span className="d-label inline-flex items-center gap-1 text-[9.5px] text-info">
            <ShieldCheck aria-hidden="true" className="size-3" />
            scope locked
          </span>
          {scopeNotice.rootListing && <span>top-level listing</span>}
          {scopeNotice.paths.map((path) => (
            <span key={path}>read: {path}</span>
          ))}
          {scopeNotice.shell === 'denied' && <span className="text-ink-3">shell denied</span>}
          {scopeNotice.network === 'denied' && <span className="text-ink-3">network denied</span>}
        </div>
      )}
      <WorkspaceGrantsChip sessionId={selectedSessionId} isStreaming={isStreaming} />
    </div>
  );
}

/**
 * The Session turn workspace: header (title, route, recent Sessions, scope),
 * the transcript document, the composer with its live wire, and the
 * Inspector. All behaviour lives in `useSessionTurn`.
 */
export function ChatPanel({ recentSessions = [], title, onStreamingChange, ...props }: ChatPanelProps) {
  const turn = useSessionTurn(props);
  useEffect(() => {
    onStreamingChange?.(turn.isStreaming);
  }, [onStreamingChange, turn.isStreaming]);
  const { activeSession, setActiveSession, config } = props;
  const [inspectorOpen, setInspectorOpen] = useState(readInspectorOpen);

  const toggleInspector = useCallback(() => {
    setInspectorOpen((open) => {
      try {
        localStorage.setItem(INSPECTOR_STORAGE_KEY, open ? '0' : '1');
      } catch {
        /* storage unavailable — the toggle still works for this view */
      }
      return !open;
    });
  }, []);

  const { displayedProvider, displayedModel, sessionStats, isStreaming, pendingApproval } = turn;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-line bg-canvas">
          <RecentSessions
            sessions={recentSessions}
            activeSession={activeSession}
            onNew={turn.handleNewChat}
            onSelect={(id) => setActiveSession(id)}
          />
          <div className="flex items-start gap-3 px-8 pb-3 pt-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2.5">
                <h2 className="d-display min-w-0 truncate text-[24px] leading-tight text-ink" title={title}>
                  {title || (activeSession ? 'Session' : 'New Session')}
                </h2>
                {isStreaming && <StatusDot tone="accent" live className="mt-1" />}
              </div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-ink-3">
                {config && (
                  <>
                    <span title="Configured Inference backend" className="text-accent">Configured backend: {displayedProvider}</span>
                    {displayedModel && (
                      <>
                        <span aria-hidden="true" className="text-ink-4">/</span>
                        <span title="Model" className="text-ink-2">{displayedModel}</span>
                      </>
                    )}
                    {shouldShowSessionStats(sessionStats.turnCount) && (
                      <Chip className="border-accent-line py-0 text-[10px] text-accent-hot">{formatSessionStatsLine(sessionStats)}</Chip>
                    )}
                  </>
                )}
                {activeSession && (
                  <>
                    {config && <span aria-hidden="true" className="text-ink-4">·</span>}
                    <span title={activeSession} className="text-ink-4">Session: {activeSession.slice(0, 8)}</span>
                  </>
                )}
              </div>
            </div>
            <IconButton
              aria-label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
              aria-pressed={inspectorOpen}
              title={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
              onClick={toggleInspector}
              className="mt-0.5"
            >
              {inspectorOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
            </IconButton>
          </div>
          <div className="px-8 pb-3 [&:not(:has(*_*))]:hidden">
            <ScopeStrip turn={turn} />
          </div>
        </header>

        <Transcript turn={turn} config={config} />
        <MemoryTurnControls turn={turn} /><Composer turn={turn} />
      </div>

      {inspectorOpen && <Inspector turn={turn} />}

      {pendingApproval && (
        <ApprovalModal
          key={`${pendingApproval.session_id}:${pendingApproval.call_id}`}
          callId={pendingApproval.call_id}
          name={pendingApproval.name}
          args={pendingApproval.arguments}
          error={turn.approvalError}
          pending={turn.approvalPending}
          onRetry={
            turn.approvalRetryDecision === null
              ? undefined
              : () => {
                  void turn.handleApproval(turn.approvalRetryDecision as boolean);
                }
          }
          onApprove={() => {
            void turn.handleApproval(true);
          }}
          onReject={() => {
            void turn.handleApproval(false);
          }}
        />
      )}
    </div>
  );
}

export default ChatPanel;
