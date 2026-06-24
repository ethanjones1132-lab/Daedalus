import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '../ui';
import type { CompanionState } from './types';
import {
  JarvisSession, JarvisMessage, JarvisConfig, JarvisStatus,
  OPENROUTER_MODELS,
} from './types';
import ControlCenterView from './ControlCenterView';
import MarkdownView from './MarkdownView';
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

export default function JarvisView({ initialSubView = 'chat', onCompanionChange }: JarvisViewProps) {
  const [subView, setSubView] = useState<JarvisSubView>(initialSubView);
  const [sessions, setSessions] = useState<JarvisSession[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [config, setConfig] = useState<JarvisConfig | null>(null);
  const [status, setStatus] = useState<JarvisStatus | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const result = await invoke<JarvisSession[]>('jarvis_list_sessions');
      setSessions(result);
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

function ChatPanel({
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
  const [toolCalls, setToolCalls] = useState<{
    call_id?: string;
    name: string;
    arguments: unknown;
    result?: string;
    is_error?: boolean;
    matched?: boolean;
  }[]>([]);

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
  useEffect(() => { activeSessionRef.current = activeSession; }, [activeSession]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { onSessionCreatedRef.current = onSessionCreated; }, [onSessionCreated]);

  const matchesStreamSession = useCallback((sid: string | undefined) => {
    const current = activeSessionRef.current || sessionIdRef.current;
    if (!current) return true;
    if (!sid) return false;
    return sid === current;
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
    prevActiveSessionRef.current = activeSession;
    if (prev && prev !== activeSession) {
      invoke('cancel_chat_stream', { sessionId: prev }).catch(() => {});
      setIsStreaming(false);
      setPipelineStage('');
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
    if (suppressHistoryLoadRef.current && suppressHistoryLoadRef.current === activeSession) {
      // Freshly created by handleSend — the optimistic messages are already on
      // screen and the stream is in flight. Loading empty history would wipe
      // them. Consume the suppression once and leave the messages intact.
      suppressHistoryLoadRef.current = null;
      setLoadingHistory(false);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    invoke<SessionHistoryMessage[]>('get_session_history', { sessionId: activeSession })
      .then((rows) => {
        if (cancelled) return;
        setMessages(rows.map(r => ({
          role: (r.role === 'user' || r.role === 'assistant' || r.role === 'tool' || r.role === 'system') ? r.role : 'assistant',
          content: r.content,
          timestamp: r.created_at,
        })));
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
      setError(null);
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant' && last.isStreaming) {
          return [...prev.slice(0, -1), { ...last, content: last.content + text }];
        }
        return [...prev, { role: 'assistant', content: text, isStreaming: true }];
      });
    }));

    track(listen<{ session_id: string }>('jarvis://done', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      setIsStreaming(false);
      setPipelineStage('');
      setPendingApproval(null);
      setUserPinnedToBottom(true);
      const sid = event.payload.session_id || activeSessionRef.current || sessionIdRef.current;
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.isStreaming) {
          const finalized = { ...last, isStreaming: false };
          if (sid && finalized.content.trim()) {
            invoke('append_message', {
              sessionId: sid,
              role: 'assistant',
              content: finalized.content,
            }).catch((e) => console.error('Failed to persist assistant message:', e));
          }
          return [...prev.slice(0, -1), finalized];
        }
        return prev;
      });
      onSessionCreatedRef.current();
    }));

    track(listen<{ error: string; session_id: string }>('jarvis://error', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      setIsStreaming(false);
      setPipelineStage('');
      setPendingApproval(null);
      setError(event.payload.error);
      setUserPinnedToBottom(true);
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.isStreaming) {
          // If nothing streamed before the error (e.g. a turn-fatal auth
          // failure), drop the empty assistant bubble so the user sees just
          // their message + the error banner — not a blank reply. Otherwise
          // finalize whatever partial text did arrive.
          if (!last.content.trim()) {
            return prev.slice(0, -1);
          }
          return [...prev.slice(0, -1), { ...last, isStreaming: false }];
        }
        return prev;
      });
    }));

    track(listen<{ stage: string; status: string; agent: string; session_id?: string }>('jarvis://stage', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      const { stage, status } = event.payload;
      setPipelineStage(status === 'done' ? '' : stage);
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
      setToolCalls(prev => {
        const idx = [...prev].reverse().findIndex((c) => {
          if (c.result !== undefined) return false;
          if (call_id && c.call_id) return c.call_id === call_id;
          return c.name === name;
        });
        if (idx >= 0) {
          const real = prev.length - 1 - idx;
          const next = [...prev];
          next[real] = { ...next[real], result: output, is_error, matched: true };
          return next;
        }
        return [...prev, { name, arguments: null, result: output, is_error }];
      });
    }));

    track(listen<{ tokens: number; cost_usd: number; session_id?: string }>('jarvis://cost', (event) => {
      if (!matchesStreamSession(event.payload.session_id)) return;
      setTurnCost({ tokens: event.payload.tokens, costUsd: event.payload.cost_usd });
    }));

    return () => {
      disposed = true;
      unsubs.forEach((f) => f());
    };
  }, [matchesStreamSession]);

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
  }, [activeSession, isStreaming]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming) return;
    const userMsg = input.trim();
    setInput('');
    setError(null);
    setIsStreaming(true);
    setPipelineStage('');
    setReasoningText('');
    setShowReasoning(false);
    setAgentSteps([]);
    setShowAgents(true);
    setToolCalls([]);
    setTurnCost(null);
    setUserPinnedToBottom(true);
    setMessages(prev => [
      ...prev,
      { role: 'user', content: userMsg },
      { role: 'assistant', content: '', isStreaming: true },
    ]);

    try {
      let effectiveSessionId = activeSession || sessionId;
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

      await invoke('jarvis_send_message', {
        message: userMsg,
        sessionId: effectiveSessionId,
      });
    } catch (e) {
      setIsStreaming(false);
      setError(String(e));
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last.isStreaming) {
          return [...prev.slice(0, -1), { ...last, isStreaming: false }];
        }
        return prev;
      });
    }
  }, [input, isStreaming, activeSession, sessionId, onSessionCreated, setActiveSession]);

  // Phase 1.3 — real Stop. POST /chat/cancel on the Bun server; SseRelay now
  // treats the resulting `cancelled` frame as terminal, so isStreaming flips.
  const handleStop = useCallback(async () => {
    const sid = activeSession || sessionId;
    if (!sid) {
      setIsStreaming(false);
      return;
    }
    try {
      const cancelled = await invoke<boolean>('cancel_chat_stream', { sessionId: sid });
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
        sessionId: pendingApproval.session_id,
        toolCallId: pendingApproval.call_id,
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
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
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
      invoke('cancel_chat_stream', { sessionId: sid }).catch(() => {});
    }
    setIsStreaming(false);
    setMessages([]);
    setSessionId('');
    setActiveSession(null);
    setError(null);
    setPipelineStage('');
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
  const showSkeleton =
    isStreaming &&
    !loadingHistory &&
    (messages.length === 0 ||
      (lastAssistant && lastAssistant.role !== 'assistant' && !lastAssistant.isStreaming));

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
          <ChatMessage key={i} message={msg} index={i} prefersReducedMotion={prefersReducedMotion.current} />
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
            <span className="text-bone-faint">running…</span>
          </motion.div>
        )}

        {error && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-3 bg-error/10 border border-error/30 rounded-xl"
            role="alert"
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
  message, index, prefersReducedMotion,
}: {
  message: JarvisMessage;
  index: number;
  prefersReducedMotion: boolean;
}) {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  }, [message.content]);

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
          : isTool
            ? 'glass-mythos bg-obsidian/40 border-iron/30 mr-8'
            : 'glass-strong bg-cyan-neon/5 border-cyan-neon/20 mr-8'
      )}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className={cn(
          'text-[10px] font-mono uppercase tracking-wider font-bold flex items-center gap-1',
          isUser ? 'text-royal-light' : isTool ? 'text-bone-dim' : 'text-cyan-neon'
        )}>
          {isUser ? <><User size={11} /> YOU</> : isTool ? <><Wrench size={11} /> TOOL: {message.tool_name || 'unknown'}</> : <><Bot size={11} /> JARVIS</>}
        </span>
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
        isUser ? 'text-bone' : isTool ? 'text-bone-dim' : 'text-bone-muted'
      )}>
        {isUser || isTool ? message.content : <MarkdownView content={message.content} />}
        {message.isStreaming && (
          <motion.span
            className="inline-block w-1.5 h-3.5 bg-cyan-neon/70 ml-0.5 align-middle rounded-sm"
            animate={prefersReducedMotion ? undefined : { opacity: [0, 1, 0] }}
            transition={{ duration: 0.8, repeat: prefersReducedMotion ? 0 : Infinity }}
            aria-hidden="true"
          />
        )}
      </div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Tool Call Card (Phase 3.1) ──
