import { useState, useEffect, useRef, useCallback } from 'react';
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
import MarkdownRenderer from './MarkdownRenderer';

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

  const subNavItems: { id: JarvisSubView; label: string; icon: string }[] = [
    { id: 'chat', label: 'Chat', icon: '◈' },
    { id: 'sessions', label: 'Sessions', icon: '◉' },
    { id: 'config', label: 'Config', icon: '⚙' },
    { id: 'status', label: 'Status', icon: '♡' },
    { id: 'control', label: 'Control', icon: '◆' },
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

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.25 }}
      className="h-full flex flex-col"
    >
      {/* Sub-navigation tabs */}
      <div className="flex items-center gap-1 mb-4 shrink-0">
        {subNavItems.map(item => (
          <button
            key={item.id}
            onClick={() => setSubView(item.id)}
            className={cn(
              'px-3 py-1.5 text-xs font-mono rounded-lg border transition-all duration-150 flex items-center gap-1.5',
              subView === item.id
                ? 'bg-royal/20 text-royal-light border-royal/40'
                : 'text-bone-dim border-iron/30 hover:border-iron/50 hover:text-bone-muted'
            )}
          >
            <span className="text-[10px]">{item.icon}</span>
            {item.label}
          </button>
        ))}
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
// ── Chat Panel ──
// ═══════════════════════════════════════════════════════════════

