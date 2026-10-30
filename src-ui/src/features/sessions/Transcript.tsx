import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TRANSCRIPT_WINDOW, anchoredScrollTop, extendWindow, transcriptWindow, windowSlice, windowStart } from '../../lib/transcript-window';
import { TranscriptWindowNotice } from './TranscriptWindowNotice';
import { ArrowDown, Bug, Code2, Lightbulb, type LucideIcon } from 'lucide-react';
import { AlertLine, Mark } from '../../design';
import type { JarvisConfig } from '../../domain/types';
import { TurnMessage } from './TurnMessage';
import { CURATED_SUGGESTIONS, type SessionTurn } from './useSessionTurn';

const EXAMPLE_PROMPTS: Array<{ prompt: string; detail: string; Icon: LucideIcon }> = [
  { prompt: 'Refactor a function', detail: 'Tighten a function without changing its behaviour.', Icon: Code2 },
  { prompt: 'Debug a stack trace', detail: 'Paste a trace; Jarvis traces it to the cause.', Icon: Bug },
  { prompt: 'Explain a piece of code', detail: 'Walk through what it does and why.', Icon: Lightbulb },
];

function backendLine(config: JarvisConfig | null): string | null {
  switch (config?.active_backend) {
    case 'openrouter':
      return `Configured backend · OpenRouter · ${config.openrouter?.model ?? ''}`;
    case 'ollama':
      return `Configured backend · Ollama · ${config.ollama?.model ?? ''}`;
    case 'llama_cpp':
      return `Configured backend · llama.cpp · ${config.llama_cpp?.model ?? ''}`;
    case 'claude_cli':
      return `Configured backend · Claude CLI · ${config.claude_cli?.model ?? 'default'}`;
    default:
      return null;
  }
}

