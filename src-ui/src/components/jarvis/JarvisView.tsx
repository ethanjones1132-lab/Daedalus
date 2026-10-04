import { useState, useEffect, useRef, useCallback, useLayoutEffect, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { cn, ConfirmModal, EmptyState, LoadingState, ErrorState } from '../ui';
import type { CompanionState } from './types';
import {
  JarvisSession, JarvisMessage, JarvisConfig, JarvisStatus,
  OPENROUTER_MODELS,
} from './types';
import ControlCenterView, { type ControlCenterTab } from './ControlCenterView';
import { sessionScroll } from './session-scroll';
import {
  clearSubmittedSessionDraft,
  createSessionDraftStore,
  getSessionDraft,
  getSessionDraftSnapshot,
  restoreFailedSessionDraft,
  updateSessionDraft,
  type SessionDraftStore,
} from './session-draft-state';
import MarkdownView from './MarkdownView';
import SessionRunsView from './SessionRunsView';
import WorkspaceGrantsChip from './WorkspaceGrantsChip';
import SystemStatusBar from './SystemStatusBar';
import {
  createUnknownFrameReporter,
  InactivityWatchdog,
  isTerminalStageStatus,
  isPassiveSseFrame,
  parseSseDataLine,
  readToolResultTruncation,
} from './sse-protocol';
import {
  SendGate,
  SendInFlightGuard,
  appendAgentProgress,
  buildActivityFeed,
  buildTurnProgress,
  dedupeMessages,
  finalizeStreamingMessages,
  formatActivityFeedSummary,
  formatAgentProgressSummary,
  formatFallbackProgress,
  formatInferenceRoute,
  formatRunDuration,
  isToolCallEchoOnly,
  mergeToolResult,
  sanitizeAssistantDisplay,
  shouldSubmitComposerKey,
  type ActivityItem,
  type ToolCallState,
} from './chat-state';
import { errorDisplayForCode } from './error-display';
import {
  activityLedgerItems,
  createActivityLedger,
  decodeConductorDirectiveFrame,
  reduceActivityLedger,
  type ActivityLedgerEvent,
  type ActivityLedgerState,
  type ActivityToolCall,
} from './activity-ledger';
import {
  acceptFirstTerminal,
  boundedPartialOutput,
  classifyStreamTermination,
  decodeResultFrame,
  STREAM_INCOMPLETE_CODE,
  STREAM_INCOMPLETE_MESSAGE,
  STREAM_TIMEOUT_CODES,
  type DecodedStreamTerminal,
  type StreamTerminalFrame,
  type StreamTerminalOutcome,
} from './stream-lifecycle';
import {
  coerceMemoryRecallStatus,
  decodeMemoryStatusFrame,
  decodeMemoryTurnDiagnostic,
  decodeMemoryTurnPreparation,
  decodeNativeHistoryRows,
  formatMemoryTurnLabel,
  type MemoryRecallStatus,
  type MemoryTurnDiagnosticView,
} from './memory-turn-state';
import {
  activeRelayMemoryTurn,
  clearRelayMemoryTurn,
  isRegisteredRelayMemoryTurn,
} from './relay-memory-correlation';
import { formatSessionStatsLine, shouldShowSessionStats } from './session-stats';
import { filterSessions, formatFilterResultCount } from './session-filter';
import {
  RUN_NOT_RECORDED_TEXT,
  RUN_OUTCOME_PENDING_TEXT,
  RUN_OUTCOME_UNAVAILABLE_TEXT,
  RUN_ROW_UNCONFIRMED_TEXT,
  RUN_TELEMETRY_UNAVAILABLE_MESSAGE,
  decideRunRecord,
  decideSessionRunTelemetry,
  runRecordView,
  sessionOutcomeView,
  singleFlightSessionRunRead,
  type RunRecordIntent,
  type RunRecordState,
  type SessionRunRead,
  type SessionRunTelemetry,
  type SessionRunWrite,
} from './session-run-telemetry';
import {
  reconcileSessionDeletions,
  sessionDeleteLocked,
  type SessionDeleteOperation,
} from './session-delete-state';
import {
  Send, Square, Bot, User, Wrench, Check, Copy, ChevronDown,
  ChevronRight, Sparkles, LoaderCircle, Plus, ArrowDown,
} from 'lucide-react';

// ═══════════════════════════════════════════════════════════════
// ── Main Jarvis View ──
// ═══════════════════════════════════════════════════════════════

type JarvisSubView = 'chat' | 'sessions' | 'config' | 'status' | 'control';

interface JarvisViewProps {
  initialSubView?: JarvisSubView;
  initialControlTab?: ControlCenterTab;
  onCompanionChange?: (companion: CompanionState | null) => void;
}

type ToolApprovalRequest = {
  call_id: string;
  name: string;
  arguments: unknown;
  session_id: string;
};

const sameToolApproval = (left: ToolApprovalRequest | null, right: ToolApprovalRequest | null) =>
  left?.call_id === right?.call_id && left?.session_id === right?.session_id;

const sessionInvokeArgs = (sessionId: string) => ({
  sessionId,
  session_id: sessionId,
});

// ── Durable run record (Task 4.1) ────────────────────────────────────
// `record_terminal_run` is Native's only writer for `session_runs` and
// `get_session_runs` its per-Session read. A turn's terminal frame used to be
// reported fire-and-forget, so a write Native rejected left the Session
// reading as one that never ran. These two helpers keep the write and the
// read-back on the existing command surface and report nothing but success or
// failure: native error text never leaves this boundary.

/** One terminal run, addressed by the Session it belongs to. */
export interface RunRecordPayload extends RunRecordIntent {
  selectedModel: string | null;
  tokenCount: number;
  toolCount: number;
  cancelledReason: string | null;
  partialOutput: string | null;
}

const recordTerminalRun = (payload: RunRecordPayload): Promise<SessionRunWrite> =>
  invoke('record_terminal_run', {
    ...sessionInvokeArgs(payload.sessionId),
    runId: payload.runId,
    outcome: payload.outcome,
    selectedModel: payload.selectedModel,
    tokenCount: payload.tokenCount,
    toolCount: payload.toolCount,
    cancelledReason: payload.cancelledReason,
    partialOutput: payload.partialOutput,
  }).then(
    () => ({ ok: true }) as SessionRunWrite,
    () => ({ ok: false }) as SessionRunWrite,
  );

const readSessionRunsFor = async (sessionId: string): Promise<SessionRunRead> => {
  try {
    return { ok: true, value: await invoke<unknown>('get_session_runs', sessionInvokeArgs(sessionId)) };
  } catch {
    return { ok: false };
  }
};

const JARVIS_API_URL = 'http://127.0.0.1:19877';
const STREAM_INACTIVITY_TIMEOUT_MS = 90_000;
// Phase 2.4 — bound the UI's native memory finalization attempt (including the
// Tauri command wait and any native operation-gate backlog) so a stuck native
// task cannot postpone terminal publication indefinitely. Above the owned
// transport's own 1s connect / 3s total request bounds; on timeout the ordinary
// result is shown with a truthful pending notice. The finalizer is not retried.
const MEMORY_FINALIZE_TIMEOUT_MS = 5_000;

// Task 7 Part C (2026-07-03 incident 1d4727cf): the server's structured
// `error` frame carries a `code` (e.g. "first_token_timeout") that
// previously was logged and then discarded — `handleFrame` threw a plain
// `Error`, so by the time `handleSend`'s catch block ran there was no way
// to render a distinct error bubble or show the code as detail. This class
// carries the code through the throw/catch boundary.
class JarvisStreamError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'JarvisStreamError';
    this.code = code;
  }
}

