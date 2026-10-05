import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { cn, ConfirmModal, EmptyState, LoadingState, ErrorState } from '../ui';
import type { CompanionState } from './types';
import {
  JarvisSession, JarvisMessage, JarvisConfig, JarvisStatus,
  OPENROUTER_MODELS,
  type AgentOption,
  type SessionMemorySelection,
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
import MemoryScopeControls from './MemoryScopeControls';
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
  captureReceiptState,
  decodeCaptureReceipt,
  type CaptureReceipt,
  type CaptureStateView,
} from './memory-capture-state';
import MemoryTurnStatus, { type MemorySourceMessage } from './MemoryTurnStatus';
import { decodeSessionContinuity, RESUME_OBJECTIVE_DIRECTIVE, type SessionContinuity } from './memory-control-state';
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

/**
 * Decode the native `MemoryScope` read-back from `memory_bind_session_workspace`
 * or `jarvis_new_session`. A malformed/absent result is never treated as a
 * confirmed binding. Only the canonical native value is accepted; the UI never
 * fabricates `project_root`.
 */
function decodeBoundScope(value: unknown): { kind: string; agent_id: string; project_root: string | null } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== 'string' || typeof record.agent_id !== 'string') return null;
  if (record.project_root !== null && typeof record.project_root !== 'string') return null;
  return { kind: record.kind, agent_id: record.agent_id, project_root: record.project_root ?? null };
}

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
  /**
   * Native-registered Goal run binding id for this turn, or null. This is a
   * correlation identity only: native verifies its own registration plus the
   * owned Bun child's consume receipt before associating a Goal. The UI never
   * supplies a Goal id as authority.
   */
  goalBindingId: string | null;
}

const recordTerminalRun = (payload: RunRecordPayload): Promise<SessionRunWrite> => {
  const base = {
    ...sessionInvokeArgs(payload.sessionId),
    runId: payload.runId,
    outcome: payload.outcome,
    selectedModel: payload.selectedModel,
    tokenCount: payload.tokenCount,
    toolCount: payload.toolCount,
    cancelledReason: payload.cancelledReason,
    partialOutput: payload.partialOutput,
  };
  // A Goal-linked turn uses the Goal-specific command so native can verify the
  // consumed binding receipt; an ordinary turn keeps the unchanged command.
  if (payload.goalBindingId) {
    return invoke('record_goal_terminal_run', {
      ...base,
      bindingId: payload.goalBindingId,
    }).then(
      () => ({ ok: true }) as SessionRunWrite,
      () => ({ ok: false }) as SessionRunWrite,
    );
  }
  return invoke('record_terminal_run', base).then(
    () => ({ ok: true }) as SessionRunWrite,
    () => ({ ok: false }) as SessionRunWrite,
  );
};

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

