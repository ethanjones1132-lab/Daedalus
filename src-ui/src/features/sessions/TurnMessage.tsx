import { useCopyOutcome } from '../../hooks/useCopyOutcome';
import { memo, useState } from 'react';
import { Check, ChevronRight, Copy, Wrench } from 'lucide-react';
import { Badge, Mark, Spinner, cn, toneOf } from '../../design';
import type { JarvisMessage } from '../../domain/types';
import { isToolCallEchoOnly, sanitizeAssistantDisplay } from '../../domain/chat-state';
import { errorDisplayForCode } from '../../domain/error-display';
import MarkdownView from './MarkdownView';
import { clockTime } from './outcome';

/*
 * One Session turn message, typeset as a document:
 *   · a user prompt is a surface block with a brass rule and a mono annotation
 *   · an answer is prose with the Jarvis mark in the gutter and a quiet footer
 *   · partial / timed out / failed / stopped answers carry a tinted rule, a
 *     Badge with words, and the actionable hint from error-display.ts
 */

/** Collapsed card for an answer whose whole body is leaked tool-call JSON. */
function ToolCallEchoCard({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-sunken">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 font-mono text-[11px] text-ink-3 hover:text-ink-2"
      >
        <Wrench aria-hidden="true" className="size-3" />
        <span>tool call echo</span>
        <ChevronRight aria-hidden="true" className={cn('ml-auto size-3 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono text-[11px] text-ink-3">{content}</pre>
      )}
    </div>
  );
}

/** Memoized so token flushes only re-render the body, not the turn chrome. */
const MessageBody = memo(function MessageBody({
  content,
  isStreaming,
  isCancelled,
  isToolEcho,
  streamStatus,
}: {
  content: string;
  isStreaming: boolean;
  isCancelled: boolean;
  isToolEcho: boolean;
  streamStatus?: string;
}) {
  if (isCancelled) return <div><MarkdownView content={content} /><p className="text-[13.5px] italic text-ink-3">(stopped)</p></div>;
  if (streamStatus) {
    return (
      <p className="flex items-center gap-2 font-mono text-[11.5px] text-ink-3">
        <Spinner size={12} />
        {streamStatus}
      </p>
    );
  }
  if (isToolEcho) return <ToolCallEchoCard content={content} />;
  return (
    <div className="relative">
      <MarkdownView content={content} />
      {isStreaming && <span aria-hidden="true" className="d-caret" />}
    </div>
  );
});

function CopyButton({ text, index }: { text: string; index: number }) {
  const { view, copy } = useCopyOutcome(text);
  const copied = view.copied;
  return (
    <span className="inline-flex items-center gap-2"><button
      type="button"
      disabled={view.phase === 'copying'}
      onClick={copy}
      aria-label={`Copy message ${index + 1}`}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-[5px] px-1.5 font-mono text-[10.5px] transition-colors',
        copied ? 'text-ok' : 'text-ink-4 hover:bg-hover hover:text-ink',
      )}
    >
      {copied ? <Check aria-hidden="true" className="size-3" /> : <Copy aria-hidden="true" className="size-3" />}
      <span aria-hidden="true">{copied ? 'Copied' : 'Copy'}</span>
    </button>{view.failed && <span role="alert" className="text-err">{view.message}</span>}</span>
  );
}

