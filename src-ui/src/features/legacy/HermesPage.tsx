import { useEffect, useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';
import {
  AlertLine,
  Badge,
  Button,
  Mark,
  PageHeader,
  Panel,
  StatusDot,
  StatusLine,
  Textarea,
  cn,
  type Tone,
} from '../../design';
import { useHermesChat, type HermesState } from '../../lib/hermes';
import { HERMES_SUBMIT_FAILED_REASON, HERMES_TURN_STOPPED } from '../../lib/hermes-state';

/*
 * Hermes Bridge (legacy) — a single-pane chat against the Hermes bridge
 * subprocess. CONTEXT.md: the Hermes bridge is NOT the chat path; Sessions go
 * UI -> Tauri -> Bun server -> Inference backend. This surface stays reachable
 * for the bridge that is still registered in the Tauri shell.
 *
 * Unavailable reasons arrive already redacted from lib/hermes-state; this page
 * never renders a raw native error.
 */

const stateLabel = (s: HermesState): string => {
  switch (s) {
    case 'ready': return 'ready';
    case 'starting': return 'starting…';
    case 'draining': return 'draining…';
    case 'unavailable': return 'unavailable';
    case 'cold': return 'cold';
  }
};

const stateTone = (s: HermesState): Tone => {
  switch (s) {
    case 'ready': return 'ok';
    case 'starting': return 'info';
    case 'unavailable': return 'error';
    case 'draining': return 'info';
    case 'cold': return 'muted';
  }
};

export default function HermesPage() {
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
  const [submitError, setSubmitError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputVersionRef = useRef(0);
  const sendPendingRef = useRef(false);
  const mountedRef = useRef(true);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const bridgeReady = isReady && sessionId !== null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
    const activeSession = sessionIdRef.current;
    const text = input.trim();
    if (!text || !activeSession || sendPendingRef.current) return;
    const inputVersion = ++inputVersionRef.current;
    sendPendingRef.current = true;
    setInput('');
    try {
      const accepted = await submit(text);
      if (accepted) {
        setSubmitError(null);
        inputRef.current?.focus();
        return;
      }
      if (
        !mountedRef.current
        || sessionIdRef.current !== activeSession
        || inputVersionRef.current !== inputVersion
      ) {
        return;
      }
      setInput(text);
      setSubmitError(HERMES_SUBMIT_FAILED_REASON);
      inputRef.current?.focus();
    } finally {
      sendPendingRef.current = false;
    }
  };

  const onInputChange = (value: string) => {
    inputVersionRef.current += 1;
    setInput(value);
    setSubmitError(null);
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
    <div className="mx-auto flex h-full w-full max-w-[920px] flex-col px-8 pb-8 pt-8">
      <PageHeader
        className="mb-5 shrink-0"
        eyebrow={
          <span className="inline-flex items-center gap-2">
            System
            <Badge tone="muted" size="xs">
              legacy
            </Badge>
          </span>
        }
        title="Hermes Bridge"
        description="Legacy single-pane chat with the Hermes bridge subprocess. It is not the Session chat path — Session turns run through the Bun server."
      />

      <Panel flush className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-2.5">
            <StatusDot tone={stateTone(state)} live={state === 'starting'} />
            <span className="text-[13px] font-medium text-ink">
              Hermes <span className="ml-1 text-ink-3">· {stateLabel(state)}</span>
            </span>
          </div>
          <StatusLine label="Hermes Bridge status" busy={state === 'starting' || isStarting}>
            {availabilityText}
          </StatusLine>
        </header>

        {(state === 'unavailable' || interruptError || submitError) && (
          <div className="shrink-0 space-y-2 px-4 pt-3">
            {state === 'unavailable' && (
              <AlertLine
                label="Hermes Bridge availability"
                onRetry={() => void retry()}
                retryLabel="Retry Hermes Bridge"
                retryDisabled={isStarting}
              >
                <p>{reason ?? 'Hermes Bridge is unavailable.'}</p>
              </AlertLine>
            )}
            {interruptError && (
              <AlertLine tone="warn" label="Hermes turn interruption">
                <p>{interruptError}</p>
              </AlertLine>
            )}
            {submitError && (
              <AlertLine
                label="Hermes prompt submission"
                onRetry={() => void onSend()}
                retryLabel="Retry Hermes prompt"
                retryDisabled={isStreaming || isStarting || isStopping || !bridgeReady}
              >
                <p>{submitError}</p>
              </AlertLine>
            )}
          </div>
        )}

        <div ref={transcriptRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 py-12 text-center">
              <Mark size={36} draw={false} className="text-ink-4" />
              <p className="max-w-xs text-[13px] leading-relaxed text-ink-3">
                {bridgeReady
                  ? 'Ask Hermes anything. Use Shift+Enter for newlines.'
                  : state === 'unavailable'
                    ? 'Hermes Bridge is unavailable.'
                    : state === 'starting' || isStarting
                      ? 'Starting Hermes Bridge…'
                      : state === 'draining'
                        ? 'Hermes Bridge is stopping.'
                        : 'Checking Hermes Bridge…'}
              </p>
            </div>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={cn(
                  'd-rise whitespace-pre-wrap break-words text-[13.5px] leading-relaxed',
                  m.role === 'user' && 'border-l-2 border-accent pl-3.5 text-ink',
                  m.role === 'assistant' && 'pl-3.5 text-ink-2',
                  m.role === 'system' && 'rounded-md border border-err/25 bg-err-wash px-3 py-2 text-center text-[12px] text-err',
                )}
              >
                {m.content || (m.streaming ? <span aria-hidden="true" className="d-caret" /> : '')}
                {m.streaming && m.content && <span aria-hidden="true" className="d-caret" />}
                {m.cancelled && <div className="mt-1.5 text-[12px] text-warn">{HERMES_TURN_STOPPED}</div>}
                {m.error && <div className="mt-1.5 text-[12px] text-err">{m.error}</div>}
              </div>
            ))
          )}
        </div>

        <footer className="flex shrink-0 items-end gap-2 border-t border-line p-3">
          <Textarea
            ref={inputRef}
            aria-label="Message Hermes"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKey}
            disabled={!bridgeReady || isStreaming || isStarting || isStopping}
            rows={1}
            className="min-h-[38px] flex-1 resize-none"
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
          />
          {isStreaming ? (
            <Button variant="danger" size="md" icon={<Square />} onClick={() => void interrupt()} disabled={isStopping}>
              {isStopping ? 'Stopping…' : interruptError ? 'Retry stop' : 'Stop'}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="md"
              icon={<Send />}
              onClick={() => void onSend()}
              disabled={!bridgeReady || isStarting || isStopping || input.trim().length === 0}
            >
              Send
            </Button>
          )}
        </footer>
      </Panel>
    </div>
  );
}