export default function JarvisView({ initialSubView = 'chat', initialControlTab, onCompanionChange }: JarvisViewProps) {
  const [subView, setSubView] = useState<JarvisSubView>(initialSubView);
  const [sessions, setSessions] = useState<JarvisSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const sessionsRequest = useRef(0);
  // The recorded run outcome of a Session is durable Native state
  // (`get_all_session_runs` over the `session_runs` table). A rejected or
  // undecodable read is tracked as `unavailable` rather than collapsed into an
  // empty list, so a Session whose outcome could not be read is never shown as
  // a Session that never ran. See `session-run-telemetry.ts`.
  const [runTelemetry, setRunTelemetry] = useState<SessionRunTelemetry>({ state: 'pending' });
  // The run record of the turn that just ended, confirmed against Native's
  // read-back. Owned here so the Session list can keep saying "this turn's run
  // is not recorded" after the operator leaves Chat.
  const [runRecord, setRunRecord] = useState<RunRecordState | null>(null);
  const sessionRunReader = useRef<ReturnType<typeof singleFlightSessionRunRead> | null>(null);
  const readSessionRuns = sessionRunReader.current
    ?? (sessionRunReader.current = singleFlightSessionRunRead(() => invoke<unknown>('get_all_session_runs')));
  const [sessionDeleteOperations, setSessionDeleteOperations] = useState<Record<string, SessionDeleteOperation<JarvisSession>>>({});
  const sessionDeleteOperationsRef = useRef<Record<string, SessionDeleteOperation<JarvisSession>>>({});
  const sessionDeleteReadPending = useRef(false);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [config, setConfig] = useState<JarvisConfig | null>(null);
  const [status, setStatus] = useState<JarvisStatus | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState(false);
  const configPending = useRef(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState(false);
  const statusPending = useRef(false);

  const publishSessionDeleteOperations = useCallback((next: Record<string, SessionDeleteOperation<JarvisSession>>) => {
    sessionDeleteOperationsRef.current = next;
    setSessionDeleteOperations(next);
  }, []);

  const loadSessions = useCallback(async (options?: { deletionRead?: boolean }) => {
    if (options?.deletionRead && sessionDeleteReadPending.current) return;
    const request = ++sessionsRequest.current;
    if (options?.deletionRead) sessionDeleteReadPending.current = true;
    else sessionDeleteReadPending.current = false;
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const result = await invoke<JarvisSession[]>('jarvis_list_sessions');
      if (request !== sessionsRequest.current) return;
      const reconciled = reconcileSessionDeletions(result, sessionDeleteOperationsRef.current, request);
      publishSessionDeleteOperations(reconciled.operations);
      setSessions(reconciled.rows);
      setRunTelemetry({ state: 'pending' });
      const confirmed = new Set(reconciled.confirmed);
      if (confirmed.size > 0) {
        setActiveSession(current => current && confirmed.has(current) ? null : current);
      }
      // The recorded-run read is a second, independent native request. It is
      // deliberately not awaited with the list: the Session rows are
      // authoritative and a slow or hung outcome read must never hold them
      // hostage. The request identity still applies, so a stale read cannot
      // overwrite a newer one.
      const visibleIds = reconciled.rows.map(row => row.id);
      void readSessionRuns().then(read => {
        if (request !== sessionsRequest.current) return;
        setRunTelemetry(decideSessionRunTelemetry(read, visibleIds));
      });
    } catch (e) {
      if (request !== sessionsRequest.current) return;
      const next = { ...sessionDeleteOperationsRef.current };
      let removalFailure = false;
      for (const [id, operation] of Object.entries(next)) {
        if (operation.phase === 'reconciling' || operation.phase === 'read-failed') {
          next[id] = { ...operation, phase: 'read-failed' };
          removalFailure = true;
        }
      }
      if (removalFailure) publishSessionDeleteOperations(next);
      else setSessionsError(String(e));
    } finally {
      if (request === sessionsRequest.current) {
        if (options?.deletionRead) sessionDeleteReadPending.current = false;
        setSessionsLoading(false);
      }
    }
  }, [publishSessionDeleteOperations, readSessionRuns]);

  const deleteSession = useCallback((session: JarvisSession) => {
    if (sessionDeleteLocked(sessionDeleteOperationsRef.current[session.id])) return;
    const operation: SessionDeleteOperation<JarvisSession> = {
      row: session,
      phase: 'writing',
      after: sessionsRequest.current,
    };
    publishSessionDeleteOperations({ ...sessionDeleteOperationsRef.current, [session.id]: operation });
    void (async () => {
      try {
        await invoke<void>('jarvis_delete_session', { sessionId: session.id });
        if (sessionDeleteOperationsRef.current[session.id] !== operation) return;
        publishSessionDeleteOperations({
          ...sessionDeleteOperationsRef.current,
          [session.id]: { ...operation, phase: 'reconciling', after: sessionsRequest.current },
        });
        await loadSessions({ deletionRead: true });
      } catch {
        if (sessionDeleteOperationsRef.current[session.id] !== operation) return;
        publishSessionDeleteOperations({
          ...sessionDeleteOperationsRef.current,
          [session.id]: { ...operation, phase: 'write-failed', after: sessionsRequest.current },
        });
      }
    })();
  }, [loadSessions, publishSessionDeleteOperations]);

  const retrySessionDeleteRead = useCallback((id: string) => {
    const current = sessionDeleteOperationsRef.current[id];
    if (!current || current.phase !== 'read-failed' || sessionDeleteReadPending.current) return;
    publishSessionDeleteOperations({
      ...sessionDeleteOperationsRef.current,
      [id]: { ...current, phase: 'reconciling', after: sessionsRequest.current },
    });
    void loadSessions({ deletionRead: true });
  }, [loadSessions, publishSessionDeleteOperations]);

  const loadConfig = useCallback(async () => {
    if (configPending.current) return;
    configPending.current = true;
    setConfigLoading(true);
    try {
      const result = await invoke<JarvisConfig>('jarvis_get_config');
      if (!result) throw new Error('Missing config');
      setConfig(result);
      setConfigError(false);
    } catch {
      // Native errors may contain configuration values; never display or log them.
      setConfigError(true);
    } finally {
      configPending.current = false;
      setConfigLoading(false);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    if (statusPending.current) return;
    statusPending.current = true;
    setStatusLoading(true);
    try {
      const result = await invoke<JarvisStatus>('jarvis_check_status');
      if (!result) throw new Error('Missing status');
      setStatus(result);
      setStatusError(false);
    } catch {
      setStatusError(true);
    } finally {
      statusPending.current = false;
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
    loadConfig();
    loadStatus();
  }, [loadSessions, loadConfig, loadStatus]);

  const subNavItems: { id: JarvisSubView; label: string; icon: React.ReactNode }[] = [
    { id: 'chat', label: 'Chat', icon: <Sparkles size={11} /> },
    { id: 'sessions', label: 'Sessions', icon: <ChevronRight size={11} /> },
    { id: 'config', label: 'Config', icon: <Wrench size={11} /> },
    { id: 'status', label: 'Status', icon: <ChevronDown size={11} /> },
    { id: 'control', label: 'Control', icon: <Plus size={11} /> },
  ];

  // Load companion and notify parent
  useEffect(() => {
    const loadCompanion = async () => {
      try {
        const companion = await invoke<CompanionState | null>('jarvis_get_companion');
        onCompanionChange?.(companion);
      } catch (e) {
        console.error('Failed to load companion:', e);
        onCompanionChange?.(null);
      }
    };
    loadCompanion();
  }, [onCompanionChange]);

  // Multi-session sticky tabs: a row of chips just under the top subnav so the
  // user can quick-switch between recent conversations without leaving Chat.
  const recentSessions = sessions.slice(0, 6);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.25 }}
      className="h-full min-h-0 flex flex-col overflow-hidden"
    >
      {/* Persistent command rail: view tabs and recent sessions never leave
                reach while the nested feature surface (notably Chat) scrolls. */}
            <div
              data-testid="jarvis-persistent-nav"
              className="sticky top-0 z-20 shrink-0 mb-3 -mx-1 px-1 pb-2 bg-void/95 backdrop-blur-md border-b border-white/[0.04]"
            >
            {/* System status bar — compact at-a-glance health */}
            <SystemStatusBar activeBackend={config?.active_backend ?? null} />
            {/* Sub-navigation tabs — ARIA tablist + tab semantics (Phase 4) */}
      <div
        role="tablist"
        aria-label="Jarvis views"
        className="flex items-center gap-1 mb-2 overflow-x-auto"
      >
        {subNavItems.map(item => {
          const selected = subView === item.id;
          return (
            <button
              key={item.id}
              role="tab"
              aria-selected={selected}
              aria-current={selected ? 'page' : undefined}
              onClick={() => setSubView(item.id)}
              className={cn(
                'shrink-0 px-3 py-1.5 text-xs font-mono rounded-lg border transition-all duration-150 flex items-center gap-1.5',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50 focus-visible:ring-offset-1 focus-visible:ring-offset-void',
                selected
                  ? 'bg-royal/20 text-royal-light border-royal/40'
                  : 'text-bone-dim border-iron/30 hover:border-iron/50 hover:text-bone-muted'
              )}
            >
              <span className="opacity-70">{item.icon}</span>
              {item.label}
            </button>
          );
        })}
      </div>

      {/* Sticky session chips (Phase 3.4) */}
      {recentSessions.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => { setActiveSession(null); setSubView('chat'); }}
            aria-label="New chat"
            aria-pressed={activeSession === null}
            aria-current={activeSession === null ? 'true' : undefined}
            className={cn(
              'shrink-0 px-2 py-0.5 rounded-md text-[10px] font-mono border transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50',
              activeSession === null
                ? 'bg-cyan-neon/15 text-cyan-glow border-cyan-neon/40'
                : 'text-bone-dim border-iron/30 hover:border-iron/50 hover:text-bone-muted'
            )}
          >
            <Plus size={10} className="inline -mt-0.5" /> New
          </button>
          {recentSessions.map(s => {
            const selected = activeSession === s.id;
            const label = (s.name || s.title || s.id.slice(0, 8)) as string;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => { setActiveSession(s.id); setSubView('chat'); }}
                aria-pressed={selected}
                aria-current={selected ? 'true' : undefined}
                className={cn(
                  'shrink-0 px-2 py-0.5 rounded-md text-[10px] font-mono border transition-colors max-w-[160px] truncate',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50',
                  selected
                    ? 'bg-royal/20 text-royal-light border-royal/40'
                    : 'text-bone-dim border-iron/30 hover:border-iron/50 hover:text-bone-muted'
                )}
                title={label}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        <AnimatePresence mode="wait">
          {subView === 'chat' && (
            <motion.div key="chat" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <ChatPanel
                activeSession={activeSession}
                setActiveSession={setActiveSession}
                config={config}
                backendLabel={config?.active_backend === 'openrouter' ? 'OpenRouter' : config?.active_backend === 'llama_cpp' ? 'Gemma 4 · llama.cpp' : (config?.active_backend === 'claude_cli' ? 'Claude CLI' : 'Ollama')}
                modelLabel={config ? (config.active_backend === 'ollama' ? config.ollama.model : config.active_backend === 'llama_cpp' ? config.llama_cpp.model : (config.active_backend === 'claude_cli' ? (config.claude_cli.model ?? '') : config.openrouter.model)) : ''}
                onSessionCreated={loadSessions}
                onRunRecordSettled={setRunRecord}
              />
            </motion.div>
          )}
          {subView === 'sessions' && (
            <motion.div key="sessions" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <SessionsPanel
                sessions={sessions}
                loading={sessionsLoading}
                error={sessionsError}
                runTelemetry={runTelemetry}
                runRecord={runRecord}
                activeSession={activeSession}
                deleteOperations={sessionDeleteOperations}
                onSelect={(id) => { setActiveSession(id); setSubView('chat'); }}
                onNew={() => { setActiveSession(null); setSubView('chat'); }}
                onDelete={deleteSession}
                onRetryDeleteRead={retrySessionDeleteRead}
                onRefresh={() => { void loadSessions(); }}
              />
            </motion.div>
          )}
          {subView === 'config' && (
            <motion.div key="config" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <ConfigPanel config={config} setConfig={setConfig} loading={configLoading} loadError={configError} onRetry={loadConfig} />
            </motion.div>
          )}
          {subView === 'status' && (
            <motion.div key="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <StatusPanel status={status} loading={statusLoading} loadError={statusError} onRefresh={loadStatus} />
            </motion.div>
          )}
          {subView === 'control' && (
            <motion.div key="control" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <ControlCenterView initialTab={initialControlTab} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Status Dot ──
// ═══════════════════════════════════════════════════════════════

function StatusDot({ ok, warn, size = 'md' }: { ok: boolean; warn?: boolean; size?: 'sm' | 'md' }) {
  const color = ok ? 'bg-cyan-neon' : warn ? 'bg-amber-400' : 'bg-red-500';
  const sizeClass = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';
  return (
    <motion.div
      className={cn('rounded-full', sizeClass, color)}
      animate={{
        boxShadow: ok
          ? ['0 0 4px rgba(34,211,238,0.3)', '0 0 10px rgba(34,211,238,0.5)', '0 0 4px rgba(34,211,238,0.3)']
          : warn
            ? ['0 0 4px rgba(251,191,36,0.3)', '0 0 10px rgba(251,191,36,0.5)', '0 0 4px rgba(251,191,36,0.3)']
            : ['0 0 4px rgba(239,68,68,0.3)', '0 0 10px rgba(239,68,68,0.5)', '0 0 4px rgba(239,68,68,0.3)'],
      }}
      transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Glass Card ──
// ═══════════════════════════════════════════════════════════════

function GlassCard({ children, className, onClick, hoverable = true }: {
  children: React.ReactNode; className?: string; onClick?: () => void; hoverable?: boolean;
}) {
  return (
    <motion.div
      className={cn(
        'bg-obsidian/60 backdrop-blur-xl border border-iron/40 rounded-xl p-4',
        'transition-colors duration-200',
        hoverable && 'hover:border-royal/30 hover:bg-obsidian/80',
        onClick && 'cursor-pointer',
        className
      )}
      onClick={onClick}
      whileHover={hoverable ? { scale: 1.005 } : undefined}
      transition={{ duration: 0.15 }}
    >
      {children}
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Pill ──
// ═══════════════════════════════════════════════════════════════

function Pill({ children, variant = 'default' }: { children: React.ReactNode; variant?: string }) {
  const colors: Record<string, string> = {
    default: 'bg-iron/30 text-bone-muted border-iron/50',
    success: 'bg-cyan-neon/15 text-cyan-glow border-cyan-neon/30',
    warning: 'bg-amber-400/15 text-amber-400 border-amber-400/30',
    error: 'bg-red-500/15 text-red-400 border-red-500/30',
    info: 'bg-royal/15 text-royal-light border-royal/30',
    active: 'bg-cyan-neon/20 text-cyan-glow border-cyan-neon/40',
  };
  return (
    <span className={cn('px-2 py-0.5 text-xs font-mono uppercase tracking-wider border rounded', colors[variant] || colors.default)}>
      {children}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Chat Panel (Phase 1.1 + 1.3 + 1.4 + 2.3-2.8 + 3.x + 4)
// ═══════════════════════════════════════════════════════════════

// Helper: a single SSE-stream "SessionHistor§Message" shape, mirroring the
// SessionMessageOut returned by get_session_history.
interface SessionHistoryMessage {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tokens: number;
  tool_calls: string | null;
  created_at: string;
}

// Curated follow-up suggestion chips. The backend doesn't yet emit a per-turn
// recommendation, so we surface a small static set so the surface feels alive.
const CURATED_SUGGESTIONS: string[] = [
  'Refine the previous answer',
  'Walk me through the reasoning',
  'Suggest next steps',
  'Apply this to my code',
];

export function ChatPanel({
  activeSession, setActiveSession, config, backendLabel, modelLabel, onSessionCreated, onRunRecordSettled,
}: {
  activeSession: string | null;
  setActiveSession: (id: string | null) => void;
  config: JarvisConfig | null;
  backendLabel: string;
  modelLabel: string;
  onSessionCreated: () => void;
  onRunRecordSettled?: (state: RunRecordState | null) => void;
}) {
  const [messages, setMessages] = useState<JarvisMessage[]>([]);
  const [draftStore, setDraftStore] = useState<SessionDraftStore>(() => createSessionDraftStore());
  const draftStoreRef = useRef<SessionDraftStore>(draftStore);
  const input = getSessionDraft(draftStore, activeSession).text;
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string>('');
  const selectedSessionId = activeSession ?? '';
  const [error, setError] = useState<string | null>(null);
  // Orchestrator pipeline progress: e.g. "planner", "executor", "reviewer"
  const [pipelineStage, setPipelineStage] = useState<string>('');
  // Recursive-critique info: set when recursive topology is in a critique/re-enter cycle
  const [recursionDepth, setRecursionDepth] = useState<number | null>(null);
  // Reasoning/CoT text accumulated while streaming (cleared on done)
  const [reasoningText, setReasoningText] = useState<string>('');
  const [showReasoning, setShowReasoning] = useState(false);
  // Intermediate agent activity per stage (planner/executor/reviewer/rewriter)
  const [agentSteps, setAgentSteps] = useState<{ stage: string; text: string }[]>([]);
  const [showAgents, setShowAgents] = useState(true);

  // Phase 1.1 — pending tool approval surfaced from `jarvis://approval_request`.
  const [pendingApproval, setPendingApproval] = useState<ToolApprovalRequest | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalPending, setApprovalPending] = useState(false);
  const [approvalRetryDecision, setApprovalRetryDecision] = useState<boolean | null>(null);
  const pendingApprovalRef = useRef<ToolApprovalRequest | null>(null);
  const approvalInFlightRef = useRef<{
    callId: string;
    sessionId: string;
    approved: boolean;
  } | null>(null);
  const seenApprovalKeysRef = useRef<Set<string>>(new Set());

  // Phase 3.1 — inline tool-call cards built from `tool_use` / `tool_result`.
  const [toolCalls, setToolCalls] = useState<ToolCallState[]>([]);
  const [activityLedger, setActivityLedger] = useState<ActivityLedgerState>(() => createActivityLedger());
  const dispatchActivity = useCallback((event: ActivityLedgerEvent) => {
    setActivityLedger((current) => reduceActivityLedger(current, event));
  }, []);
  const resetActivityLedger = useCallback(() => {
    setActivityLedger(createActivityLedger());
  }, []);

  // Phase 2.4 — per-turn native memory diagnostics. The transient status comes
  // from `memory_status`/`memory_applied` SSE frames; the native diagnostic
  // read-back after terminal sync is the authority. No recalled text or
  // capability ever reaches the UI.
  const [memoryLiveStatus, setMemoryLiveStatus] = useState<MemoryRecallStatus | null>(null);
  const [memoryDiagnostic, setMemoryDiagnostic] = useState<MemoryTurnDiagnosticView | null>(null);
  const [memoryHistoryWarning, setMemoryHistoryWarning] = useState<string | null>(null);
  const [memoryFinalizationNotice, setMemoryFinalizationNotice] = useState<string | null>(null);
  // Explicit per-turn user-wide opt-in. Default false; cleared whenever the
  // selected Session (and therefore Agent scope) changes so it can never carry
  // silently into a different Session/Agent.
  const [includeUserScope, setIncludeUserScope] = useState(false);
  // The owning relay memory turn currently displayed. Used to drop stale
  // warnings/diagnostics when a different relay submission becomes active.
  const memoryOwnerRef = useRef<{ sessionId: string; turnId: string } | null>(null);
  useEffect(() => {
    // A Session change invalidates the previous turn's memory surface and any
    // relay correlation: no old warning/diagnostic may survive it.
    setIncludeUserScope(false);
    setMemoryLiveStatus(null);
    setMemoryDiagnostic(null);
    setMemoryHistoryWarning(null);
    setMemoryFinalizationNotice(null);
    memoryOwnerRef.current = null;
    clearRelayMemoryTurn();
  }, [activeSession]);

  // Phase 3.3 — token / cost tally for the current turn.
  const [turnCost, setTurnCost] = useState<{ tokens: number; costUsd: number } | null>(null);
  const [turnElapsedMs, setTurnElapsedMs] = useState(0);
  const turnStartedAtRef = useRef<number | null>(null);
  // Last agent_run_id that we accumulated into `sessionStats`. We use this
  // to make the per-turn accumulation idempotent: the `orchestration_metrics`
  // frame is the natural "turn done" signal, but a re-stream or
  // re-sent metrics frame must not double-count the same turn's tokens in
  // the session pill. Cleared on session switch.
  const lastAccumulatedRunIdRef = useRef<string | undefined>(undefined);
  const [scopeNotice, setScopeNotice] = useState<{
    paths: string[];
    rootListing: boolean;
    shell: string;
    network: string;
  } | null>(null);
  const [runMetrics, setRunMetrics] = useState<{
    durationMs: number;
    tokens: number;
    tools: number;
    fallbackRetries: number;
    fallbackReason?: string;
    scopeCompliant?: boolean;
    provider?: string;
    model?: string;
    firstVisibleTokenMs?: number;
  } | null>(null);

  // Per-session cumulative rollup for the chat header Session Stats pill.
  // Accumulates the `runMetrics.tokens` from every completed turn in the
  // active session; resets to 0 on session switch (`+ New Chat` or session
  // picker) and on every load. The pill is hidden while `turnCount === 0`
  // (no completed turns yet) so a brand-new session doesn't show "0 tok".
  // The completion check is `turnCount` rather than `tokens > 0` so that
  // an extremely cheap turn that round-trips 0 tokens still surfaces the
  // "1 turn" line in the stats pill.
  const [sessionStats, setSessionStats] = useState<{ tokens: number; turnCount: number }>({ tokens: 0, turnCount: 0 });

  // Loading-state for Session history fetch (Phase 2.3).
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [historyRetry, setHistoryRetry] = useState(0);

  // Scroll-aware autoscroll (Phase 2.5). When the user scrolls up we pause
  // automatic anchoring so the chat isn't yanked away mid-read. A floating
  // "jump to latest" button re-engages the anchor.
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [userPinnedToBottom, setUserPinnedToBottom] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Stable refs for values the stream handlers need without re-subscribing
  // listeners mid-turn (see memory/jarvis-tauri-listen-race.md).
  const activeSessionRef = useRef(activeSession);
  const mountedRef = useRef(true);
  const sessionIdRef = useRef(sessionId);
  const onSessionCreatedRef = useRef(onSessionCreated);
  const streamAbortRef = useRef<AbortController | null>(null);
  const sendGateRef = useRef(new SendGate());
  // 2026-07-13 live incident (session 7254c3ae): a rapid second Enter-press
  // bypassed the React-state `isStreaming` guard because setState is
  // async/batched. The server-side ActiveStreamRegistry then silently
  // superseded the in-flight turn. This ref-backed synchronous guard
  // closes the race on the client side; see SendInFlightGuard.
  const sendInFlightRef = useRef(new SendInFlightGuard());
  const stopRequestedRef = useRef(false);
  // Whether any response text frame has landed this Session turn. Ref-backed
  // so the pure `buildTurnProgress` view-model can distinguish "receiving
  // response text" from unverified stage work without a dedicated state
  // waterfall; reset at send, finalize, error, cancel, and session switch.
  const turnHadResponseTextRef = useRef(false);
  const clearPendingApproval = useCallback(() => {
    pendingApprovalRef.current = null;
    setPendingApproval(null);
    setApprovalError(null);
    setApprovalRetryDecision(null);
  }, []);

  const publishDraftStore = useCallback((nextStore: SessionDraftStore) => {
    if (nextStore === draftStoreRef.current) return;
    draftStoreRef.current = nextStore;
    setDraftStore(nextStore);
  }, []);

  const setInput = useCallback((
    next: string | ((current: string) => string),
    sessionId: string | null = activeSession,
  ) => {
    const currentStore = draftStoreRef.current;
    const currentText = getSessionDraft(currentStore, sessionId).text;
    const nextText = typeof next === 'function' ? next(currentText) : next;
    publishDraftStore(updateSessionDraft(currentStore, sessionId, nextText));
  }, [activeSession, publishDraftStore]);

  const presentApprovalRequest = useCallback((request: ToolApprovalRequest | null | undefined) => {
    if (!request || !request.session_id || !request.call_id || !request.name) return false;
    const key = JSON.stringify([request.session_id, request.call_id]);
    if (seenApprovalKeysRef.current.has(key)) return false;
    seenApprovalKeysRef.current.add(key);
    pendingApprovalRef.current = request;
    setPendingApproval(request);
    setApprovalError(null);
    setApprovalRetryDecision(null);
    setApprovalPending(approvalInFlightRef.current !== null);
    return true;
  }, []);

  useLayoutEffect(() => { activeSessionRef.current = activeSession; }, [activeSession]);
  useEffect(() => {
    if (!isStreaming || turnStartedAtRef.current === null) return;
    const tick = () => setTurnElapsedMs(Date.now() - (turnStartedAtRef.current ?? Date.now()));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [isStreaming]);
  useLayoutEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { onSessionCreatedRef.current = onSessionCreated; }, [onSessionCreated]);
  useEffect(() => { onRunRecordSettledRef.current = onRunRecordSettled; }, [onRunRecordSettled]);

  // ── Durable run record ────────────────────────────────────────────
  // A terminal frame is the UI's observation, not a durable record. The
  // record only exists once Native's read-back reports this `run_id` for this
  // Session, so every state below is derived from the write plus that
  // read-back (`decideRunRecord`) and is published to the owner so the
  // Session list can mark an unconfirmed run.
  const [runRecord, setRunRecord] = useState<RunRecordState | null>(null);
  const runRecordRef = useRef<RunRecordState | null>(null);
  const runRecordPayload = useRef<RunRecordPayload | null>(null);
  const runRecordToken = useRef(0);
  const onRunRecordSettledRef = useRef(onRunRecordSettled);

  const publishRunRecord = useCallback((next: RunRecordState | null) => {
    runRecordRef.current = next;
    if (mountedRef.current) setRunRecord(next);
    onRunRecordSettledRef.current?.(next);
  }, []);

  const confirmRunRecord = useCallback(async (payload: RunRecordPayload, options?: { readOnly?: boolean }) => {
    const token = ++runRecordToken.current;
    runRecordPayload.current = payload;
    const intent: RunRecordIntent = {
      sessionId: payload.sessionId,
      runId: payload.runId,
      outcome: payload.outcome,
    };
    publishRunRecord({ intent, phase: 'writing' });
    // A read-only retry is for a write Native already accepted: it re-reads
    // instead of writing again, so settling an unreadable record can never
    // overwrite the stored row.
    const write = options?.readOnly
      ? ({ ok: true } as SessionRunWrite)
      : await recordTerminalRun(payload);
    if (token !== runRecordToken.current || !mountedRef.current) return;
    if (write.ok) publishRunRecord({ intent, phase: 'confirming' });
    // A rejected write is never confirmed by a read: it is reported as-is.
    const read = write.ok
      ? await readSessionRunsFor(payload.sessionId)
      : ({ ok: false } as SessionRunRead);
    if (token !== runRecordToken.current || !mountedRef.current) return;
    const verdict = decideRunRecord(intent, write, read);
    publishRunRecord({ intent, ...verdict });
    if (verdict.phase === 'confirmed') {
      // The terminal frame landed before this write, so the list reload that
      // `finalizeAssistantMessage` triggered can have read the table too
      // early. Re-read it so the row shows the run Native actually stored.
      onSessionCreatedRef.current();
    }
  }, [publishRunRecord]);

  const retryRunRecord = useCallback(() => {
    const payload = runRecordPayload.current;
    if (!payload) return;
    const readOnly = runRecordView(runRecordRef.current)?.phase === 'unreadable';
    void confirmRunRecord(payload, { readOnly });
  }, [confirmRunRecord]);

  // A new turn invalidates the previous turn's confirmation, and with it any
  // read-back still in flight for that turn.
  const clearRunRecord = useCallback(() => {
    runRecordToken.current += 1;
    publishRunRecord(null);
  }, [publishRunRecord]);

  const matchesStreamSession = useCallback((sid: string | undefined) => {
    if (!mountedRef.current) return false;
    const current = activeSessionRef.current;
    if (current === null) return sid === undefined || sid === '';
    if (!sid) return false;
    return sid === current;
  }, []);

  // M6 — coalesce token deltas into one setMessages per animation frame so
  // high-frequency SSE token events don't thrash React with N re-renders
  // per second. Buffer into a ref; rAF (or immediate sync flush on finalize
  // / error / cancel / session switch) applies the concatenated chunk.
  const pendingTokenRef = useRef('');
  const tokenRafRef = useRef<number | null>(null);

  const cancelTokenRaf = useCallback(() => {
    if (tokenRafRef.current !== null) {
      cancelAnimationFrame(tokenRafRef.current);
      tokenRafRef.current = null;
    }
  }, []);

  /** Drain the token buffer; cancel any scheduled rAF. Returns the text. */
  const takePendingTokens = useCallback(() => {
    cancelTokenRaf();
    const text = pendingTokenRef.current;
    pendingTokenRef.current = '';
    return text;
  }, [cancelTokenRaf]);

  /** Append a text chunk onto the streaming assistant bubble (pure). */
  const applyTokenChunk = useCallback((prev: JarvisMessage[], text: string): JarvisMessage[] => {
    if (!text) return prev;
    const last = prev[prev.length - 1];
    if (last && last.role === 'assistant' && last.isStreaming) {
      return [...prev.slice(0, -1), { ...last, content: last.content + text }];
    }
    return [...prev, { role: 'assistant', content: text, isStreaming: true }];
  }, []);

  /** Apply any buffered tokens into messages state (rAF path). */
  const flushPendingTokens = useCallback(() => {
    tokenRafRef.current = null;
    if (!mountedRef.current) {
      pendingTokenRef.current = '';
      return;
    }
    const text = pendingTokenRef.current;
    if (!text) return;
    pendingTokenRef.current = '';
     setError(null);
     setPipelineStage('');
     dispatchActivity({ kind: 'live_stage', stage: '' });
     turnHadResponseTextRef.current = true;
    setMessages(prev => applyTokenChunk(prev, text));
  }, [applyTokenChunk, dispatchActivity]);

  /** Drop buffered tokens + cancel rAF (session wipe / new chat). */
  const discardPendingTokens = useCallback(() => {
    cancelTokenRaf();
    pendingTokenRef.current = '';
  }, [cancelTokenRaf]);

  const appendAssistantText = useCallback((text: string) => {
    if (!mountedRef.current || !text) return;
    pendingTokenRef.current += text;
    if (tokenRafRef.current !== null) return;
    tokenRafRef.current = requestAnimationFrame(() => {
      flushPendingTokens();
    });
  }, [flushPendingTokens]);

  const finalizeAssistantMessage = useCallback((sid?: string, terminal?: DecodedStreamTerminal) => {
    if (!mountedRef.current) return;
    // Drain rAF buffer inside the same setMessages as finalize so React
    // batching cannot drop the last ~16ms of streamed text.
    const pending = takePendingTokens();
    setIsStreaming(false);
    setPipelineStage('');
    setRecursionDepth(null);
    clearPendingApproval();
    setUserPinnedToBottom(true);
    turnHadResponseTextRef.current = false;
    const effectiveSid = sid || activeSessionRef.current || sessionIdRef.current;
    setMessages(prev => {
      const withTokens = applyTokenChunk(prev, pending);
      const last = withTokens[withTokens.length - 1];
      const messageOutcome: StreamTerminalOutcome | undefined = terminal
        && terminal.outcome !== 'success'
        && terminal.outcome !== 'cancelled'
        ? terminal.outcome
        : undefined;
      const finalizedMessages = finalizeStreamingMessages(withTokens, messageOutcome, terminal?.code);
      const finalized = finalizedMessages[finalizedMessages.length - 1];
      if (last?.role === 'assistant' && last.isStreaming) {
        const shouldPersist = !terminal || terminal.outcome === 'success';
        if (shouldPersist && effectiveSid && finalized?.role === 'assistant' && finalized.content.trim()) {
          invoke('append_message', {
            ...sessionInvokeArgs(effectiveSid),
            role: 'assistant',
            content: finalized.content,
          }).catch((e: any) => { console.error('Failed to persist assistant message:', e); setError('Append failed: ' + (e?.message || String(e))); });
        }
        return finalizedMessages;
      }
      return withTokens;
    });
    onSessionCreatedRef.current();
  }, [applyTokenChunk, clearPendingApproval, takePendingTokens]);

  // Reduced-motion respect — we use it to disable token fade-in / shimmer.
  const prefersReducedMotion = useRef(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    prefersReducedMotion.current = mq.matches;
    const handler = (e: MediaQueryListEvent) => { prefersReducedMotion.current = e.matches; };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Scroll-position watcher. We declare "pinned" as: at most 80px above the
  // bottom. Anything further up means the user is reading — pause autoscroll.
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setUserPinnedToBottom(distanceFromBottom < 80);
  }, []);

  const scrollToBottom = useCallback((behavior: 'smooth' | 'auto' = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  // Throttled scroll during streaming: tokens arrive at 20-50 Hz, but
  // smooth-scrolling on every character feels laggy and costs layout work.
  // 100ms ≈ 10 fps — smooth enough to follow the cursor, cheap enough to not
  // thrash the main thread.
  useEffect(() => {
    if (!isStreaming || !userPinnedToBottom) return;
    const t = setTimeout(() => scrollToBottom('smooth'), 100);
    return () => clearTimeout(t);
  }, [messages, isStreaming, userPinnedToBottom, scrollToBottom]);

  // Non-streaming reflow: snap immediately when messages change (history load).
  useEffect(() => {
    if (isStreaming) return;
    if (userPinnedToBottom) scrollToBottom('auto');
  }, [messages, isStreaming, userPinnedToBottom, scrollToBottom]);

  // Phase 2.3 — load session history from SQLite when the user switches to a
  // different session. Without this the user sees an empty chat for a session
  // that has prior messages. Was the #1 audit bug.
  const prevActiveSessionRef = useRef<string | null>(activeSession);
  // When handleSend creates a session for the very first message, it sets this
  // to the new id and optimistically renders the user + streaming-assistant
  // messages. The history-load effect below would otherwise immediately fetch
  // the (still-empty) history and overwrite them — the "my message vanished"
  // bug. We skip the load exactly once for that freshly-created session.
  const suppressHistoryLoadRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevActiveSessionRef.current;
    setHistoryError(false);
    if (suppressHistoryLoadRef.current && suppressHistoryLoadRef.current === activeSession) {
      // Freshly created by handleSend: preserve its optimistic turn and make
      // this Session the new comparison baseline without invalidating the send.
      prevActiveSessionRef.current = activeSession;
      suppressHistoryLoadRef.current = null;
      sessionScroll.save(activeSession || '', { offset: scrollContainerRef.current?.scrollTop ?? 0, pinnedToBottom: userPinnedToBottom });
      setLoadingHistory(false);
      return;
    }
    prevActiveSessionRef.current = activeSession;
    if (prev !== activeSession) {
      seenApprovalKeysRef.current.clear();
      if (prev) invoke('cancel_chat_stream', sessionInvokeArgs(prev)).catch(() => {});
      streamAbortRef.current?.abort('Session switched');
      streamAbortRef.current = null;
      sendGateRef.current.invalidate();
      stopRequestedRef.current = false;
      discardPendingTokens();
      setMessages([]);
      setIsStreaming(false);
      setPipelineStage('');
      setRecursionDepth(null);
      setReasoningText('');
      setShowReasoning(false);
      setAgentSteps([]);
      setShowAgents(true);
      setToolCalls([]);
      resetActivityLedger();
      setTurnCost(null);
      setScopeNotice(null);
      setRunMetrics(null);
      setTurnElapsedMs(0);
      turnStartedAtRef.current = null;
      clearPendingApproval();
      setApprovalError(null);
      setError(null);
      turnHadResponseTextRef.current = false;
      // Reset the per-session rollup so the Session Stats pill starts
      // empty for the new session. The accumulation-ref is cleared in
      // lockstep so a re-sent metrics frame from a previous stream
      // can't bridge the gap.
      setSessionStats({ tokens: 0, turnCount: 0 });
      lastAccumulatedRunIdRef.current = undefined;
    }
    if (!activeSession) {
      setLoadingHistory(false);
      discardPendingTokens();
      setMessages([]);
      setSessionId('');
      setToolCalls([]);
      resetActivityLedger();
      setTurnCost(null);
      setScopeNotice(null);
      setRunMetrics(null);
      setTurnElapsedMs(0);
      turnStartedAtRef.current = null;
      setError(null);
      setPipelineStage('');
      setReasoningText('');
      setAgentSteps([]);
      setIsStreaming(false);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    invoke<SessionHistoryMessage[]>('get_session_history', sessionInvokeArgs(activeSession))
      .then((rows) => {
        if (cancelled) return;
        // Map the DB row id into JarvisMessage.id (Task 7 / incident 1d4727cf)
        // so a message that was already shown optimistically — and is now
        // reappearing via this history reload — carries the same identity
        // and can be deduped instead of rendering as a second bubble.
        setMessages(dedupeMessages(rows.map(r => ({
          id: r.id,
          role: (r.role === 'user' || r.role === 'assistant' || r.role === 'tool' || r.role === 'system') ? r.role : 'assistant',
          content: r.content,
          timestamp: r.created_at,
        }))));
        // Restore scroll offset for this session on reload (Jarvis scroll-state).
        const saved = sessionScroll.load(activeSession || '');
        if (saved && scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = saved.offset;
          setUserPinnedToBottom(saved.pinnedToBottom);
        }
        // Jump to the bottom without animation on initial history load.
        requestAnimationFrame(() => {
          if (!cancelled) {
            setUserPinnedToBottom(true);
            scrollToBottom('auto');
          }
        });
      })
      .catch(() => {
        if (!cancelled) setHistoryError(true);
      })
      .finally(() => {
        if (!cancelled) {
          sessionScroll.save(activeSession || '', { offset: scrollContainerRef.current?.scrollTop ?? 0, pinnedToBottom: userPinnedToBottom });
          setLoadingHistory(false);
        }
      });
    return () => { cancelled = true; };
  }, [activeSession, clearPendingApproval, historyRetry, scrollToBottom, discardPendingTokens]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sendGateRef.current.invalidate();
      sendInFlightRef.current.finish();
      const controller = streamAbortRef.current;
      streamAbortRef.current = null;
      controller?.abort('Passive view teardown');
      discardPendingTokens();
    };
  }, [discardPendingTokens]);

  // Register jarvis:// listeners once on mount. Async listen() + deps that
  // change during streaming causes a re-subscribe storm (jarvis-tauri-listen-race).
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let disposed = false;
    const track = (p: Promise<() => void>) => {
      p.then((f) => {
        if (disposed) f();
        else unsubs.push(f);
      });
    };

    track(listen<{ text: string; session_id: string }>('jarvis://token', (event) => {
      const { text, session_id } = event.payload;
      if (!text || !matchesStreamSession(session_id)) return;
      appendAssistantText(text);
    }));

    // A relay terminal event that carries a `turn_id` is memory-correlated and
    // must match the exact registered relay submission; otherwise a late
    // done/error from an old relay turn could finalize a newer direct turn.
    // Legacy events without a `turn_id` are accepted only while no direct
    // submission and no registered relay turn owns the Session. The
    // synchronous `sendInFlightRef` guard is required too, because `handleSend`
    // acquires it before awaiting initial Session creation (when
    // `streamAbortRef` is still null and no Session is selected yet), so a
    // legacy event could otherwise mutate a pending direct submission; idle
    // legacy behavior is preserved.
    const relayTerminalIsCorrelated = (sessionId: unknown, turnId: unknown): boolean => {
      if (turnId === undefined || turnId === null) {
        return activeRelayMemoryTurn() === null
          && streamAbortRef.current === null
          && !sendInFlightRef.current.isInFlight();
      }
      return isRegisteredRelayMemoryTurn(sessionId, turnId);
    };

    track(listen<{ session_id: string; turn_id?: string }>('jarvis://done', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      if (!relayTerminalIsCorrelated(event.payload.session_id, event.payload.turn_id)) return;
      dispatchActivity({ kind: 'terminal', outcome: 'success' });
      finalizeAssistantMessage(event.payload.session_id);
    }));

    // NOTE (Task 7 / 2026-07-03 incident 1d4727cf): this `jarvis_send_message`
    // / `jarvis://*` Tauri-event path is wired but not currently invoked by
    // the chat UI — `handleSend` uses the direct-fetch `streamFromJarvisApi`
    // path below instead, which has the primary error/cancelled handling.
    // Hardened here too for defense-in-depth in case something re-enables
    // this path. The Rust `SseFrameOutcome::Error` variant only carries a
    // message string, not a `code` (unlike the fetch path's raw JSON
    // frames) — reported as a gap below rather than changing Rust.
    track(listen<{ error: string; session_id: string; code?: string; turn_id?: string }>('jarvis://error', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      if (!relayTerminalIsCorrelated(event.payload.session_id, event.payload.turn_id)) return;
      const pending = takePendingTokens();
      setIsStreaming(false);
      setPipelineStage('');
      dispatchActivity({ kind: 'terminal', outcome: 'failed' });
      setRecursionDepth(null);
      clearPendingApproval();
      setError(event.payload.error);
      setUserPinnedToBottom(true);
      setMessages(prev => {
        const withTokens = applyTokenChunk(prev, pending);
        const last = withTokens[withTokens.length - 1];
        if (last && last.isStreaming) {
          // If nothing streamed before the error (e.g. a turn-fatal auth
          // failure), turn the bubble into a designed error bubble showing
          // the message text (instead of silently dropping it, which left
          // the user with only their own message + the easy-to-miss banner).
          const partial = last.content.trim();
          return [...withTokens.slice(0, -1), {
            ...last,
            content: partial ? last.content : event.payload.error,
            isStreaming: false,
            isError: true,
            errorCode: event.payload.code,
          }];
        }
        return withTokens;
      });
    }));

    // Rust's SseRelay maps a `cancelled` SSE frame straight to `jarvis://done`
    // (see runner.rs `SseFrameOutcome::Cancelled`) — there is no distinct
    // `jarvis://cancelled` Tauri event today, so this listener is a no-op
    // registration for forward-compatibility / documentation of the gap
    // rather than dead code masking a real handler. If a future Rust change
    // adds a genuine `jarvis://cancelled` emit, this starts working without
    // further UI changes.
    track(listen<{ session_id: string; turn_id?: string }>('jarvis://cancelled', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      if (!relayTerminalIsCorrelated(event.payload.session_id, event.payload.turn_id)) return;
      const pending = takePendingTokens();
      setIsStreaming(false);
      setPipelineStage('');
      dispatchActivity({ kind: 'terminal', outcome: 'cancelled' });
      setRecursionDepth(null);
      setError(null);
      setMessages(prev => {
        const withTokens = applyTokenChunk(prev, pending);
        const last = withTokens[withTokens.length - 1];
        if (last?.role === 'assistant' && last.isStreaming) {
          const content = sanitizeAssistantDisplay(last.content);
          if (!content) return withTokens.slice(0, -1);
          return [...withTokens.slice(0, -1), { ...last, content, isStreaming: false, isCancelled: true }];
        }
        return withTokens;
      });
    }));

    track(listen<{ stage: string; status: string; agent: string; session_id?: string }>('jarvis://stage', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const { stage, status } = event.payload;
      setPipelineStage(isTerminalStageStatus(status) ? '' : stage);
      setAgentSteps(prev => appendAgentProgress(prev, {
        stage,
        text: isTerminalStageStatus(status) ? status : 'started',
        source: 'stage',
      }));
      dispatchActivity({ kind: 'stage', stage, status });
    }));

    track(listen<{ depth: number; status: string; reenter_stage?: string; critique?: string; session_id?: string }>('jarvis://recursion', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const { depth, status } = event.payload;
      // Show depth only while an active recursive critique cycle is running
      setRecursionDepth(status === 'done' || status === 'max_depth' ? null : depth);
    }));

    track(listen<{ text: string; session_id?: string }>('jarvis://reasoning', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      setReasoningText(prev => prev + event.payload.text);
    }));

    track(listen<{ trace: unknown; session_id?: string }>('jarvis://reasoning_complete', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const trace = event.payload.trace as { steps?: Array<{ content?: string }> } | null;
      if (trace?.steps?.length) {
        const joined = trace.steps.map((s) => s.content ?? '').filter(Boolean).join('\n');
        if (joined) setReasoningText(joined);
      }
      setShowReasoning(true);
    }));

    track(listen<{ stage: string; text: string; session_id?: string }>('jarvis://agent_activity', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const { stage, text } = event.payload;
      if (stage === 'coordinator') {
        setPipelineStage('coordinator');
        dispatchActivity({ kind: 'live_stage', stage });
        return;
      }
      const filtered = appendAgentProgress([], { stage, text, source: 'activity' });
      const step = filtered[0];
      if (step) dispatchActivity({ kind: 'agent_activity', stage: step.stage, text: step.text });
      setAgentSteps(prev => appendAgentProgress(prev, { stage, text, source: 'activity' }));
    }));

    track(listen<{
      call_id: string;
      name: string;
      arguments: unknown;
      session_id: string;
    }>('jarvis://approval_request', (event) => {
      const p = event.payload;
      if (!matchesStreamSession(p.session_id)) return;
      presentApprovalRequest({
        call_id: p.call_id,
        name: p.name,
        arguments: p.arguments,
        session_id: p.session_id,
      });
    }));

    track(listen<{ call_id?: string; name: string; arguments: unknown; session_id?: string }>('jarvis://tool_call', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const call = {
        call_id: event.payload.call_id,
        name: event.payload.name,
        arguments: event.payload.arguments,
      };
      setToolCalls(prev => [...prev, call]);
      dispatchActivity({ kind: 'tool_use', callId: call.call_id, name: call.name, arguments: call.arguments });
    }));

    track(listen<{
      call_id: string;
      name: string;
      output: string;
      is_error: boolean;
      session_id?: string;
    }>('jarvis://tool_result', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const { call_id, name, output, is_error } = event.payload;
      setToolCalls(prev => mergeToolResult(prev, {
        callId: call_id,
        name,
        output,
        isError: is_error,
      }));
      dispatchActivity({
        kind: 'tool_result',
        callId: call_id,
        name,
        output,
        isError: is_error,
      });
    }));

    track(listen<{ tokens: number; cost_usd: number; session_id?: string }>('jarvis://cost', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      setTurnCost({ tokens: event.payload.tokens, costUsd: event.payload.cost_usd });
    }));

    // Phase 2.4 — relay memory metadata. Accepted ONLY for the exact
    // `{session_id, turn_id}` registered by the owning submission before it
    // invoked the relay (see `relay-memory-correlation`). Events cannot
    // establish their own identity, so a delayed older relay event can never
    // bind or overwrite a newer turn. Metadata only; durable counts come from
    // the native diagnostic projection. Typed warning codes are surfaced
    // visibly and persist until the next submission/Session change.
    const applyRelayWarning = (code: unknown): void => {
      if (code === 'history_unavailable') {
        setMemoryHistoryWarning('Relay memory history unavailable for this turn.');
      } else if (code === 'memory_finalization_failed') {
        setMemoryFinalizationNotice('Relay memory finalization failed; showing the ordinary result.');
      } else if (code === 'memory_finalization_pending') {
        setMemoryFinalizationNotice('Relay memory finalization is pending; showing the ordinary result.');
      }
    };
    // Bind the owning relay submission. On a different owner, drop the previous
    // turn's warning/diagnostic so nothing stale survives a submission change.
    const bindRelayMemoryOwner = (sid: string, turnId: string): void => {
      const owner = memoryOwnerRef.current;
      if (owner && owner.sessionId === sid && owner.turnId === turnId) return;
      setMemoryDiagnostic(null);
      setMemoryHistoryWarning(null);
      setMemoryFinalizationNotice(null);
      memoryOwnerRef.current = { sessionId: sid, turnId };
    };
    track(listen<{
      session_id?: string;
      turn_id?: string;
      status?: unknown;
      selected_ids?: unknown;
      store_revision?: unknown;
      code?: unknown;
    }>('jarvis://memory-status', (event) => {
      const p = event.payload;
      if (!matchesStreamSession(p.session_id)) return;
      if (!isRegisteredRelayMemoryTurn(p.session_id, p.turn_id)) return;
      bindRelayMemoryOwner(p.session_id as string, p.turn_id as string);
      applyRelayWarning(p.code);
      const decoded = decodeMemoryStatusFrame(p);
      if (decoded) setMemoryLiveStatus(decoded.status);
    }));
    track(listen<Record<string, unknown> & { session_id?: string; turn_id?: string }>(
      'jarvis://memory-diagnostic',
      (event) => {
        const p = event.payload;
        if (!matchesStreamSession(p.session_id)) return;
        if (!isRegisteredRelayMemoryTurn(p.session_id, p.turn_id)) return;
        bindRelayMemoryOwner(p.session_id as string, p.turn_id as string);
        try {
          const view = decodeMemoryTurnDiagnostic(p);
          if (view.turnId === p.turn_id && view.sessionId === p.session_id) {
            setMemoryDiagnostic(view);
          }
        } catch (e) {
          console.warn('[Jarvis] relay memory diagnostic was malformed:', e);
        }
      },
    ));

    return () => {
      disposed = true;
      unsubs.forEach((f) => f());
    };
  }, [appendAssistantText, applyTokenChunk, clearPendingApproval, confirmRunRecord, dispatchActivity, finalizeAssistantMessage, matchesStreamSession, presentApprovalRequest, takePendingTokens]);

  // True autosize composer (Phase 2.4). The previous rows=⟨line-count⟩ approach
  // overflowed for single-line wrapped text.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [input]);

  // Autofocus + focus-after-send + focus-after-session-switch.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!pendingApprovalRef.current) inputRef.current?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [activeSession]);

  const streamFromJarvisApi = useCallback(async (
    sid: string,
    userMsg: string,
    sendGeneration: number,
    onAccepted: () => void,
    clientMessageId: string,
    includeUserScope: boolean,
  ) => {
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    const requestIsCurrent = () => (
      mountedRef.current
      && sendGateRef.current.isCurrent(sendGeneration)
      && matchesStreamSession(sid)
      && streamAbortRef.current === controller
    );

    // Submission guard: Session/generation/controller ownership PLUS an
    // explicit abort/Stop. Used after each awaited setup operation and before
    // starting inference, so a Stop during append/prepare/history cannot race
    // `/chat/cancel` and then still launch a fetch. The display guard
    // (`requestIsCurrent`) is intentionally separate so a legitimate
    // cancellation terminal can still render for the current turn.
    const submissionAlive = () => (
      requestIsCurrent() && !controller.signal.aborted && !stopRequestedRef.current
    );
    const stopIfStale = () => {
      if (submissionAlive()) return;
      if (!controller.signal.aborted) controller.abort('Stale Session turn');
      throw new DOMException('Stale Session turn', 'AbortError');
    };

    // One stable turn identity for this submitted turn, held across every
    // frame and the terminal native sync. It is distinct from the opaque
    // native preparation id returned by `memory_prepare_turn`.
    const turnId = crypto.randomUUID();
    setMemoryLiveStatus(null);
    setMemoryDiagnostic(null);
    setMemoryHistoryWarning(null);
    setMemoryFinalizationNotice(null);

    let userMessageId: string | null = null;
    let inactivityTimedOut = false;
    let terminal: DecodedStreamTerminal | null = null;

    // One memoized, bounded, ID-only native finalization per local turn. It is
    // attempted on every exit path (success, error, cancellation, EOF and
    // stale-Session teardown), even after a Session switch/abort, but it never
    // repaints a stale Session. The exact `{session_id, turn_id}` tuple is
    // captured and late completion after the deadline is ignored. The native
    // diagnostic read-back is the sole authority for persisted selected/applied
    // metadata; a timeout or failure surfaces a truthful notice and never
    // manufactures receipt or terminal evidence.
    let finalizePromise: Promise<boolean> | null = null;
    const finalizeMemoryTurn = (): Promise<boolean> => {
      if (finalizePromise) return finalizePromise;
      finalizePromise = (async (): Promise<boolean> => {
        if (!userMessageId) return true;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
          timeoutHandle = setTimeout(() => resolve({ kind: 'timeout' }), MEMORY_FINALIZE_TIMEOUT_MS);
        });
        // `memory_sync_turn` already returns the authenticated native
        // `MemoryTurnDiagnostic`; the whole sync+decode lives inside this one
        // bounded race, so there is no second unbounded await. A late resolve
        // after the timeout can never reach the decode/repaint path.
        const sync = invoke<unknown>('memory_sync_turn', {
          request: { session_id: sid, turn_id: turnId },
        }).then(
          (diagnostic) => ({ kind: 'ok' as const, diagnostic }),
          () => ({ kind: 'failed' as const, diagnostic: null }),
        );
        const outcome = await Promise.race([sync, timeout]);
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        if (outcome.kind === 'timeout') {
          if (requestIsCurrent()) {
            setMemoryFinalizationNotice('Memory finalization is pending; showing the ordinary result.');
          }
          return false;
        }
        if (outcome.kind === 'failed') {
          if (requestIsCurrent()) {
            setMemoryFinalizationNotice('Memory sync unavailable; showing the ordinary result.');
          }
          return false;
        }
        // Success: decode the already-returned authenticated diagnostic. A
        // tuple mismatch is an observable failure rather than a stale repaint.
        try {
          const view = decodeMemoryTurnDiagnostic(outcome.diagnostic);
          if (!requestIsCurrent()) return true;
          if (view.turnId !== turnId || view.sessionId !== sid) {
            setMemoryFinalizationNotice('Memory status did not match this turn.');
            return false;
          }
          setMemoryDiagnostic(view);
        } catch (e) {
          console.warn('[Jarvis] memory diagnostic read-back failed:', e);
          if (requestIsCurrent()) {
            setMemoryFinalizationNotice('Memory status unavailable for this turn.');
          }
          return false;
        }
        return true;
      })();
      return finalizePromise;
    };

    // ── Persisted-turn lifecycle ──────────────────────────────────────────
    // A saved source row is a precondition for any inference. The complete
    // append→prepare→history→fetch→read lifecycle is wrapped so a saved turn is
    // finalized exactly once even on setup/HTTP/body/EOF/abort failure.
    try {
      // 1. Persist the user row FIRST. Native preparation must reference the
      // exact persisted row id, never the optimistic UI id. `append_message`
      // returns the DB row id (sessions.rs `insert_message_row`); swapping the
      // client-generated id for it lets a later history-reload dedupe this as
      // the SAME message instance (2026-07-03 incident 1d4727cf).
      try {
        const dbId = await invoke<string>('append_message', {
          ...sessionInvokeArgs(sid),
          role: 'user',
          content: userMsg,
        });
        if (typeof dbId !== 'string' || !dbId) {
          throw new Error('the server did not return a saved message id');
        }
        userMessageId = dbId;
        if (requestIsCurrent()) {
          setMessages(prev => prev.map((m) => (m.id === clientMessageId ? { ...m, id: dbId } : m)));
        }
      } catch (e: any) {
        stopIfStale();
        console.error('Failed to persist user message:', e);
        // No saved row -> no inference. Throw a truthful persistence failure to
        // the existing draft-recovery path; never claim the optimistic bubble
        // is saved.
        throw new Error('Could not save your message: ' + (e?.message || String(e)));
      }
      stopIfStale();

      // 2. Prepare native recall and load native prompt history. References
      // only; no memory text crosses the webview. A failed preparation still
      // runs ordinary inference with a typed status and no preparation
      // reference. A failed/unreadable history read sends empty prior history
      // with a visible warning rather than a stale UI cache.
      let memoryPreparationId: string | null = null;
      let initialMemoryStatus: MemoryRecallStatus = 'unavailable';
      let history: Array<{ role: string; content: string }> = [];
      try {
        const prepared = decodeMemoryTurnPreparation(await invoke('memory_prepare_turn', {
          request: {
            session_id: sid,
            turn_id: turnId,
            user_message_id: userMessageId,
            include_user_scope: includeUserScope,
          },
        }));
        if (prepared.turn_id !== turnId) {
          throw new Error('memory preparation identity mismatch');
        }
        initialMemoryStatus = prepared.status;
        memoryPreparationId = prepared.preparation_id;
      } catch (e) {
        console.warn('[Jarvis] memory preparation failed:', e);
        initialMemoryStatus = coerceMemoryRecallStatus(e);
        memoryPreparationId = null;
      }
      stopIfStale();
      try {
        const nativeHistory = await invoke<unknown>(
          'memory_turn_history',
          { request: { session_id: sid, user_message_id: userMessageId } },
        );
        const rows = decodeNativeHistoryRows(nativeHistory);
        if (rows) {
          history = rows;
        } else if (requestIsCurrent()) {
          setMemoryHistoryWarning('Memory history was unreadable; sending this turn without prior context.');
        }
      } catch (e) {
        console.warn('[Jarvis] native memory history failed:', e);
        if (requestIsCurrent()) setMemoryHistoryWarning('Memory history unavailable for this turn.');
      }
      stopIfStale();

      const response = await fetch(`${JARVIS_API_URL}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsg,
          session_id: sid,
          history,
          turn_id: turnId,
          memory_status: initialMemoryStatus,
          ...(memoryPreparationId ? { memory_preparation_id: memoryPreparationId } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Jarvis server returned ${response.status}: ${body}`);
      }
      if (!response.body) {
        throw new Error('Jarvis server returned no response stream.');
      }
      stopIfStale();
      onAccepted();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamedVisibleText = false;
    let streamedRawText = '';
    // Task 4.1: mirror the Rust relay's TerminalRunAccumulator (jarvis/
    // runner.rs). This direct-fetch path bypasses that relay, so the UI
    // reports the terminal outcome it observed via the `record_terminal_run`
    // Tauri command once the stream ends — otherwise session_runs stays
    // empty and a force-stopped turn leaves no durable trace.
    const runAcc: {
      runId?: string;
      outcome?: 'success' | 'partial' | 'failed' | 'timed_out' | 'cancelled';
      selectedModel?: string;
      tokenCount: number;
      toolCount: number;
      cancelledReason?: string;
      partialOutput?: string;
    } = { tokenCount: 0, toolCount: 0 };
     let terminalFrame: StreamTerminalFrame = null;
     let activityTerminalDispatched = false;
    const persistTerminalRun = () => {
      if (!requestIsCurrent() || !runAcc.outcome) return;
      // A force-stop can land before the pipeline ever emitted agent_run_id
      // (the incident's exact case) — synthesize an id so the cancellation
      // is still durably recorded. run_id is the idempotency key, so a
      // client-generated id is safe, and a retry re-uses the same one.
      const runId = runAcc.runId ?? `run_client_${crypto.randomUUID()}`;
      void confirmRunRecord({
        sessionId: sid,
        runId,
        outcome: runAcc.outcome,
        selectedModel: runAcc.selectedModel ?? null,
        tokenCount: runAcc.tokenCount,
        toolCount: runAcc.toolCount,
        cancelledReason: runAcc.cancelledReason ?? null,
        partialOutput: runAcc.partialOutput ?? null,
      });
    };
    const acceptTerminal = (next: DecodedStreamTerminal): boolean => {
      const accepted = acceptFirstTerminal(terminal, next);
      if (!accepted || accepted === terminal) return false;
      terminal = accepted;
      terminalFrame = accepted.frame;
      runAcc.outcome = accepted.outcome;
      if (accepted.outcome === 'partial' || accepted.outcome === 'timed_out') {
        runAcc.partialOutput = boundedPartialOutput(accepted.text || streamedRawText);
      }
      return true;
    };
    const reportUnknownFrame = createUnknownFrameReporter();
    const inactivityWatchdog = new InactivityWatchdog(
      STREAM_INACTIVITY_TIMEOUT_MS,
      () => {
        if (terminal) return;
        inactivityTimedOut = true;
        controller.abort('Jarvis stream inactivity timeout');
        reader.cancel('Jarvis stream inactivity timeout').catch(() => {});
      },
    );

    const handleFrame = async (frame: any): Promise<void> => {
      if (!requestIsCurrent()) return;
      if (!frame || typeof frame !== 'object') return;
      // Phase 2.4 — transient memory diagnostics. Never authority: the native
      // diagnostic read-back after terminal sync is. Stale turn/Session frames
      // are ignored so a late completion cannot repaint another turn.
      if (frame.type === 'memory_status') {
        const decoded = decodeMemoryStatusFrame(frame);
        if (!decoded || decoded.turn_id !== turnId) return;
        setMemoryLiveStatus(decoded.status);
        return;
      }
      if (frame.type === 'memory_applied') {
        // Metadata only. Applied IDs shown to the operator come from the
        // native diagnostic, never from an unsigned SSE frame.
        return;
      }
      if (frame.type === 'stream_event' && frame.delta?.text) {
        const text = String(frame.delta.text);
        streamedRawText += text;
        streamedVisibleText = /\S/.test(sanitizeAssistantDisplay(streamedRawText));
        appendAssistantText(text);
        return;
      }
      if (frame.type === 'agent_activity' && frame.text) {
        const stage = String(frame.stage || 'agent');
        if (stage === 'coordinator') {
          setPipelineStage('coordinator');
          dispatchActivity({ kind: 'live_stage', stage });
          return;
        }
        const activityText = String(frame.text);
        const filtered = appendAgentProgress([], { stage, text: activityText, source: 'activity' });
        const step = filtered[0];
        if (step) dispatchActivity({ kind: 'agent_activity', stage: step.stage, text: step.text });
        setAgentSteps(prev => appendAgentProgress(prev, {
          stage,
          text: activityText,
          source: 'activity',
        }));
        return;
      }
      if (frame.type === 'orchestrator_stage') {
        const stage = String(frame.stage || 'agent');
        const terminal = isTerminalStageStatus(frame.status);
        setPipelineStage(terminal ? '' : stage);
        const detail = typeof frame.detail === 'string' ? frame.detail : '';
        const elapsed = Number(frame.elapsed_ms);
        const progressText = detail.startsWith('tool:')
          ? `used ${detail.slice(5)}`
          : terminal
            ? `${String(frame.status)}${Number.isFinite(elapsed) ? ` in ${(elapsed / 1000).toFixed(1)}s` : ''}`
            : 'started';
        setAgentSteps(prev => appendAgentProgress(prev, {
          stage,
          text: progressText,
          source: detail.startsWith('tool:') ? 'tool' : 'stage',
        }));
        dispatchActivity({ kind: 'stage', stage, status: frame.status, detail: frame.detail, elapsedMs: frame.elapsed_ms });
        return;
      }
      if (frame.type === 'orchestrator_recursion') {
        const status = String(frame.status || '');
        setRecursionDepth(status === 'done' || status === 'max_depth' ? null : Number(frame.depth || 0));
        return;
      }
      if (frame.type === 'reasoning_step' || frame.type === 'reasoning_chunk') {
        const text = frame.content ?? frame.text ?? frame.delta?.text ?? frame.step?.content;
        if (text) setReasoningText(prev => prev + String(text));
        return;
      }
      if (frame.type === 'reasoning_complete') {
        setShowReasoning(true);
        return;
      }
      if (frame.type === 'tool_approval_request') {
        const frameSessionId = frame.session_id;
        const callId = frame.call_id;
        const name = frame.name;
        if (typeof frameSessionId !== 'string'
          || frameSessionId !== sid
          || typeof callId !== 'string'
          || !callId.trim()
          || typeof name !== 'string'
          || !name.trim()) return;
        presentApprovalRequest({
          call_id: callId,
          name,
          arguments: frame.arguments,
          session_id: frameSessionId,
        });
        return;
      }
      if (frame.type === 'tool_use') {
        runAcc.toolCount += 1;
        const call = {
          call_id: frame.id || frame.call_id,
          name: frame.name || frame.tool_name || 'unknown',
          arguments: frame.arguments ?? frame.input ?? null,
        };
        setToolCalls(prev => [...prev, call]);
        dispatchActivity({ kind: 'tool_use', callId: call.call_id, name: call.name, arguments: call.arguments });
        return;
      }
      if (frame.type === 'tool_result') {
        const callId = frame.call_id;
        const name = frame.name || 'tool';
        const output = String(frame.output ?? frame.result ?? '');
        const isError = Boolean(frame.is_error || frame.status === 'error');
        const contextTruncation = readToolResultTruncation(frame);
        setToolCalls(prev => mergeToolResult(prev, {
          callId,
          name,
          output,
          isError,
          contextTruncation: contextTruncation ?? undefined,
        }));
        dispatchActivity({
          kind: 'tool_result',
          callId,
          name,
          output,
          isError,
          contextTruncation: contextTruncation ?? undefined,
        });
        return;
      }
      if (frame.type === 'conductor_directive') {
        const decoded = decodeConductorDirectiveFrame(frame, sid);
        if (decoded.kind === 'ignored') return;
        if (decoded.kind === 'valid') {
          dispatchActivity({ kind: 'directive', key: decoded.key, directive: decoded.directive, stage: decoded.directive.stage });
        } else {
          dispatchActivity({ kind: 'diagnostic', text: decoded.message });
        }
        return;
      }
      if (frame.type === 'cost_info') {
        runAcc.selectedModel = typeof frame.model === 'string' ? frame.model : runAcc.selectedModel;
        runAcc.tokenCount = Number(frame.total_tokens ?? frame.tokens ?? 0) || runAcc.tokenCount;
        setTurnCost({
          tokens: Number(frame.total_tokens ?? frame.tokens ?? 0),
          costUsd: Number(frame.cost_usd ?? 0),
        });
        return;
      }
      if (frame.type === 'scope_notice') {
        setScopeNotice({
          paths: Array.isArray(frame.allowed_paths) ? frame.allowed_paths.map(String) : [],
          rootListing: Boolean(frame.allow_root_listing),
          shell: String(frame.shell || 'unchanged'),
          network: String(frame.network || 'unchanged'),
        });
        return;
      }
      if (frame.type === 'orchestration_metrics') {
        const durationMs = Math.max(0, Number(frame.duration_ms ?? 0));
        const tokens = Math.max(0, Number(frame.tokens_total ?? 0));
        const tools = Math.max(0, Number(frame.tool_calls ?? 0));
        runAcc.tokenCount = tokens || runAcc.tokenCount;
        runAcc.toolCount = tools || runAcc.toolCount;
        setTurnElapsedMs(durationMs);
        setRunMetrics({
          durationMs,
          tokens,
          tools,
          fallbackRetries: Math.max(0, Number(frame.fallback_retries ?? 0)),
          fallbackReason: typeof frame.fallback_reason === 'string' ? frame.fallback_reason : undefined,
          scopeCompliant: typeof frame.scope_compliant === 'boolean' ? frame.scope_compliant : undefined,
          provider: typeof frame.actual_provider === 'string' ? frame.actual_provider : undefined,
          model: typeof frame.actual_model === 'string' ? frame.actual_model : undefined,
          firstVisibleTokenMs: Number.isFinite(Number(frame.first_visible_token_ms))
            ? Math.max(0, Number(frame.first_visible_token_ms))
            : undefined,
        });
        // Per-session cumulative rollup: accumulate this turn's tokens onto
        // the session total, but only the first time we see this runId. The
        // server emits the metrics frame once per turn, but a re-stream or a
        // downstream re-send would otherwise double-count the same turn.
        // The `runAcc.runId` is set by the `agent_run_id` frame earlier in
        // the same stream — if it never arrived, we silently skip (the pill
        // will only count turns that had a complete run identity, which
        // matches what gets durably recorded via `record_terminal_run`).
        if (runAcc.runId && runAcc.runId !== lastAccumulatedRunIdRef.current) {
          lastAccumulatedRunIdRef.current = runAcc.runId;
          setSessionStats(prev => ({ tokens: prev.tokens + tokens, turnCount: prev.turnCount + 1 }));
        }
        if (Array.isArray(frame.executed_tools)) {
          const ledgerCalls: ToolCallState[] = frame.executed_tools.map((value: unknown, index: number) => {
            const entry = value && typeof value === 'object' ? value as Record<string, unknown> : {};
            const ok = entry.ok !== false;
            return {
              call_id: `ledger-${index}`,
              name: String(entry.name || 'tool'),
              arguments: typeof entry.path === 'string' ? { path: entry.path } : {},
              result: ok ? 'Succeeded · recorded in executed-tool ledger' : `Failed · ${String(entry.error_code || 'tool error')}`,
              is_error: !ok,
              matched: true,
            };
          });
          setToolCalls(prev => prev.length > 0 ? prev : ledgerCalls);
        }
        if (tokens > 0) setTurnCost(prev => ({ tokens, costUsd: prev?.costUsd ?? 0 }));
        return;
      }
      if (frame.type === 'fallback_notice') {
        const fallbackStage = formatFallbackProgress(frame);
        setPipelineStage(fallbackStage);
        dispatchActivity({ kind: 'live_stage', stage: fallbackStage });
        return;
      }
      // Task 4.1: agent_run_id is otherwise passive but carries the durable
      // run identity — capture before the passive filter swallows it.
      if (frame.type === 'agent_run_id' && typeof frame.agent_run_id === 'string') {
        runAcc.runId = frame.agent_run_id;
        return;
      }
      if (isPassiveSseFrame(frame.type)) return;
      if (frame.type === 'result') {
        const decision = decodeResultFrame(frame);
        // Phase 2.4 — finalize the native turn before any local terminal
        // publication (activity, outcome, run-record write). Re-check current
        // ownership after the await so a Session switch during the bounded wait
        // cannot repaint another Session.
        await finalizeMemoryTurn();
        if (!requestIsCurrent()) return;
        if (!acceptTerminal(decision)) return;
        dispatchActivity({ kind: 'terminal', outcome: decision.outcome });
        activityTerminalDispatched = true;
        if (decision.hardError) {
          const message = decision.text || String(frame.error || 'Jarvis returned a non-success result.');
          throw new JarvisStreamError(message, decision.code);
        }
        if (!streamedVisibleText && decision.text) appendAssistantText(decision.text);
        return;
      }
      if (frame.type === 'error') {
        const code = typeof frame.code === 'string' ? frame.code : undefined;
        const decision: DecodedStreamTerminal = {
          frame: 'error',
          outcome: code && STREAM_TIMEOUT_CODES.has(code) ? 'timed_out' : 'failed',
          code,
          text: '',
          hardError: true,
        };
        await finalizeMemoryTurn();
        if (!requestIsCurrent()) return;
        if (!acceptTerminal(decision)) return;
        dispatchActivity({ kind: 'terminal', outcome: decision.outcome });
        activityTerminalDispatched = true;
        if (code) {
          // eslint-disable-next-line no-console
          console.warn(`[Jarvis] stream error code=${code}: ${frame.error}`);
        }
        throw new JarvisStreamError(String(frame.error || 'Jarvis stream failed.'), code);
      }
      if (frame.type === 'cancelled') {
        const decision: DecodedStreamTerminal = {
          frame: 'cancelled',
          outcome: 'cancelled',
          code: 'cancelled',
          text: '',
          hardError: false,
        };
        await finalizeMemoryTurn();
        if (!requestIsCurrent()) return;
        if (!acceptTerminal(decision)) return;
        dispatchActivity({ kind: 'terminal', outcome: decision.outcome });
        activityTerminalDispatched = true;
        // P0-B (2026-07-02): `cancelled` is now reserved for genuine user
        // / `/chat/cancel` aborts (the server-side fix prevents a hung
        // model from emitting this). Previously the UI had no handler for
        // it — the frame was silently dropped, the read loop ended, and
        // `finalizeAssistantMessage` left an empty assistant bubble
        // visible. Now we mark the stream as intentionally stopped, clear
        // the streaming indicator, and surface a non-error "(stopped)"
        // notice so the user knows the turn ended because they asked.
        //
        // Task 7 Part C: finalize into a muted `isCancelled` bubble (rather
        // than a plain finalized assistant message) if partial text
        // streamed, or drop the empty stub entirely if nothing did —
        // `isStreaming` always ends false either way, so there's no
        // forever-spinner.
        // 2026-07-13 finding: this used to hardcode 'user_stop' regardless
        // of cause, so a resend racing an in-flight turn (ActiveStreamRegistry
        // superseding it) recorded identically to a deliberate Stop click.
        // The server now classifies the real reason (index.ts's
        // classifyAbortReason); fall back to 'user_stop' only if an older
        // server build omits the field.
        runAcc.cancelledReason = typeof frame.reason === 'string' ? frame.reason : 'user_stop';
        clearPendingApproval();
        const pending = takePendingTokens();
        setIsStreaming(false);
        stopRequestedRef.current = false;
        setError(null);
        setMessages(prev => {
          const withTokens = applyTokenChunk(prev, pending);
          const last = withTokens[withTokens.length - 1];
          if (last?.role === 'assistant' && last.isStreaming) {
            const content = sanitizeAssistantDisplay(last.content);
            if (!content) return withTokens.slice(0, -1);
            return [...withTokens.slice(0, -1), { ...last, content, isStreaming: false, isCancelled: true }];
          }
          return finalizeStreamingMessages(withTokens);
        });
        return;
      }
      // P0-I (2026-07-02): unknown / unhandled frame types used to be
      // silently dropped. Log them once per type so operator / dev can
      // spot contract drift between the server emitter and the UI
      // handler chain. (P0-B fix relies on this: any future regression
      // that re-introduces a "hung model emits cancelled" path will
      // surface here as a `cancelled` log if a handler is later added.)
      if (typeof frame.type === 'string') {
        reportUnknownFrame(frame.type);
      }
    };

    inactivityWatchdog.start();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const eventText of events) {
          for (const line of eventText.split('\n')) {
            // Task 7 Part C: `parseSseDataLine` throws `SseProtocolError` for
            // a malformed/typeless frame. That used to propagate out of this
            // whole loop via the outer try/catch below — one bad frame ended
            // the entire turn with a scary error, even though the stream
            // itself was fine. Warn + skip that single line instead; only
            // genuine terminal failures thrown from handleFrame (e.g. an
            // `error` SSE frame) should still end the turn.
            let frame: ReturnType<typeof parseSseDataLine>;
            try {
              frame = parseSseDataLine(line);
            } catch (parseError) {
              console.warn('[Jarvis] skipping malformed SSE frame:', parseError);
              continue;
            }
            if (frame) {
              inactivityWatchdog.touch();
              await handleFrame(frame);
            }
          }
        }
      }
      const termination = classifyStreamTermination({
        terminalFrame,
        terminalOutcome: runAcc.outcome ?? null,
        inactivityTimedOut,
        aborted: controller.signal.aborted,
        stopRequested: stopRequestedRef.current,
      });
      if (termination === 'unterminated') {
        runAcc.outcome = 'failed';
        runAcc.partialOutput = boundedPartialOutput(streamedRawText);
        // Finalize before the EOF/abort terminal publication and run write.
        await finalizeMemoryTurn();
        if (!requestIsCurrent()) return;
        dispatchActivity({ kind: 'terminal', outcome: 'failed' });
        activityTerminalDispatched = true;
        throw new JarvisStreamError(STREAM_INCOMPLETE_MESSAGE, STREAM_INCOMPLETE_CODE);
      }
    } catch (error) {
      if (inactivityTimedOut) {
        throw new Error(`Jarvis stream was inactive for ${STREAM_INACTIVITY_TIMEOUT_MS / 1000} seconds.`);
      }
      throw error;
    } finally {
      inactivityWatchdog.stop();
      // Phase 2.4 — finalize the native turn BEFORE any local terminal
      // publication or run-record write. This is memoized, so terminal-frame
      // branches that already finalized are a no-op here.
      await finalizeMemoryTurn();
      // Task 4.1: durably record the terminal outcome on every exit path.
      // Stream ends without a terminal frame: an inactivity timeout is
      // timed_out; a client-side abort (user Stop that raced ahead of the
      // server's `cancelled` frame, or component teardown) is cancelled.
      if (requestIsCurrent() && !runAcc.outcome) {
        if (inactivityTimedOut) {
          runAcc.outcome = 'timed_out';
        } else if (controller.signal.aborted || stopRequestedRef.current) {
          runAcc.outcome = 'cancelled';
          runAcc.cancelledReason = 'client_abort';
        }
        if (!activityTerminalDispatched) {
          dispatchActivity({ kind: 'terminal', outcome: runAcc.outcome ?? 'failed' });
          activityTerminalDispatched = true;
        }
      }
      persistTerminalRun();
    }
    } finally {
      // Safety net for setup/HTTP/body failures that occur before the read
      // loop starts. The same memoized finalizer runs, so a saved turn is
      // finalized exactly once on every exit path, including stale/aborted
      // submissions.
      await finalizeMemoryTurn();
    }
    if (inactivityTimedOut) {
      throw new Error(`Jarvis stream was inactive for ${STREAM_INACTIVITY_TIMEOUT_MS / 1000} seconds.`);
    }

    if (requestIsCurrent()) finalizeAssistantMessage(sid, terminal ?? undefined);
    if (streamAbortRef.current === controller) streamAbortRef.current = null;
  }, [appendAssistantText, applyTokenChunk, clearPendingApproval, dispatchActivity, finalizeAssistantMessage, matchesStreamSession, presentApprovalRequest, takePendingTokens]);

  const handleSend = useCallback(async () => {
    // 2026-07-13 live incident (session 7254c3ae): the `isStreaming` React
    // state guard below misses rapid double-Enter presses because setState
    // is async/batched — a second handleSend in the same tick sees the
    // pre-flip value. The server-side ActiveStreamRegistry then silently
    // supersedes the in-flight turn. Check the synchronous in-flight guard
    // FIRST so the race is closed on the client.
    if (!sendInFlightRef.current.begin()) {
      const blocks = sendInFlightRef.current.blocksRecorded();
      console.warn(`[Jarvis UI] send blocked: stream in flight (blocks=${blocks})`);
      setError('A turn is still streaming — please wait for it to finish before sending again.');
      return;
    }
    const submittedDraft = getSessionDraftSnapshot(draftStoreRef.current, activeSession);
    if (!submittedDraft.text.trim() || isStreaming) {
      sendInFlightRef.current.finish();
      return;
    }
    const sendGeneration = sendGateRef.current.tryAcquire();
    if (sendGeneration === null) {
      sendInFlightRef.current.finish();
      return;
    }
    stopRequestedRef.current = false;
    const userMsg = submittedDraft.text.trim();
    discardPendingTokens();
    setError(null);
    // Phase 2.4 — clear the previous turn's memory surface. The native history
    // is read inside `streamFromJarvisApi`, never from the UI cache.
    setMemoryLiveStatus(null);
    setMemoryDiagnostic(null);
    setMemoryHistoryWarning(null);
    setMemoryFinalizationNotice(null);
    // A new submission invalidates any prior relay correlation so a late relay
    // event from a previous turn cannot bind to this one.
    clearRelayMemoryTurn();
    memoryOwnerRef.current = null;
    // Consume the per-turn user-wide opt-in: this turn snapshots the explicit
    // choice, then the control resets to the Session default (false) so it can
    // never silently carry across an Agent change within the same Session.
    const includeUserScopeForTurn = includeUserScope;
    setIncludeUserScope(false);
    setIsStreaming(true);
    turnStartedAtRef.current = Date.now();
    setTurnElapsedMs(0);
    setPipelineStage('');
    turnHadResponseTextRef.current = false;
    setRecursionDepth(null);
    setReasoningText('');
    setShowReasoning(false);
    setAgentSteps([]);
    setShowAgents(true);
    setToolCalls([]);
    resetActivityLedger();
    clearRunRecord();
    setTurnCost(null);
    setScopeNotice(null);
    setRunMetrics(null);
    setUserPinnedToBottom(true);
    // Client-side identity for the optimistic user bubble (Task 7 / incident
    // 1d4727cf). Upgraded to the DB row id once `append_message` resolves
    // (see streamFromJarvisApi) so dedupeMessages recognizes the reload-from-
    // history copy as the same instance rather than rendering it twice.
    const clientMessageId = crypto.randomUUID();
    setMessages(prev => [
      ...prev,
      { id: clientMessageId, role: 'user', content: userMsg },
      { role: 'assistant', content: '', isStreaming: true },
    ]);

    let effectiveSessionId = activeSession || sessionId;
    try {
      if (!effectiveSessionId) {
        const newSession = await invoke<JarvisSession>('jarvis_new_session', {
          name: userMsg.slice(0, 60),
        });
        if (!mountedRef.current || !sendGateRef.current.isCurrent(sendGeneration)) return;
        effectiveSessionId = newSession.id;
        // Suppress the history-load effect that setActiveSession is about to
        // trigger — otherwise it overwrites the optimistic messages above with
        // the empty history of this brand-new session.
         suppressHistoryLoadRef.current = newSession.id;
         setSessionId(newSession.id);
         sessionIdRef.current = newSession.id;
         activeSessionRef.current = newSession.id;
         setActiveSession(newSession.id);
        onSessionCreated();
      }

      await streamFromJarvisApi(effectiveSessionId, userMsg, sendGeneration, () => {
        publishDraftStore(clearSubmittedSessionDraft(draftStoreRef.current, submittedDraft));
      }, clientMessageId, includeUserScopeForTurn);
    } catch (e) {
      if (!mountedRef.current) return;
      if (!sendGateRef.current.isCurrent(sendGeneration)) {
        publishDraftStore(restoreFailedSessionDraft(draftStoreRef.current, submittedDraft));
        return;
      }
      streamAbortRef.current = null;
      clearPendingApproval();
      const pending = takePendingTokens();
      setIsStreaming(false);
      if (stopRequestedRef.current) {
        stopRequestedRef.current = false;
        setError(null);
        setMessages(prev => finalizeStreamingMessages(applyTokenChunk(prev, pending)));
        return;
      }
      // Task 7 Part C (incident 1d4727cf): finalize the streaming bubble into
      // a designed error bubble — friendly text, `errorCode` as small muted
      // detail — instead of leaving a plain assistant-looking message and
      // relying solely on the (dismissable, easy-to-miss) banner below.
      const errorMessage = String(e instanceof Error ? e.message : e);
       const errorCode = e instanceof JarvisStreamError ? e.code : undefined;
       setError(errorMessage);
       publishDraftStore(restoreFailedSessionDraft(draftStoreRef.current, submittedDraft));
       setMessages(prev => {
        const withTokens = applyTokenChunk(prev, pending);
        const last = withTokens[withTokens.length - 1];
        if (last?.role === 'assistant' && last.isStreaming) {
          const partial = last.content.trim();
          return [...withTokens.slice(0, -1), {
            ...last,
            content: partial ? last.content : errorMessage,
            isStreaming: false,
            isError: true,
            errorCode,
          }];
        }
        return withTokens;
      });
    } finally {
      sendGateRef.current.release(sendGeneration);
      // Mirror the React `isStreaming` state into the synchronous guard so
      // the next handleSend call can proceed normally. The `isCurrent`/
      // `invalidate` dance in sendGateRef handles stale completions, but
      // the in-flight guard is the simpler "is anything in flight right
      // now" check that needs a single finish() on every exit.
      sendInFlightRef.current.finish();
    }
  }, [isStreaming, messages, activeSession, sessionId, onSessionCreated, setActiveSession, clearRunRecord, streamFromJarvisApi, discardPendingTokens, takePendingTokens, applyTokenChunk, publishDraftStore, resetActivityLedger, includeUserScope]);

  // Phase 1.3 — real Stop. POST /chat/cancel on the Bun server; SseRelay now
  // treats the resulting `cancelled` frame as terminal, so isStreaming flips.
  const handleStop = useCallback(async () => {
    const sid = activeSession || sessionId;
    if (!sid) {
      setIsStreaming(false);
      return;
    }
    stopRequestedRef.current = true;
    clearPendingApproval();
    const controller = streamAbortRef.current;
    setReasoningText('');
    setShowReasoning(false);
    fetch(`${JARVIS_API_URL}/chat/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sid }),
    }).catch(() => {});
    try {
      const cancelled = await invoke<boolean>('cancel_chat_stream', sessionInvokeArgs(sid));
      if (cancelled) {
        controller?.abort('Explicit Stop confirmed');
      } else {
        controller?.abort('Explicit Stop was not confirmed');
        setIsStreaming(false);
      }
    } catch (e) {
      console.error('Failed to cancel stream:', e);
      controller?.abort('Explicit Stop request failed');
      setIsStreaming(false);
    }
  }, [activeSession, clearPendingApproval, sessionId]);

  // Phase 1.1 — approve / deny the pending tool call and forward the decision
  // to the Bun server. Surface any POST error so the user can retry.
  const handleApproval = useCallback(async (approved: boolean) => {
    const request = pendingApprovalRef.current;
    if (!request || approvalInFlightRef.current) return;
    const inFlight = {
      callId: request.call_id,
      sessionId: request.session_id,
      approved,
    };
    approvalInFlightRef.current = inFlight;
    setApprovalPending(true);
    try {
      await invoke('jarvis_tool_decision', {
        ...sessionInvokeArgs(request.session_id),
        toolCallId: request.call_id,
        tool_call_id: request.call_id,
        decision: approved ? 'approve' : 'deny',
      });
      if (sameToolApproval(pendingApprovalRef.current, request)) clearPendingApproval();
    } catch {
      if (sameToolApproval(pendingApprovalRef.current, request)) {
        setApprovalError('Tool approval decision failed. Retry the same decision.');
        setApprovalRetryDecision(approved);
      }
    } finally {
      if (approvalInFlightRef.current === inFlight) {
        approvalInFlightRef.current = null;
        setApprovalPending(false);
      }
    }
  }, [clearPendingApproval]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Enter sends; Shift+Enter / Ctrl+Enter / Cmd+Enter → newline.
    if (shouldSubmitComposerKey({
      key: e.key,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      isComposing: e.nativeEvent.isComposing,
    })) {
      e.preventDefault();
      handleSend();
      return;
    }
    // Esc → stop the stream during streaming, otherwise blur.
    if (e.key === 'Escape' && isStreaming) {
      e.preventDefault();
      handleStop();
      return;
    }
    // Cmd/Ctrl+K → new chat.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      handleNewChat();
    }
  };

  const handleNewChat = () => {
    const sid = activeSession || sessionId;
    if (isStreaming && sid) {
      invoke('cancel_chat_stream', sessionInvokeArgs(sid)).catch(() => {});
    }
    streamAbortRef.current?.abort('New Session');
    streamAbortRef.current = null;
    sendGateRef.current.invalidate();
    stopRequestedRef.current = false;
    discardPendingTokens();
    setIsStreaming(false);
    setMessages([]);
    setSessionId('');
    setActiveSession(null);
    activeSessionRef.current = null;
    sessionIdRef.current = '';
    setError(null);
    setPipelineStage('');
    setRecursionDepth(null);
    setReasoningText('');
    setShowReasoning(false);
     setAgentSteps([]);
     setToolCalls([]);
     resetActivityLedger();
     setTurnCost(null);
    setScopeNotice(null);
    setRunMetrics(null);
    setTurnElapsedMs(0);
    turnStartedAtRef.current = null;
    setSessionStats({ tokens: 0, turnCount: 0 });
    lastAccumulatedRunIdRef.current = undefined;
    clearPendingApproval();
    setUserPinnedToBottom(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const onSuggestionClick = (s: string) => {
    setInput(s);
    inputRef.current?.focus();
  };

  const lastAssistant = messages[messages.length - 1];
  // In-flight Session turn progress (M4 sibling): pure view-model output from
  // observed runtime telemetry only. Rendered as a plain status row, so stage
  // progress stays readable before the first token and after the collapsible
  // Activity feed is collapsed — never a bare unexplained spinner.
  const turnProgress = buildTurnProgress({
    isStreaming,
    pipelineStage,
    agentSteps,
    hasResponseText: turnHadResponseTextRef.current,
    approvalName: pendingApproval?.name,
  });
  const streamStatusText = turnProgress?.text;
  // One fixed sentence per run-record phase, derived only from what Native's
  // read-back reported (see `runRecordView`).
  const runRecordSummary = runRecordView(runRecord);
  const runRecordInFlight = runRecord?.phase === 'writing' || runRecord?.phase === 'confirming';
  const showSkeleton =
    isStreaming &&
    !loadingHistory &&
    (messages.length === 0 ||
      !lastAssistant ||
      lastAssistant.role !== 'assistant' ||
      !sanitizeAssistantDisplay(lastAssistant.content));

  const lastAssistantFinished =
    messages.length > 0 &&
    messages[messages.length - 1].role === 'assistant' &&
    !messages[messages.length - 1].isStreaming &&
    !isStreaming;

  const displayedProvider = runMetrics?.provider
    ? formatInferenceRoute(runMetrics.provider)
    : backendLabel;
  const displayedModel = runMetrics?.model ?? modelLabel;
  const displayedRoute = runMetrics?.provider || runMetrics?.model
    ? formatInferenceRoute(runMetrics.provider, runMetrics.model)
    : formatInferenceRoute(config?.active_backend, modelLabel);
  // Concrete, honest memory-turn status. Counts come only from the native
  // diagnostic; while the turn is live a transient status may be shown without
  // counts.
  const memoryStatusLabel = formatMemoryTurnLabel(memoryLiveStatus, memoryDiagnostic);

  return (
    <div className="h-full flex flex-col">
      {/* Chat header bar */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-bone tracking-tight">Jarvis</h2>
          {config && (
            <>
              <Pill variant={config.active_backend === 'openrouter' ? 'info' : 'success'}>{displayedProvider}</Pill>
              <Pill>{displayedModel}</Pill>
              {shouldShowSessionStats(sessionStats.turnCount) && (
                <Pill variant="info">{formatSessionStatsLine(sessionStats)}</Pill>
              )}
            </>
          )}
          {activeSession && <Pill variant="active">Session: {activeSession.slice(0, 8)}</Pill>}
        </div>
        <button
          onClick={handleNewChat}
          className="px-3 py-1 text-xs font-mono text-bone-dim border border-iron/30 rounded-lg hover:border-iron/50 hover:text-bone-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
        >
          + New Chat
        </button>
      </div>

      {turnProgress && (
        <div
          role="status"
          aria-label="Session turn progress"
          aria-atomic="true"
          className="shrink-0 mb-3 rounded-lg border border-cyan-neon/20 bg-cyan-neon/5 px-3 py-2 text-xs font-mono text-bone-muted"
        >
          {turnProgress.text}
        </div>
      )}

      {/* Durable run record. Confirmed only when Native's read-back reports
          this run id; anything else stays visible as an unconfirmed record
          with a deliberate retry, never as a recorded run. */}
      {runRecordSummary && (
        <div
          role="status"
          aria-label="Recorded run confirmation"
          aria-atomic="true"
          className={cn(
            'shrink-0 mb-3 rounded-lg border px-3 py-2 text-xs font-mono flex items-start gap-2',
            runRecordSummary.confirmed
              ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300/90'
              : 'border-amber-500/20 bg-amber-500/5 text-amber-200/90',
          )}
        >
          <span className="min-w-0">{runRecordSummary.text}</span>
          {runRecordSummary.retryable && (
            <button
              type="button"
              onClick={retryRunRecord}
              disabled={runRecordInFlight}
              className="shrink-0 underline disabled:opacity-40"
            >
              {runRecordSummary.phase === 'unreadable'
                ? 'Read the run outcome again'
                : 'Record the run outcome again'}
            </button>
          )}
        </div>
      )}

      {/* Messages area — ARIA live-region so screen readers announce tokens. */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Jarvis chat transcript"
        className="flex-1 overflow-y-auto mb-4 space-y-3 pr-1 min-h-0 scroll-smooth"
      >
        {loadingHistory && (
          <div role="status" aria-label="Session history loading" className="space-y-2">
            <span className="sr-only">Loading session history…</span>
            {[0, 1, 2].map(i => (
              <div
                key={i}
                className={cn(
                  'rounded-xl border border-iron/30 p-3 mr-12',
                  i % 2 === 0 ? 'bg-cyan-neon/5' : 'bg-royal/5',
                )}
              >
                <div className="mb-2">
                  <div className="h-2 w-16 rounded bg-iron/50" />
                </div>
                <div className="h-3 w-3/4 rounded bg-iron/40 animate-pulse" />
                <div className="mt-1 h-3 w-1/2 rounded bg-iron/30 animate-pulse" />
              </div>
            ))}
          </div>
        )}

        {historyError && (
          <div role="alert" aria-label="Session history error" className="rounded-xl border border-iron/30 p-3 text-sm text-bone-dim">
            <p>Could not load session history.</p>
            <button
              type="button"
              onClick={() => setHistoryRetry(value => value + 1)}
              className="mt-2 px-3 py-1 text-xs font-mono border border-iron/30 rounded-lg hover:text-bone-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
            >
              Retry
            </button>
          </div>
        )}

        {messages.length === 0 && !loadingHistory && !historyError && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-md">
              <motion.div
                className="text-5xl mb-4 opacity-20"
                animate={{ opacity: [0.15, 0.25, 0.15] }}
                transition={{ duration: 3, repeat: Infinity }}
              >
                ⬡
              </motion.div>
              <p className="text-bone font-semibold text-lg mb-1">Jarvis</p>
              <p className="text-bone-dim text-sm font-mono">
                Your local AI coding assistant. Ask me to build, debug, or explore code.
              </p>
              {config?.active_backend === 'openrouter' && (
                <p className="text-bone-faint text-xs font-mono mt-2">
                  Powered by OpenRouter · {config.openrouter.model}
                </p>
              )}
              {config?.active_backend === 'ollama' && (
                <p className="text-bone-faint text-xs font-mono mt-2">
                  Powered by Ollama · {config.ollama.model}
                </p>
              )}
              {config?.active_backend === 'claude_cli' && (
                <p className="text-bone-faint text-xs font-mono mt-2">
                  Powered by Claude CLI · {config.claude_cli.model ?? 'default'}
                </p>
              )}
              {/* Example prompt chips for first impression */}
              <div className="flex flex-wrap justify-center gap-2 mt-4">
                {['Refactor a function', 'Debug a stack trace', 'Explain a piece of code'].map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => onSuggestionClick(p)}
                    className={cn(
                      'px-2.5 py-1 rounded-lg text-[11px] font-mono border transition-colors',
                      'text-bone-dim border-iron/30 hover:border-royal/40 hover:text-bone-muted',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50'
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {messages.length === 0 && !loadingHistory && !historyError && <EmptyState message="No messages yet" />}

        {messages.map((msg, i) => (
          <ChatMessage
            key={msg.id ?? i}
            message={msg}
            index={i}
            prefersReducedMotion={prefersReducedMotion.current}
            streamStatus={msg.isStreaming && !msg.content.trim() && !showSkeleton ? streamStatusText : undefined}
          />
        ))}

        {/* First-token skeleton (Phase 2.5) — shimmer placeholder for the
            assistant bubble before any token has landed. */}
        {showSkeleton && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="rounded-xl px-4 py-3 border mr-8 bg-cyan-neon/5 border-cyan-neon/15"
            aria-hidden="true"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] font-mono uppercase tracking-wider font-bold text-cyan-neon flex items-center gap-1">
                <Bot size={11} /> JARVIS
              </span>
              <motion.span
                className="text-[10px] font-mono text-cyan-neon flex items-center gap-1"
                animate={{ opacity: prefersReducedMotion.current ? 1 : [0.4, 1, 0.4] }}
                transition={{ duration: 1.2, repeat: prefersReducedMotion.current ? 0 : Infinity }}
              >
                <LoaderCircle size={10} className={prefersReducedMotion.current ? '' : 'animate-spin'} /> thinking
              </motion.span>
            </div>
            <div className="space-y-1.5">
              <div className="h-2.5 w-3/4 rounded bg-iron/50 shimmer-bar" />
              <div className="h-2.5 w-1/2 rounded bg-iron/40 shimmer-bar" />
              <div className="h-2.5 w-2/3 rounded bg-iron/30 shimmer-bar" />
            </div>
          </motion.div>
        )}

        {scopeNotice && (
          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 rounded-lg border border-cyan-neon/20 bg-cyan-neon/5 text-[10px] font-mono text-cyan-glow"
            aria-label="Explicit workspace scope"
          >
            <span className="uppercase tracking-wider font-bold">scope locked</span>
            {scopeNotice.rootListing && <span>top-level listing</span>}
            {scopeNotice.paths.map(path => <span key={path}>read: {path}</span>)}
            {scopeNotice.shell === 'denied' && <span>shell denied</span>}
            {scopeNotice.network === 'denied' && <span>network denied</span>}
          </div>
        )}

        <WorkspaceGrantsChip sessionId={selectedSessionId} isStreaming={isStreaming} />

        {/* M4 — unified activity feed (agentSteps + toolCalls + pipelineStage). */}
        {(() => {
          const ledgerFeed = activityLedgerItems(activityLedger);
          const legacyFeed = buildActivityFeed(agentSteps, toolCalls, pipelineStage || undefined);
          const activityFeed = ledgerFeed.length === 0
            ? legacyFeed
            : ledgerFeed.some((item) => item.kind === 'tool' || item.kind === 'tool_result')
              ? ledgerFeed
              : [...ledgerFeed, ...legacyFeed.filter((item) => item.kind === 'tool')];
          if (activityFeed.length === 0) return null;
          return (
            <ActivityFeed
              items={activityFeed}
              isStreaming={isStreaming}
              turnElapsedMs={turnElapsedMs}
              recursionDepth={recursionDepth}
              prefersReducedMotion={prefersReducedMotion.current}
            />
          );
        })()}

        {runMetrics && (
          <div
            className={cn(
              'flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 rounded-lg border text-[10px] font-mono',
              runMetrics.scopeCompliant === false
                ? 'border-error/30 bg-error/5 text-error'
                : 'border-iron/30 bg-obsidian/40 text-bone-dim',
            )}
            aria-label="Orchestration run metrics"
          >
            <span className="uppercase tracking-wider text-bone-muted">run</span>
            <span>{formatRunDuration(runMetrics.durationMs)}</span>
            <span>{runMetrics.tokens.toLocaleString()} tok</span>
            <span>{runMetrics.tools} tool{runMetrics.tools === 1 ? '' : 's'}</span>
            {(runMetrics.provider || runMetrics.model) && (
              <span>{formatInferenceRoute(runMetrics.provider, runMetrics.model)}</span>
            )}
            {runMetrics.firstVisibleTokenMs !== undefined && (
              <span>TTFT {formatRunDuration(runMetrics.firstVisibleTokenMs)}</span>
            )}
            {runMetrics.fallbackRetries > 0 && (
              <span>
                {runMetrics.fallbackRetries} fallback {runMetrics.fallbackRetries === 1 ? 'retry' : 'retries'}
                {runMetrics.fallbackReason ? ` · ${runMetrics.fallbackReason.replace(/_/g, ' ')}` : ''}
              </span>
            )}
            {runMetrics.scopeCompliant !== undefined && (
              <span>{runMetrics.scopeCompliant ? 'scope verified' : 'scope violation'}</span>
            )}
          </div>
        )}

        {/* Reasoning disclosure only — agent progress lives in Activity feed. */}
        {reasoningText && (
          <ReasoningAgentsAccordion
            reasoningText={reasoningText}
            agentSteps={[]}
            showAgents={showAgents}
            setShowAgents={setShowAgents}
            showReasoning={showReasoning}
            setShowReasoning={setShowReasoning}
          />
        )}

        {error && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-3 bg-error/10 border border-error/30 rounded-xl"
            role="alert"
            aria-live="assertive"
          >
            <p className="text-error text-xs font-mono break-words">{error}</p>
          </motion.div>
        )}

        {/* Follow-up suggestion chips once an assistant message is finalized. */}
        {lastAssistantFinished && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {CURATED_SUGGESTIONS.map(s => (
              <button
                key={s}
                type="button"
                onClick={() => onSuggestionClick(s)}
                className={cn(
                  'px-2.5 py-1 rounded-lg text-[11px] font-mono border transition-colors',
                  'text-bone-dim border-iron/30 hover:border-royal/40 hover:text-bone-muted',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50'
                )}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Phase 2.5 — "Jump to latest" pill when the user has scrolled up. */}
      <AnimatePresence>
        {!userPinnedToBottom && (
          <motion.button
            type="button"
            onClick={() => { setUserPinnedToBottom(true); scrollToBottom('smooth'); }}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className="absolute right-8 bottom-28 mb-1 px-2.5 py-1 rounded-full text-[11px] font-mono bg-royal/30 text-royal-light border border-royal/40 hover:bg-royal/50 transition-colors flex items-center gap-1 z-10"
            aria-label="Jump to latest message"
          >
            <ArrowDown size={11} /> Latest
          </motion.button>
        )}
      </AnimatePresence>

      {/* Input area — single-slot morph: Send | Stop (the user's chosen UX). */}
      <div className="shrink-0">
        <div className="relative">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? 'Jarvis is thinking… (Esc to stop)' : 'Ask Jarvis anything… (Enter to send · Shift+Enter for newline · ⌘K new chat)'}
            className={cn(
              'w-full px-4 py-3 pr-14 text-sm font-mono bg-obsidian/60 border rounded-xl text-bone',
              'placeholder:text-bone-faint transition-colors resize-none',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50',
              isStreaming ? 'border-royal/30 opacity-80' : 'border-iron/40'
            )}
            rows={1}
            aria-label="Chat input"
          />
          <button
            onClick={isStreaming ? handleStop : handleSend}
            disabled={!isStreaming && !input.trim()}
            aria-label={isStreaming ? 'Stop streaming' : 'Send message'}
            className={cn(
              'absolute right-2 bottom-2 w-8 h-8 rounded-lg flex items-center justify-center transition-all',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50',
              isStreaming
                ? 'bg-error/30 text-error hover:bg-error/50 cursor-pointer'
                : !input.trim()
                  ? 'bg-iron/20 text-bone-faint cursor-not-allowed'
                  : 'bg-royal/30 text-royal-light hover:bg-royal/50 cursor-pointer'
            )}
          >
            <AnimatePresence mode="wait" initial={false}>
              {isStreaming ? (
                <motion.span
                  key="stop"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.12 }}
                >
                  <Square size={14} fill="currentColor" />
                </motion.span>
              ) : (
                <motion.span
                  key="send"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.12 }}
                >
                  <Send size={14} />
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        </div>
        <div className="flex items-center justify-between mt-1.5 px-1">
          <span className="text-[10px] font-mono text-bone-faint">
            {isStreaming ? `● Streaming · ${formatRunDuration(turnElapsedMs)}` : `${messages.filter(m => m.role === 'user').length} message${messages.filter(m => m.role === 'user').length !== 1 ? 's' : ''} sent`}
          </span>
          <span className="text-[10px] font-mono text-bone-faint flex items-center gap-2">
            {turnCost && (
              <>
                <span>{turnCost.tokens.toLocaleString()} tok</span>
                {turnCost.costUsd > 0 && <span>${turnCost.costUsd.toFixed(4)}</span>}
                <span aria-hidden="true">·</span>
              </>
            )}
            via {displayedRoute}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 mt-1.5 px-1">
          <label className="flex items-center gap-1.5 text-[10px] font-mono text-bone-faint cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeUserScope}
              onChange={(e) => setIncludeUserScope(e.target.checked)}
              disabled={isStreaming}
              className="accent-royal"
              aria-label="Include user-wide memory"
            />
            Include user-wide memory
          </label>
          {memoryStatusLabel && (
            <span
              role="status"
              aria-label="Memory recall status"
              className="text-[10px] font-mono text-bone-faint truncate"
            >
              {memoryStatusLabel}
            </span>
          )}
        </div>
        {memoryHistoryWarning && (
          <p
            role="status"
            aria-label="Memory history warning"
            className="mt-0.5 px-1 text-[10px] font-mono text-bone-faint"
          >
            {memoryHistoryWarning}
          </p>
        )}
        {memoryFinalizationNotice && (
          <p
            role="status"
            aria-label="Memory finalization status"
            className="mt-0.5 px-1 text-[10px] font-mono text-bone-faint"
          >
            {memoryFinalizationNotice}
          </p>
        )}
      </div>

      {/* Phase 1.1 — Tool approval modal. Rendered outside the scroll area so
          it never gets clipped; focus is trapped by Esc / click-backdrop. */}
      <AnimatePresence>
        {pendingApproval && (
          <ApprovalModal
            key={`${pendingApproval.session_id}:${pendingApproval.call_id}`}
            call_id={pendingApproval.call_id}
            name={pendingApproval.name}
            args={pendingApproval.arguments}
            error={approvalError}
            pending={approvalPending}
            onRetry={approvalRetryDecision === null ? undefined : () => { void handleApproval(approvalRetryDecision); }}
            onApprove={() => { void handleApproval(true); }}
            onReject={() => { void handleApproval(false); }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Streaming message body leaf (M6) ──
// Memoized so token flushes re-render only the body, not the full
// bubble chrome / tree above. rAF coalesce already batches updates;
// this keeps the residual work small.
// ═══════════════════════════════════════════════════════════════

const StreamingMessageBody = memo(function StreamingMessageBody({
  content,
  isStreaming,
  isCancelled,
  isToolEcho,
  streamStatus,
  prefersReducedMotion,
}: {
  content: string;
  isStreaming: boolean;
  isCancelled: boolean;
  isToolEcho: boolean;
  streamStatus?: string;
  prefersReducedMotion: boolean;
}) {
  if (isCancelled) return <>(stopped)</>;
  if (streamStatus) {
    return <span className="text-bone-faint font-mono text-xs">{streamStatus}</span>;
  }
  if (isToolEcho) return <ToolCallEchoCard content={content} />;
  return (
    <>
      <MarkdownView content={content} />
      {isStreaming && (
        <motion.span
          className="inline-block w-1.5 h-3.5 bg-cyan-neon/70 ml-0.5 align-middle rounded-sm"
          animate={prefersReducedMotion ? undefined : { opacity: [0, 1, 0] }}
          transition={{ duration: 0.8, repeat: prefersReducedMotion ? 0 : Infinity }}
          aria-hidden="true"
        />
      )}
    </>
  );
});

// ═══════════════════════════════════════════════════════════════
// ── Chat Message Bubble (Phase 2.2 + 2.7 + 4) ──
// ═══════════════════════════════════════════════════════════════

function ChatMessage({
  message, index, prefersReducedMotion, streamStatus,
}: {
  message: JarvisMessage;
  index: number;
  prefersReducedMotion: boolean;
  streamStatus?: string;
}) {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const displayContent = isUser || isTool
    ? message.content
    : sanitizeAssistantDisplay(message.content);
  // Task 7 Part B (2026-07-03 incident 1d4727cf): the assistant bubble once
  // rendered raw tool-call JSON as markdown text when a synthesizer stage
  // leaked it into the display content instead of routing through the
  // `tool_call` SSE frame. Pure defense-in-depth — the server should never
  // send this — so keep the detector conservative (chat-state.ts).
  const isToolEcho = !isUser && !isTool && isToolCallEchoOnly(displayContent);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  }, [displayContent]);

  const isErrorBubble = !isUser && !isTool && (message.isError || message.terminalOutcome === 'failed');
  const isPartialBubble = !isUser && !isTool && message.terminalOutcome === 'partial';
  const isTimedOutBubble = !isUser && !isTool && message.terminalOutcome === 'timed_out';
  const isNonSuccessBubble = isPartialBubble || isTimedOutBubble;
  const isCancelledBubble = !isUser && !isTool && message.isCancelled;
  if (!isUser && !isTool && !displayContent && !streamStatus && !isNonSuccessBubble && !isErrorBubble) return null;
  // P0a follow-up (2026-07-05): per-code error UX. The server emits a small
  // set of structured `error` codes; render each one with its own label,
  // pill tone, and actionable hint (see ./error-display.ts). A `turn_deadline_exceeded`
  // is a soft amber event, not a red hard failure — surfacing it as red makes
  // the user think the model is broken when really it was just slow.
  const errorDisplay = isErrorBubble ? errorDisplayForCode(message.errorCode) : null;

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={cn(
        'rounded-xl px-4 py-3 text-sm border shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]',
        'backdrop-blur-xl',
        isUser
          ? 'glass-strong bg-royal/10 border-royal/25 ml-12'
          : isErrorBubble
            ? 'glass-mythos bg-error/10 border-error/30 mr-8'
            : isNonSuccessBubble
              ? 'glass-mythos bg-amber-400/10 border-amber-400/30 mr-8'
              : isCancelledBubble
                ? 'glass-mythos bg-iron/10 border-iron/30 mr-8'
                : isTool
                  ? 'glass-mythos bg-obsidian/40 border-iron/30 mr-8'
                  : 'glass-strong bg-cyan-neon/5 border-cyan-neon/20 mr-8'
      )}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className={cn(
          'text-[10px] font-mono uppercase tracking-wider font-bold flex items-center gap-1',
          isUser
            ? 'text-royal-light'
            : isErrorBubble
              ? 'text-amber-400'
              : isNonSuccessBubble
                ? 'text-amber-400'
                : isCancelledBubble
                  ? 'text-bone-faint'
                  : isTool
                    ? 'text-bone-dim'
                    : 'text-cyan-neon'

        )}>
          {isUser
            ? <><User size={11} /> YOU</>
            : isTool
              ? <><Wrench size={11} /> TOOL: {message.tool_name || 'unknown'}</>
              : <><Bot size={11} /> JARVIS</>}
        </span>
        {isErrorBubble && errorDisplay && (
          <Pill variant={errorDisplay.pillVariant}>{errorDisplay.label}</Pill>
        )}
        {isPartialBubble && (
          <span aria-label="Partial result" className="flex items-center gap-1">
            <Pill variant="warning">partial</Pill>
            {message.errorCode && <span className="text-[10px] font-mono text-amber-200/80">{message.errorCode}</span>}
          </span>
        )}
        {isTimedOutBubble && (
          <span aria-label="Timed out result" className="flex items-center gap-1">
            <Pill variant="warning">timed out</Pill>
            {message.errorCode && <span className="text-[10px] font-mono text-amber-200/80">{message.errorCode}</span>}
          </span>
        )}
        {isCancelledBubble && <Pill>stopped</Pill>}
        {message.isStreaming && (
          <motion.span
            className="text-[10px] font-mono text-cyan-neon flex items-center gap-1"
            animate={prefersReducedMotion ? undefined : { opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.2, repeat: prefersReducedMotion ? 0 : Infinity }}
            aria-hidden="true"
          >
            <LoaderCircle size={10} className={prefersReducedMotion ? '' : 'animate-spin'} /> streaming
          </motion.span>
        )}
        {message.timestamp && !message.isStreaming && (
          <span className="text-[10px] font-mono text-bone-faint">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        )}
        {!message.isStreaming && !isUser && (
          <button
            onClick={handleCopy}
            aria-label={`Copy message ${index + 1}`}
            className="ml-auto text-bone-faint hover:text-cyan-glow transition-colors p-1 rounded border border-iron/20 hover:border-cyan-neon/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
          </button>
        )}
      </div>
      <div className={cn(
        'leading-relaxed break-words',
        isUser || isTool ? 'text-xs font-mono whitespace-pre-wrap' : 'text-sm',
        isUser
          ? 'text-bone'
          : isErrorBubble
            ? 'text-bone-muted'
            : isNonSuccessBubble
              ? 'text-bone-muted'
              : isCancelledBubble
                ? 'text-bone-faint italic'
                : isTool
                  ? 'text-bone-dim'
                  : 'text-bone-muted'

      )}>
        {isUser || isTool
          ? displayContent
          : (
            <StreamingMessageBody
              content={displayContent}
              isStreaming={!!message.isStreaming}
              isCancelled={!!isCancelledBubble}
              isToolEcho={isToolEcho}
              streamStatus={streamStatus}
              prefersReducedMotion={prefersReducedMotion}
            />
          )}
        {isErrorBubble && errorDisplay && (
          <div className="mt-2 text-xs italic text-bone-dim">
            {errorDisplay.hint ?? `code: ${message.errorCode ?? 'unknown'}`}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Tool-call echo card (Task 7 Part B) ──
// ═══════════════════════════════════════════════════════════════
//
// Minimal inline variant of ToolCallCard's visual language, for the case
// where an assistant message's ENTIRE display content is bare tool-call
// JSON (see isToolCallEchoOnly). Collapsed + muted by default since this
// is leaked internal plumbing, not a real reply.
function ToolCallEchoCard({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-iron/30 bg-obsidian/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-2.5 py-1 text-[10px] font-mono text-bone-faint hover:text-bone-dim transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
      >
        <Wrench size={10} className="text-bone-faint" />
        <span>tool call echo</span>
        <span className="ml-auto opacity-70">{open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
      </button>
      {open && (
        <pre className="px-2.5 pb-2 text-[10px] font-mono text-bone-faint whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
          {content}
        </pre>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Tool Call Card (Phase 3.1) ──
// ═══════════════════════════════════════════════════════════════

function ToolCallCard({ call }: {
  call: ActivityToolCall;
}) {
  const [open, setOpen] = useState(false);
  const argText = (() => {
    try {
      if (!call.arguments) return '';
      if (typeof call.arguments === 'string') return call.arguments;
      return JSON.stringify(call.arguments, null, 2);
    } catch { return String(call.arguments); }
  })();

  return (
     <div
       aria-label={`Tool: ${call.name}`}
       data-activity-item="true"
       data-activity-kind="tool"
       className={cn(
         'rounded-xl border border-iron/30 bg-obsidian/40 overflow-hidden mr-8',
         call.is_error || call.terminalState === 'incomplete' || call.terminalState === 'failed'
           ? 'border-error/40'
           : 'border-iron/30'
       )}
     >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[10px] font-mono text-bone-dim hover:text-bone-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
      >
        <Wrench size={10} className="text-royal-light" />
        <span className="text-bone">{call.name}</span>
         {call.result === undefined && (
           <span className="text-amber-400 flex items-center gap-0.5">
             <LoaderCircle size={9} className="animate-spin" /> running
           </span>
         )}
         {call.terminalState === 'cancelled' && <Pill>cancelled</Pill>}
         {call.terminalState === 'incomplete' && <Pill variant="warning">incomplete</Pill>}
         {call.is_error && <Pill variant="error">error</Pill>}
         {call.result !== undefined && !call.is_error && !call.terminalState && <Pill variant="success">done</Pill>}
        {call.contextTruncation && <Pill variant="warning">context trimmed</Pill>}
        <span className="ml-auto opacity-70">{open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="px-3 pb-2 space-y-1.5"
          >
            {argText && (
              <div>
                <div className="text-[9px] font-mono uppercase tracking-widest text-bone-faint mb-0.5">Args</div>
                <pre className="text-[10px] font-mono text-bone-dim whitespace-pre-wrap break-words bg-void/40 rounded p-2 max-h-32 overflow-y-auto">{argText}</pre>
              </div>
            )}
            {call.result !== undefined && (
              <div>
                <div className="text-[9px] font-mono uppercase tracking-widest text-bone-faint mb-0.5">{call.is_error ? 'Error' : 'Result'}</div>
                {call.contextTruncation && (
                  <div className="mb-1 text-[9px] font-mono text-amber-300/80">
                    Full result shown here; inference context retained {call.contextTruncation.retained_chars.toLocaleString()} of {call.contextTruncation.original_chars.toLocaleString()} characters.
                  </div>
                )}
                <pre className={cn('text-[10px] font-mono whitespace-pre-wrap break-words bg-void/40 rounded p-2 max-h-48 overflow-y-auto', call.is_error ? 'text-error' : 'text-bone-dim')}>{call.result}</pre>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Activity feed (M4) — stages + tools + plan rows ──
// ═══════════════════════════════════════════════════════════════

function ActivityFeed({
  items,
  isStreaming,
  turnElapsedMs,
  recursionDepth,
  prefersReducedMotion,
}: {
  items: ActivityItem[];
  isStreaming: boolean;
  turnElapsedMs: number;
  recursionDepth: number | null;
  prefersReducedMotion: boolean;
}) {
  // Default expanded while streaming, collapsed when the turn finishes.
  // Users can still toggle mid-turn; the next isStreaming flip re-syncs.
  const [open, setOpen] = useState(isStreaming);
  useEffect(() => {
    setOpen(isStreaming);
  }, [isStreaming]);

  const summary = formatActivityFeedSummary(items);

  return (
    <div
      className="border border-iron/20 rounded-lg overflow-hidden mr-8"
      aria-label="Turn activity"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[10px] font-mono text-bone-faint hover:text-bone-dim transition-colors bg-obsidian/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
      >
        <span aria-hidden="true">{open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
        <span className="text-royal-light uppercase tracking-wider">Activity</span>
        {isStreaming && (
          <motion.span
            className="text-cyan-neon flex items-center gap-1"
            animate={prefersReducedMotion ? undefined : { opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.2, repeat: prefersReducedMotion ? 0 : Infinity }}
            aria-hidden="true"
          >
            <LoaderCircle size={9} className={prefersReducedMotion ? '' : 'animate-spin'} />
          </motion.span>
        )}
        <span className="ml-auto opacity-50 flex items-center gap-2">
          <span>{summary}</span>
          {isStreaming && recursionDepth === null && (
            <span className="text-bone-faint">{formatRunDuration(turnElapsedMs)}</span>
          )}
          {recursionDepth !== null && (
            <span className="text-bone-faint">↩ depth {recursionDepth}</span>
          )}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="px-3 py-2 space-y-2 max-h-72 overflow-y-auto bg-obsidian/20"
          >
             {items.map((item) => {
               if (item.kind === 'tool') {
                 return <ToolCallCard key={item.id} call={item.call} />;
               }
               if (item.kind === 'tool_result') {
                 return (
                   <div
                     key={item.id}
                     data-activity-item="true"
                     data-activity-kind="tool_result"
                     aria-label={`Tool result: ${item.name}`}
                     className="px-2 py-1.5 rounded-md border border-iron/20 bg-obsidian/30 text-[10px] font-mono"
                   >
                     <div className="flex items-center gap-2 text-bone-dim">
                       <Wrench size={10} className="text-royal-light" />
                       <span>{item.name} result</span>
                       {item.isError ? <Pill variant="error">error</Pill> : <Pill variant="success">done</Pill>}
                     </div>
                     <div className="mt-1 whitespace-pre-wrap break-words text-bone-faint">{item.output || 'No output reported.'}</div>
                   </div>
                 );
               }
               if (item.kind === 'directive') {
                 return (
                   <div
                     key={item.id}
                     data-activity-item="true"
                     data-activity-kind="directive"
                     aria-label={`Conductor directive: ${item.directive.label}`}
                     className="px-2 py-1.5 rounded-md border border-amber-400/25 bg-amber-400/5 text-[10px] font-mono"
                   >
                     <div className="flex items-center gap-2 text-amber-200">
                       <Sparkles size={10} />
                       <span className="uppercase tracking-wider">Conductor</span>
                       <span>{item.directive.label}</span>
                     </div>
                     <div className="mt-1 text-bone-faint">{item.directive.detail}</div>
                   </div>
                 );
               }
               if (item.kind === 'diagnostic') {
                 return (
                   <div
                     key={item.id}
                     data-activity-item="true"
                     data-activity-kind="diagnostic"
                     aria-label="Activity diagnostic"
                     className="px-2 py-1.5 rounded-md border border-amber-400/25 bg-amber-400/5 text-[10px] font-mono text-amber-200"
                   >
                     {item.text}
                   </div>
                 );
               }
               if (item.kind === 'stage') {
                 return (
                   <div
                     key={item.id}
                     data-activity-item="true"
                     data-activity-kind="stage"
                     className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-royal/5 border border-royal/15 text-[10px] font-mono text-royal-light"
                     aria-label={`Orchestrator stage: ${item.stage}`}
                   >
                     <motion.span
                       animate={prefersReducedMotion ? undefined : { opacity: [0.4, 1, 0.4] }}
                       transition={{ duration: 1.2, repeat: prefersReducedMotion ? 0 : Infinity }}
                       aria-hidden="true"
                     >
                       <Sparkles size={11} />
                     </motion.span>
                     <span className="uppercase tracking-wider">{item.stage}</span>
                     {isStreaming && (
                       <span className="text-bone-faint ml-auto">running</span>
                     )}
                   </div>
                 );
               }
               return (
                 <div
                   key={item.id}
                   data-activity-item="true"
                   data-activity-kind="plan"
                   className="px-1"
                 >
                   <div className="text-[9px] font-mono text-royal-light uppercase tracking-widest mb-0.5 flex items-center gap-1">
                     <Sparkles size={9} /> {item.stage}
                   </div>
                   <div className="text-[11px] font-mono text-bone-faint whitespace-pre-wrap leading-relaxed">
                     {item.text}
                   </div>
                 </div>
               );
             })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Reasoning + Agents combined accordion (Phase 3.2) ──
// ═══════════════════════════════════════════════════════════════

function ReasoningAgentsAccordion({
  reasoningText, agentSteps, showAgents, setShowAgents, showReasoning, setShowReasoning,
}: {
  reasoningText: string;
  agentSteps: { stage: string; text: string }[];
  showAgents: boolean;
  setShowAgents: (f: (v: boolean) => boolean) => void;
  showReasoning: boolean;
  setShowReasoning: (f: (v: boolean) => boolean) => void;
}) {
  const progressSummary = formatAgentProgressSummary(agentSteps);
  return (
    <div className="border border-iron/20 rounded-lg overflow-hidden">
      {reasoningText && (
        <>
          <button
            type="button"
            onClick={() => setShowReasoning(r => !r)}
            aria-expanded={showReasoning}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[10px] font-mono text-bone-faint hover:text-bone-dim transition-colors bg-obsidian/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
          >
            <span aria-hidden="true">{showReasoning ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
            <span>Thinking</span>
            <span className="ml-auto opacity-50">{reasoningText.length.toLocaleString()} chars</span>
          </button>
          <AnimatePresence initial={false}>
            {showReasoning && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="px-3 py-2 text-[11px] font-mono text-bone-faint whitespace-pre-wrap max-h-40 overflow-y-auto bg-obsidian/20"
              >
                {reasoningText}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
      {agentSteps.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowAgents(a => !a)}
            aria-expanded={showAgents}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[10px] font-mono text-bone-faint hover:text-bone-dim transition-colors bg-obsidian/30 border-t border-iron/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
          >
            <span aria-hidden="true">{showAgents ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
            <span className="text-royal-light">Agents</span>
            <span className="ml-auto opacity-50">{progressSummary}</span>
          </button>
          <AnimatePresence initial={false}>
            {showAgents && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="px-3 py-2 space-y-3 max-h-64 overflow-y-auto bg-obsidian/20"
              >
                {agentSteps.map((step, i) => (
                  <div key={i}>
                    <div className="text-[9px] font-mono text-royal-light uppercase tracking-widest mb-0.5 flex items-center gap-1">
                      <Sparkles size={9} /> {step.stage}
                    </div>
                    <div className="text-[11px] font-mono text-bone-faint whitespace-pre-wrap leading-relaxed">{step.text}</div>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Tool Approval Modal (Phase 1.1) — local file replacing
// ├── src-ui/src/components/jarvis/ToolApprovalModal.tsx ─────
// ═══════════════════════════════════════════════════════════════

function ApprovalModal({ call_id, name, args, error, pending, onRetry, onApprove, onReject }: {
  call_id: string;
  name: string;
  args: unknown;
  error: string | null;
  pending: boolean;
  onRetry?: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const approveRef = useRef<HTMLButtonElement>(null);
  const onApproveRef = useRef(onApprove);
  const onRejectRef = useRef(onReject);
  onApproveRef.current = onApprove;
  onRejectRef.current = onReject;

  const argText = (() => {
    try {
      if (!args) return '';
      if (typeof args === 'string') return args;
      return JSON.stringify(args, null, 2);
    } catch { return String(args); }
  })();

  useEffect(() => {
    const opener = document.activeElement;
    const enabledControls = () => Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') || [],
    );
    const focusFirstControl = () => {
      const target = enabledControls()[0] || dialogRef.current;
      target?.focus();
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) focusFirstControl();
    };
    document.addEventListener('focusin', containFocus);
    rejectRef.current?.focus();
    return () => {
      document.removeEventListener('focusin', containFocus);
      if (opener instanceof HTMLElement && opener.isConnected && !opener.hasAttribute('disabled')) {
        opener.focus();
      }
      if (!(opener instanceof HTMLElement) || !opener.isConnected || document.activeElement !== opener) {
        const tabIndex = document.body.getAttribute('tabindex');
        document.body.setAttribute('tabindex', '-1');
        document.body.focus();
        if (tabIndex === null) document.body.removeAttribute('tabindex');
        else document.body.setAttribute('tabindex', tabIndex);
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onRejectRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') || [],
      );
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <motion.div
      ref={dialogRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => onRejectRef.current()}
      role="dialog"
      aria-modal="true"
      aria-label="Tool approval required"
      aria-busy={pending}
      tabIndex={-1}
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="glass-strong bg-obsidian border border-iron/40 rounded-xl p-6 w-full max-w-md shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-bone font-semibold mb-2 flex items-center gap-2">
          <Wrench size={14} className="text-cyan-neon" />
          Tool Approval Required
        </h3>
        <p className="text-bone-muted text-sm mb-1">
          The orchestrator wants to execute <span className="font-mono text-cyan-glow">{name}</span> with:
        </p>
        <pre
          className="my-3 p-3 bg-void/60 border border-iron/30 rounded-lg text-xs font-mono text-bone overflow-x-auto max-h-60 overflow-y-auto"
          aria-label="Tool arguments"
        >
          {argText || '(no arguments)'}
        </pre>
        {pending && (
          <p
            className="text-cyan-glow text-xs font-mono mb-2"
            role="status"
            aria-label="Tool approval decision pending"
          >
            Submitting tool approval decision.
          </p>
        )}
        {error && (
          <p className="text-error text-xs font-mono mb-2 break-words" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-3 justify-end mt-4">
          <button
            ref={rejectRef}
            type="button"
            aria-label="Reject tool call"
            className="px-4 py-2 text-xs font-mono rounded-lg border border-error/40 text-error hover:bg-error/10 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/50 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => onRejectRef.current()}
            disabled={pending}
          >
            Reject  (Esc)
          </button>
          {onRetry && (
            <button
              type="button"
              aria-label="Retry tool decision"
              className="px-4 py-2 text-xs font-mono rounded-lg border border-royal/40 text-royal-light hover:bg-royal/10 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-royal/50 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onRetry}
              disabled={pending}
            >
              Retry decision
            </button>
          )}
          <button
            ref={approveRef}
            type="button"
            aria-label="Approve tool call"
            className="px-4 py-2 text-xs font-mono rounded-lg border border-cyan-neon/40 text-cyan-glow hover:bg-cyan-neon/10 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => onApproveRef.current()}
            disabled={pending}
          >
            Approve  (Enter)
          </button>
        </div>
        <p className="text-[10px] font-mono text-bone-faint mt-3">
          Call id: <span className="font-mono">{call_id.slice(0, 12)}</span>
        </p>
      </motion.div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Sessions Panel ──
// ═══════════════════════════════════════════════════════════════

function SessionsPanel({
  sessions, loading, error, runTelemetry, runRecord, activeSession, deleteOperations, onSelect, onNew, onDelete, onRetryDeleteRead, onRefresh,
}: {
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
}) {
  // Free-text filter — case-insensitive subsequence match against name /
  // title / id / model / backend. See `session-filter.ts` for the contract.
  const [filterQuery, setFilterQuery] = useState('');
  // Which Session's recorded-run history is expanded (one at a time).
  const [expandedRuns, setExpandedRuns] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const filteredSessions = filterSessions(sessions, filterQuery);
  const isFiltering = filterQuery.trim().length > 0;
  const pendingDelete = sessions.find(session => session.id === pendingDeleteId);

  useEffect(() => {
    if (pendingDeleteId && !pendingDelete) setPendingDeleteId(null);
  }, [pendingDelete, pendingDeleteId]);

  const openDelete = (session: JarvisSession, e: React.MouseEvent) => {
    e.stopPropagation();
    if (sessionDeleteLocked(deleteOperations[session.id])) return;
    setPendingDeleteId(session.id);
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    setPendingDeleteId(null);
    onDelete(pendingDelete);
  };

  return (
    <div className="h-full flex flex-col">
      <ConfirmModal
        open={pendingDelete !== undefined}
        message={`Delete session "${pendingDelete?.name || pendingDelete?.title || pendingDelete?.id}"?`}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeleteId(null)}
      />
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-bone tracking-tight">
          Sessions <span className="text-bone-font text-sm font-mono">{formatFilterResultCount(filteredSessions.length, sessions.length)}</span>
        </h2>
        <div className="flex gap-2">
          <button
            onClick={onRefresh}
            aria-label="Refresh sessions"
            disabled={loading}
            className="px-3 py-1 text-xs font-mono text-bone-dim border border-iron/30 rounded-lg hover:border-iron/50 hover:text-bone-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
          >
            ↻ Refresh
          </button>
          <button
            onClick={onNew}
            aria-label="New session"
            className="px-3 py-1 text-xs font-mono text-bone-dim border border-iron/30 rounded-lg hover:border-iron/50 hover:text-bone-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
          >
            + New
          </button>
        </div>
      </div>

      {/* Search input — narrows the list to matches on name / title / id /
          model / backend. Hidden when the session list is empty (no point in
          filtering zero rows). The X button only appears while a query is
          active, so the empty input takes the same visual space as before. */}
      {sessions.length > 0 && (
        <div className="mb-3 flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Filter by name, model, or id…"
              aria-label="Filter sessions"
              data-testid="sessions-filter-input"
              className="w-full px-3 py-1.5 pr-7 text-xs font-mono text-bone bg-iron/10 border border-iron/30 rounded-lg placeholder:text-bone-faint focus:outline-none focus:border-cyan-neon/40 focus:ring-1 focus:ring-cyan-neon/30"
            />
            {isFiltering && (
              <button
                type="button"
                onClick={() => setFilterQuery('')}
                aria-label="Clear filter"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-bone-faint hover:text-bone-dim text-xs font-mono px-1 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-neon/40"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-2">
        {loading && (
          <div role="status">
            <LoadingState message={sessions.length > 0 ? 'Refreshing sessions…' : 'Loading sessions…'} />
          </div>
        )}
        {error && (
          <div role="alert">
            <ErrorState
              error={`Could not load sessions. ${sessions.length > 0 ? 'Showing previously loaded sessions; they may be out of date. ' : ''}${error}`}
              onRetry={onRefresh}
            />
          </div>
        )}
        {/* Announced summary of the run-outcome read. Native error detail is
            never shown here: the message is fixed and the per-row marker
            carries the state. */}
        {runTelemetry.state === 'unavailable' && !loading && sessions.length > 0 && (
          <div role="alert" className="text-xs text-amber-200/90 font-mono">
            {RUN_TELEMETRY_UNAVAILABLE_MESSAGE}{' '}
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              aria-label="Retry run outcomes"
              className="underline disabled:opacity-40"
            >
              Retry run outcomes
            </button>
          </div>
        )}
        {sessions.length === 0 && (loading || error) ? null : sessions.length === 0 ? (
          <div className="flex items-center justify-center h-48">
            <div className="text-center">
              <p className="text-bone-dim text-sm font-mono">No sessions yet</p>
              <p className="text-bone-faint text-xs font-mono mt-1">Start a chat to create one</p>
            </div>
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="flex items-center justify-center h-48">
            <div className="text-center">
              <p className="text-bone-dim text-sm font-mono">No sessions match "{filterQuery}"</p>
              <p className="text-bone-faint text-xs font-mono mt-1">Try a different name, model, or id prefix</p>
            </div>
          </div>
        ) : (
          filteredSessions.map(session => {
            const operation = deleteOperations[session.id];
            const deleteLocked = sessionDeleteLocked(operation);
            const outcome = sessionOutcomeView(runTelemetry, session.id);
            // A turn whose run record was never confirmed must not read as a
            // Session that ran cleanly, even when the durable read is honest
            // about finding no run for it.
            const unconfirmedRun = runRecord?.intent.sessionId === session.id
              && runRecord.phase !== 'confirmed';
            return (
            <GlassCard
              key={session.id}
              className={cn(activeSession === session.id && 'border-royal/40 bg-royal/10')}
              onClick={() => onSelect(session.id)}
            >
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onSelect(session.id); }}
                  aria-label={`Select session ${session.name || session.title || session.id}`}
                  aria-pressed={activeSession === session.id}
                  aria-current={activeSession === session.id ? 'true' : undefined}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
                >
                  <StatusDot ok={activeSession === session.id} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-semibold text-bone truncate">{session.name || session.title || 'Untitled'}</span>
                      <Pill>{session.model}</Pill>
                    </div>
                    <div className="text-[11px] font-mono text-bone-faint">
                      {session.message_count} msgs · {new Date(session.created_at).toLocaleDateString()}
                      {outcome.kind === 'recorded' && (
                        <span className="ml-2">
                          ·{' '}
                          <span
                            className={cn(
                              outcome.run.outcome === 'success' && 'text-emerald-400',
                              outcome.run.outcome === 'partial' && 'text-amber-400',
                              outcome.run.outcome === 'failed' && 'text-error',
                              outcome.run.outcome === 'timed_out' && 'text-amber-400',
                              outcome.run.outcome === 'cancelled' && 'text-bone-dim',
                            )}
                          >
                            {outcome.run.outcome}
                          </span>
                          {outcome.run.selected_model && (
                            <span className="ml-1 text-bone-faint">({outcome.run.selected_model})</span>
                          )}
                          {/* The durable run_id, so an operator can match this
                              row against the run the turn reported. */}
                          <span className="ml-1 text-bone-faint">· run {outcome.run.run_id}</span>
                          {outcome.olderCount > 0 && (
                            <span className="ml-1 text-bone-faint">
                              · {outcome.olderCount} older {outcome.olderCount === 1 ? 'run' : 'runs'}
                            </span>
                          )}
                        </span>
                      )}
                      {outcome.kind === 'not_recorded' && (
                        <>
                          {' · '}
                          <span>{RUN_NOT_RECORDED_TEXT}</span>
                        </>
                      )}
                      {outcome.kind === 'unavailable' && (
                        <>
                          {' · '}
                          <span className="text-amber-400">{RUN_OUTCOME_UNAVAILABLE_TEXT}</span>
                        </>
                      )}
                      {outcome.kind === 'pending' && (
                        <>
                          {' · '}
                          <span>{RUN_OUTCOME_PENDING_TEXT}</span>
                        </>
                      )}
                      {unconfirmedRun && (
                        <>
                          {' · '}
                          <span className="text-amber-400">{RUN_ROW_UNCONFIRMED_TEXT}</span>
                        </>
                      )}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={(e) => openDelete(session, e)}
                  disabled={deleteLocked}
                  aria-label={`Delete session ${session.name || session.title || session.id}`}
                  className="text-bone-faint hover:text-error text-xs font-mono transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/50 rounded px-1 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ✕
                </button>
              </div>
              {operation?.phase === 'writing' && <div role="status" className="mt-1.5 text-xs text-bone/60">Deleting session…</div>}
              {operation?.phase === 'reconciling' && <div role="status" className="mt-1.5 text-xs text-bone/60">Deletion saved. Confirming session removal…</div>}
              {operation?.phase === 'write-failed' && (
                <div role="alert" className="mt-1.5 text-xs text-red-200">
                  Could not delete the Session. The previous row was kept.{' '}
                  <button type="button" onClick={(e) => { e.stopPropagation(); setPendingDeleteId(session.id); }} className="underline">Retry</button>
                </div>
              )}
              {operation?.phase === 'read-failed' && (
                <div role="alert" className="mt-1.5 text-xs text-red-200">
                  Deletion was saved, but the Session list could not confirm removal. Showing the previous row; it may be stale. Retry reloads the list only.{' '}
                  <button type="button" onClick={(e) => { e.stopPropagation(); onRetryDeleteRead(session.id); }} disabled={loading} className="underline disabled:opacity-40">Retry</button>
                </div>
              )}
              {/* Per-Session run history, read through Native's own per-Session
                  command. Collapsed by default so the list keeps its density. */}
              <div className="mt-1">
                <button
                  type="button"
                  aria-expanded={expandedRuns === session.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedRuns(current => (current === session.id ? null : session.id));
                  }}
                  className="text-[11px] font-mono text-bone-faint underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
                >
                  {expandedRuns === session.id ? 'Hide recorded runs' : 'Show recorded runs'}
                </button>
                {expandedRuns === session.id && <SessionRunsView sessionId={session.id} />}
              </div>
            </GlassCard>
            );
          })
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Config Panel ──
// ═══════════════════════════════════════════════════════════════

function ConfigPanel({ config, setConfig, loading, loadError, onRetry }: {
  config: JarvisConfig | null;
  setConfig: (c: JarvisConfig | null) => void;
  loading: boolean;
  loadError: boolean;
  onRetry: () => void;
}) {
  const [localConfig, setLocalConfig] = useState<JarvisConfig | null>(config);
  const [savedConfig, setSavedConfig] = useState<JarvisConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const savePending = useRef(false);
  const saved = savedConfig !== null && savedConfig === localConfig;
  const [showApiKeys, setShowApiKeys] = useState(false);

  useEffect(() => {
    setLocalConfig(config);
  }, [config]);

  const handleSave = async () => {
    if (!localConfig || savePending.current) return;
    const submittedConfig = localConfig;
    savePending.current = true;
    setSaving(true);
    setSaveError(false);
    setSavedConfig(null);
    try {
      await invoke('jarvis_save_config', { config: submittedConfig });
      setConfig(submittedConfig);
      setSavedConfig(submittedConfig);
    } catch {
      // Native errors may contain configuration values; never display or log them.
      setSaveError(true);
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };

  const updateField = <K extends keyof JarvisConfig>(key: K, value: JarvisConfig[K]) => {
    if (!localConfig) return;
    setLocalConfig({ ...localConfig, [key]: value });
  };

  if (!localConfig) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 h-48">
        {loading && <p role="status" className="text-bone-dim text-sm font-mono">Loading config...</p>}
        {loadError && (
          <div role="alert" className="text-error text-xs font-mono text-center">
            <p>Could not load config. Retry to load configuration.</p>
            <button
              onClick={onRetry}
              disabled={loading}
              aria-label="Retry config"
              className="mt-2 px-3 py-1.5 border border-error/30 rounded-lg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/50"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pr-1">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-bone tracking-tight">Configuration</h2>
        <button
          onClick={handleSave}
          disabled={saving}
          className={cn(
            'px-4 py-1.5 text-xs font-mono rounded-lg border transition-all disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50',
            saved
              ? 'bg-cyan-neon/20 text-cyan-glow border-cyan-neon/40'
              : 'bg-royal/20 text-royal-light border-royal/40 hover:bg-royal/30'
          )}
        >
          {saving ? 'Saving...' : saved ? '✓ Saved' : 'Save Config'}
        </button>
      </div>

      {saving && <p role="status" className="mb-4 text-bone-dim text-xs font-mono">Saving config...</p>}
      {saved && <p role="status" className="mb-4 text-cyan-glow text-xs font-mono">Config saved.</p>}
      {saveError && (
        <div role="alert" className="mb-4 p-3 bg-error/10 border border-error/30 rounded-xl text-error text-xs font-mono">
          <p>Could not save config. Your edits are preserved. Retry to save configuration.</p>
          <button
            onClick={handleSave}
            disabled={saving}
            aria-label="Retry save config"
            className="mt-2 px-3 py-1.5 border border-error/30 rounded-lg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/50"
          >
            Retry
          </button>
        </div>
      )}

      {/* Freeze the submitted draft until native persistence resolves. */}
      <fieldset disabled={saving} aria-label="Configuration settings" className="space-y-4 min-w-0 border-0 p-0 m-0">
        {/* Backend Selection */}
        <GlassCard hoverable={false}>
          <h3 className="text-sm font-semibold text-bone mb-3">Backend</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <button
              onClick={() => updateField('active_backend', 'ollama')}
              className={cn(
                'flex-1 px-4 py-3 rounded-xl border text-sm font-mono transition-all text-center',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50',
                localConfig.active_backend === 'ollama'
                  ? 'bg-cyan-neon/15 border-cyan-neon/40 text-cyan-glow'
                  : 'bg-obsidian/40 border-iron/30 text-bone-dim hover:border-iron/50'
              )}
            >
              <div className="font-semibold">Ollama</div>
              <div className="text-[10px] text-bone-faint mt-0.5">Local models</div>
            </button>
            <button
              onClick={() => updateField('active_backend', 'llama_cpp')}
              className={cn(
                'flex-1 px-4 py-3 rounded-xl border text-sm font-mono transition-all text-center',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50',
                localConfig.active_backend === 'llama_cpp'
                  ? 'bg-cyan-neon/15 border-cyan-neon/40 text-cyan-glow'
                  : 'bg-obsidian/40 border-iron/30 text-bone-dim hover:border-iron/50'
              )}
            >
              <div className="font-semibold">Gemma 4 · llama.cpp</div>
              <div className="text-[10px] font-mono text-bone-faint mt-0.5">Local · 26B-A4B</div>
            </button>
            <button
              onClick={() => updateField('active_backend', 'openrouter')}
              className={cn(
                'flex-1 px-4 py-3 rounded-xl border text-sm font-mono transition-all text-center',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50',
                localConfig.active_backend === 'openrouter'
                  ? 'bg-royal/15 border-royal/40 text-royal-light'
                  : 'bg-obsidian/40 border-iron/30 text-bone-dim hover:border-iron/50'
              )}
            >
              <div className="font-semibold">OpenRouter</div>
              <div className="text-[10px] text-bone-faint mt-0.5">Cloud models</div>
            </button>
          </div>
        </GlassCard>

        <GlassCard hoverable={false}>
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <h3 className="text-sm font-semibold text-bone">Provider API Keys</h3>
              <p className="text-[10px] font-mono text-bone-faint mt-1">Used by the runtime fallback cascade; save before starting a chat.</p>
            </div>
            <button
              onClick={() => setShowApiKeys(!showApiKeys)}
              aria-label={showApiKeys ? 'Hide provider API keys' : 'Show provider API keys'}
              className="text-[10px] font-mono text-bone-dim hover:text-bone-muted transition-colors px-1.5 py-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
            >
              {showApiKeys ? 'Hide keys' : 'Show keys'}
            </button>
          </div>
          <div className="space-y-3">
            <div>
              <label className="text-[10px] font-mono text-bone-dim block mb-1">OpenRouter API key</label>
              <input
                type={showApiKeys ? 'text' : 'password'}
                value={localConfig.openrouter?.api_key ?? ''}
                onChange={(e) => setLocalConfig(prev => prev ? { ...prev, openrouter: { ...prev.openrouter, api_key: e.target.value } } : prev)}
                placeholder="sk-or-v1-..."
                className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-bone-dim block mb-1">OpenCode Go API key</label>
              <input
                type={showApiKeys ? 'text' : 'password'}
                value={localConfig.opencode_go?.api_key ?? ''}
                onChange={(e) => setLocalConfig(prev => prev ? { ...prev, opencode_go: { ...prev.opencode_go, api_key: e.target.value } } : prev)}
                placeholder="OpenCode Go key"
                className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-bone-dim block mb-1">OpenCode Zen API key</label>
              <input
                type={showApiKeys ? 'text' : 'password'}
                value={localConfig.opencode_zen?.api_key ?? ''}
                onChange={(e) => setLocalConfig(prev => prev ? { ...prev, opencode_zen: { ...prev.opencode_zen, api_key: e.target.value } } : prev)}
                placeholder="OpenCode Zen key"
                className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
              />
            </div>
          </div>
        </GlassCard>

        <GlassCard hoverable={false}>
          <h3 className="text-sm font-semibold text-bone mb-3">OpenCode first-token timeout</h3>
          <p className="text-[10px] font-mono text-bone-faint mb-3">After this many milliseconds with no response bytes, Jarvis abandons that provider and advances the fallback cascade.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-mono text-bone-dim block mb-1">OpenCode Go (ms)</label>
              <input
                type="number"
                min={1000}
                step={1000}
                value={localConfig.opencode_go?.first_token_timeout_ms ?? 45000}
                onChange={(e) => setLocalConfig(prev => prev ? { ...prev, opencode_go: { ...prev.opencode_go, first_token_timeout_ms: Math.max(1000, Number(e.target.value) || 45000) } } : prev)}
                className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone focus:outline-none focus:border-royal/50 transition-colors"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-bone-dim block mb-1">OpenCode Zen (ms)</label>
              <input
                type="number"
                min={1000}
                step={1000}
                value={localConfig.opencode_zen?.first_token_timeout_ms ?? 45000}
                onChange={(e) => setLocalConfig(prev => prev ? { ...prev, opencode_zen: { ...prev.opencode_zen, first_token_timeout_ms: Math.max(1000, Number(e.target.value) || 45000) } } : prev)}
                className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone focus:outline-none focus:border-royal/50 transition-colors"
              />
            </div>
          </div>
        </GlassCard>

        {/* Model Selection */}
        <GlassCard hoverable={false}>
          <h3 className="text-sm font-semibold text-bone mb-3">Model</h3>
          {localConfig.active_backend === 'openrouter' ? (
            <div className="space-y-2">
              <select
                value={localConfig.openrouter.model}
                onChange={(e) => updateField('openrouter', { ...localConfig.openrouter, model: e.target.value })}
                className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone focus:outline-none focus:border-royal/50 transition-colors"
              >
                <option value="">Custom model...</option>
                {OPENROUTER_MODELS.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.pricing}) — {m.description}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={localConfig.openrouter.model}
                onChange={(e) => updateField('openrouter', { ...localConfig.openrouter, model: e.target.value })}

                placeholder="Enter custom model ID"
                className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
              />
            </div>
          ) : localConfig.active_backend === 'llama_cpp' ? (
            <div className="space-y-2">
              <input
                type="text"
                value={localConfig.llama_cpp?.model ?? ''}
                onChange={(e) => updateField('llama_cpp', { ...localConfig.llama_cpp, model: e.target.value })}
                placeholder="Gemma llama.cpp model alias"
                className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
              />
              {([
                ['server_path', 'llama-server executable path (or JARVIS_LLAMA_SERVER_PATH)'],
                ['model_path', 'GGUF model file path (or JARVIS_LLAMA_MODEL_PATH)'],
                ['mtp_path', 'Optional MTP draft head path (or JARVIS_LLAMA_MTP_PATH)'],
              ] as const).map(([field, placeholder]) => (
                <input
                  key={field}
                  type="text"
                  aria-label={`llama.cpp ${field}`}
                  value={localConfig.llama_cpp?.[field] ?? ''}
                  onChange={(e) => updateField('llama_cpp', { ...localConfig.llama_cpp, [field]: e.target.value })}
                  placeholder={placeholder}
                  className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
                />
              ))}
              <div className="text-[10px] font-mono text-bone-faint">Server: {localConfig.llama_cpp?.base_url ?? 'http://127.0.0.1:8080/v1'} · context {localConfig.llama_cpp?.context_window ?? 16384} · reasoning budget {localConfig.llama_cpp?.reasoning_budget ?? 1536}</div>
            </div>
          ) : (
            <input
              type="text"
              value={localConfig.ollama.model}
              onChange={(e) => updateField('ollama', { ...localConfig.ollama, model: e.target.value })}
              placeholder="e.g., qwen2.5-coder:7b"
              className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
            />
          )}
        </GlassCard>

        <GlassCard hoverable={false}>
          <h3 className="text-sm font-semibold text-bone mb-1">Orchestration Runtime</h3>
          <p className="text-[10px] font-mono text-bone-faint mb-3">
            Runs coordinator, tool, review, and synthesis stages. Turn it off for a faster single-pass response.
          </p>
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-bone-dim">
              {localConfig.orchestrator?.enabled ? 'Multi-stage orchestration' : 'Single-pass runtime'}
            </span>
            <button
              onClick={() => updateField('orchestrator', {
                ...localConfig.orchestrator,
                enabled: !localConfig.orchestrator?.enabled,
              })}
              aria-pressed={Boolean(localConfig.orchestrator?.enabled)}
              aria-label="Toggle orchestration runtime"
              className={cn(
                'w-10 h-5 rounded-full transition-colors relative',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50',
                localConfig.orchestrator?.enabled ? 'bg-cyan-neon/40' : 'bg-iron/40'
              )}
            >
              <motion.div
                className={cn('w-4 h-4 rounded-full absolute top-0.5', localConfig.orchestrator?.enabled ? 'bg-cyan-neon' : 'bg-bone-dim')}
                animate={{ left: localConfig.orchestrator?.enabled ? 22 : 2 }}
                transition={{ duration: 0.15 }}
              />
            </button>
          </div>
        </GlassCard>

        {/* Base URLs */}
        <GlassCard hoverable={false}>
          <h3 className="text-sm font-semibold text-bone mb-3">Base URLs</h3>
          <div className="space-y-3">
            <div>
              <label className="text-[10px] font-mono text-bone-dim block mb-1">Ollama URL</label>
              <input
                type="text"
                value={localConfig.ollama.base_url}
                onChange={(e) => updateField('ollama', { ...localConfig.ollama, base_url: e.target.value })}
                className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-bone-dim block mb-1">OpenRouter URL</label>
              <input
                type="text"
                value={localConfig.openrouter.base_url}
                onChange={(e) => updateField('openrouter', { ...localConfig.openrouter, base_url: e.target.value })}
                className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
              />
            </div>
          </div>
        </GlassCard>

        {/* System Prompt */}
        <GlassCard hoverable={false}>
          <h3 className="text-sm font-semibold text-bone mb-3">System Prompt</h3>
          <textarea
            value={localConfig.system_prompt}
            onChange={(e) => updateField('system_prompt', e.target.value)}
            rows={4}
            className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors resize-none"
          />
        </GlassCard>

        {/* Bridge Settings */}
        <GlassCard hoverable={false}>
          <h3 className="text-sm font-semibold text-bone mb-3">Bridge</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-bone-dim">Enable Bridge</span>
              <button
                onClick={() => updateField('bridge_enabled', !localConfig.bridge_enabled)}
                aria-pressed={localConfig.bridge_enabled}
                aria-label="Toggle bridge"

                className={cn(
                  'w-10 h-5 rounded-full transition-colors relative',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50',
                  localConfig.bridge_enabled ? 'bg-cyan-neon/40' : 'bg-iron/40'
                )}
              >
                <motion.div
                  className={cn('w-4 h-4 rounded-full absolute top-0.5', localConfig.bridge_enabled ? 'bg-cyan-neon' : 'bg-bone-dim')}
                  animate={{ left: localConfig.bridge_enabled ? 22 : 2 }}
                  transition={{ duration: 0.15 }}
                />
              </button>
            </div>
            <div>
              <label className="text-[10px] font-mono text-bone-dim block mb-1">Bridge Port</label>
              <input
                type="number"
                value={localConfig.bridge_port}
                onChange={(e) => updateField('bridge_port', parseInt(e.target.value) || 19876)}
                className="w-32 px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone focus:outline-none focus:border-royal/50 transition-colors"
              />
            </div>
          </div>
        </GlassCard>

        {/* Jarvis Path (read-only) */}
        <GlassCard hoverable={false}>
          <h3 className="text-sm font-semibold text-bone mb-3">Jarvis Path</h3>
          <input
            type="text"
            value={localConfig.jarvis_path}
            readOnly
            className="w-full px-3 py-2 text-xs font-mono bg-obsidian/30 border border-iron/20 rounded-lg text-bone-faint cursor-not-allowed"
          />
          <p className="text-[10px] font-mono text-bone-faint mt-1">Auto-detected from workspace</p>
        </GlassCard>

        {/* Web Search Provider */}
        <GlassCard hoverable={false}>
          <h3 className="text-sm font-semibold text-bone mb-3">Web Search Provider</h3>
          <p className="text-[10px] font-mono text-bone-faint mb-3">
            DuckDuckGo needs no key. Brave/Tavily are higher quality but require a key — with a
            provider selected and no key set, search silently falls back to DuckDuckGo.
          </p>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {(['duckduckgo', 'brave', 'tavily'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setLocalConfig(prev => prev ? { ...prev, web_search: { ...prev.web_search, provider: p } } : prev)}
                className={cn(
                  'px-3 py-2 rounded-xl border text-xs font-mono transition-all text-center capitalize',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50',
                  localConfig.web_search.provider === p
                    ? 'bg-cyan-neon/15 border-cyan-neon/40 text-cyan-glow'
                    : 'bg-obsidian/40 border-iron/30 text-bone-dim hover:border-iron/50'
                )}
              >
                {p}
              </button>
            ))}
          </div>
          {localConfig.web_search.provider !== 'duckduckgo' && (
            <div className="space-y-3">
              {localConfig.web_search.provider === 'brave' && (
                <div>
                  <label className="text-[10px] font-mono text-bone-dim block mb-1">Brave API key</label>
                  <input
                    type="password"
                    value={localConfig.web_search.brave_api_key}
                    onChange={(e) => setLocalConfig(prev => prev ? { ...prev, web_search: { ...prev.web_search, brave_api_key: e.target.value } } : prev)}
                    placeholder="Brave Search API key"
                    className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
                  />
                </div>
              )}
              {localConfig.web_search.provider === 'tavily' && (
                <div>
                  <label className="text-[10px] font-mono text-bone-dim block mb-1">Tavily API key</label>
                  <input
                    type="password"
                    value={localConfig.web_search.tavily_api_key}
                    onChange={(e) => setLocalConfig(prev => prev ? { ...prev, web_search: { ...prev.web_search, tavily_api_key: e.target.value } } : prev)}
                    placeholder="Tavily API key"
                    className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
                  />
                </div>
              )}
            </div>
          )}
        </GlassCard>

        {/* Shell / bash resolution */}
        <GlassCard hoverable={false}>
          <h3 className="text-sm font-semibold text-bone mb-3">Shell</h3>
          <div className="space-y-3">
            <div>
              <label className="text-[10px] font-mono text-bone-dim block mb-1">
                Bash interpreter path <span className="text-bone-faint">(blank = auto-resolve Git Bash)</span>
              </label>
              <input
                type="text"
                value={localConfig.tools.bash_path}
                onChange={(e) => setLocalConfig(prev => prev ? { ...prev, tools: { ...prev.tools, bash_path: e.target.value } } : prev)}
                placeholder="C:\Program Files\Git\bin\bash.exe"
                className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
              />
              <p className="text-[10px] font-mono text-bone-faint mt-1">
                Never point this at System32\bash.exe — that is the WSL launcher, not Git Bash, and
                resolves paths in a different filesystem namespace.
              </p>
            </div>
            <div>
              <label className="text-[10px] font-mono text-bone-dim block mb-1">Shell timeout ceiling (ms)</label>
              <input
                type="number"
                min={1000}
                step={1000}
                value={localConfig.tools.shell_timeout_max_ms}
                onChange={(e) => setLocalConfig(prev => prev ? { ...prev, tools: { ...prev.tools, shell_timeout_max_ms: Math.max(1000, Number(e.target.value) || 120000) } } : prev)}
                className="w-40 px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone focus:outline-none focus:border-royal/50 transition-colors"
              />
            </div>
          </div>
        </GlassCard>

        {/* Claude CLI auth mode — the free-routing imperative lives here */}
        <GlassCard hoverable={false}>
          <h3 className="text-sm font-semibold text-bone mb-3">Claude CLI Auth Mode</h3>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <button
              onClick={() => setLocalConfig(prev => prev ? { ...prev, claude_cli: { ...prev.claude_cli, auth_mode: 'proxy' } } : prev)}
              className={cn(
                'px-4 py-3 rounded-xl border text-sm font-mono transition-all text-center',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50',
                localConfig.claude_cli.auth_mode === 'proxy'
                  ? 'bg-cyan-neon/15 border-cyan-neon/40 text-cyan-glow'
                  : 'bg-obsidian/40 border-iron/30 text-bone-dim hover:border-iron/50'
              )}
            >
              <div className="font-semibold">Proxy</div>
              <div className="text-[10px] text-bone-faint mt-0.5">Free — local Ollama / OpenRouter</div>
            </button>
            <button
              onClick={() => setLocalConfig(prev => prev ? { ...prev, claude_cli: { ...prev.claude_cli, auth_mode: 'subscription' } } : prev)}
              className={cn(
                'px-4 py-3 rounded-xl border text-sm font-mono transition-all text-center',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50',
                localConfig.claude_cli.auth_mode === 'subscription'
                  ? 'bg-red-500/15 border-red-500/40 text-red-200'
                  : 'bg-obsidian/40 border-iron/30 text-bone-dim hover:border-iron/50'
              )}
            >
              <div className="font-semibold">Subscription</div>
              <div className="text-[10px] text-bone-faint mt-0.5">Spends your Claude quota</div>
            </button>
          </div>
          {localConfig.claude_cli.auth_mode === 'subscription' && (
            <div className="px-3 py-2.5 rounded-lg border bg-red-500/10 border-red-500/30 text-red-100 text-xs font-mono flex items-start gap-2">
              <span className="text-sm leading-none mt-0.5">⚠</span>
              <span>
                Subscription mode bypasses the free local proxy and talks to Anthropic directly —
                every request here spends your Claude subscription quota. The automated executor
                delegate always refuses subscription mode and falls back to the free native path
                regardless of this setting, so this only affects manual/interactive CLI use.
              </span>
            </div>
          )}
        </GlassCard>
      </fieldset>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Status Panel ──
// ═══════════════════════════════════════════════════════════════

function StatusPanel({ status, loading, loadError, onRefresh }: {
  status: JarvisStatus | null;
  loading: boolean;
  loadError: boolean;
  onRefresh: () => void;
}) {
  const loadFeedback = (
    <div className="space-y-3">
      {loading && (
        <p role="status" className="text-bone-dim text-sm font-mono">
          {status ? 'Refreshing status...' : 'Loading status...'}
        </p>
      )}
      {loadError && (
        <div role="alert" className="p-3 bg-error/10 border border-error/30 rounded-xl text-error text-xs font-mono">
          <p>{status ? 'Could not refresh status. Showing previously loaded status; it may be stale.' : 'Could not load status.'}</p>
          <button
            onClick={onRefresh}
            disabled={loading}
            aria-label="Retry status"
            className="mt-2 px-3 py-1.5 border border-error/30 rounded-lg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/50"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );

  if (!status) {
    return (
      <div className="flex items-center justify-center h-48">
        {loadFeedback}
      </div>
    );
  }

  const isOllama = status.active_backend === 'ollama';
  const isOpenRouter = status.active_backend === 'openrouter';
  const isClaudeCli = status.active_backend === 'claude_cli';

  const serviceItems: { label: string; ok: boolean; desc: string; required: boolean }[] = [
    {
      label: 'Bun Server',
      ok: status.bun_server_running,
      desc: status.bun_server_url,
      required: true,
    },
    {
      label: 'Ollama',
      ok: status.ollama_running,
      desc: isOllama ? `model: ${status.model || '—'}` : 'not required for this backend',
      required: isOllama,
    },
    {
      label: 'Model loaded',
      ok: status.model_available,
      desc: status.model || '—',
      required: isOllama,
    },
    {
      label: 'OpenRouter key',
      ok: status.openrouter_key_set,
      desc: isOpenRouter ? 'API key is set' : 'not required for this backend',
      required: isOpenRouter,
    },
    {
      label: 'Claude proxy',
      ok: status.claude_proxy_running,
      desc: 'port 19878',
      required: isClaudeCli,
    },
    {
      label: 'Bridge',
      ok: status.bridge_active,
      desc: `port ${status.bridge_port}`,
      required: false,
    },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-bone tracking-tight">Status</h2>
          <Pill variant={isOllama ? 'success' : 'info'}>
            {status.active_backend}
          </Pill>
          {status.model && <Pill>{status.model}</Pill>}
        </div>
        <button
          onClick={onRefresh}
          aria-label="Refresh status"
          disabled={loading}
          className="px-3 py-1 text-xs font-mono text-bone-dim border border-iron/30 rounded-lg hover:border-iron/50 hover:text-bone-muted transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
        >
          ↻ Refresh
        </button>
      </div>

      {(loading || loadError) && <div className="mb-4">{loadFeedback}</div>}

      <div className="space-y-2">
        {serviceItems.map(item => (
          <GlassCard key={item.label} hoverable={false} className={cn('py-2.5', !item.required && 'opacity-60')}>
            <div className="flex items-center gap-3">
              <StatusDot ok={item.ok} warn={!item.required && !item.ok} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-bone">{item.label}</span>
                  {item.required && (
                    <Pill variant={item.ok ? 'success' : 'error'}>{item.ok ? 'ok' : 'down'}</Pill>
                  )}
                  {!item.required && (
                    <Pill variant={item.ok ? 'success' : 'default'}>{item.ok ? 'ok' : 'off'}</Pill>
                  )}
                </div>
                <p className="text-[11px] font-mono text-bone-faint mt-0.5 truncate">{item.desc}</p>
              </div>
            </div>
          </GlassCard>
        ))}
      </div>

      {/* Quick actions */}
      <div className="mt-4 flex gap-2">
        <button
          onClick={async () => {
            try { await invoke('jarvis_start_bridge'); onRefresh(); }
            catch (e) { console.error('Failed to start bridge:', e); }
          }}
          className="px-3 py-1.5 text-xs font-mono text-cyan-glow border border-cyan-neon/30 rounded-lg hover:bg-cyan-neon/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
        >
          Start Bridge
        </button>
        <button
          onClick={async () => {
            try { await invoke('jarvis_stop_bridge'); onRefresh(); }
            catch (e) { console.error('Failed to stop bridge:', e); }
          }}
          className="px-3 py-1.5 text-xs font-mono text-error border border-error/30 rounded-lg hover:bg-error/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/50"
        >
          Stop Bridge
        </button>
        {isOllama && (
          <button
            onClick={async () => {
              try { await invoke('jarvis_restart_ollama'); onRefresh(); }
              catch (e) { console.error('Failed to restart Ollama:', e); }
            }}
            className="px-3 py-1.5 text-xs font-mono text-amber-300 border border-amber-400/30 rounded-lg hover:bg-amber-400/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
          >
            Restart Ollama
          </button>
        )}
      </div>
    </div>
  );
}