export function TurnMessage({ message, index, streamStatus }: { message: JarvisMessage; index: number; streamStatus?: string }) {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const displayContent = isUser || isTool ? message.content : sanitizeAssistantDisplay(message.content);
  const isToolEcho = !isUser && !isTool && isToolCallEchoOnly(displayContent);

  const isErrorBubble = !isUser && !isTool && (message.isError || message.terminalOutcome === 'failed');
  const isPartialBubble = !isUser && !isTool && message.terminalOutcome === 'partial';
  const isTimedOutBubble = !isUser && !isTool && message.terminalOutcome === 'timed_out';
  const isNonSuccessBubble = isPartialBubble || isTimedOutBubble;
  const isCancelledBubble = !isUser && !isTool && Boolean(message.isCancelled);
  if (!isUser && !isTool && !displayContent && !streamStatus && !isNonSuccessBubble && !isErrorBubble) return null;
  const errorDisplay = isErrorBubble ? errorDisplayForCode(message.errorCode) : null;
  const time = message.timestamp && !message.isStreaming ? clockTime(message.timestamp) : '';

  if (isUser) {
    return (
      <article className="d-rise">
        <div className="mb-1.5 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-3">
          <span className="text-accent">You</span>
          {time && (
            <>
              <span aria-hidden="true" className="text-ink-4">·</span>
              <span className="tabular">{time}</span>
            </>
          )}
        </div>
        <div className="whitespace-pre-wrap break-words rounded-r-lg rounded-l-[3px] border border-l-2 border-line border-l-accent bg-surface px-4 py-3 text-[14px] leading-relaxed text-ink">
          {displayContent}
        </div>
      </article>
    );
  }

  if (isTool) {
    return (
      <article className="d-rise pl-10">
        <div className="mb-1.5 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-3">
          <Wrench aria-hidden="true" className="size-3" />
          <span>Tool: {message.tool_name || 'unknown'}</span>
          {time && <span className="tabular text-ink-4">· {time}</span>}
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[11.5px] text-ink-2">
          {displayContent}
        </pre>
      </article>
    );
  }

  const ruleTone = isErrorBubble
    ? errorDisplay && toneOf(errorDisplay.pillVariant) === 'warn'
      ? 'border-warn'
      : 'border-err'
    : isNonSuccessBubble
      ? 'border-warn'
      : isCancelledBubble
        ? 'border-line-strong'
        : null;

  return (
    <article className="d-rise group/answer relative pl-10">
      <span aria-hidden="true" className="absolute left-0 top-[3px] flex size-6 items-center justify-center">
        <Mark size={18} live={message.isStreaming} draw={Boolean(message.isStreaming)} className={ruleTone ? 'text-ink-3' : undefined} />
      </span>
      <div className={cn(ruleTone && cn('border-l-2 pl-4', ruleTone))}>
        <MessageBody
          content={displayContent}
          isStreaming={Boolean(message.isStreaming)}
          isCancelled={isCancelledBubble}
          isToolEcho={isToolEcho}
          streamStatus={streamStatus}
        />
        {isErrorBubble && errorDisplay && (
          <p className="mt-2 text-[12px] italic leading-relaxed text-ink-3">
            {errorDisplay.hint ?? `code: ${message.errorCode ?? 'unknown'}`}
          </p>
        )}
      </div>
      {!message.isStreaming && (
        <footer className="mt-2 flex min-h-6 flex-wrap items-center gap-2 font-mono text-[10.5px] text-ink-4">
          {isErrorBubble && errorDisplay && (
            <Badge tone={toneOf(errorDisplay.pillVariant)} dot>
              {errorDisplay.label}
            </Badge>
          )}
          {isPartialBubble && (
            <span aria-label="Partial result" className="inline-flex items-center gap-1.5">
              <Badge tone="warn" dot>partial</Badge>
              {message.errorCode && <span className="text-warn">{message.errorCode}</span>}
            </span>
          )}
          {isTimedOutBubble && (
            <span aria-label="Timed out result" className="inline-flex items-center gap-1.5">
              <Badge tone="warn" dot>timed out</Badge>
              {message.errorCode && <span className="text-warn">{message.errorCode}</span>}
            </span>
          )}
          {isCancelledBubble && <Badge tone="muted">stopped</Badge>}
          {time && <span className="tabular">{time}</span>}
          <span className="opacity-0 transition-opacity group-hover/answer:opacity-100 focus-within:opacity-100">
            <CopyButton text={displayContent} index={index} />
          </span>
        </footer>
      )}
    </article>
  );
}
