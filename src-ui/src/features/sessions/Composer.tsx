import { ArrowUp, CheckCircle2, CircleAlert, Square } from 'lucide-react';
import { Kbd, Spinner, StatusDot, cn } from '../../design';
import { formatRunDuration } from '../../domain/chat-state';
import type { SessionTurn } from './useSessionTurn';

/**
 * The live wire: a brass filament across the composer's top edge while a
 * turn streams, carrying the turn-progress sentence; after the turn it holds
 * the durable run-record receipt (confirmed only by Native's read-back).
 * Both are role=status live regions OUTSIDE the transcript log.
 */
function LiveWire({ turn }: { turn: SessionTurn }) {
  const { turnProgress, runRecordSummary, runRecordInFlight, retryRunRecord, isStreaming } = turn;
  if (!turnProgress && !runRecordSummary) return null;
  return (
    <div className="relative mb-2.5 flex min-h-[22px] items-center">
      <span
        aria-hidden="true"
        className={cn('absolute inset-x-0 top-1/2', isStreaming ? 'd-wire' : 'h-px bg-line')}
      />
      <div className="relative mx-auto flex max-w-full items-center gap-3 bg-canvas px-3">
        {turnProgress && (
          <div
            role="status"
            aria-label="Session turn progress"
            aria-atomic="true"
            className="flex min-w-0 items-center gap-2 font-mono text-[11.5px] text-ink-2"
          >
            <StatusDot tone="accent" live />
            <span className="truncate">{turnProgress.text}</span>
          </div>
        )}
        {!turnProgress && runRecordSummary && (
          <div
            role="status"
            aria-label="Recorded run confirmation"
            aria-atomic="true"
            className={cn(
              'flex min-w-0 items-center gap-2 font-mono text-[11.5px]',
              runRecordSummary.confirmed ? 'text-ok' : 'text-warn',
            )}
          >
            {runRecordInFlight ? (
              <Spinner size={12} />
            ) : runRecordSummary.confirmed ? (
              <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0" />
            ) : (
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0">{runRecordSummary.text}</span>
            {runRecordSummary.retryable && (
              <button
                type="button"
                onClick={retryRunRecord}
                disabled={runRecordInFlight}
                className="shrink-0 rounded-[4px] border border-warn/30 px-1.5 py-px text-[11px] text-warn hover:bg-warn-wash disabled:opacity-40"
              >
                {runRecordSummary.phase === 'unreadable' ? 'Read the run outcome again' : 'Record the run outcome again'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function Composer({ turn }: { turn: SessionTurn }) {
  const {
    inputRef,
    input,
    setInput,
    handleKeyDown,
    handleSend,
    handleStop,
    isStreaming,
    turnElapsedMs,
    turnCost,
    sentCount,
    displayedRoute,
  } = turn;
  const canSend = Boolean(input.trim());

  return (
    // ⌘K inside the composer means "new Session"; the shell's palette
    // listener ignores keydowns from inside [data-owns-mod-k].
    <div data-owns-mod-k="" className="shrink-0 px-8 pb-4 pt-1">
      <div className="mx-auto w-full max-w-[760px]">
        <LiveWire turn={turn} />
        {turn.stopView.status && <div role="status" aria-label="Stop request" className="mb-2 text-xs text-ink-3">{turn.stopView.status}</div>}
        {turn.stopView.alert && <div role="alert" aria-label="Stop request" className="mb-2 text-xs text-err">{turn.stopView.alert} <button type="button" onClick={() => void turn.handleStop()}>Retry stop</button></div>}
        <div
          className={cn(
            'rounded-xl border bg-surface shadow-card transition-[border-color,box-shadow] duration-200',
            isStreaming
              ? 'border-accent-line'
              : 'border-line-strong focus-within:border-accent-line focus-within:shadow-[0_0_0_3px_var(--d-accent-wash),0_10px_30px_-18px_var(--d-accent)]',
          )}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            aria-label="Chat input"
            placeholder={
              isStreaming
                ? 'Jarvis is thinking… (Esc to stop)'
                : 'Ask Jarvis anything…'
            }
            className="block max-h-80 min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-relaxed text-ink placeholder:text-ink-4 focus:outline-none focus-visible:outline-none"
          />
          <div className="flex items-center gap-3 px-3 pb-2.5 pl-4">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-ink-4">
              {isStreaming ? (
                <>
                  <Kbd>Esc</Kbd>
                  <span>to stop</span>
                </>
              ) : (
                <>
                  <Kbd>↵</Kbd>
                  <span>send</span>
                  <span aria-hidden="true" className="px-0.5 max-[1439px]:hidden">·</span>
                  <Kbd className="max-[1439px]:hidden">⇧↵</Kbd>
                  <span className="max-[1439px]:hidden">newline</span>
                  <span aria-hidden="true" className="px-0.5">·</span>
                  <Kbd>⌘K</Kbd>
                  <span>new Session</span>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={isStreaming ? handleStop : handleSend}
              disabled={isStreaming ? turn.stopView.stopDisabled : !canSend}
              aria-label={isStreaming ? 'Stop streaming' : 'Send message'}
              className={cn(
                'relative flex size-8 shrink-0 items-center justify-center rounded-lg border transition-all duration-150',
                isStreaming
                  ? 'border-accent-line bg-accent-wash text-accent-hot hover:bg-accent hover:text-accent-ink'
                  : canSend
                    ? 'border-transparent bg-accent text-accent-ink shadow-[0_6px_16px_-8px_var(--d-accent)] hover:bg-accent-hot'
                    : 'cursor-not-allowed border-line bg-raised text-ink-4',
              )}
            >
              {isStreaming ? (
                <Square aria-hidden="true" className="size-3" fill="currentColor" />
              ) : (
                <ArrowUp aria-hidden="true" className="size-4" strokeWidth={2.2} />
              )}
            </button>
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-4 px-1 font-mono text-[10.5px] text-ink-4">
          <span className={cn('tabular', isStreaming && 'text-accent')}>
            {isStreaming
              ? `● Streaming · ${formatRunDuration(turnElapsedMs)}`
              : `${sentCount} message${sentCount !== 1 ? 's' : ''} sent`}
          </span>
          <span className="flex min-w-0 items-center gap-2 tabular">
            {turnCost && (
              <>
                <span>{turnCost.tokens.toLocaleString()} tok</span>
                {turnCost.costUsd > 0 && <span>${turnCost.costUsd.toFixed(4)}</span>}
                <span aria-hidden="true">·</span>
              </>
            )}
            <span className="truncate">via {displayedRoute}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
