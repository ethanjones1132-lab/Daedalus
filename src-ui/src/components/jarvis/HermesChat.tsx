import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useHermesChat, type HermesState } from '../../lib/hermes';
import { HERMES_TURN_STOPPED } from '../../lib/hermes-state';
import { cn, GlassCard, StatusDot } from '../ui';

const stateLabel = (s: HermesState): string => {
  switch (s) {
    case 'ready': return 'ready';
    case 'starting': return 'starting…';
    case 'draining': return 'draining…';
    case 'unavailable': return 'unavailable';
    case 'cold': return 'cold';
  }
};

const stateColor = (s: HermesState): 'success' | 'info' | 'error' | 'default' => {
  switch (s) {
    case 'ready': return 'success';
    case 'starting': return 'info';
    case 'unavailable': return 'error';
    case 'draining': return 'info';
    case 'cold': return 'default';
  }
};

export function HermesChat() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const {
    messages,
    submit,
    interrupt,
    retry,
    isStreaming,
    isStarting,
    isStopping,
    interruptError,
    state,
    reason,
    isReady,
  } = useHermesChat(sessionId ?? '');
  const [input, setInput] = useState('');
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bridgeReady = isReady && sessionId !== null;

  useEffect(() => {
    if (!isReady || sessionId) return;
    const id = `s-${Date.now().toString(36)}`;
    setSessionId(id);
  }, [isReady, sessionId]);

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
    inputRef.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  };

  const availabilityText = state === 'starting' || isStarting
    ? 'Starting Hermes Bridge…'
    : state === 'ready'
    ? 'Hermes Bridge ready.'
    : state === 'draining'
    ? 'Hermes Bridge is stopping.'
    : state === 'unavailable'
    ? reason ?? 'Hermes Bridge is unavailable.'
    : 'Checking Hermes Bridge…';

  return (
    <GlassCard className="flex flex-col h-full overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-3">
          <StatusDot variant={stateColor(state)} pulse={state === 'starting'} />
          <span className="text-sm font-medium text-bone">
            Hermes <span className="text-bone/40 ml-1">· {stateLabel(state)}</span>
          </span>
        </div>
        <div role="status" aria-label="Hermes Bridge status" className="text-xs text-bone/50">
          {availabilityText}
        </div>
      </header>

      {state === 'unavailable' && (
        <div role="alert" aria-label="Hermes Bridge availability" className="mx-4 mt-3 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-100">
          <p>{reason ?? 'Hermes Bridge is unavailable.'}</p>
          <button
            type="button"
            aria-label="Retry Hermes Bridge"
            onClick={() => void retry()}
            disabled={isStarting}
            className="mt-2 rounded-lg border border-red-200/20 px-3 py-1 text-xs text-red-100 disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      )}

      {interruptError && (
        <div role="alert" aria-label="Hermes turn interruption" className="mx-4 mt-3 rounded-xl border border-amber-300/20 bg-amber-500/10 p-3 text-sm text-amber-100">
          <p>{interruptError}</p>
        </div>
      )}

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
              {bridgeReady
                ? 'Ask Hermes anything. Use Shift+Enter for newlines.'
                : state === 'unavailable'
                ? 'Hermes Bridge is unavailable.'
                : state === 'starting' || isStarting
                ? 'Starting Hermes Bridge…'
                : state === 'draining'
                ? 'Hermes Bridge is stopping.'
                : 'Checking Hermes Bridge…'}
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
                {m.cancelled && (
                  <div className="mt-1 text-xs text-amber-200/80">{HERMES_TURN_STOPPED}</div>
                )}
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
          aria-label="Message Hermes"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          disabled={!bridgeReady || isStreaming || isStarting || isStopping}
          rows={1}
          placeholder={
            !bridgeReady
              ? state === 'unavailable'
                ? 'Hermes Bridge unavailable'
                : state === 'starting' || isStarting
                ? 'Starting Hermes Bridge…'
                : 'Checking Hermes Bridge…'
              : isStopping
              ? 'Stopping…'
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
            onClick={() => void interrupt()}
            disabled={isStopping}
            className="px-4 py-2 text-sm rounded-xl bg-red-500/20 text-red-200 hover:bg-red-500/30 transition-colors disabled:opacity-50"
          >
            {isStopping ? 'Stopping…' : interruptError ? 'Retry stop' : 'Stop'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void onSend()}
            disabled={!bridgeReady || isStarting || isStopping || input.trim().length === 0}
            className={cn(
              'px-4 py-2 text-sm rounded-xl transition-colors',
              bridgeReady && input.trim().length > 0
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
