import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '../ui';
import type { CompanionState } from './types';
import {
  JarvisSession, JarvisMessage, JarvisConfig, JarvisStatus, SessionRunRecord,
  OPENROUTER_MODELS,
} from './types';
import ControlCenterView from './ControlCenterView';
import MarkdownView from './MarkdownView';
import {
  createUnknownFrameReporter,
  InactivityWatchdog,
  isTerminalStageStatus,
  isPassiveSseFrame,
  parseSseDataLine,
  readToolResultTruncation,
  type ToolResultTruncationMetadata,
} from './sse-protocol';
import {
  SendGate,
  dedupeMessages,
  finalizeStreamingMessages,
  isToolCallEchoOnly,
  mergeToolResult,
  recoverComposerAfterFailure,
  sanitizeAssistantDisplay,
  shouldSubmitComposerKey,
  type ToolCallState,
} from './chat-state';
import { errorDisplayForCode } from './error-display';
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
  onCompanionChange?: (companion: CompanionState | null) => void;
}

const sessionInvokeArgs = (sessionId: string) => ({
  sessionId,
  session_id: sessionId,
});

const JARVIS_API_URL = 'http://127.0.0.1:19877';
const STREAM_INACTIVITY_TIMEOUT_MS = 90_000;

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

export default function JarvisView({ initialSubView = 'chat', onCompanionChange }: JarvisViewProps) {
  const [subView, setSubView] = useState<JarvisSubView>(initialSubView);
  const [sessions, setSessions] = useState<JarvisSession[]>([]);
  const [sessionRuns, setSessionRuns] = useState<Record<string, SessionRunRecord>>({});
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [config, setConfig] = useState<JarvisConfig | null>(null);
  const [status, setStatus] = useState<JarvisStatus | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const [result, runs] = await Promise.all([
        invoke<JarvisSession[]>('jarvis_list_sessions'),
        invoke<SessionRunRecord[]>('get_all_session_runs').catch(() => [] as SessionRunRecord[]),
      ]);
      setSessions(result);
      const runMap: Record<string, SessionRunRecord> = {};
      for (const run of runs) {
        if (!runMap[run.session_id]) {
          runMap[run.session_id] = run;
        }
      }
      setSessionRuns(runMap);
    } catch (e) { console.error('Failed to load sessions:', e); }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const result = await invoke<JarvisConfig>('jarvis_get_config');
      setConfig(result);
    } catch (e) { console.error('Failed to load config:', e); }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const result = await invoke<JarvisStatus>('jarvis_check_status');
      setStatus(result);
    } catch (e) { console.error('Failed to load status:', e); }
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
      className="h-full flex flex-col"
    >
      {/* Sub-navigation tabs — ARIA tablist + tab semantics (Phase 4) */}
      <div
        role="tablist"
        aria-label="Jarvis views"
        className="flex items-center gap-1 mb-3 shrink-0"
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
                'px-3 py-1.5 text-xs font-mono rounded-lg border transition-all duration-150 flex items-center gap-1.5',
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
        <div className="flex items-center gap-1.5 mb-3 overflow-x-auto pb-1 shrink-0">
          <button
            type="button"
            onClick={() => { setActiveSession(null); setSubView('chat'); }}
            aria-label="New chat"
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

      {/* Content */}
      <div className="flex-1 min-h-0">
        <AnimatePresence mode="wait">
          {subView === 'chat' && (
            <motion.div key="chat" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <ChatPanel
                activeSession={activeSession}
                setActiveSession={setActiveSession}
                config={config}
                backendLabel={config?.active_backend === 'openrouter' ? 'OpenRouter' : (config?.active_backend === 'claude_cli' ? 'Claude CLI' : 'Ollama')}
                modelLabel={config ? (config.active_backend === 'ollama' ? config.ollama.model : (config.active_backend === 'claude_cli' ? (config.claude_cli.model ?? '') : config.openrouter.model)) : ''}
                onSessionCreated={loadSessions}
              />
            </motion.div>
          )}
          {subView === 'sessions' && (
            <motion.div key="sessions" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <SessionsPanel
                sessions={sessions}
                sessionRuns={sessionRuns}
                activeSession={activeSession}
                onSelect={(id) => { setActiveSession(id); setSubView('chat'); }}
                onNew={() => { setActiveSession(null); setSubView('chat'); }}
                onDelete={loadSessions}
                onRefresh={loadSessions}
              />
            </motion.div>
          )}
          {subView === 'config' && (
            <motion.div key="config" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <ConfigPanel config={config} setConfig={setConfig} />
            </motion.div>
          )}
          {subView === 'status' && (
            <motion.div key="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <StatusPanel status={status} onRefresh={loadStatus} />
            </motion.div>
          )}
          {subView === 'control' && (
            <motion.div key="control" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <ControlCenterView />
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
  activeSession, setActiveSession, config, backendLabel, modelLabel, onSessionCreated,
}: {
  activeSession: string | null;
  setActiveSession: (id: string | null) => void;
  config: JarvisConfig | null;
  backendLabel: string;
  modelLabel: string;
  onSessionCreated: () => void;
}) {
  const [messages, setMessages] = useState<JarvisMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string>('');
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
  const [pendingApproval, setPendingApproval] = useState<{
    call_id: string;
    name: string;
    arguments: unknown;
    session_id: string;
  } | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  // Phase 3.1 — inline tool-call cards built from `tool_use` / `tool_result`.
  const [toolCalls, setToolCalls] = useState<ToolCallState[]>([]);

  // Phase 3.3 — token / cost tally for the current turn.
  const [turnCost, setTurnCost] = useState<{ tokens: number; costUsd: number } | null>(null);

  // Loading-state for Session history fetch (Phase 2.3).
  const [loadingHistory, setLoadingHistory] = useState(false);

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
  const sessionIdRef = useRef(sessionId);
  const onSessionCreatedRef = useRef(onSessionCreated);
  const streamAbortRef = useRef<AbortController | null>(null);
  const sendGateRef = useRef(new SendGate());
  const stopRequestedRef = useRef(false);
  useEffect(() => { activeSessionRef.current = activeSession; }, [activeSession]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { onSessionCreatedRef.current = onSessionCreated; }, [onSessionCreated]);

  const matchesStreamSession = useCallback((sid: string | undefined) => {
    const current = activeSessionRef.current || sessionIdRef.current;
    if (!current) return true;
    if (!sid) return false;
    return sid === current;
  }, []);

  const appendAssistantText = useCallback((text: string) => {
    if (!text) return;
    setError(null);
    setPipelineStage('');
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant' && last.isStreaming) {
        return [...prev.slice(0, -1), { ...last, content: last.content + text }];
      }
      return [...prev, { role: 'assistant', content: text, isStreaming: true }];
    });
  }, []);

  const finalizeAssistantMessage = useCallback((sid?: string) => {
    setIsStreaming(false);
    setPipelineStage('');
    setRecursionDepth(null);
    setPendingApproval(null);
    setUserPinnedToBottom(true);
    const effectiveSid = sid || activeSessionRef.current || sessionIdRef.current;
    setMessages(prev => {
      const last = prev[prev.length - 1];
      const finalizedMessages = finalizeStreamingMessages(prev);
      const finalized = finalizedMessages[finalizedMessages.length - 1];
      if (last?.role === 'assistant' && last.isStreaming) {
        if (effectiveSid && finalized?.role === 'assistant' && finalized.content.trim()) {
          invoke('append_message', {
            ...sessionInvokeArgs(effectiveSid),
            role: 'assistant',
            content: finalized.content,
          }).catch((e) => console.error('Failed to persist assistant message:', e));
        }
        return finalizedMessages;
      }
      return prev;
    });
    onSessionCreatedRef.current();
  }, []);

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
    if (suppressHistoryLoadRef.current && suppressHistoryLoadRef.current === activeSession) {
      // Freshly created by handleSend: preserve its optimistic turn and make
      // this Session the new comparison baseline without invalidating the send.
      prevActiveSessionRef.current = activeSession;
      suppressHistoryLoadRef.current = null;
      setLoadingHistory(false);
      return;
    }
    prevActiveSessionRef.current = activeSession;
    if (prev !== activeSession) {
      if (prev) invoke('cancel_chat_stream', sessionInvokeArgs(prev)).catch(() => {});
      streamAbortRef.current?.abort('Session switched');
      streamAbortRef.current = null;
      sendGateRef.current.invalidate();
      stopRequestedRef.current = false;
      setMessages([]);
      setIsStreaming(false);
      setPipelineStage('');
      setRecursionDepth(null);
      setReasoningText('');
      setShowReasoning(false);
      setAgentSteps([]);
      setShowAgents(true);
      setToolCalls([]);
      setTurnCost(null);
      setPendingApproval(null);
      setApprovalError(null);
      setError(null);
    }
    if (!activeSession) {
      setMessages([]);
      setSessionId('');
      setToolCalls([]);
      setTurnCost(null);
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
        // Jump to the bottom without animation on initial history load.
        requestAnimationFrame(() => {
          if (!cancelled) {
            setUserPinnedToBottom(true);
            scrollToBottom('auto');
          }
        });
      })
      .catch((e) => {
        if (!cancelled) console.error('Failed to load session history:', e);
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => { cancelled = true; };
  }, [activeSession, scrollToBottom]);

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

    track(listen<{ session_id: string }>('jarvis://done', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
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
    track(listen<{ error: string; session_id: string; code?: string }>('jarvis://error', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      setIsStreaming(false);
      setPipelineStage('');
      setRecursionDepth(null);
      setPendingApproval(null);
      setError(event.payload.error);
      setUserPinnedToBottom(true);
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.isStreaming) {
          // If nothing streamed before the error (e.g. a turn-fatal auth
          // failure), turn the bubble into a designed error bubble showing
          // the message text (instead of silently dropping it, which left
          // the user with only their own message + the easy-to-miss banner).
          const partial = last.content.trim();
          return [...prev.slice(0, -1), {
            ...last,
            content: partial ? last.content : event.payload.error,
            isStreaming: false,
            isError: true,
            errorCode: event.payload.code,
          }];
        }
        return prev;
      });
    }));

    // Rust's SseRelay maps a `cancelled` SSE frame straight to `jarvis://done`
    // (see runner.rs `SseFrameOutcome::Cancelled`) — there is no distinct
    // `jarvis://cancelled` Tauri event today, so this listener is a no-op
    // registration for forward-compatibility / documentation of the gap
    // rather than dead code masking a real handler. If a future Rust change
    // adds a genuine `jarvis://cancelled` emit, this starts working without
    // further UI changes.
    track(listen<{ session_id: string }>('jarvis://cancelled', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      setIsStreaming(false);
      setPipelineStage('');
      setRecursionDepth(null);
      setError(null);
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last.isStreaming) {
          const content = sanitizeAssistantDisplay(last.content);
          if (!content) return prev.slice(0, -1);
          return [...prev.slice(0, -1), { ...last, content, isStreaming: false, isCancelled: true }];
        }
        return prev;
      });
    }));

    track(listen<{ stage: string; status: string; agent: string; session_id?: string }>('jarvis://stage', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const { stage, status } = event.payload;
      setPipelineStage(isTerminalStageStatus(status) ? '' : stage);
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
        return;
      }
      setAgentSteps(prev => {
        const last = prev[prev.length - 1];
        if (last && last.stage === stage) {
          return [...prev.slice(0, -1), { stage, text: last.text + text }];
        }
        return [...prev, { stage, text }];
      });
    }));

    track(listen<{
      call_id: string;
      name: string;
      arguments: unknown;
      session_id: string;
    }>('jarvis://approval_request', (event) => {
      const p = event.payload;
      if (!matchesStreamSession(p.session_id)) return;
      setApprovalError(null);
      setPendingApproval({
        call_id: p.call_id,
        name: p.name,
        arguments: p.arguments,
        session_id: p.session_id,
      });
    }));

    track(listen<{ call_id?: string; name: string; arguments: unknown; session_id?: string }>('jarvis://tool_call', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      setToolCalls(prev => [...prev, {
        call_id: event.payload.call_id,
        name: event.payload.name,
        arguments: event.payload.arguments,
      }]);
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
    }));

    track(listen<{ tokens: number; cost_usd: number; session_id?: string }>('jarvis://cost', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      setTurnCost({ tokens: event.payload.tokens, costUsd: event.payload.cost_usd });
    }));

    return () => {
      disposed = true;
      unsubs.forEach((f) => f());
    };
  }, [appendAssistantText, finalizeAssistantMessage, matchesStreamSession]);

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
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [activeSession]);

  const streamFromJarvisApi = useCallback(async (
    sid: string,
    userMsg: string,
    history: Array<{ role: string; content: string }>,
    sendGeneration: number,
    onAccepted: () => void,
    clientMessageId: string,
  ) => {
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    setPipelineStage('stream relay');

    // `append_message` returns the DB row id (sessions.rs `insert_message_row`).
    // Swap the client-generated id for the persisted one so a later
    // history-reload (which maps DB row ids into JarvisMessage.id) recognizes
    // this as the SAME message instance and dedupes it, instead of showing it
    // twice — the 2026-07-03 incident 1d4727cf "two YOU bubbles" bug.
    invoke<string>('append_message', {
      ...sessionInvokeArgs(sid),
      role: 'user',
      content: userMsg,
    }).then((dbId) => {
      // Guard for a non-empty string specifically — `invoke` is typed as
      // `Promise<string>` but nothing prevents a stale/mocked backend from
      // resolving something else (e.g. a bare `true`), which would corrupt
      // JarvisMessage.id and the `key` it feeds into.
      if (typeof dbId !== 'string' || !dbId) return;
      setMessages(prev => prev.map((m) => (m.id === clientMessageId ? { ...m, id: dbId } : m)));
    }).catch((e) => console.error('Failed to persist user message:', e));

    const response = await fetch(`${JARVIS_API_URL}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: userMsg,
        session_id: sid,
        history,
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
    if (!sendGateRef.current.isCurrent(sendGeneration)) {
      controller.abort('Stale Session turn');
      throw new DOMException('Stale Session turn', 'AbortError');
    }
    onAccepted();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamedVisibleText = false;
    let streamedRawText = '';
    let inactivityTimedOut = false;
    const reportUnknownFrame = createUnknownFrameReporter();
    const inactivityWatchdog = new InactivityWatchdog(
      STREAM_INACTIVITY_TIMEOUT_MS,
      () => {
        inactivityTimedOut = true;
        controller.abort('Jarvis stream inactivity timeout');
        reader.cancel('Jarvis stream inactivity timeout').catch(() => {});
      },
    );

    const handleFrame = (frame: any) => {
      if (!sendGateRef.current.isCurrent(sendGeneration)) return;
      if (!frame || typeof frame !== 'object') return;
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
          return;
        }
        setAgentSteps(prev => {
          const last = prev[prev.length - 1];
          const text = String(frame.text);
          if (last && last.stage === stage) {
            return [...prev.slice(0, -1), { stage, text: last.text + text }];
          }
          return [...prev, { stage, text }];
        });
        return;
      }
      if (frame.type === 'orchestrator_stage') {
        setPipelineStage(isTerminalStageStatus(frame.status) ? '' : String(frame.stage || ''));
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
      if (frame.type === 'tool_use') {
        setToolCalls(prev => [...prev, {
          call_id: frame.id || frame.call_id,
          name: frame.name || frame.tool_name || 'unknown',
          arguments: frame.arguments ?? frame.input ?? null,
        }]);
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
        return;
      }
      if (frame.type === 'cost_info') {
        setTurnCost({
          tokens: Number(frame.total_tokens ?? frame.tokens ?? 0),
          costUsd: Number(frame.cost_usd ?? 0),
        });
        return;
      }
      if (frame.type === 'fallback_notice') {
        const target = String(frame.model || frame.provider || 'next available backend');
        setPipelineStage(`fallback → ${target}`);
        return;
      }
      if (isPassiveSseFrame(frame.type)) return;
      if (frame.type === 'result') {
        if (frame.is_error) throw new Error(String(frame.result || frame.error || 'Jarvis stream failed.'));
        if (!streamedVisibleText) {
          const text = String(frame.result || '');
          if (text) appendAssistantText(text);
        }
        return;
      }
      if (frame.type === 'error') {
        // P0-B (2026-07-02): the `code` field discriminates the failure
        // mode. `first_token_timeout` means the model hung and was
        // terminated by the server-side watchdog; surface a clearer
        // message than the raw `frame.error` (which the server now
        // formats to a per-model "did not produce any output within the
        // per-model first-token window" string). Other codes fall
        // through to the raw `frame.error` text.
        const code = typeof frame.code === 'string' ? frame.code : undefined;
        if (code) {
          // eslint-disable-next-line no-console
          console.warn(`[Jarvis] stream error code=${code}: ${frame.error}`);
        }
        throw new JarvisStreamError(String(frame.error || 'Jarvis stream failed.'), code);
      }
      if (frame.type === 'cancelled') {
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
        setIsStreaming(false);
        stopRequestedRef.current = false;
        setError(null);
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant' && last.isStreaming) {
            const content = sanitizeAssistantDisplay(last.content);
            if (!content) return prev.slice(0, -1);
            return [...prev.slice(0, -1), { ...last, content, isStreaming: false, isCancelled: true }];
          }
          return finalizeStreamingMessages(prev);
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
              handleFrame(frame);
            }
          }
        }
      }
    } catch (error) {
      if (inactivityTimedOut) {
        throw new Error(`Jarvis stream was inactive for ${STREAM_INACTIVITY_TIMEOUT_MS / 1000} seconds.`);
      }
      throw error;
    } finally {
      inactivityWatchdog.stop();
    }
    if (inactivityTimedOut) {
      throw new Error(`Jarvis stream was inactive for ${STREAM_INACTIVITY_TIMEOUT_MS / 1000} seconds.`);
    }

    if (sendGateRef.current.isCurrent(sendGeneration)) finalizeAssistantMessage(sid);
    if (streamAbortRef.current === controller) streamAbortRef.current = null;
  }, [appendAssistantText, finalizeAssistantMessage]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming) return;
    const sendGeneration = sendGateRef.current.tryAcquire();
    if (sendGeneration === null) return;
    stopRequestedRef.current = false;
    const userMsg = input.trim();
    const history = messages
      .filter((msg) => !msg.isStreaming && msg.content.trim())
      .map((msg) => ({ role: msg.role, content: msg.content }));
    setError(null);
    setIsStreaming(true);
    setPipelineStage('');
    setRecursionDepth(null);
    setReasoningText('');
    setShowReasoning(false);
    setAgentSteps([]);
    setShowAgents(true);
    setToolCalls([]);
    setTurnCost(null);
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
        effectiveSessionId = newSession.id;
        // Suppress the history-load effect that setActiveSession is about to
        // trigger — otherwise it overwrites the optimistic messages above with
        // the empty history of this brand-new session.
        suppressHistoryLoadRef.current = newSession.id;
        setSessionId(newSession.id);
        setActiveSession(newSession.id);
        onSessionCreated();
      }

      await streamFromJarvisApi(effectiveSessionId, userMsg, history, sendGeneration, () => {
        setInput(current => current.trim() === userMsg ? '' : current);
      }, clientMessageId);
    } catch (e) {
      if (!sendGateRef.current.isCurrent(sendGeneration)) return;
      streamAbortRef.current = null;
      setIsStreaming(false);
      if (stopRequestedRef.current) {
        stopRequestedRef.current = false;
        setError(null);
        setMessages(prev => finalizeStreamingMessages(prev));
        return;
      }
      // Task 7 Part C (incident 1d4727cf): finalize the streaming bubble into
      // a designed error bubble — friendly text, `errorCode` as small muted
      // detail — instead of leaving a plain assistant-looking message and
      // relying solely on the (dismissable, easy-to-miss) banner below.
      const errorMessage = String(e instanceof Error ? e.message : e);
      const errorCode = e instanceof JarvisStreamError ? e.code : undefined;
      setError(errorMessage);
      setInput(current => recoverComposerAfterFailure(current, userMsg));
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last.isStreaming) {
          const partial = last.content.trim();
          return [...prev.slice(0, -1), {
            ...last,
            content: partial ? last.content : errorMessage,
            isStreaming: false,
            isError: true,
            errorCode,
          }];
        }
        return prev;
      });
    } finally {
      sendGateRef.current.release(sendGeneration);
    }
  }, [input, isStreaming, messages, activeSession, sessionId, onSessionCreated, setActiveSession, streamFromJarvisApi]);

  // Phase 1.3 — real Stop. POST /chat/cancel on the Bun server; SseRelay now
  // treats the resulting `cancelled` frame as terminal, so isStreaming flips.
  const handleStop = useCallback(async () => {
    const sid = activeSession || sessionId;
    if (!sid) {
      setIsStreaming(false);
      return;
    }
    stopRequestedRef.current = true;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setReasoningText('');
    setShowReasoning(false);
    fetch(`${JARVIS_API_URL}/chat/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sid }),
    }).catch(() => {});
    try {
      const cancelled = await invoke<boolean>('cancel_chat_stream', sessionInvokeArgs(sid));
      if (!cancelled) setIsStreaming(false);
    } catch (e) {
      console.error('Failed to cancel stream:', e);
      setIsStreaming(false);
    }
  }, [activeSession, sessionId]);

  // Phase 1.1 — approve / deny the pending tool call and forward the decision
  // to the Bun server. Surface any POST error so the user can retry.
  const handleApproval = useCallback(async (approved: boolean) => {
    if (!pendingApproval) return;
    try {
      await invoke('jarvis_tool_decision', {
        ...sessionInvokeArgs(pendingApproval.session_id),
        toolCallId: pendingApproval.call_id,
        tool_call_id: pendingApproval.call_id,
        decision: approved ? 'approve' : 'deny',
      });
      setPendingApproval(null);
      setApprovalError(null);
    } catch (e) {
      setApprovalError(String(e));
    }
  }, [pendingApproval]);

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
    setIsStreaming(false);
    setMessages([]);
    setSessionId('');
    setActiveSession(null);
    setError(null);
    setPipelineStage('');
    setRecursionDepth(null);
    setReasoningText('');
    setShowReasoning(false);
    setAgentSteps([]);
    setToolCalls([]);
    setTurnCost(null);
    setPendingApproval(null);
    setUserPinnedToBottom(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const onSuggestionClick = (s: string) => {
    setInput(s);
    inputRef.current?.focus();
  };

  const lastAssistant = messages[messages.length - 1];
  const streamStatusText = (() => {
    if (!isStreaming) return undefined;
    if (pendingApproval) return `Jarvis is waiting for approval to run ${pendingApproval.name}.`;
    if (pipelineStage) return `Jarvis is running ${pipelineStage}...`;
    const latestAgentStep = agentSteps[agentSteps.length - 1];
    if (latestAgentStep?.stage) return `Jarvis is working in ${latestAgentStep.stage}...`;
    return 'Jarvis is preparing the response...';
  })();
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

  return (
    <div className="h-full flex flex-col">
      {/* Chat header bar */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-bone tracking-tight">Jarvis</h2>
          {config && (
            <>
              <Pill variant={config.active_backend === 'openrouter' ? 'info' : 'success'}>{backendLabel}</Pill>
              <Pill>{modelLabel}</Pill>
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
          <div className="space-y-2">
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

        {messages.length === 0 && !loadingHistory && (
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

        {/* Inline tool-call cards (Phase 3.1). */}
        {toolCalls.length > 0 && (
          <div className="space-y-1.5">
            {toolCalls.map((call, i) => (
              <ToolCallCard key={`tc-${i}`} call={call} />
            ))}
          </div>
        )}

        {/* Reasoning + Agents combined disclosure — accordion with per-stage rows */}
        {(reasoningText || agentSteps.length > 0) && (
          <ReasoningAgentsAccordion
            reasoningText={reasoningText}
            agentSteps={agentSteps}
            showAgents={showAgents}
            setShowAgents={setShowAgents}
            showReasoning={showReasoning}
            setShowReasoning={setShowReasoning}
          />
        )}

        {/* Pipeline stage breadcrumb (orchestrator mode) */}
        {pipelineStage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-2 px-3 py-2 bg-royal/5 border border-royal/15 rounded-lg text-[10px] font-mono text-royal-light"
            aria-label={`Orchestrator stage: ${pipelineStage}`}
          >
            <motion.span
              animate={{ opacity: prefersReducedMotion.current ? 1 : [0.4, 1, 0.4] }}
              transition={{ duration: 1.2, repeat: prefersReducedMotion.current ? 0 : Infinity }}
              aria-hidden="true"
            >
              <Sparkles size={11} />
            </motion.span>
            <span className="uppercase tracking-wider">{pipelineStage}</span>
            {recursionDepth !== null && (
              <span className="text-bone-faint">↩ depth {recursionDepth}</span>
            )}
            {recursionDepth === null && <span className="text-bone-faint">running…</span>}
          </motion.div>
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
            {isStreaming ? '● Streaming…' : `${messages.filter(m => m.role === 'user').length} message${messages.filter(m => m.role === 'user').length !== 1 ? 's' : ''} sent`}
          </span>
          <span className="text-[10px] font-mono text-bone-faint flex items-center gap-2">
            {turnCost && (
              <>
                <span>{turnCost.tokens.toLocaleString()} tok</span>
                {turnCost.costUsd > 0 && <span>${turnCost.costUsd.toFixed(4)}</span>}
                <span aria-hidden="true">·</span>
              </>
            )}
            {config?.active_backend === 'openrouter' ? 'via OpenRouter' : config?.active_backend === 'claude_cli' ? 'via Claude CLI' : 'via Ollama'}
          </span>
        </div>
      </div>

      {/* Phase 1.1 — Tool approval modal. Rendered outside the scroll area so
          it never gets clipped; focus is trapped by Esc / click-backdrop. */}
      <AnimatePresence>
        {pendingApproval && (
          <ApprovalModal
            call_id={pendingApproval.call_id}
            name={pendingApproval.name}
            args={pendingApproval.arguments}
            error={approvalError}
            onApprove={() => handleApproval(true)}
            onReject={() => handleApproval(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

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

  if (!isUser && !isTool && !displayContent && !streamStatus) return null;

  // Task 7 Part C: a finalized assistant bubble that ended in a server/stream
  // error or a user-cancelled turn gets a distinct visual treatment instead
  // of silently looking like a normal reply (or, previously, leaving the
  // streaming spinner running forever).
  const isErrorBubble = !isUser && !isTool && message.isError;
  const isCancelledBubble = !isUser && !isTool && message.isCancelled;
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
            : isCancelledBubble
              ? 'text-bone-faint italic'
              : isTool
                ? 'text-bone-dim'
                : 'text-bone-muted'
      )}>
        {isUser || isTool
          ? displayContent
          : isCancelledBubble
            ? '(stopped)'
            : streamStatus
              ? <span className="text-bone-faint font-mono text-xs">{streamStatus}</span>
              : isToolEcho
                ? <ToolCallEchoCard content={displayContent} />
                : <MarkdownView content={displayContent} />}
        {message.isStreaming && (
          <motion.span
            className="inline-block w-1.5 h-3.5 bg-cyan-neon/70 ml-0.5 align-middle rounded-sm"
            animate={prefersReducedMotion ? undefined : { opacity: [0, 1, 0] }}
            transition={{ duration: 0.8, repeat: prefersReducedMotion ? 0 : Infinity }}
            aria-hidden="true"
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
  call: {
    name: string;
    arguments: unknown;
    result?: string;
    is_error?: boolean;
    matched?: boolean;
    contextTruncation?: ToolResultTruncationMetadata;
  };
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
      className={cn(
        'rounded-xl border border-iron/30 bg-obsidian/40 overflow-hidden mr-8',
        call.is_error ? 'border-error/40' : 'border-iron/30'
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
        {call.is_error && <Pill variant="error">error</Pill>}
        {call.result !== undefined && !call.is_error && <Pill variant="success">done</Pill>}
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
            <span className="ml-auto opacity-50">{agentSteps.length} stage{agentSteps.length !== 1 ? 's' : ''}</span>
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

function ApprovalModal({ call_id, name, args, error, onApprove, onReject }: {
  call_id: string;
  name: string;
  args: unknown;
  error: string | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  const argText = (() => {
    try {
      if (!args) return '';
      if (typeof args === 'string') return args;
      return JSON.stringify(args, null, 2);
    } catch { return String(args); }
  })();

  // Esc to reject. Use a captured keydown listener at modal mount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onReject();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onApprove();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onApprove, onReject]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onReject}
      role="dialog"
      aria-modal="true"
      aria-label="Tool approval required"
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
        {error && (
          <p className="text-error text-xs font-mono mb-2 break-words" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-3 justify-end mt-4">
          <button
            type="button"
            autoFocus
            aria-label="Reject tool call"
            className="px-4 py-2 text-xs font-mono rounded-lg border border-error/40 text-error hover:bg-error/10 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/50"
            onClick={onReject}
          >
            Reject  (Esc)
          </button>
          <button
            type="button"
            aria-label="Approve tool call"
            className="px-4 py-2 text-xs font-mono rounded-lg border border-cyan-neon/40 text-cyan-glow hover:bg-cyan-neon/10 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
            onClick={onApprove}
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
  sessions, sessionRuns, activeSession, onSelect, onNew, onDelete, onRefresh,
}: {
  sessions: JarvisSession[];
  sessionRuns: Record<string, SessionRunRecord>;
  activeSession: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: () => void;
  onRefresh: () => void;
}) {
  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke('jarvis_delete_session', { sessionId: id });
      onDelete();
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-bone tracking-tight">Sessions <span className="text-bone-font text-sm font-mono">({sessions.length})</span></h2>
        <div className="flex gap-2">
          <button
            onClick={onRefresh}
            aria-label="Refresh sessions"
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

      <div className="flex-1 overflow-y-auto space-y-2">
        {sessions.length === 0 ? (
          <div className="flex items-center justify-center h-48">
            <div className="text-center">
              <p className="text-bone-dim text-sm font-mono">No sessions yet</p>
              <p className="text-bone-faint text-xs font-mono mt-1">Start a chat to create one</p>
            </div>
          </div>
        ) : (
          sessions.map(session => (
            <GlassCard
              key={session.id}
              className={cn(activeSession === session.id && 'border-royal/40 bg-royal/10')}
              onClick={() => onSelect(session.id)}
            >
              <div className="flex items-center gap-3">
                <StatusDot ok={activeSession === session.id} size="sm" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-semibold text-bone truncate">{session.name || session.title || 'Untitled'}</span>
                    <Pill>{session.model}</Pill>
                  </div>
                  <div className="text-[11px] font-mono text-bone-faint">
                    {session.message_count} msgs · {new Date(session.created_at).toLocaleDateString()}
                    {sessionRuns[session.id] && (
                      <span className="ml-2">
                        · <span className={{
                          success: 'text-emerald-400',
                          partial: 'text-amber-400',
                          failed: 'text-error',
                          timed_out: 'text-amber-400',
                          cancelled: 'text-bone-dim',
                        }[sessionRuns[session.id]!.outcome]}>
                          {sessionRuns[session.id]!.outcome}
                        </span>
                        {sessionRuns[session.id]!.selected_model && (
                          <span className="ml-1 text-bone-faint">({sessionRuns[session.id]!.selected_model})</span>
                        )}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={(e) => handleDelete(session.id, e)}
                  aria-label={`Delete session ${session.name || session.title || session.id}`}
                  className="text-bone-faint hover:text-error text-xs font-mono transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/50 rounded px-1"
                >
                  ✕
                </button>
              </div>
            </GlassCard>
          ))
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Config Panel ──
// ═══════════════════════════════════════════════════════════════

function ConfigPanel({ config, setConfig }: { config: JarvisConfig | null; setConfig: (c: JarvisConfig | null) => void }) {
  const [localConfig, setLocalConfig] = useState<JarvisConfig | null>(config);
  const [saved, setSaved] = useState(false);
  const [showApiKeys, setShowApiKeys] = useState(false);

  useEffect(() => {
    setLocalConfig(config);
  }, [config]);

  const handleSave = async () => {
    if (!localConfig) return;
    try {
      await invoke('jarvis_save_config', { config: localConfig });
      setConfig(localConfig);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('Failed to save config:', e);
    }
  };

  const updateField = <K extends keyof JarvisConfig>(key: K, value: JarvisConfig[K]) => {
    if (!localConfig) return;
    setLocalConfig({ ...localConfig, [key]: value });
  };

  if (!localConfig) {
    return (
      <div className="flex items-center justify-center h-48">
        <p className="text-bone-dim text-sm font-mono">Loading config...</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pr-1">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-bone tracking-tight">Configuration</h2>
        <button
          onClick={handleSave}
          className={cn(
            'px-4 py-1.5 text-xs font-mono rounded-lg border transition-all',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50',
            saved
              ? 'bg-cyan-neon/20 text-cyan-glow border-cyan-neon/40'
              : 'bg-royal/20 text-royal-light border-royal/40 hover:bg-royal/30'
          )}
        >
          {saved ? '✓ Saved' : 'Save Config'}
        </button>
      </div>

      <div className="space-y-4">
        {/* Backend Selection */}
        <GlassCard hoverable={false}>
          <h3 className="text-sm font-semibold text-bone mb-3">Backend</h3>
          <div className="flex gap-2">
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
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Status Panel ──
// ═══════════════════════════════════════════════════════════════

function StatusPanel({ status, onRefresh }: { status: JarvisStatus | null; onRefresh: () => void }) {
  if (!status) {
    return (
      <div className="flex items-center justify-center h-48">
        <p className="text-bone-dim text-sm font-mono">Loading status...</p>
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
          className="px-3 py-1 text-xs font-mono text-bone-dim border border-iron/30 rounded-lg hover:border-iron/50 hover:text-bone-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
        >
          ↻ Refresh
        </button>
      </div>

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