/** Empty Session: shown only after a successful observation of no messages. */
function EmptySession({ config, onPick }: { config: JarvisConfig | null; onPick: (prompt: string) => void }) {
  const line = backendLine(config);
  return (
    <div className="flex min-h-full flex-col items-center justify-center py-10 text-center">
      <Mark size={44} className="mb-6 opacity-90" />
      <h2 className="d-display text-[44px] leading-[1.02] text-ink">
        What are we <em className="text-accent-hot">building</em> today?
      </h2>
      <p className="mt-3 max-w-md text-[13.5px] leading-relaxed text-ink-3">
        Your AI coding assistant for building, debugging, and exploring code.
      </p>
      {line && <p className="mt-2 font-mono text-[11px] text-ink-4">{line}</p>}
      <div className="mt-9 grid w-full max-w-[640px] grid-cols-3 gap-3 text-left">
        {EXAMPLE_PROMPTS.map(({ prompt, detail, Icon }) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onPick(prompt)}
            className="group flex flex-col gap-2 rounded-[10px] border border-line bg-surface p-3.5 transition-[border-color,background-color,transform] duration-200 hover:-translate-y-px hover:border-accent-line hover:bg-raised"
          >
            <Icon aria-hidden="true" className="size-4 text-ink-3 transition-colors group-hover:text-accent" />
            <span className="text-[13px] font-medium text-ink">{prompt}</span>
            <span className="text-[11.5px] leading-snug text-ink-3">{detail}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** First-token skeleton: the answer's place, before any visible text lands. */
function AnswerSkeleton() {
  return (
    <div aria-hidden="true" className="relative pl-10">
      <span className="absolute left-0 top-[3px] flex size-6 items-center justify-center">
        <Mark size={18} live draw={false} />
      </span>
      <div className="space-y-2.5 pt-1.5">
        <div className="d-skeleton h-3 w-[78%]" />
        <div className="d-skeleton h-3 w-[92%]" />
        <div className="d-skeleton h-3 w-[54%]" />
      </div>
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div role="status" aria-label="Session history loading" className="space-y-9">
      <span className="sr-only">Loading session history…</span>
      {[0, 1, 2].map((i) =>
        i % 2 === 0 ? (
          <div key={i} aria-hidden="true">
            <div className="d-skeleton mb-2 h-2.5 w-14" />
            <div className="rounded-r-lg border border-l-2 border-line border-l-accent-line bg-surface px-4 py-3.5">
              <div className="d-skeleton h-3 w-2/3" />
            </div>
          </div>
        ) : (
          <div key={i} aria-hidden="true" className="space-y-2.5 pl-10">
            <div className="d-skeleton h-3 w-[86%]" />
            <div className="d-skeleton h-3 w-[72%]" />
            <div className="d-skeleton h-3 w-[40%]" />
          </div>
        ),
      )}
    </div>
  );
}

export function Transcript({ turn, config }: { turn: SessionTurn; config: JarvisConfig | null }) {
  const [visible, setVisible] = useState(TRANSCRIPT_WINDOW);
  const anchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  useEffect(() => setVisible(TRANSCRIPT_WINDOW), [turn.selectedSessionId]);
  const extend = () => {
    const node = turn.scrollContainerRef.current;
    anchor.current = node ? { scrollHeight: node.scrollHeight, scrollTop: node.scrollTop } : null;
    setVisible(current => extendWindow(current, turn.messages.length));
  };
  useLayoutEffect(() => {
    const node = turn.scrollContainerRef.current;
    if (node && anchor.current) { node.scrollTop = anchoredScrollTop(anchor.current, node.scrollHeight); anchor.current = null; }
  }, [visible, turn.scrollContainerRef]);

  const {
    messages,
    loadingHistory,
    historyError,
    retryHistory,
    showSkeleton,
    streamStatusText,
    lastAssistantFinished,
    error,
    scrollContainerRef,
    messagesEndRef,
    handleScroll,
    userPinnedToBottom,
    jumpToLatest,
    onSuggestionClick,
  } = turn;
  const empty = messages.length === 0 && !loadingHistory && !historyError;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Jarvis chat transcript"
        className="flex-1 min-h-0 overflow-y-auto scroll-smooth"
      >
        <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col px-8 pb-10 pt-8">
          {loadingHistory && <HistorySkeleton />}

          {historyError && (
            <AlertLine label="Session history error" onRetry={retryHistory} retryText="Retry">
              Could not load session history.
            </AlertLine>
          )}

          {empty && <EmptySession config={config} onPick={onSuggestionClick} />}

          {messages.length > 0 && (
            <div className="space-y-9"><TranscriptWindowNotice window={transcriptWindow(messages.length, visible)} onExtend={extend} />
              {windowSlice(messages, visible).map((msg, i) => (
                <TurnMessage
                  key={msg.id ?? i}
                  message={msg}
                  index={i + windowStart(messages.length, visible)}
                  streamStatus={msg.isStreaming && !msg.content.trim() && !showSkeleton ? streamStatusText : undefined}
                />
              ))}
            </div>
          )}

          {showSkeleton && (
            <div className="mt-9">
              <AnswerSkeleton />
            </div>
          )}

          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="d-rise mt-8 flex items-start gap-2.5 rounded-lg border border-err/25 bg-err-wash px-3.5 py-2.5"
            >
              <span aria-hidden="true" className="mt-[5px] size-1.5 shrink-0 rounded-full bg-err" />
              <p className="min-w-0 break-words font-mono text-[12px] leading-relaxed text-ink">{error}</p>
            </div>
          )}

          {lastAssistantFinished && (
            <div className="mt-5 flex flex-wrap gap-1.5 pl-10">
              {CURATED_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onSuggestionClick(s)}
                  className="h-7 rounded-full border border-line bg-transparent px-3 text-[12px] text-ink-3 transition-colors hover:border-accent-line hover:bg-accent-wash hover:text-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {!userPinnedToBottom && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label="Jump to latest message"
          className="d-rise absolute bottom-3 left-1/2 z-10 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-accent-line bg-overlay px-3 font-mono text-[11px] text-accent-hot shadow-pop hover:bg-raised"
        >
          <ArrowDown aria-hidden="true" className="size-3" />
          Latest
        </button>
      )}
    </div>
  );
}