function ChatPanel({
  activeSession, setActiveSession, config, onSessionCreated,
}: {
  activeSession: string | null;
  setActiveSession: (id: string | null) => void;
  config: JarvisConfig | null;
  onSessionCreated: () => void;
}) {
  const [messages, setMessages] = useState<JarvisMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [backendLabel, setBackendLabel] = useState<string>('');
  const [modelLabel, setModelLabel] = useState<string>('');
  // Orchestrator pipeline progress: e.g. "planner", "executor", "reviewer"
  const [pipelineStage, setPipelineStage] = useState<string>('');
  // Reasoning/CoT text accumulated while streaming (cleared on done)
  const [reasoningText, setReasoningText] = useState<string>('');
  const [showReasoning, setShowReasoning] = useState(false);
  // Intermediate agent activity per stage (planner/executor/reviewer/rewriter)
  const [agentSteps, setAgentSteps] = useState<{ stage: string; text: string }[]>([]);
  const [showAgents, setShowAgents] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (config) {
      setBackendLabel(config.active_backend === 'openrouter' ? 'OpenRouter' : 'Ollama');
      setModelLabel((config.active_backend === 'ollama' ? config.ollama.model : config.openrouter.model));
    }
  }, [config]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Throttle scroll during streaming: tokens arrive at 20-50 Hz, but smooth-scrolling
  // on every character feels laggy and costs layout work. 100ms ≈ 10 fps — smooth
  // enough to follow the cursor, cheap enough to not thrash the main thread.
  useEffect(() => {
    if (!isStreaming) {
      scrollToBottom();
      return;
    }
    const t = setTimeout(scrollToBottom, 100);
    return () => clearTimeout(t);
  }, [messages, isStreaming, scrollToBottom]);

  // Listen for streaming tokens
  useEffect(() => {
    const unlisten = listen<{ text: string; session_id: string }>('jarvis://token', (event) => {
      const { text } = event.payload;
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant' && last.isStreaming) {
          return [...prev.slice(0, -1), { ...last, content: last.content + text }];
        }
        return [...prev, { role: 'assistant', content: text, isStreaming: true }];
      });
    });

    const unlistenDone = listen<{ session_id: string }>('jarvis://done', () => {
      setIsStreaming(false);
      setPipelineStage('');
      // Keep reasoningText visible after done so the user can review the
      // chain-of-thought that produced the answer. They can collapse it
      // manually; we'll clear it on the next user message.
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.isStreaming) {
          return [...prev.slice(0, -1), { ...last, isStreaming: false }];
        }
        return prev;
      });
      onSessionCreated();
    });

    const unlistenError = listen<{ error: string; session_id: string }>('jarvis://error', (event) => {
      setIsStreaming(false);
      setPipelineStage('');
      setError(event.payload.error);
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.isStreaming) {
          return [...prev.slice(0, -1), { ...last, isStreaming: false }];
        }
        return prev;
      });
    });

    const unlistenStage = listen<{ stage: string; status: string; agent: string }>('jarvis://stage', (event) => {
      const { stage, status } = event.payload;
      setPipelineStage(status === 'done' ? '' : stage);
    });

    const unlistenReasoning = listen<{ text: string }>('jarvis://reasoning', (event) => {
      setReasoningText(prev => prev + event.payload.text);
    });

    const unlistenAgents = listen<{ stage: string; text: string }>('jarvis://agent_activity', (event) => {
      const { stage, text } = event.payload;
      setAgentSteps(prev => {
        const last = prev[prev.length - 1];
        if (last && last.stage === stage) {
          return [...prev.slice(0, -1), { stage, text: last.text + text }];
        }
        return [...prev, { stage, text }];
      });
    });

    return () => {
      unlisten.then(f => f());
      unlistenDone.then(f => f());
      unlistenError.then(f => f());
      unlistenStage.then(f => f());
      unlistenReasoning.then(f => f());
      unlistenAgents.then(f => f());
    };
  }, [onSessionCreated]);

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
    setShowAgents(false);
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);

    try {
      // Auto-create a session on first message so the turn is durable in SQLite
      // and the user can return to it from the Sessions panel. Without this, the
      // first message gets a transient UUID and vanishes on refresh.
      let effectiveSessionId = activeSession || sessionId;
      if (!effectiveSessionId) {
        const newSession = await invoke<JarvisSession>('jarvis_new_session', {
          name: userMsg.slice(0, 60),
        });
        effectiveSessionId = newSession.id;
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
    }
  }, [input, isStreaming, activeSession, sessionId, onSessionCreated]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewChat = () => {
    setMessages([]);
    setSessionId('');
    setActiveSession(null);
    setError(null);
    setPipelineStage('');
    setReasoningText('');
    setShowReasoning(false);
    setAgentSteps([]);
    setShowAgents(false);
    inputRef.current?.focus();
  };

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
          className="px-3 py-1 text-xs font-mono text-bone-dim border border-iron/30 rounded-lg hover:border-iron/50 hover:text-bone-muted transition-colors"
        >
          + New Chat
        </button>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto mb-4 space-y-3 pr-1 min-h-0">
        {messages.length === 0 && (
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
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <ChatMessage key={i} message={msg} />
        ))}

        {error && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-3 bg-error/10 border border-error/30 rounded-xl"
          >
            <p className="text-error text-xs font-mono">{error}</p>
          </motion.div>
        )}

        {/* Pipeline stage breadcrumb (orchestrator mode) */}
        {pipelineStage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-2 px-3 py-2 bg-royal/5 border border-royal/15 rounded-lg text-[10px] font-mono text-royal-light"
          >
            <motion.span
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1.2, repeat: Infinity }}
            >
              ◈
            </motion.span>
            <span className="uppercase tracking-wider">{pipelineStage}</span>
            <span className="text-bone-faint">running…</span>
          </motion.div>
        )}

        {/* Reasoning/CoT disclosure (only shown when there's content) */}
        {reasoningText && (
          <div className="border border-iron/20 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setShowReasoning(r => !r)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[10px] font-mono text-bone-faint hover:text-bone-dim transition-colors bg-obsidian/30"
            >
              <span>{showReasoning ? '▾' : '▸'}</span>
              <span>Thinking</span>
              <span className="ml-auto opacity-50">{reasoningText.length} chars</span>
            </button>
            {showReasoning && (
              <div className="px-3 py-2 text-[11px] font-mono text-bone-faint whitespace-pre-wrap max-h-40 overflow-y-auto bg-obsidian/20">
                {reasoningText}
              </div>
            )}
          </div>
        )}

        {/* Agent pipeline activity — collapsed by default, shows per-stage intermediate output */}
        {agentSteps.length > 0 && (
          <div className="border border-royal/15 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAgents(a => !a)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[10px] font-mono text-bone-faint hover:text-bone-dim transition-colors bg-obsidian/30"
            >
              <span>{showAgents ? '▾' : '▸'}</span>
              <span className="text-royal-light">Agents</span>
              <span className="ml-auto opacity-50">{agentSteps.length} stage{agentSteps.length !== 1 ? 's' : ''}</span>
            </button>
            {showAgents && (
              <div className="px-3 py-2 space-y-3 max-h-64 overflow-y-auto bg-obsidian/20">
                {agentSteps.map((step, i) => (
                  <div key={i}>
                    <div className="text-[9px] font-mono text-royal-light uppercase tracking-widest mb-0.5">{step.stage}</div>
                    <div className="text-[11px] font-mono text-bone-faint whitespace-pre-wrap leading-relaxed">{step.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0">
        <div className="relative">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? 'Jarvis is thinking...' : 'Ask Jarvis anything... (Enter to send, Shift+Enter for newline)'}
            disabled={isStreaming}
            rows={Math.min(Math.max(input.split('\n').length, 1), 8)}
            className={cn(
              'w-full px-4 py-3 pr-14 text-sm font-mono bg-obsidian/60 border rounded-xl text-bone',
              'placeholder:text-bone-faint focus:outline-none transition-colors resize-none',
              isStreaming ? 'border-royal/30 opacity-60' : 'border-iron/40 focus:border-royal/50'
            )}
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
            className={cn(
              'absolute right-2 bottom-2 w-8 h-8 rounded-lg flex items-center justify-center transition-all',
              isStreaming || !input.trim()
                ? 'bg-iron/20 text-bone-faint cursor-not-allowed'
                : 'bg-royal/30 text-royal-light hover:bg-royal/50 cursor-pointer'
            )}
          >
            {isStreaming ? (
              <motion.div
                className="w-4 h-4 border-2 border-royal/30 border-t-royal-light rounded-full"
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
              />
            ) : (
              <span className="text-sm">↑</span>
            )}
          </button>
        </div>
        <div className="flex items-center justify-between mt-1.5 px-1">
          <span className="text-[10px] font-mono text-bone-faint">
            {isStreaming ? '● Streaming...' : `${messages.filter(m => m.role === 'user').length} messages sent`}
          </span>
          <span className="text-[10px] font-mono text-bone-faint">
            {config?.active_backend === 'openrouter' ? 'via OpenRouter' : 'via Ollama'}
          </span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Chat Message Bubble ──
// ═══════════════════════════════════════════════════════════════

function ChatMessage({ message }: { message: JarvisMessage }) {
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
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={cn(
        'rounded-xl px-4 py-3 text-sm border',
        isUser
          ? 'bg-royal/10 border-royal/20 ml-12'
          : isTool
            ? 'bg-obsidian/40 border-iron/20 mr-8'
            : 'bg-cyan-neon/5 border-cyan-neon/15 mr-8'
      )}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className={cn(
          'text-[10px] font-mono uppercase tracking-wider font-bold',
          isUser ? 'text-royal-light' : isTool ? 'text-bone-dim' : 'text-cyan-neon'
        )}>
          {isUser ? 'YOU' : isTool ? `TOOL: ${message.tool_name || 'unknown'}` : 'JARVIS'}
        </span>
        {message.isStreaming && (
          <motion.span
            className="text-[10px] font-mono text-cyan-neon"
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.2, repeat: Infinity }}
          >
            ● streaming
          </motion.span>
        )}
        {message.timestamp && !message.isStreaming && (
          <span className="text-[10px] font-mono text-bone-faint">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        )}
        {!message.isStreaming && (
          <button
            onClick={handleCopy}
            className="ml-auto text-[10px] font-mono text-bone-faint hover:text-bone-dim transition-colors px-1.5 py-0.5 rounded border border-iron/20 hover:border-iron/40"
            title="Copy message"
          >
            {copied ? '✓ copied' : 'copy'}
          </button>
        )}
      </div>
      <div className={cn(
        'leading-relaxed break-words',
        // User + tool output stay literal monospace; the assistant gets full markdown
        // (code blocks, lists, bold, links) at a readable prose size — restoring the
        // chat quality that regressed when this bubble rendered raw text.
        isUser || isTool ? 'text-xs font-mono whitespace-pre-wrap' : 'text-sm',
        isUser ? 'text-bone' : isTool ? 'text-bone-dim' : 'text-bone-muted'
      )}>
        {isUser || isTool ? message.content : <MarkdownRenderer content={message.content} />}
        {message.isStreaming && (
          <motion.span
            className="inline-block w-1.5 h-3.5 bg-cyan-neon/60 ml-0.5 align-middle"
            animate={{ opacity: [0, 1, 0] }}
            transition={{ duration: 0.8, repeat: Infinity }}
          />
        )}
      </div>
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
          <button onClick={onRefresh} className="px-3 py-1 text-xs font-mono text-bone-dim border border-iron/30 rounded-lg hover:border-iron/50 hover:text-bone-muted transition-colors">↻ Refresh</button>
          <button onClick={onNew} className="px-3 py-1 text-xs font-mono text-bone-dim border border-iron/30 rounded-lg hover:border-iron/50 hover:text-bone-muted transition-colors">+ New</button>
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
                    <span className="text-sm font-semibold text-bone truncate">{session.name}</span>
                    <Pill>{session.model}</Pill>
                  </div>
                  <div className="text-[11px] font-mono text-bone-faint">
                    {session.message_count} msgs · {new Date(session.created_at).toLocaleDateString()}
                  </div>
                </div>
                <button
                  onClick={(e) => handleDelete(session.id, e)}
                  className="text-bone-faint hover:text-error text-xs font-mono transition-colors shrink-0"
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
                localConfig.active_backend === 'ollama'
                  ? 'bg-cyan-neon/15 border-cyan-neon/40 text-cyan-glow'
                  : 'bg-obsidian/40 border-iron/30 text-bone-dim hover:border-iron/50'
              )}
            >
              <div className="text-lg mb-1">◎</div>
              <div className="font-semibold">Ollama</div>
              <div className="text-[10px] text-bone-faint mt-0.5">Local models</div>
            </button>
            <button
              onClick={() => updateField('active_backend', 'openrouter')}
              className={cn(
                'flex-1 px-4 py-3 rounded-xl border text-sm font-mono transition-all text-center',
                localConfig.active_backend === 'openrouter'
                  ? 'bg-royal/15 border-royal/40 text-royal-light'
                  : 'bg-obsidian/40 border-iron/30 text-bone-dim hover:border-iron/50'
              )}
            >
              <div className="text-lg mb-1">◈</div>
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
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-bone-dim hover:text-bone-muted transition-colors"
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
                placeholder="Enter custom model ID (e.g., anthropic/claude-sonnet-4)"
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
                className={cn(
                  'w-10 h-5 rounded-full transition-colors relative',
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

  // Build a per-backend service checklist so the user sees exactly what's
  // needed for *their* active backend, not a generic list that's always red.
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
          className="px-3 py-1 text-xs font-mono text-bone-dim border border-iron/30 rounded-lg hover:border-iron/50 hover:text-bone-muted transition-colors"
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
                    <Pill variant={item.ok ? 'default' : 'default'}>{item.ok ? 'ok' : 'off'}</Pill>
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
          className="px-3 py-1.5 text-xs font-mono text-cyan-glow border border-cyan-neon/30 rounded-lg hover:bg-cyan-neon/10 transition-colors"
        >
          Start Bridge
        </button>
        <button
          onClick={async () => {
            try { await invoke('jarvis_stop_bridge'); onRefresh(); }
            catch (e) { console.error('Failed to stop bridge:', e); }
          }}
          className="px-3 py-1.5 text-xs font-mono text-error border border-error/30 rounded-lg hover:bg-error/10 transition-colors"
        >
          Stop Bridge
        </button>
        {isOllama && (
          <button
            onClick={async () => {
              try { await invoke('jarvis_restart_ollama'); onRefresh(); }
              catch (e) { console.error('Failed to restart Ollama:', e); }
            }}
            className="px-3 py-1.5 text-xs font-mono text-amber-300 border border-amber-400/30 rounded-lg hover:bg-amber-400/10 transition-colors"
          >
            Restart Ollama
          </button>
        )}
      </div>
    </div>
  );
}
