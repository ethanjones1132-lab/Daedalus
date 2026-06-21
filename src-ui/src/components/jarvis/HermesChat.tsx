import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useHermesChat, hermesSpawn, type HermesState } from '../../lib/hermes';
import { cn, GlassCard, StatusDot } from '../ui';

const stateLabel = (s: HermesState): string => {
  switch (s) {
    case 'ready': return 'ready';
    case 'starting': return 'starting…';
    case 'draining': return 'draining…';
    case 'crashed': return 'crashed';
    case 'cold': return 'cold';
  }
};

const stateColor = (s: HermesState): 'success' | 'info' | 'error' | 'default' => {
  switch (s) {
    case 'ready': return 'success';
    case 'starting': return 'info';
    case 'crashed': return 'error';
    case 'draining': return 'info';
    case 'cold': return 'default';
  }
};

export function HermesChat() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const { messages, submit, interrupt, isStreaming, state, reason, isReady } =
    useHermesChat(sessionId ?? '');
  const [input, setInput] = useState('');
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-spawn the bridge on first mount.
  useEffect(() => {
    if (state === 'cold') {
      hermesSpawn().catch((e) => console.error('[hermes] spawn failed:', e));
    }
  }, [state]);

  // Lazy-create a session once the bridge is ready.
  useEffect(() => {
    if (!isReady || sessionId) return;
    // The recovered tree doesn't expose a `hermes_create_session` Tauri
    // command; the session id is generated client-side and the bridge
    // attaches to it on first prompt.submit. This matches the runner.
    const id = `s-${Date.now().toString(36)}`;
    setSessionId(id);
  }, [isReady, sessionId]);

  // Auto-scroll to the latest message.
  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages.length]);

  const onSend = async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await submit(text);
    // Refocus the input for the next turn.
    inputRef.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <GlassCard className="flex flex-col h-full overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-3">
          <StatusDot variant={stateColor(state)} pulse={state === 'starting'} />
          <span className="text-sm font-medium text-bone">
            Hermes <span className="text-bone/40 ml-1">· {stateLabel(state)}</span>
          </span>
        </div>
        {state === 'crashed' && reason && (
          <span className="text-xs text-red-400/80 max-w-xs truncate" title={reason}>
            {reason}
          </span>
        )}
      </header>

      <div
        ref={transcriptRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0"
      >
        <AnimatePresence initial={false}>
          {messages.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center text-bone/40 text-sm py-12"
            >
              {state === 'ready'
                ? 'Ask Hermes anything. Use Shift+Enter for newlines.'
                : state === 'crashed'
                ? `Bridge crashed: ${reason ?? 'unknown'} — restart to recover.`
                : 'Starting the bridge…'}
            </motion.div>
          ) : (
            messages.map((m) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className={cn(
                  'max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words',
                  m.role === 'user'
                    ? 'ml-auto bg-accent/20 text-bone'
                    : m.role === 'system'
                    ? 'mx-auto bg-red-500/10 text-red-200/80 text-xs'
                    : 'mr-auto bg-white/5 text-bone',
                  m.streaming && 'animate-pulse',
                )}
              >
                {m.content || (m.streaming ? '▍' : '')}
                {m.error && (
                  <div className="mt-1 text-xs text-red-300/80">{m.error}</div>
                )}
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>

      <footer className="border-t border-white/5 p-3 flex gap-2 items-end">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          disabled={!isReady || isStreaming}
          rows={1}
          placeholder={
            !isReady
              ? state === 'crashed'
                ? 'Bridge is down'
                : 'Waiting for bridge…'
              : isStreaming
              ? 'Streaming…'
              : 'Type a message…'
          }
          className={cn(
            'flex-1 resize-none bg-white/5 border border-white/10 rounded-xl px-3 py-2',
            'text-sm text-bone placeholder:text-bone/30',
            'focus:outline-none focus:border-accent/50',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={interrupt}
            className="px-4 py-2 text-sm rounded-xl bg-red-500/20 text-red-200 hover:bg-red-500/30 transition-colors"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={!isReady || input.trim().length === 0}
            className={cn(
              'px-4 py-2 text-sm rounded-xl transition-colors',
              isReady && input.trim().length > 0
                ? 'bg-accent text-bone hover:bg-accent/80'
                : 'bg-white/5 text-bone/30 cursor-not-allowed',
            )}
          >
            Send
          </button>
        )}
      </footer>
    </GlassCard>
  );
}

export default HermesChat;