// Honest, generic capture-status label. The projection states stay exactly
// `saved|pending|unchanged|failed`; these small labels describe the capture
// outcome without claiming that a factual memory row was created or that
// durable state stayed unchanged (a goal replace/clear can change durable
// continuity with saved_count 0 or with a null memory id).
function captureStateLabel(view: CaptureStateView): string {
  switch (view.state) {
    case 'saved':
      return `Saved (${view.savedCount})`;
    case 'pending':
      return 'Capture pending';
    case 'failed':
      return 'Capture failed';
    default:
      return 'No new saved items';
  }
}

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
                sessions={sessions}
                onSessionsChanged={() => { void loadSessions(); }}
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
  sessions = [], onSessionsChanged = () => {},
}: {
  activeSession: string | null;
  setActiveSession: (id: string | null) => void;
  config: JarvisConfig | null;
  backendLabel: string;
  modelLabel: string;
  onSessionCreated: () => void;
  onRunRecordSettled?: (state: RunRecordState | null) => void;
  /** Persisted Session identity projection; optional for older render sites. */
  sessions?: JarvisSession[];
  /** Refresh the persisted Session list after a native binding change. */
  onSessionsChanged?: () => void;
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
  // Phase 3.3 — honest capture status for the current turn. A `saved` state is
  // shown ONLY when a committed native receipt reports saved_count > 0; an
  // error/blocked-only receipt is `failed`. Assistant prose never acknowledges
  // a save.
  const [memoryCaptureState, setMemoryCaptureState] = useState<CaptureStateView | null>(null);
  // Phase 4.4 — full committed receipt and confirmed objective for the turn
  // status panel. The receipt is authoritative only when decoded and identity
  // checked; the objective comes only from a native continuity read.
  const [memoryReceipt, setMemoryReceipt] = useState<CaptureReceipt | null>(null);
  const [memoryContinuity, setMemoryContinuity] = useState<SessionContinuity | null>(null);
  const [memoryContinuityError, setMemoryContinuityError] = useState<string | null>(null);
  const [memoryContinuityPending, setMemoryContinuityPending] = useState(false);
  const [memoryTurnReadError, setMemoryTurnReadError] = useState<string | null>(null);
  // Monotonic token: every Session/turn read (and every Session/turn change)
  // bumps it so a late response from a previous identity is discarded.
  const memoryReadSeqRef = useRef(0);
  // Stable indirection so the finalizer/listener callbacks can request a
  // post-turn read without joining their dependency arrays.
  const refreshMemoryTurnRef = useRef<((sid: string, turnId: string | null) => void) | null>(null);
  // Exact pending explicit continuity operation, captured once at first
  // attempt. `key` is the logical target (Session id + source message id +
  // objective payload) and never includes the revision. An ambiguous set
  // (committed but the response was lost/rejected) keeps this tuple so an
  // unchanged-target retry replays the SAME operation id and expected revision,
  // even if a read-back refreshed the displayed revision. A changed
  // source/objective starts a new operation against the current authoritative
  // continuity. Cleared only on a confirmed decoded native set response.
  const continuityOperationRef = useRef<{
    key: string;
    request: {
      session_id: string;
      expected_revision: number;
      source_message_id: string;
      objective: string | null;
      operation_id: string;
    };
  } | null>(null);
  // Explicit per-turn user-wide opt-in. Default false; cleared whenever the
  // selected Session (and therefore Agent scope) changes so it can never carry
  // silently into a different Session/Agent.
  const [includeUserScope, setIncludeUserScope] = useState(false);
  // Phase 4.2 Session identity. The Agent applies to a Session created on the
  // next send; the project binding is applied to an existing Session through
  // the native command. Both are never inferred from user prose.
  const [sessionAgents, setSessionAgents] = useState<AgentOption[]>([]);
  const [pendingAgentId, setPendingAgentId] = useState('main');
  const [pendingProjectRoot, setPendingProjectRoot] = useState<string | null>(null);
  // A Session created for a first send whose workspace binding then failed.
  // It is reused on retry so a rejected bind never creates a second Session.
  const pendingNewSessionRef = useRef<string | null>(null);
  // Render-visible mirror of `pendingNewSessionRef`. It exists only so the
  // identity controls can lock the Agent selector while that created-but-
  // unbound Session is awaiting retry; the ref stays the value `handleSend`
  // reads. Cleared whenever the pending identity is consumed or abandoned.
  const [pendingNativeSessionId, setPendingNativeSessionId] = useState<string | null>(null);
  // Agent the pending native Session was actually created with, so a retry can
  // never reuse it on behalf of a different displayed Agent selection.
  const pendingNewSessionAgentRef = useRef('main');
  // The owning relay memory turn currently displayed. Used to drop stale
  // warnings/diagnostics when a different relay submission becomes active.
  const memoryOwnerRef = useRef<{ sessionId: string; turnId: string } | null>(null);
  // Phase 3.3 — relay-only aggregate of streamed answer text, held OUTSIDE
  // React state. It backs the legacy (no turn id / unregistered) idle relay
  // terminal persistence path: the native relay owns the append for registered
  // turns, but a legacy terminal must still durably persist its answer from an
  // explicit coordinator rather than from inside a `setMessages` updater.
  const relayAssistantAggregateRef = useRef('');
  // Monotonic conversation epoch. Bumped on every new submission and Session
  // change so an asynchronous legacy relay append can prove it still belongs to
  // the exact turn/session that started it and never rewrites a newer bubble.
  const conversationEpochRef = useRef(0);
  // Registered relay turns whose terminal has already been consumed. Late
  // memory-status/diagnostic/capture events for a settled `{session_id, turn_id}`
  // are rejected so they cannot repaint a finished turn. Bounded: cleared on the
  // owning submission/Session change; keys are only the live registration.
  const settledRelayOwnersRef = useRef<Set<string>>(new Set());

  // Phase 4.4 — one-shot native read of the confirmed objective plus, when a
  // turn identity is known (or the continuity names the latest turn), that
  // turn's authoritative diagnostic and committed capture receipt. Read-only:
  // it never performs capture or exposes recalled text. Every await re-checks a
  // monotonic token and the captured Session so a late response from a switched
  // Session/turn is discarded.
  const refreshMemoryTurn = useCallback(async (sid: string, turnId: string | null) => {
    const seq = ++memoryReadSeqRef.current;
    setMemoryContinuityPending(true);
    setMemoryContinuityError(null);
    setMemoryTurnReadError(null);
    let continuity: SessionContinuity | null = null;
    let continuityFailed = false;
    try {
      continuity = decodeSessionContinuity(await invoke('memory_continuity_read', {
        request: { session_id: sid },
      }));
    } catch {
      continuityFailed = true;
    }
    if (seq !== memoryReadSeqRef.current || !mountedRef.current || activeSessionRef.current !== sid) return;
    setMemoryContinuity(continuity);
    setMemoryContinuityError(continuityFailed ? 'Memory continuity unavailable for this Session.' : null);
    setMemoryContinuityPending(false);

    const readTurn = turnId ?? continuity?.latest_turn_id ?? null;
    if (!readTurn) return;
    let rawDiagnostic: unknown = null;
    let rawReceipt: unknown = null;
    let readFailed = false;
    try {
      rawDiagnostic = await invoke('memory_turn_diagnostic', {
        request: { session_id: sid, turn_id: readTurn },
      });
    } catch {
      readFailed = true;
    }
    try {
      rawReceipt = await invoke('memory_capture_receipts', {
        request: { session_id: sid, turn_id: readTurn },
      });
    } catch {
      readFailed = true;
    }
    if (seq !== memoryReadSeqRef.current || !mountedRef.current || activeSessionRef.current !== sid) return;
    if (readFailed) {
      setMemoryTurnReadError('Memory turn detail unavailable.');
      return;
    }
    try {
      const view = decodeMemoryTurnDiagnostic(rawDiagnostic);
      if (view.turnId === readTurn && view.sessionId === sid) setMemoryDiagnostic(view);
    } catch {
      setMemoryTurnReadError('Memory turn detail unavailable.');
    }
    // A null receipt means unavailable (no committed receipt read), never a
    // confirmed zero-save result. Only the full receipt is updated here: the
    // compact capture status/label is owned by the finalizer/relay handler so a
    // pending or failed capture signal is never clobbered by this read.
    const receipt = decodeCaptureReceipt(rawReceipt);
    if (receipt && receipt.turn_id === readTurn && receipt.session_id === sid) {
      setMemoryReceipt(receipt);
    } else {
      setMemoryReceipt(null);
    }
  }, []);

  useEffect(() => {
    refreshMemoryTurnRef.current = refreshMemoryTurn;
  }, [refreshMemoryTurn]);

  useEffect(() => {
    // A Session change invalidates the previous turn's memory surface and any
    // relay correlation: no old warning/diagnostic may survive it. It also
    // abandons any orphan pending-Session identity from a failed first bind.
    pendingNewSessionRef.current = null;
    pendingNewSessionAgentRef.current = 'main';
    setPendingNativeSessionId(null);
    setIncludeUserScope(false);
    setMemoryLiveStatus(null);
    setMemoryDiagnostic(null);
    setMemoryHistoryWarning(null);
    setMemoryFinalizationNotice(null);
    setMemoryCaptureState(null);
    setMemoryReceipt(null);
    setMemoryContinuity(null);
    setMemoryContinuityError(null);
    setMemoryContinuityPending(false);
    setMemoryTurnReadError(null);
    memoryOwnerRef.current = null;
    relayAssistantAggregateRef.current = '';
    settledRelayOwnersRef.current.clear();
    conversationEpochRef.current += 1;
    // Invalidate any in-flight read from the previous identity, then read the
    // reopened Session's confirmed objective/latest turn once.
    memoryReadSeqRef.current += 1;
    clearRelayMemoryTurn();
    if (activeSession) void refreshMemoryTurn(activeSession, null);
  }, [activeSession, refreshMemoryTurn]);

  // The user-wide opt-in is local to the selected Session/Agent and must never
  // carry silently across an Agent change. It also defaults off on mount and
  // after an app restart because it is never persisted.
  useEffect(() => {
    setIncludeUserScope(false);
  }, [pendingAgentId]);

  // Enabled native Agents for the New Session identity selector. A failed or
  // malformed read leaves the selector at the safe `main` default rather than
  // inventing an Agent.
  useEffect(() => {
    let cancelled = false;
    invoke<unknown>('list_agents')
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        const next: AgentOption[] = [];
        for (const row of rows) {
          if (typeof row !== 'object' || row === null) continue;
          const record = row as Record<string, unknown>;
          if (typeof record.id !== 'string' || typeof record.enabled !== 'boolean') continue;
          next.push({
            id: record.id,
            name: typeof record.name === 'string' ? record.name : undefined,
            enabled: record.enabled,
          });
        }
        setSessionAgents(next);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Roadmap Priority #2 Part 2 — Goal-linked chat. The selected Goal id is a
  // SUGGESTION to native only; native validates the Goal's Session/Agent/scope
  // binding and registers a bounded one-shot binding before the run. The UI
  // never infers scope from the Goal text and never fabricates a Goal link.
  const [goalOptions, setGoalOptions] = useState<Array<{ id: string; objective: string; status: string }>>([]);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  // The native binding id actually registered for the CURRENT turn, captured at
  // stream start. The terminal run record uses ONLY this value, so a Goal
  // selected mid-turn cannot be attributed to an earlier turn.
  const linkedGoalBindingIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<unknown>('goal_list')
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        const next: Array<{ id: string; objective: string; status: string }> = [];
        for (const row of rows) {
          if (typeof row !== 'object' || row === null) continue;
          const record = row as Record<string, unknown>;
          if (typeof record.id !== 'string' || typeof record.objective !== 'string') continue;
          const status = typeof record.status === 'string' ? record.status : 'pending';
          if (status === 'completed' || status === 'failed' || status === 'cancelled') continue;
          next.push({ id: record.id, objective: record.objective, status });
        }
        setGoalOptions(next);
        setSelectedGoalId((prev) => (prev && next.some((g) => g.id === prev) ? prev : null));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

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

  const finalizeAssistantMessage = useCallback((_sid?: string, terminal?: DecodedStreamTerminal) => {
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
    setMessages(prev => {
      const withTokens = applyTokenChunk(prev, pending);
      const messageOutcome: StreamTerminalOutcome | undefined = terminal
        && terminal.outcome !== 'success'
        && terminal.outcome !== 'cancelled'
        ? terminal.outcome
        : undefined;
      return finalizeStreamingMessages(withTokens, messageOutcome, terminal?.code);
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
      // Native-relay aggregate, independent of React state, for the legacy
      // no-turn-id terminal persistence path.
      relayAssistantAggregateRef.current += text;
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

    // Terminal-settlement guard. Once a registered relay terminal is consumed,
    // late memory-status/diagnostic/capture events for the same exact
    // `{session_id, turn_id}` are rejected so they cannot repaint a finished
    // turn. A capture event legitimately arrives BEFORE the terminal and is
    // accepted then frozen. Settlement is bounded: the only registered tuple is
    // the live submission, and the set is cleared on the owning submission /
    // Session change.
    const relayOwnerKey = (sid: string, turnId: string): string => `${sid}\u0000${turnId}`;
    const isRelayOwnerSettled = (sid: unknown, turnId: unknown): boolean => (
      typeof sid === 'string'
      && typeof turnId === 'string'
      && settledRelayOwnersRef.current.has(relayOwnerKey(sid, turnId))
    );
    const markRelayOwnerSettled = (sid: string, turnId: string): void => {
      const settled = settledRelayOwnersRef.current;
      if (settled.size > 32) settled.clear();
      settled.add(relayOwnerKey(sid, turnId));
    };

    // Transcript only: pin the native-owned assistant DB row id onto the local
    // visible bubble so a later history reload dedupes it. Never factual
    // verification.
    const reconcileRelayAssistantId = (sid: string, dbId: string | null): void => {
      if (!dbId || !mountedRef.current || !matchesStreamSession(sid)) return;
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant') {
          return [...prev.slice(0, -1), { ...last, id: dbId }];
        }
        return prev;
      });
    };

    // Legacy idle relay terminal (no turn id, unregistered): the UI still owns
    // the assistant append. The owner epoch + local assistant id are captured
    // BEFORE the await; a completion that lands after a Session/new-turn change
    // makes no UI writes, and the exact originating bubble is reconciled by its
    // stable local id. Registered turns are native-owned and never reach this.
    const persistLegacyRelayAssistant = (sid: string): void => {
      const aggregate = relayAssistantAggregateRef.current;
      relayAssistantAggregateRef.current = '';
      const content = sanitizeAssistantDisplay(aggregate).trim();
      if (!content || !sid) return;
      const ownerEpoch = conversationEpochRef.current;
      const localAssistantId = crypto.randomUUID();
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && !last.id) {
          return [...prev.slice(0, -1), { ...last, id: localAssistantId }];
        }
        return prev;
      });
      void invoke<string>('append_message', {
        ...sessionInvokeArgs(sid),
        role: 'assistant',
        content,
      }).then((dbId) => {
        if (conversationEpochRef.current !== ownerEpoch || !matchesStreamSession(sid)) return;
        if (typeof dbId === 'string' && dbId) {
          setMessages(prev => prev.map((m) => (
            m.id === localAssistantId ? { ...m, id: dbId } : m
          )));
        }
      }).catch((e: any) => {
        if (conversationEpochRef.current !== ownerEpoch || !matchesStreamSession(sid)) return;
        console.error('Failed to persist assistant message:', e);
        setError('Append failed: ' + (e?.message || String(e)));
      });
    };

    track(listen<{
      session_id: string;
      turn_id?: string;
      assistant_message_id?: unknown;
      native_owns_append?: unknown;
    }>('jarvis://done', (event) => {
      const p = event.payload;
      if (!matchesStreamSession(p.session_id)) return;
      if (!relayTerminalIsCorrelated(p.session_id, p.turn_id)) return;
      if (typeof p.turn_id === 'string') markRelayOwnerSettled(p.session_id, p.turn_id);
      dispatchActivity({ kind: 'terminal', outcome: 'success' });
      finalizeAssistantMessage(p.session_id);
      const dbId = typeof p.assistant_message_id === 'string' && p.assistant_message_id.length > 0
        ? p.assistant_message_id
        : null;
      const nativeOwned = p.native_owns_append === true
        || (typeof p.turn_id === 'string' && isRegisteredRelayMemoryTurn(p.session_id, p.turn_id));
      if (!nativeOwned && dbId === null) {
        persistLegacyRelayAssistant(p.session_id);
      } else {
        // Native owns the append (or already persisted): clear the relay
        // aggregate so it cannot leak into a later legacy terminal, and pin
        // the returned row id onto the local bubble. Never a UI duplicate.
        relayAssistantAggregateRef.current = '';
        reconcileRelayAssistantId(p.session_id, dbId);
      }
    }));

    // NOTE (Task 7 / 2026-07-03 incident 1d4727cf): this `jarvis_send_message`
    // / `jarvis://*` Tauri-event path is wired but not currently invoked by
    // the chat UI — `handleSend` uses the direct-fetch `streamFromJarvisApi`
    // path below instead, which has the primary error/cancelled handling.
    // Hardened here too for defense-in-depth in case something re-enables
    // this path. The Rust `SseFrameOutcome::Error` variant only carries a
    // message string, not a `code` (unlike the fetch path's raw JSON
    // frames) — reported as a gap below rather than changing Rust.
    track(listen<{
      error: string;
      session_id: string;
      code?: string;
      turn_id?: string;
      assistant_message_id?: unknown;
    }>('jarvis://error', (event) => {
      const p = event.payload;
      if (!matchesStreamSession(p.session_id)) return;
      if (!relayTerminalIsCorrelated(p.session_id, p.turn_id)) return;
      if (typeof p.turn_id === 'string') markRelayOwnerSettled(p.session_id, p.turn_id);
      const dbId = typeof p.assistant_message_id === 'string' && p.assistant_message_id.length > 0
        ? p.assistant_message_id
        : null;
      const pending = takePendingTokens();
      setIsStreaming(false);
      setPipelineStage('');
      dispatchActivity({ kind: 'terminal', outcome: 'failed' });
      setRecursionDepth(null);
      clearPendingApproval();
      setError(p.error);
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
            content: partial ? last.content : p.error,
            isStreaming: false,
            isError: true,
            errorCode: p.code,
          }];
        }
        return withTokens;
      });
      // A native-owned relay may have persisted the successful answer as an
      // unassociated row (source conflict); reconcile its id, never append.
      relayAssistantAggregateRef.current = '';
      reconcileRelayAssistantId(p.session_id, dbId);
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
      if (typeof event.payload.turn_id === 'string') {
        markRelayOwnerSettled(event.payload.session_id, event.payload.turn_id);
      }
      relayAssistantAggregateRef.current = '';
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
      setMemoryCaptureState(null);
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
      if (isRelayOwnerSettled(p.session_id, p.turn_id)) return;
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
        if (isRelayOwnerSettled(p.session_id, p.turn_id)) return;
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
    // Phase 3.3 — honest relay capture status. A committed receipt is decoded
    // and projected with `captureReceiptState`; a metadata-only error code is
    // `failed` unless it is the bounded `capture_pending` timeout, which stays
    // pending. A committed receipt survives a separated sync/append failure.
    // Assistant prose never acknowledges a save.
    track(listen<{
      session_id?: string;
      turn_id?: string;
      receipt?: unknown;
      error_code?: unknown;
      sync_failed?: unknown;
      append_failed?: unknown;
    }>(
      'jarvis://memory-capture',
      (event) => {
        const p = event.payload;
        if (!matchesStreamSession(p.session_id)) return;
        if (!isRegisteredRelayMemoryTurn(p.session_id, p.turn_id)) return;
        if (isRelayOwnerSettled(p.session_id, p.turn_id)) return;
        bindRelayMemoryOwner(p.session_id as string, p.turn_id as string);
        // Decode and bind the receipt to the exact correlation tuple; a missing
        // or mismatched receipt must never become Saved.
        const decoded = decodeCaptureReceipt(p.receipt);
        const receipt = decoded
          && decoded.turn_id === p.turn_id
          && decoded.session_id === p.session_id
          ? decoded
          : null;
        const errorCode = typeof p.error_code === 'string' ? p.error_code : null;
        setMemoryCaptureState(captureReceiptState(receipt, errorCode));
        setMemoryReceipt(receipt);
        // Read the authoritative full diagnostic/objective for this exact relay
        // turn (read-only; the relay event itself is metadata only).
        if (typeof p.session_id === 'string' && typeof p.turn_id === 'string') {
          refreshMemoryTurnRef.current?.(p.session_id, p.turn_id);
        }
        // Native reports sync/append failures independently from capture; they
        // never fail a committed receipt but stay observable.
        if (p.sync_failed === true) {
          setMemoryFinalizationNotice('Relay memory sync unavailable; showing the ordinary result.');
        } else if (p.append_failed === true) {
          setMemoryFinalizationNotice('Relay assistant transcript not saved; showing the ordinary result.');
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
    assistantClientMessageId: string,
    includeUserScope: boolean,
    goalId: string | null,
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
    setMemoryCaptureState(null);

    let userMessageId: string | null = null;
    let inactivityTimedOut = false;
    let terminal: DecodedStreamTerminal | null = null;

    // The final assistant text this direct turn should persist, and whether the
    // observed terminal permits persistence. Updated by the terminal frame
    // handlers below the finalizer's definition, so the finalizer reads the
    // latest values from this mutable holder. The appended DB id is returned as
    // worker data (never written to React state from the worker).
    const assistantPersist: { text: string; allowed: boolean; done: boolean } = {
      text: '',
      allowed: false,
      done: false,
    };

    // One memoized finalization per local turn, shared by every exit path.
    // Direct UI owns the direct assistant append; the whole sequential
    // append -> sync -> capture attempt shares ONE 5-second race. The worker
    // returns DATA ONLY — it never calls setState or emits. The single winner
    // is published once after the race under the original Session/generation/
    // controller tuple, and the tuple is marked settled so a late worker result
    // (or a timeout) can never repaint. Capture is attempted from the persisted
    // immutable user turn even when append or sync fails, and a committed saved
    // receipt stays Saved even when sync failed.
    let finalizePromise: Promise<boolean> | null = null;
    let finalizeSettled = false;
    const finalizeMemoryTurn = (): Promise<boolean> => {
      if (finalizePromise) return finalizePromise;
      finalizePromise = (async (): Promise<boolean> => {
        if (!userMessageId) return true;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
          timeoutHandle = setTimeout(() => resolve({ kind: 'timeout' }), MEMORY_FINALIZE_TIMEOUT_MS);
        });

        // 1. Direct assistant append, awaited first, with the original turn id.
        // Runs only when the observed terminal permits persistence and nonempty
        // sanitized text exists. 2. Sync. 3. Capture. Each step is independently
        // caught so a failed append or sync still dispatches capture from the
        // immutable saved user source.
        const worker = (async (): Promise<{
          kind: 'settled';
          diagnostic: unknown;
          receipt: unknown;
          appendDbId: string | null;
          appendFailed: boolean;
          syncFailed: boolean;
          captureFailed: boolean;
        }> => {
          let appendDbId: string | null = null;
          let appendFailed = false;
          if (assistantPersist.allowed && !assistantPersist.done) {
            assistantPersist.done = true;
            const text = sanitizeAssistantDisplay(assistantPersist.text).trim();
            if (text) {
              try {
                const dbId = await invoke<string>('append_message', {
                  ...sessionInvokeArgs(sid),
                  role: 'assistant',
                  content: text,
                  memory_turn_id: turnId,
                  memoryTurnId: turnId,
                });
                appendDbId = typeof dbId === 'string' && dbId ? dbId : null;
              } catch (e) {
                appendFailed = true;
                console.error('Failed to persist assistant message:', e);
              }
            }
          }

          let diagnostic: unknown = null;
          let syncFailed = false;
          try {
            diagnostic = await invoke<unknown>('memory_sync_turn', {
              request: { session_id: sid, turn_id: turnId },
            });
          } catch {
            syncFailed = true;
          }

          let receipt: unknown = null;
          let captureFailed = false;
          try {
            receipt = await invoke<unknown>('memory_capture_turn', {
              request: { session_id: sid, turn_id: turnId },
            });
          } catch (e) {
            captureFailed = true;
            console.warn('[Jarvis] memory capture failed:', e);
          }
          return {
            kind: 'settled',
            diagnostic,
            receipt,
            appendDbId,
            appendFailed,
            syncFailed,
            captureFailed,
          };
        })();

        const outcome = await Promise.race([worker, timeout]);
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        if (finalizeSettled) return false;
        finalizeSettled = true;

        if (outcome.kind === 'timeout') {
          if (requestIsCurrent()) {
            setMemoryCaptureState(captureReceiptState(null, 'capture_pending'));
            setMemoryFinalizationNotice('Memory finalization is pending; showing the ordinary result.');
          }
          return false;
        }

        // Publish the one winner under the original tuple checks. A late worker
        // result after a timeout or Session switch is discarded here.
        if (!requestIsCurrent()) return false;

        // Reconcile the actual persisted assistant DB id onto the exact
        // originating local assistant bubble. Only this timely winner reaches
        // here, and only under the original Session/generation/controller guard;
        // a late timeout worker's legitimate DB append is never repainted, and a
        // new turn/Session bubble is never rewritten.
        if (outcome.appendDbId && assistantClientMessageId) {
          const persistedId = outcome.appendDbId;
          setMessages(prev => prev.map((m) => (
            m.id === assistantClientMessageId ? { ...m, id: persistedId } : m
          )));
        }

        // Receipt: decoded and projected independently of sync/append. It must
        // match the immutable original {session_id, turn_id}; a missing or
        // mismatched receipt is not Saved.
        let receipt: CaptureReceipt | null = null;
        if (!outcome.captureFailed) {
          const decoded = decodeCaptureReceipt(outcome.receipt);
          if (decoded && decoded.turn_id === turnId && decoded.session_id === sid) {
            receipt = decoded;
          }
        }
        setMemoryCaptureState(captureReceiptState(receipt, receipt === null ? 'capture_unavailable' : null));
        setMemoryReceipt(receipt);

        // Diagnostic: decoded separately and identity-checked. A sync failure
        // is observable metadata and never fails a committed capture receipt.
        let diagnosticOk = false;
        if (!outcome.syncFailed) {
          try {
            const view = decodeMemoryTurnDiagnostic(outcome.diagnostic);
            if (view.turnId === turnId && view.sessionId === sid) {
              setMemoryDiagnostic(view);
              diagnosticOk = true;
            }
          } catch (e) {
            console.warn('[Jarvis] memory diagnostic read-back failed:', e);
          }
        }
        if (!diagnosticOk) {
          setMemoryFinalizationNotice(
            outcome.syncFailed
              ? 'Memory sync unavailable; showing the ordinary result.'
              : 'Memory status unavailable for this turn.',
          );
        } else if (outcome.appendFailed) {
          setMemoryFinalizationNotice('Assistant transcript not saved; showing the ordinary result.');
        }
        // Read the confirmed objective for this exact Session/turn. This is a
        // read-only native refresh; it never captures or mutates state.
        refreshMemoryTurnRef.current?.(sid, turnId);
        return diagnosticOk;
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

      // 2. Prepare native recall and load native prompt history. References
      // only; no memory text crosses the webview. A failed preparation still
      // runs ordinary inference with a typed status and no preparation
      // reference. A failed/unreadable history read sends empty prior history
      // with a visible warning rather than a stale UI cache.
      //
      // NB: there is deliberately NO stale guard between the saved user append
      // and `memory_prepare_turn`. Even after a Session switch/abort, the newly
      // saved immutable user source must be prepared/bound so the bounded
      // finalizer can capture it with the ORIGINAL turn identity. The stale
      // guard after preparation stops before history/fetch, so no inference is
      // launched for a stale submission.
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

      // Roadmap Priority #2 Part 2 — Goal linkage. Native validates the
      // selected Goal's Session/Agent/canonical-project binding, loads the
      // exact saved user source row already used by `memory_prepare_turn`
      // (`userMessageId`), and registers a bounded one-shot binding for this
      // exact turn. This is INDEPENDENT of memory preparation: a Goal-linked run
      // proceeds even when memory is unavailable. A rejected/unsupported Goal is
      // not silently downgraded — the turn runs goal-less and the UI drops the
      // selection. The UI never supplies a Goal id or hash as authority, and
      // only the returned native binding id is later used for the terminal
      // proof.
      linkedGoalBindingIdRef.current = null;
      if (goalId && userMessageId) {
        try {
          const preparation = await invoke<{
            goal_id?: string;
            turn_id?: string;
            registered?: boolean;
            binding_id?: string;
          }>('goal_prepare_run', {
            goalId,
            sessionId: sid,
            turnId,
            sourceMessageId: userMessageId,
          });
          if (
            preparation
            && preparation.registered === true
            && preparation.goal_id === goalId
            && preparation.turn_id === turnId
            && typeof preparation.binding_id === 'string'
            && preparation.binding_id.length > 0
          ) {
            linkedGoalBindingIdRef.current = preparation.binding_id;
          } else if (requestIsCurrent()) {
            setSelectedGoalId((prev) => (prev === goalId ? null : prev));
          }
        } catch {
          if (requestIsCurrent()) {
            setSelectedGoalId((prev) => (prev === goalId ? null : prev));
          }
        }
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
          // Exact persisted user source row already bound by
          // `goal_prepare_run`, carried only for a registered Goal turn so the
          // server can match it against the native binding. Identity only; the
          // server never treats it as authority and ordinary turns omit it.
          ...(linkedGoalBindingIdRef.current && userMessageId
            ? { source_message_id: userMessageId }
            : {}),
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
        goalBindingId: linkedGoalBindingIdRef.current,
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
        // Record the direct assistant text this turn may persist (and whether
        // the terminal permits it) BEFORE the bounded finalizer runs. A
        // non-success hard error persists nothing.
        assistantPersist.text = streamedRawText;
        assistantPersist.allowed = !decision.hardError;
        if (!streamedVisibleText && decision.text && !decision.hardError) {
          // The orchestrator aggregate never streamed as deltas: hold it as the
          // turn's assistant text in the same accumulator used for persistence.
          streamedRawText += decision.text;
          assistantPersist.text = streamedRawText;
          appendAssistantText(decision.text);
        }
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

  // Phase 4.2 — bind a canonical workspace through the native command and
  // confirm the native read-back. A rejected/malformed result is never a
  // confirmed binding. The native canonicalizer owns path validation; the UI
  // never parses workspace scope from user prose or grant chips.
  const bindWorkspaceForSession = useCallback(async (sid: string, root: string): Promise<boolean> => {
    try {
      const scope = await invoke<unknown>('memory_bind_session_workspace', {
        request: { session_id: sid, workspace_root: root },
      });
      const decoded = decodeBoundScope(scope);
      return decoded !== null && decoded.kind === 'project' && typeof decoded.project_root === 'string' && decoded.project_root.length > 0;
    } catch {
      return false;
    }
  }, []);

  const handleSelectAgent = useCallback((agentId: string) => {
    // Agent selection applies to a future Session only; an existing Session's
    // Agent ownership is immutable. While a created-but-unbound Session is
    // pending retry its Agent is fixed: honoring a change here would let the
    // retry reuse a native Session owned by a different Agent. The visible
    // control is locked in this state; this guard is the authoritative block.
    if (pendingNewSessionRef.current) return;
    setPendingAgentId(agentId);
    setIncludeUserScope(false);
  }, []);

  const handleBindWorkspace = useCallback(async (root: string | null) => {
    const sid = activeSession;
    if (!sid) {
      // Pending New Session: hold the choice; it is applied on first send.
      setPendingProjectRoot(root);
      return;
    }
    if (isStreaming) return;
    try {
      const scope = await invoke<unknown>('memory_bind_session_workspace', {
        request: { session_id: sid, workspace_root: root },
      });
      const decoded = decodeBoundScope(scope);
      const expectedKind = root === null ? 'agent' : 'project';
      if (!decoded || decoded.kind !== expectedKind) {
        throw new Error('invalid binding read-back');
      }
      onSessionsChanged();
    } catch {
      setError('Could not update the Session workspace binding. The previous binding is unchanged.');
    }
  }, [activeSession, isStreaming, onSessionsChanged]);

  // Phase 4.4 — explicit objective set/clear. A new operation is validated
  // natively against the exact persisted user source, the expected continuity
  // revision, and the exact substring rule; success is confirmed only from the
  // decoded native `SessionContinuity` response for the captured Session. On a
  // lost or rejected set response the mutation is ambiguous — it may have
  // committed — so the UI does a read-only current-state refresh and keeps the
  // exact original request tuple so an unchanged-target retry replays the same
  // operation id and expected revision (native replay is idempotent).
  const handleSetObjective = useCallback(async (input: {
    source_message_id: string;
    objective: string | null;
  }) => {
    const sid = activeSession;
    if (!sid || isStreaming) return;
    const continuity = memoryContinuity;
    if (!continuity || continuity.session_id !== sid) {
      setMemoryContinuityError('Objective state unavailable.');
      return;
    }
    // Reuse the captured tuple ONLY for the unchanged logical target. A changed
    // source/objective (or Session) starts a new operation whose expected
    // revision is the current authoritative continuity revision.
    const targetKey = JSON.stringify([sid, input.source_message_id, input.objective]);
    let request = continuityOperationRef.current?.key === targetKey
      ? continuityOperationRef.current.request
      : null;
    if (!request) {
      request = {
        session_id: sid,
        expected_revision: continuity.revision,
        source_message_id: input.source_message_id,
        objective: input.objective,
        operation_id: crypto.randomUUID(),
      };
      continuityOperationRef.current = { key: targetKey, request };
    }
    const seq = ++memoryReadSeqRef.current;
    setMemoryContinuityPending(true);
    setMemoryContinuityError(null);
    try {
      const raw = await invoke<unknown>('memory_continuity_set', { request });
      const decoded = decodeSessionContinuity(raw);
      if (decoded.session_id !== sid) throw new Error('continuity identity mismatch');
      if (seq !== memoryReadSeqRef.current || !mountedRef.current || activeSessionRef.current !== sid) return;
      setMemoryContinuity(decoded);
      setMemoryContinuityError(null);
      setMemoryContinuityPending(false);
      continuityOperationRef.current = null;
    } catch {
      if (seq !== memoryReadSeqRef.current || !mountedRef.current || activeSessionRef.current !== sid) return;
      // Ambiguous: a native commit may have landed before the response was
      // lost/rejected. Refresh the CURRENT continuity for the captured Session
      // as a display-only read; a continuity read carries no operation identity,
      // so it never confirms this operation. The exact pending request tuple is
      // retained for an unchanged-target retry.
      let refreshed: SessionContinuity | null = null;
      try {
        refreshed = decodeSessionContinuity(await invoke('memory_continuity_read', {
          request: { session_id: sid },
        }));
      } catch {
        refreshed = null;
      }
      if (seq !== memoryReadSeqRef.current || !mountedRef.current || activeSessionRef.current !== sid) return;
      if (refreshed && refreshed.session_id === sid) setMemoryContinuity(refreshed);
      setMemoryContinuityError(
        'Could not confirm the active objective update — it may or may not have been saved. Retry to replay this exact request, or change the source/objective to start a new one.',
      );
      setMemoryContinuityPending(false);
    }
  }, [activeSession, isStreaming, memoryContinuity]);

  const handleSend = useCallback(async (overrideText?: unknown) => {
    // Phase 4.4 — Resume passes the exact continuation directive as an explicit
    // override; every other caller passes no argument (a DOM event is ignored).
    // An override never clears or restores the operator's own composer draft.
    const override = typeof overrideText === 'string' && overrideText.trim().length > 0
      ? overrideText.trim()
      : null;
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
    const userMsg = override ?? submittedDraft.text.trim();
    if (!userMsg || isStreaming) {
      sendInFlightRef.current.finish();
      return;
    }
    const sendGeneration = sendGateRef.current.tryAcquire();
    if (sendGeneration === null) {
      sendInFlightRef.current.finish();
      return;
    }
    stopRequestedRef.current = false;
    discardPendingTokens();
    setError(null);
    // Phase 2.4 — clear the previous turn's memory surface. The native history
    // is read inside `streamFromJarvisApi`, never from the UI cache.
    setMemoryLiveStatus(null);
    setMemoryDiagnostic(null);
    setMemoryHistoryWarning(null);
    setMemoryFinalizationNotice(null);
    setMemoryCaptureState(null);
    setMemoryReceipt(null);
    setMemoryContinuity(null);
    setMemoryContinuityError(null);
    setMemoryContinuityPending(false);
    setMemoryTurnReadError(null);
    // Invalidate any in-flight read from a previous turn/identity.
    memoryReadSeqRef.current += 1;
    // A new submission invalidates any prior relay correlation so a late relay
    // event from a previous turn cannot bind to this one.
    clearRelayMemoryTurn();
    relayAssistantAggregateRef.current = '';
    settledRelayOwnersRef.current.clear();
    conversationEpochRef.current += 1;
    memoryOwnerRef.current = null;
    linkedGoalBindingIdRef.current = null;
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
    // Stable local identity for the optimistic assistant bubble. The direct
    // finalizer reconciles the actual persisted DB id onto exactly this id.
    const assistantClientMessageId = crypto.randomUUID();
    setMessages(prev => [
      ...prev,
      { id: clientMessageId, role: 'user', content: userMsg },
      { id: assistantClientMessageId, role: 'assistant', content: '', isStreaming: true },
    ]);

    let effectiveSessionId = activeSession || sessionId;
    try {
      if (!effectiveSessionId) {
        // Create the native Session once. A Session whose workspace bind then
        // fails is reused on retry rather than re-created.
        const selectedAgentId = pendingAgentId && pendingAgentId !== 'main' ? pendingAgentId : 'main';
        let newSessionId = pendingNewSessionRef.current;
        if (newSessionId && pendingNewSessionAgentRef.current !== selectedAgentId) {
          // The pending native Session was created for a different Agent than
          // the displayed selection. Never reuse it for the wrong Agent:
          // abandon the orphan identity so a fresh Session is created below.
          newSessionId = null;
          pendingNewSessionRef.current = null;
          setPendingNativeSessionId(null);
        }
        if (!newSessionId) {
          const newSession = await invoke<JarvisSession>('jarvis_new_session', {
            name: userMsg.slice(0, 60),
            ...(selectedAgentId !== 'main' ? { agentId: selectedAgentId } : {}),
          });
          newSessionId = newSession.id;
          pendingNewSessionRef.current = newSession.id;
          pendingNewSessionAgentRef.current = selectedAgentId;
          setPendingNativeSessionId(newSession.id);
          onSessionCreated();
        }
        if (!mountedRef.current || !sendGateRef.current.isCurrent(sendGeneration)) return;
        if (!newSessionId) {
          throw new Error('Could not create a Session for this message.');
        }
        // A selected project must bind BEFORE the user row is appended and
        // before preparation/fetch. A binding failure preserves the draft and
        // never launches inference.
        if (pendingProjectRoot) {
          const bound = await bindWorkspaceForSession(newSessionId, pendingProjectRoot);
          if (!bound) {
            if (mountedRef.current && sendGateRef.current.isCurrent(sendGeneration)) {
              setIsStreaming(false);
              setError('Could not bind the selected workspace to the new Session. The Session was created but no message was sent; choose a valid absolute directory and retry.');
              setMessages(prev => prev.filter(m => m.id !== clientMessageId && m.id !== assistantClientMessageId));
              if (!override) {
                publishDraftStore(restoreFailedSessionDraft(draftStoreRef.current, submittedDraft));
              }
            }
            return;
          }
        }
        effectiveSessionId = newSessionId;
        // Suppress the history-load effect that setActiveSession is about to
        // trigger — otherwise it overwrites the optimistic messages above with
        // the empty history of this brand-new session.
        suppressHistoryLoadRef.current = newSessionId;
        setSessionId(newSessionId);
        sessionIdRef.current = newSessionId;
        activeSessionRef.current = newSessionId;
        setActiveSession(newSessionId);
        pendingNewSessionRef.current = null;
        pendingNewSessionAgentRef.current = 'main';
        setPendingNativeSessionId(null);
        onSessionsChanged();
      }

      const goalForTurn = selectedGoalId;
      await streamFromJarvisApi(effectiveSessionId, userMsg, sendGeneration, () => {
        if (!override) {
          publishDraftStore(clearSubmittedSessionDraft(draftStoreRef.current, submittedDraft));
        }
      }, clientMessageId, assistantClientMessageId, includeUserScopeForTurn, goalForTurn);
    } catch (e) {
      if (!mountedRef.current) return;
      if (!sendGateRef.current.isCurrent(sendGeneration)) {
        if (!override) {
          publishDraftStore(restoreFailedSessionDraft(draftStoreRef.current, submittedDraft));
        }
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
       if (!override) {
         publishDraftStore(restoreFailedSessionDraft(draftStoreRef.current, submittedDraft));
       }
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
  }, [isStreaming, messages, activeSession, sessionId, onSessionCreated, onSessionsChanged, setActiveSession, clearRunRecord, streamFromJarvisApi, discardPendingTokens, takePendingTokens, applyTokenChunk, publishDraftStore, resetActivityLedger, includeUserScope, pendingAgentId, pendingProjectRoot, selectedGoalId, bindWorkspaceForSession]);

  // Phase 4.4 — Resume is an explicit control that sends the exact native
  // resume directive through the ordinary turn transport. It never fabricates
  // an objective and never touches the operator's own composer draft.
  const handleResumeObjective = useCallback(() => {
    if (
      isStreaming
      || !activeSession
      || !memoryContinuity
      || memoryContinuity.session_id !== activeSession
      || !memoryContinuity.active_objective
    ) return;
    void handleSend(RESUME_OBJECTIVE_DIRECTIVE);
  }, [isStreaming, activeSession, memoryContinuity, handleSend]);

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
    // Explicit abandon path for a created-but-unbound Session: clearing the
    // pending identity here (while `activeSession` may already be null, so the
    // Session-change effect cannot fire) releases the Agent lock so the next
    // New Session may choose a different Agent.
    pendingNewSessionRef.current = null;
    pendingNewSessionAgentRef.current = 'main';
    setPendingNativeSessionId(null);
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

  // Phase 4.2 Session memory identity. For an existing Session the Agent and
  // binding come from the persisted native row; a New Session uses the local
  // pending selection until first send creates and binds the native Session.
  const currentSession = activeSession
    ? sessions.find((session) => session.id === activeSession) ?? null
    : null;
  const sessionSelection: SessionMemorySelection = {
    session_id: activeSession,
    agent_id: currentSession?.agent_id ?? (pendingAgentId || 'main'),
    project_root: currentSession ? currentSession.project_root ?? null : pendingProjectRoot,
    include_user_scope: includeUserScope,
  };

  // Phase 4.4 — persisted user rows only (real DB ids), used solely as an
  // explicit objective source for the native setter; never a fabricated id.
  const persistedUserMessages = useMemo<MemorySourceMessage[]>(
    () => messages
      .filter((message) => message.role === 'user' && typeof message.id === 'string' && message.id.length > 0)
      .map((message) => ({ id: message.id as string, content: message.content })),
    [messages],
  );
  // Guard against the single render frame after a Session switch where the
  // passive reset effect has not yet run: never pair a new Session id with a
  // previous Session's turn snapshot, receipt, or objective.
  const memoryDiagnosticForSession =
    activeSession && memoryDiagnostic && memoryDiagnostic.sessionId === activeSession
      ? memoryDiagnostic
      : null;
  const memoryReceiptForSession =
    activeSession && memoryReceipt && memoryReceipt.session_id === activeSession
      ? memoryReceipt
      : null;
  const memoryContinuityForSession =
    activeSession && memoryContinuity && memoryContinuity.session_id === activeSession
      ? memoryContinuity
      : null;
  const memoryTurnId =
    memoryDiagnosticForSession?.turnId
    ?? memoryReceiptForSession?.turn_id
    ?? memoryContinuityForSession?.latest_turn_id
    ?? null;

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

      {/* Roadmap Priority #2 Part 2 — optional Goal linkage. The selected Goal
          is submitted to native, which validates its Session/Agent/scope
          binding before it becomes run authority; this control is not a grant. */}
      {goalOptions.length > 0 && (
        <div className="shrink-0 pb-2 flex items-center gap-2">
          <label
            htmlFor="jarvis-goal-select"
            className="text-[10px] font-mono uppercase tracking-[0.18em] text-bone/40"
          >
            Goal
          </label>
          <select
            id="jarvis-goal-select"
            value={selectedGoalId ?? ''}
            disabled={isStreaming}
            onChange={(e) => setSelectedGoalId(e.target.value || null)}
            className="max-w-[320px] truncate px-2 py-1 text-xs rounded-md bg-white/5 border border-white/10 text-bone focus:outline-none focus:border-accent/50 disabled:opacity-50"
          >
            <option value="">No goal (ordinary turn)</option>
            {goalOptions.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.objective}
              </option>
            ))}
          </select>
          <span className="text-[10px] text-bone/30">
            A goal-linked run records progress and evidence against the goal.
          </span>
        </div>
      )}

      {/* Phase 4.2 — explicit Session Agent/project identity. For an existing
          Session the Agent is fixed and Apply/Unbind bind the current Session;
          for a New Session the choice is applied on first send. This control is
          not a filesystem grant. */}
      <div className="shrink-0 pb-2">
        <MemoryScopeControls
          selection={sessionSelection}
          agents={sessionAgents}
          disabled={isStreaming}
          agentLocked={pendingNativeSessionId !== null}
          onSelectAgent={handleSelectAgent}
          onBindWorkspace={(root) => { void handleBindWorkspace(root); }}
          onIncludeUserScope={setIncludeUserScope}
        />
      </div>

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
        <div className="flex items-center justify-end gap-3 mt-1.5 px-1">
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
        {memoryCaptureState && (
          <p
            role="status"
            aria-label="Memory capture status"
            className="mt-0.5 px-1 text-[10px] font-mono text-bone-faint"
          >
            {captureStateLabel(memoryCaptureState)}
          </p>
        )}
        {/* Phase 4.4 — actual applied memory, committed capture receipt,
            current-source evidence, and confirmed objective. Read-only except
            for the explicit native continuity controls. */}
        <div className="mt-2 px-1">
          <MemoryTurnStatus
            session_id={activeSession}
            turn_id={memoryTurnId}
            diagnostic={memoryDiagnosticForSession}
            receipt={memoryReceiptForSession}
            continuity={memoryContinuityForSession}
            read_error={memoryTurnReadError}
            sourceMessages={persistedUserMessages}
            continuityPending={memoryContinuityPending}
            continuityError={memoryContinuityError}
            disabled={isStreaming}
            onSetObjective={(input) => { void handleSetObjective(input); }}
            onResumeObjective={handleResumeObjective}
          />
        </div>
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
// ── Trusted Acceptance Manifests (native trust authority) ──
// ──
// ── The registry lives in the app-owned SQLite jarvis.db and is the ONLY trust
// ── authority. The file-backed Action Registry, model output, Goal text, and
// ── task text can never create or edit manifest content. Registration grants no
// ── permission and executes nothing; this panel only displays native records
// ── and forwards explicit user add/replace/remove actions.
// ═══════════════════════════════════════════════════════════════

interface TrustedManifestRecord {
  manifest_id: string;
  registry_version: number;
  schema_version: number;
  content_hash: string;
  content: unknown;
  agent_id: string;
  project_root: string;
  action_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ActiveActionRow {
  id: string;
  status: string;
}

interface TrustedManifestAgentRow {
  id: string;
  name: string;
  enabled: boolean;
}

const TRUSTED_MANIFEST_EXAMPLE = `{
  "schema_version": 1,
  "execution": [
    { "tool": "write_file", "arguments": { "path": "notes/result.md", "content": "Hello from Jarvis\\n" } }
  ],
  "acceptance": {
    "<goal-criterion-uuid>": [
      { "tool": "read_file", "arguments": { "path": "notes/result.md" }, "expect_sha256": "<64-char-lowercase-sha256>" }
    ]
  }
}`;

// ── Trusted manifest operations (native-persisted execution receipts) ──
//
// A fresh "Run manifest" click generates exactly one operation UUID, freezes the
// exact dispatch tuple locally, and never derives a dispatch from Goal/model or
// action-description text. "Retry / reconcile" reuses that exact frozen tuple;
// it never mints a replacement id. Every outcome shown comes from an exact
// native `get_trusted_execution` readback validated against the frozen tuple.

interface TrustedExecutionReceipt {
  execution_id: string;
  action_id: string;
  manifest_id: string;
  manifest_registry_version: number;
  manifest_content_hash: string;
  status: string;
  terminal_reason: string | null;
  cancel_requested_at: string | null;
  run_id: string | null;
  bun_run_id: string | null;
  runtime_started_at: string | null;
  runtime_finished_at: string | null;
  evidence: unknown;
}

interface FrozenOperation {
  operationId: string;
  actionId: string;
  manifestId: string;
  expectedManifestVersion: number;
  expectedManifestHash: string;
}

const UNRESOLVED_OPERATION_STATUSES = ['claimed', 'dispatched', 'ambiguous', 'pending_acceptance'];
const CANCELLABLE_OPERATION_STATUSES = ['claimed', 'dispatched'];
const KNOWN_EXECUTION_STATUSES = new Set([
  'claimed',
  'dispatched',
  'pending_acceptance',
  'waiting_for_user',
  'blocked',
  'failed',
  'cancelled',
  'partial',
  'ambiguous',
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64_PATTERN.test(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function operationStorageKey(actionId: string): string {
  return `jarvis.trusted.operation.${actionId}`;
}

/** Persist the exact frozen tuple locally. Returns false when it could not be
 *  stored, so a fresh dispatch can refuse to run without a durable local tuple. */
function storeOperation(op: FrozenOperation): boolean {
  try {
    localStorage.setItem(operationStorageKey(op.actionId), JSON.stringify(op));
    return true;
  } catch {
    return false;
  }
}

function readStoredOperation(actionId: string): FrozenOperation | null {
  try {
    const raw = localStorage.getItem(operationStorageKey(actionId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Record<string, unknown>;
    const operationId = value.operationId;
    const a = value.actionId;
    const manifestId = value.manifestId;
    const version = value.expectedManifestVersion;
    const hash = value.expectedManifestHash;
    if (!isUuid(operationId)) return null;
    if (typeof a !== 'string' || a !== actionId) return null;
    if (typeof manifestId !== 'string' || manifestId.length === 0) return null;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
    if (!isHex64(hash)) return null;
    return {
      operationId,
      actionId: a,
      manifestId,
      expectedManifestVersion: version,
      expectedManifestHash: hash,
    };
  } catch {
    return null;
  }
}

function newOperationId(): string {
  const cryptoObj = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string;
        getRandomValues?: (array: Uint8Array) => Uint8Array;
      };
    }
  ).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return '';
}

function isTrustedExecutionReceipt(value: unknown): value is TrustedExecutionReceipt {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    isUuid(row.execution_id) &&
    typeof row.action_id === 'string' &&
    row.action_id.length > 0 &&
    typeof row.manifest_id === 'string' &&
    row.manifest_id.length > 0 &&
    typeof row.manifest_registry_version === 'number' &&
    Number.isInteger(row.manifest_registry_version) &&
    row.manifest_registry_version >= 1 &&
    isHex64(row.manifest_content_hash) &&
    typeof row.status === 'string' &&
    KNOWN_EXECUTION_STATUSES.has(row.status) &&
    isNullableString(row.terminal_reason) &&
    isNullableString(row.cancel_requested_at) &&
    isNullableString(row.run_id) &&
    isNullableString(row.bun_run_id) &&
    isNullableString(row.runtime_started_at) &&
    isNullableString(row.runtime_finished_at)
  );
}

function reconstructFrozen(receipt: TrustedExecutionReceipt): FrozenOperation {
  return {
    operationId: receipt.execution_id,
    actionId: receipt.action_id,
    manifestId: receipt.manifest_id,
    expectedManifestVersion: receipt.manifest_registry_version,
    expectedManifestHash: receipt.manifest_content_hash,
  };
}

function receiptMatchesFrozen(receipt: TrustedExecutionReceipt, op: FrozenOperation): boolean {
  return (
    receipt.execution_id === op.operationId &&
    receipt.action_id === op.actionId &&
    receipt.manifest_id === op.manifestId &&
    receipt.manifest_registry_version === op.expectedManifestVersion &&
    receipt.manifest_content_hash === op.expectedManifestHash
  );
}

function operationStatusVariant(
  status: string,
): 'success' | 'warn' | 'error' | 'info' | 'default' {
  if (status === 'blocked' || status === 'failed') return 'error';
  if (
    status === 'ambiguous' ||
    status === 'waiting_for_user' ||
    status === 'partial' ||
    status === 'pending_acceptance'
  ) {
    return 'warn';
  }
  if (status === 'claimed' || status === 'dispatched') return 'info';
  if (status === 'completed') return 'success';
  return 'default';
}

/** Bounded, metadata-only evidence summary. Raw tool output is never rendered. */
function evidenceSummary(evidence: unknown): string | null {
  if (!Array.isArray(evidence) || evidence.length === 0) return null;
  const parts = evidence.slice(0, 5).map((item) => {
    const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const tool = typeof row.tool === 'string' ? row.tool : '?';
    const status = typeof row.status === 'string' ? row.status : '?';
    const hash = typeof row.output_sha256 === 'string' ? row.output_sha256.slice(0, 8) : '';
    const bytes = typeof row.output_bytes === 'number' ? `${row.output_bytes}B` : '';
    const suffix = [hash ? `${hash}…` : '', bytes].filter((v) => v.length > 0).join(' ');
    return `${tool}:${status}${suffix ? ` (${suffix})` : ''}`;
  });
  return `${evidence.length} call(s): ${parts.join(', ')}`;
}

function TrustedManifestOperations({ record }: { record: TrustedManifestRecord }) {
  const actionId = record.action_id ?? '';
  const [history, setHistory] = useState<TrustedExecutionReceipt[] | null>(null);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<FrozenOperation | null>(null);
  const [receipt, setReceipt] = useState<TrustedExecutionReceipt | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  const fetchHistory = useCallback(async (): Promise<TrustedExecutionReceipt[]> => {
    const raw = await invoke<unknown>('list_trusted_executions', { actionId });
    if (!Array.isArray(raw)) throw new Error('unreadable');
    const receipts: TrustedExecutionReceipt[] = [];
    for (const row of raw) {
      if (!isTrustedExecutionReceipt(row) || row.action_id !== actionId) {
        throw new Error('malformed');
      }
      receipts.push(row);
    }
    return receipts;
  }, [actionId]);

  const loadHistory = useCallback(async (): Promise<boolean> => {
    try {
      const receipts = await fetchHistory();
      setHistory(receipts);
      setHistoryUnavailable(false);
      setHistoryError(null);
      return true;
    } catch {
      setHistoryUnavailable(true);
      setHistoryError('Could not read native operation history; new operations are disabled.');
      return false;
    }
  }, [fetchHistory]);

  useEffect(() => {
    setFrozen(readStoredOperation(actionId));
    setReceipt(null);
    setReadError(null);
    setMessage(null);
    void loadHistory();
  }, [actionId, record.manifest_id, record.registry_version, loadHistory]);

  const latestUnresolved =
    history?.find((row) => UNRESOLVED_OPERATION_STATUSES.includes(row.status)) ?? null;
  const displayReceipt = receipt ?? history?.[0] ?? null;
  const cancellable =
    displayReceipt !== null && CANCELLABLE_OPERATION_STATUSES.includes(displayReceipt.status);
  // Retry is available whenever native history holds an unresolved receipt, even
  // without a local frozen tuple (it reconstructs from the native receipt), or
  // when a frozen operation's exact readback failed.
  const canRetry =
    latestUnresolved !== null || (frozen !== null && readError !== null);

  const readback = useCallback(
    async (op: FrozenOperation): Promise<void> => {
      try {
        const raw = await invoke<unknown>('get_trusted_execution', {
          executionId: op.operationId,
        });
        if (!isTrustedExecutionReceipt(raw) || !receiptMatchesFrozen(raw, op)) {
          throw new Error('identity');
        }
        setReceipt(raw);
        setReadError(null);
        setMessage(null);
        await loadHistory();
      } catch {
        setReadError(
          'The operation receipt could not be read back from native. The frozen operation is kept for retry; no outcome is claimed.',
        );
      }
    },
    [loadHistory],
  );

  const dispatch = useCallback(
    async (op: FrozenOperation): Promise<void> => {
      setMessage(null);
      try {
        await invoke('execute_trusted_manifest_action', {
          actionId: op.actionId,
          manifestId: op.manifestId,
          operationId: op.operationId,
          expectedManifestVersion: op.expectedManifestVersion,
          expectedManifestHash: op.expectedManifestHash,
        });
      } catch (e) {
        setMessage(
          `Dispatch returned an error (${typeof e === 'string' ? e : 'unknown'}). Reading back the exact receipt…`,
        );
      }
      await readback(op);
    },
    [readback],
  );

  const runNew = useCallback(async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      let receipts: TrustedExecutionReceipt[];
      try {
        receipts = await fetchHistory();
      } catch {
        setHistoryUnavailable(true);
        setHistoryError('Could not read native operation history; new operations are disabled.');
        setMessage('Cannot read native operation history; a new operation is disabled.');
        return;
      }
      setHistory(receipts);
      setHistoryUnavailable(false);
      setHistoryError(null);
      const unresolved = receipts.find((row) =>
        UNRESOLVED_OPERATION_STATUSES.includes(row.status),
      );
      if (unresolved) {
        // Never keep a stale local tuple over the currently unresolved native
        // operation: align to the exact native tuple and direct reconciliation.
        const op =
          frozen && receiptMatchesFrozen(unresolved, frozen)
            ? frozen
            : reconstructFrozen(unresolved);
        storeOperation(op);
        setFrozen(op);
        setMessage(
          `An unresolved operation (${unresolved.status}) already exists for this action. Use “Retry / reconcile this operation”.`,
        );
        return;
      }
      const operationId = newOperationId();
      if (!operationId) {
        setMessage('This environment cannot generate an operation id; no operation was started.');
        return;
      }
      // Freeze the exact tuple locally BEFORE invoking native; refuse to invoke
      // if the durable local tuple could not be persisted.
      const op: FrozenOperation = {
        operationId,
        actionId,
        manifestId: record.manifest_id,
        expectedManifestVersion: record.registry_version,
        expectedManifestHash: record.content_hash,
      };
      if (!storeOperation(op)) {
        setMessage(
          'The exact operation tuple could not be persisted locally, so no operation was started.',
        );
        return;
      }
      setFrozen(op);
      await dispatch(op);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [actionId, record.manifest_id, record.registry_version, frozen, fetchHistory, dispatch]);

  const retry = useCallback(async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      let target: TrustedExecutionReceipt | null = null;
      try {
        const receipts = await fetchHistory();
        setHistory(receipts);
        setHistoryUnavailable(false);
        setHistoryError(null);
        target =
          receipts.find((row) => UNRESOLVED_OPERATION_STATUSES.includes(row.status)) ?? null;
      } catch {
        setHistoryUnavailable(true);
        setHistoryError('Could not read native operation history; retry is unavailable.');
      }
      let op: FrozenOperation | null;
      if (target) {
        // Always prefer the exact current native target over a stale local tuple.
        op =
          frozen && receiptMatchesFrozen(target, frozen) ? frozen : reconstructFrozen(target);
        storeOperation(op);
        setFrozen(op);
      } else {
        op = frozen;
      }
      if (!op) {
        setMessage('No local operation tuple and no unresolved native operation to reconcile.');
        return;
      }
      await dispatch(op);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [frozen, fetchHistory, dispatch]);

  const cancelOperation = useCallback(async (): Promise<void> => {
    if (pending.current) return;
    // Prefer the exact displayed native cancellable receipt over a stale local
    // tuple; if they differ, use the native receipt's exact identity.
    let op: FrozenOperation | null;
    if (displayReceipt && CANCELLABLE_OPERATION_STATUSES.includes(displayReceipt.status)) {
      op =
        frozen && receiptMatchesFrozen(displayReceipt, frozen)
          ? frozen
          : reconstructFrozen(displayReceipt);
    } else {
      op = frozen;
    }
    if (!op) {
      setMessage('No operation identity is available to cancel.');
      return;
    }
    if (
      !confirm(
        'Cancel this exact operation? Native will abort the in-flight run and return durable cancellation state.',
      )
    ) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      try {
        await invoke('cancel_trusted_execution', { executionId: op.operationId });
      } catch (e) {
        setMessage(
          `Cancel request failed (${typeof e === 'string' ? e : 'unknown'}). No terminal state is claimed.`,
        );
      }
      await readback(op);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [frozen, displayReceipt, readback]);

  return (
    <div className="mt-2 rounded-md border border-iron/30 p-2 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[10px] font-mono uppercase tracking-wider text-bone/40">Operations</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => void runNew()}
            disabled={busy || historyUnavailable || latestUnresolved !== null}
            className="px-2 py-0.5 text-[10px] font-mono rounded border border-cyan-neon/40 text-cyan-glow hover:bg-cyan-neon/10 disabled:opacity-50 transition-colors"
          >
            {busy ? 'Working…' : 'Run manifest'}
          </button>
          {canRetry && (
            <button
              type="button"
              onClick={() => void retry()}
              disabled={busy}
              className="px-2 py-0.5 text-[10px] font-mono rounded border border-royal/40 text-royal-light hover:bg-royal/10 disabled:opacity-50 transition-colors"
            >
              Retry / reconcile this operation
            </button>
          )}
          {cancellable && (
            <button
              type="button"
              onClick={() => void cancelOperation()}
              disabled={busy}
              className="px-2 py-0.5 text-[10px] font-mono rounded border border-error/40 text-error hover:bg-error/10 disabled:opacity-50 transition-colors"
            >
              Cancel operation
            </button>
          )}
        </div>
      </div>

      {historyUnavailable && (
        <div role="alert" className="text-[11px] text-red-200">
          {historyError ?? 'Native operation history is unavailable.'}
        </div>
      )}
      {readError && (
        <div role="alert" className="text-[11px] text-red-200">
          {readError}
        </div>
      )}
      {message && (
        <div role="status" className="text-[11px] text-bone/50">
          {message}
        </div>
      )}

      {displayReceipt && (
        <div className="text-[11px] font-mono text-bone/70">
          <div className="flex items-center gap-2 flex-wrap">
            <Pill variant={operationStatusVariant(displayReceipt.status)}>
              {displayReceipt.status}
            </Pill>
            <span className="break-all">op {displayReceipt.execution_id}</span>
          </div>
          {displayReceipt.terminal_reason && (
            <div className="text-bone/50">reason: {displayReceipt.terminal_reason}</div>
          )}
          <div className="text-bone/40">
            runtime {displayReceipt.runtime_started_at ?? '—'} → {displayReceipt.runtime_finished_at ?? '—'}
            {displayReceipt.cancel_requested_at
              ? ` · cancel requested ${displayReceipt.cancel_requested_at}`
              : ''}
          </div>
        </div>
      )}

      {history && history.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40">History</div>
          {history.slice(0, 8).map((row) => (
            <div key={row.execution_id} className="text-[11px] font-mono text-bone/70">
              <div className="flex items-center gap-2 flex-wrap">
                <Pill variant={operationStatusVariant(row.status)}>{row.status}</Pill>
                <span className="break-all">op {row.execution_id}</span>
              </div>
              {row.terminal_reason && (
                <div className="text-bone/50">reason: {row.terminal_reason}</div>
              )}
              <div className="text-bone/40">
                runtime {row.runtime_started_at ?? '—'} → {row.runtime_finished_at ?? '—'}
                {row.cancel_requested_at ? ` · cancel requested ${row.cancel_requested_at}` : ''}
              </div>
              {evidenceSummary(row.evidence) && (
                <div className="text-bone/40">evidence: {evidenceSummary(row.evidence)}</div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="text-[10px] font-mono text-bone-faint">
        pending_acceptance is not completion: this panel never runs acceptance or completes a Goal. A
        successful tool run alone is not acceptance.
      </p>
    </div>
  );
}

function TrustedManifestsPanel() {
  const [manifests, setManifests] = useState<TrustedManifestRecord[]>([]);
  const [agents, setAgents] = useState<TrustedManifestAgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  const pending = useRef(false);

  const [contentJson, setContentJson] = useState('');
  const [agentId, setAgentId] = useState('');
  const [projectRoot, setProjectRoot] = useState('');
  const [actionId, setActionId] = useState('');
  const [activeActions, setActiveActions] = useState<ActiveActionRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expectedVersion, setExpectedVersion] = useState('');

  // Authoritative readback. Returns true only when the registry list was read;
  // a failure keeps the previously displayed list and marks it unavailable so
  // the UI never updates optimistically or claims success without evidence.
  const load = useCallback(async (): Promise<boolean> => {
    const request = ++requestId.current;
    setLoading(true);
    try {
      const rows = await invoke<unknown>('list_trusted_acceptance_manifests');
      if (request !== requestId.current) return false;
      if (!Array.isArray(rows)) {
        setUnavailable(true);
        setReadError('The native trusted-manifest registry returned an unreadable response. Showing nothing as trusted.');
        return false;
      }
      setManifests(rows as TrustedManifestRecord[]);
      setUnavailable(false);
      setReadError(null);
      return true;
    } catch {
      if (request !== requestId.current) return false;
      setUnavailable(true);
      setReadError('Could not read the native trusted-manifest registry. No trust is inferred from this failure.');
      return false;
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, []);

  const loadAgents = useCallback(async () => {
    try {
      const rows = await invoke<unknown>('list_agents');
      if (Array.isArray(rows)) {
        const enabled = (rows as TrustedManifestAgentRow[]).filter((a) => a?.enabled);
        setAgents(enabled);
        setAgentId((current) => current || enabled[0]?.id || '');
      }
    } catch {
      // The Agent picker is a convenience; native still validates the id.
    }
  }, []);

  // Active Action Registry ids are a convenience suggestion list; native still
  // resolves and verifies the exact id, status, and approval before binding.
  const loadActiveActions = useCallback(async () => {
    try {
      const bucket = await invoke<unknown>('get_action_registry_bucket', { bucket: 'active' });
      const actions = (bucket as { actions?: unknown } | null)?.actions;
      if (Array.isArray(actions)) {
        setActiveActions(
          (actions as ActiveActionRow[]).filter(
            (a) => a && (a.status === 'open' || a.status === 'in_progress'),
          ),
        );
      }
    } catch {
      // Suggestion-only; binding still fails closed natively.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadAgents();
    void loadActiveActions();
  }, [load, loadAgents, loadActiveActions]);

  const runAction = useCallback(
    async (label: string, run: () => Promise<unknown>) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      setActionError(null);
      try {
        await run();
      } catch (e) {
        setActionError(typeof e === 'string' ? e : `${label} failed.`);
        pending.current = false;
        setBusy(false);
        return;
      }
      const confirmed = await load();
      if (!confirmed) {
        setActionError(`${label} was submitted, but the registry could not be re-read. Showing the previous list; it may be stale.`);
      }
      pending.current = false;
      setBusy(false);
    },
    [load],
  );

  const handleCreate = () => {
    if (!contentJson.trim() || !agentId.trim() || !projectRoot.trim() || !actionId.trim()) {
      setActionError(
        'Manifest content, an enabled Agent, an existing workspace root, and an exact Action Registry id are required.',
      );
      return;
    }
    void runAction('Add manifest', () =>
      invoke('create_trusted_acceptance_manifest', {
        contentJson,
        agentId: agentId.trim(),
        projectRoot: projectRoot.trim(),
        actionId: actionId.trim(),
      }),
    );
  };

  const handleSelectForReplace = (record: TrustedManifestRecord) => {
    setSelectedId(record.manifest_id);
    setExpectedVersion(String(record.registry_version));
    setAgentId(record.agent_id);
    setProjectRoot(record.project_root);
    setActionId(record.action_id ?? '');
    setContentJson(JSON.stringify(record.content, null, 2));
    setActionError(null);
  };

  const handleReplace = () => {
    if (!selectedId) {
      setActionError('Select a registered manifest to replace.');
      return;
    }
    const version = Number(expectedVersion);
    if (!Number.isInteger(version) || version < 1) {
      setActionError('Enter the current registry version you are replacing.');
      return;
    }
    if (!contentJson.trim() || !agentId.trim() || !projectRoot.trim() || !actionId.trim()) {
      setActionError(
        'Manifest content, an enabled Agent, an existing workspace root, and an exact Action Registry id are required.',
      );
      return;
    }
    void runAction('Replace manifest', () =>
      invoke('replace_trusted_acceptance_manifest', {
        manifestId: selectedId,
        expectedVersion: version,
        contentJson,
        agentId: agentId.trim(),
        projectRoot: projectRoot.trim(),
        actionId: actionId.trim(),
      }),
    );
  };

  const handleRemove = (record: TrustedManifestRecord) => {
    void runAction('Remove manifest', () =>
      invoke('remove_trusted_acceptance_manifest', {
        manifestId: record.manifest_id,
        expectedVersion: record.registry_version,
      }),
    );
  };

  const inputCls =
    'w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors';

  return (
    <GlassCard hoverable={false}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-bone">Trusted acceptance manifests</h3>
          <p className="text-[10px] font-mono text-bone-faint mt-0.5">
            Native registry in the app-owned jarvis.db. Each manifest binds exactly one Action Registry
            id and the manifest content comes only from the JSON you enter here. Action Registry files,
            model output, and Goal or task text cannot create or edit manifest content. Registering here
            grants no tool permission and runs nothing.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || busy}
          className="px-3 py-1.5 text-[10px] font-mono rounded-lg border border-iron/40 text-bone-dim hover:text-bone hover:border-iron/60 disabled:opacity-50 transition-colors shrink-0"
        >
          {loading ? 'Loading…' : 'Reload'}
        </button>
      </div>

      {readError && (
        <div role="alert" className="mb-3 text-[11px] font-mono text-error">
          {readError}
        </div>
      )}
      {unavailable && manifests.length > 0 && (
        <div role="alert" className="mb-3 text-[11px] font-mono text-amber-300">
          Showing previously loaded manifests; they may be stale.
        </div>
      )}
      {actionError && (
        <div role="alert" className="mb-3 text-[11px] font-mono text-error">
          {actionError}
        </div>
      )}

      {manifests.length === 0 && !unavailable ? (
        <EmptyState message="No trusted acceptance manifests are registered. Nothing is trusted until you explicitly add one." />
      ) : manifests.length > 0 ? (
        <ul className="space-y-2 mb-4">
          {manifests.map((record) => (
            <li
              key={record.manifest_id}
              className={cn(
                'rounded-lg border p-3',
                record.manifest_id === selectedId ? 'border-royal/50 bg-royal/5' : 'border-iron/30',
              )}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-bone-dim">
                <span>registry v{record.registry_version}</span>
                <span>schema v{record.schema_version}</span>
              </div>
              <div className="mt-1 text-[10px] font-mono text-bone break-all">
                id {record.manifest_id}
              </div>
              <div className="mt-1 text-[10px] font-mono text-bone-dim break-all">
                content-sha256 {record.content_hash}
              </div>
              <div className="mt-1 text-[10px] font-mono break-all">
                {record.action_id ? (
                  <span className="text-bone">action {record.action_id}</span>
                ) : (
                  <span className="text-amber-300">action unbound (legacy) — replace to bind</span>
                )}
              </div>
              <div className="mt-1 text-[10px] font-mono text-bone-faint break-all">
                agent {record.agent_id} · root {record.project_root}
              </div>
              <div className="mt-1 text-[10px] font-mono text-bone-faint">
                updated {record.updated_at}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleSelectForReplace(record)}
                  disabled={busy}
                  className="px-2 py-0.5 text-[10px] font-mono rounded border border-royal/40 text-royal-light hover:bg-royal/10 disabled:opacity-50 transition-colors"
                >
                  Use for replace
                </button>
                <button
                  type="button"
                  onClick={() => handleRemove(record)}
                  disabled={busy}
                  className="px-2 py-0.5 text-[10px] font-mono rounded border border-error/40 text-error hover:bg-error/10 disabled:opacity-50 transition-colors"
                >
                  Remove
                </button>
              </div>
              {record.action_id && (
                <TrustedManifestOperations
                  key={`${record.manifest_id}:${record.registry_version}`}
                  record={record}
                />
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="space-y-2 border-t border-iron/20 pt-3">
        <p className="text-[10px] font-mono text-bone-faint">
          {selectedId ? 'Editing a replace for the selected manifest.' : 'Adding a new manifest.'}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] font-mono text-bone-dim block mb-1">Enabled Agent</label>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={busy}
              className={inputCls}
            >
              <option value="">Select an enabled Agent…</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({agent.id})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-mono text-bone-dim block mb-1">Existing workspace root</label>
            <input
              type="text"
              value={projectRoot}
              onChange={(e) => setProjectRoot(e.target.value)}
              disabled={busy}
              placeholder="/absolute/path/to/project"
              className={inputCls}
            />
          </div>
        </div>
        <div>
          <label className="text-[10px] font-mono text-bone-dim block mb-1">
            Action Registry action id (exact; required)
          </label>
          <input
            type="text"
            list="trusted-manifest-action-ids"
            value={actionId}
            onChange={(e) => setActionId(e.target.value)}
            disabled={busy}
            placeholder="exact id from the active Action Registry bucket"
            className={inputCls}
          />
          <datalist id="trusted-manifest-action-ids">
            {activeActions.map((action) => (
              <option key={action.id} value={action.id} />
            ))}
          </datalist>
          <p className="text-[10px] font-mono text-bone-faint mt-1">
            Native resolves this id to exactly one active open/in_progress action with its existing
            approval condition satisfied, or rejects the binding. Only the id is identity — action
            title/description/Goal/model text is never trusted.
          </p>
        </div>
        {selectedId && (
          <div>
            <label className="text-[10px] font-mono text-bone-dim block mb-1">
              Expected current registry version
            </label>
            <input
              type="number"
              min={1}
              value={expectedVersion}
              onChange={(e) => setExpectedVersion(e.target.value)}
              disabled={busy}
              className={cn(inputCls, 'w-32')}
            />
          </div>
        )}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] font-mono text-bone-dim">v1 manifest content (strict JSON)</label>
            <button
              type="button"
              onClick={() => setContentJson(TRUSTED_MANIFEST_EXAMPLE)}
              disabled={busy}
              className="text-[10px] font-mono text-bone-faint hover:text-bone-dim disabled:opacity-50"
            >
              Load example shape
            </button>
          </div>
          <textarea
            value={contentJson}
            onChange={(e) => setContentJson(e.target.value)}
            disabled={busy}
            rows={10}
            spellCheck={false}
            placeholder={TRUSTED_MANIFEST_EXAMPLE}
            className={cn(inputCls, 'resize-y')}
          />
          <p className="text-[10px] font-mono text-bone-faint mt-1">
            Execution calls may use read tools plus the bounded writers write_file/edit_file (bounded
            UTF-8 payloads, workspace-relative paths). Acceptance checks stay read-only. Unknown keys,
            shell tools/commands, apply_patch/multi_edit, web tools, scripts, templates, and unbounded
            values are rejected by native validation. Later execution still runs through the canonical
            ToolRuntime under current Agent/Permission policy; if policy denies or requires approval it
            becomes a blocked/waiting state and is never bypassed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCreate}
            disabled={busy}
            className="px-3 py-1.5 text-[10px] font-mono rounded-lg border border-cyan-neon/40 text-cyan-glow hover:bg-cyan-neon/10 disabled:opacity-50 transition-colors"
          >
            {busy ? 'Submitting…' : 'Add manifest'}
          </button>
          <button
            type="button"
            onClick={handleReplace}
            disabled={busy || !selectedId}
            className="px-3 py-1.5 text-[10px] font-mono rounded-lg border border-royal/40 text-royal-light hover:bg-royal/10 disabled:opacity-50 transition-colors"
          >
            Replace selected
          </button>
          {selectedId && (
            <button
              type="button"
              onClick={() => {
                setSelectedId(null);
                setExpectedVersion('');
              }}
              disabled={busy}
              className="text-[10px] font-mono text-bone-faint hover:text-bone-dim disabled:opacity-50"
            >
              Clear selection
            </button>
          )}
        </div>
      </div>
    </GlassCard>
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

      <div className="mt-4">
        <TrustedManifestsPanel />
      </div>
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