// ═══════════════════════════════════════════════════════════════

function ToolCallCard({ call }: {
  call: { name: string; arguments: unknown; result?: string; is_error?: boolean; matched?: boolean };
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
  sessions, activeSession, onSelect, onNew, onDelete, onRefresh,
}: {
  sessions: JarvisSession[];
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
  const [showApiKey, setShowApiKey] = useState(false);

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

        {/* OpenRouter API Key */}
        {localConfig.active_backend === 'openrouter' && (
          <GlassCard hoverable={false}>
            <h3 className="text-sm font-semibold text-bone mb-3">OpenRouter API Key</h3>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={(localConfig.openrouter?.api_key ?? '')}
                onChange={(e) => setLocalConfig(prev => prev ? {
                  ...prev,
                  openrouter: { ...prev.openrouter, api_key: e.target.value }
                } : prev)}
                placeholder="sk-or-v1-..."
                className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors pr-16"
              />
              <button
                onClick={() => setShowApiKey(!showApiKey)}
                aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-bone-dim hover:text-bone-muted transition-colors px-1.5 py-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-neon/50"
              >
                {showApiKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <p className="text-[10px] font-mono text-bone-faint mt-1.5">
              Get your key at <span className="text-royal-light">openrouter.ai/keys</span>
            </p>
          </GlassCard>
        )}

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