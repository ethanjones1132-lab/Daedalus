import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, CornerDownLeft, GitBranch, Sparkles, TriangleAlert, Wrench } from 'lucide-react';
import { Badge, Spinner, StatusDot, cn } from '../../design';
import {
  formatActivityFeedSummary,
  formatInferenceRoute,
  formatRunDuration,
  type ActivityItem,
} from '../../domain/chat-state';
import type { ActivityToolCall } from '../../domain/activity-ledger';
import type { RunMetrics } from './useSessionTurn';

function prettyArgs(value: unknown): string {
  try {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/* A node on the activity timeline: the marker sits on the rail at left. */
function Node({ marker, children, className }: { marker: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('relative pl-6', className)}>
      <span aria-hidden="true" className="absolute left-0 top-[7px] flex size-[15px] items-center justify-center rounded-full border border-line-strong bg-surface text-ink-3 [&_svg]:size-[9px]">
        {marker}
      </span>
      {children}
    </div>
  );
}

export function ToolCallCard({ call }: { call: ActivityToolCall }) {
  const [open, setOpen] = useState(false);
  const argText = prettyArgs(call.arguments);
  const failed = call.is_error || call.terminalState === 'incomplete' || call.terminalState === 'failed';
  const running = call.result === undefined && !call.terminalState;

  return (
    <div
      aria-label={`Tool: ${call.name}`}
      data-activity-item="true"
      data-activity-kind="tool"
      className={cn(
        'overflow-hidden rounded-lg border bg-surface transition-colors',
        failed ? 'border-err/35' : running ? 'border-accent-line' : 'border-line',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-hover"
      >
        <Wrench aria-hidden="true" className={cn('size-3 shrink-0', running ? 'text-accent' : 'text-ink-3')} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">{call.name}</span>
        {running && (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-accent">
            <Spinner size={10} /> running
          </span>
        )}
        {call.terminalState === 'cancelled' && <Badge tone="muted" size="xs">cancelled</Badge>}
        {call.terminalState === 'incomplete' && <Badge tone="warn" size="xs">incomplete</Badge>}
        {call.is_error && <Badge tone="error" size="xs">error</Badge>}
        {call.result !== undefined && !call.is_error && !call.terminalState && <Badge tone="ok" size="xs">done</Badge>}
        {call.contextTruncation && <Badge tone="warn" size="xs">context trimmed</Badge>}
        <ChevronRight aria-hidden="true" className={cn('size-3 shrink-0 text-ink-4 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-2.5 pb-2.5 pt-2">
          {argText && (
            <div>
              <div className="d-label mb-1 text-[9px]">Args</div>
              <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-sunken p-2 font-mono text-[10.5px] text-ink-2">{argText}</pre>
            </div>
          )}
          {call.result !== undefined && (
            <div>
              <div className="d-label mb-1 text-[9px]">{call.is_error ? 'Error' : 'Result'}</div>
              {call.contextTruncation && (
                <div className="mb-1 text-[10.5px] text-warn">
                  Full result shown here; inference context retained {call.contextTruncation.retained_chars.toLocaleString()} of{' '}
                  {call.contextTruncation.original_chars.toLocaleString()} characters.
                </div>
              )}
              <pre
                className={cn(
                  'max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-sunken p-2 font-mono text-[10.5px]',
                  call.is_error ? 'text-err' : 'text-ink-2',
                )}
              >
                {call.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ item, isStreaming }: { item: ActivityItem; isStreaming: boolean }) {
  if (item.kind === 'tool') {
    return (
      <Node marker={<Wrench />}>
        <ToolCallCard call={item.call} />
      </Node>
    );
  }
  if (item.kind === 'tool_result') {
    return (
      <Node marker={<CornerDownLeft />}>
        <div
          data-activity-item="true"
          data-activity-kind="tool_result"
          aria-label={`Tool result: ${item.name}`}
          className="rounded-lg border border-line bg-surface px-2.5 py-1.5"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">{item.name} result</span>
            {item.isError ? <Badge tone="error" size="xs">error</Badge> : <Badge tone="ok" size="xs">done</Badge>}
          </div>
          <div className="mt-1 line-clamp-6 whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-ink-3">
            {item.output || 'No output reported.'}
          </div>
        </div>
      </Node>
    );
  }
  if (item.kind === 'directive') {
    return (
      <Node marker={<GitBranch />}>
        <div
          data-activity-item="true"
          data-activity-kind="directive"
          aria-label={`Conductor directive: ${item.directive.label}`}
          className="rounded-lg border border-warn/25 bg-warn-wash px-2.5 py-1.5"
        >
          <div className="flex items-center gap-2 text-[11.5px]">
            <span className="d-label text-[9px] text-warn">Conductor</span>
            <span className="font-medium text-ink">{item.directive.label}</span>
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-ink-2">{item.directive.detail}</div>
        </div>
      </Node>
    );
  }
  if (item.kind === 'diagnostic') {
    return (
      <Node marker={<TriangleAlert />}>
        <div
          data-activity-item="true"
          data-activity-kind="diagnostic"
          aria-label="Activity diagnostic"
          className="rounded-lg border border-warn/25 bg-warn-wash px-2.5 py-1.5 text-[11px] text-warn"
        >
          {item.text}
        </div>
      </Node>
    );
  }
  if (item.kind === 'stage') {
    return (
      <Node marker={<Sparkles className={isStreaming ? 'text-accent' : undefined} />}>
        <div
          data-activity-item="true"
          data-activity-kind="stage"
          aria-label={`Orchestrator stage: ${item.stage}`}
          className="flex items-center gap-2 py-1"
        >
          <span className="d-label text-[10px] text-ink-2">{item.stage}</span>
          {isStreaming && (
            <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] text-accent">
              <StatusDot tone="accent" live /> running
            </span>
          )}
        </div>
      </Node>
    );
  }
  return (
    <Node marker={<Sparkles />}>
      <div data-activity-item="true" data-activity-kind="plan" className="py-0.5">
        <div className="d-label text-[9.5px] text-accent">{item.stage}</div>
        <div className="mt-0.5 whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-2">{item.text}</div>
      </div>
    </Node>
  );
}

/**
 * The Turn activity feed. Open by default while a turn streams and collapsed
 * when it ends; the operator can toggle it mid-turn and the next streaming
 * flip re-syncs it (legacy contract). Rows stay mounted while collapsed (the
 * region is `hidden`), so expanded tool cards keep their state.
 */
export function ActivityFeed({
  items,
  isStreaming,
  turnElapsedMs,
  recursionDepth,
}: {
  items: ActivityItem[];
  isStreaming: boolean;
  turnElapsedMs: number;
  recursionDepth: number | null;
}) {
  const [open, setOpen] = useState(isStreaming);
  useEffect(() => {
    setOpen(isStreaming);
  }, [isStreaming]);

  const summary = formatActivityFeedSummary(items);

  return (
    <section aria-label="Turn activity" className="rounded-[10px] border border-line bg-canvas/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left hover:bg-hover"
      >
        <ChevronRight aria-hidden="true" className={cn('size-3.5 shrink-0 text-ink-4 transition-transform', open && 'rotate-90')} />
        <span className="text-[12.5px] font-semibold text-ink">Activity</span>
        {isStreaming && <StatusDot tone="accent" live />}
        <span className="ml-auto flex min-w-0 items-center gap-2 font-mono text-[10.5px] text-ink-3">
          <span className="truncate">{summary}</span>
          {isStreaming && recursionDepth === null && <span className="tabular text-accent">{formatRunDuration(turnElapsedMs)}</span>}
          {recursionDepth !== null && <span className="text-accent">↩ depth {recursionDepth}</span>}
        </span>
      </button>
      <div hidden={!open} className="relative px-3 pb-3 pt-1">
        <span aria-hidden="true" className="absolute bottom-4 left-[19.5px] top-2 w-px bg-line" />
        <div className="relative space-y-2">
          {items.map((item) => (
            <ActivityRow key={item.id} item={item} isStreaming={isStreaming} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** The run-metrics readout of a finished (or finishing) turn. */
export function RunMetricsBar({ metrics }: { metrics: RunMetrics }) {
  const violation = metrics.scopeCompliant === false;
  return (
    <div
      aria-label="Orchestration run metrics"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border px-3 py-2 font-mono text-[10.5px] tabular',
        violation ? 'border-err/30 bg-err-wash text-err' : 'border-line bg-surface text-ink-2',
      )}
    >
      <span className="d-label text-[9.5px] text-accent">run</span>
      <span>{formatRunDuration(metrics.durationMs)}</span>
      <span>{metrics.tokens.toLocaleString()} tok</span>
      <span>
        {metrics.tools} tool{metrics.tools === 1 ? '' : 's'}
      </span>
      {(metrics.provider || metrics.model) && <span className="text-ink">{formatInferenceRoute(metrics.provider, metrics.model)}</span>}
      {metrics.firstVisibleTokenMs !== undefined && <span>TTFT {formatRunDuration(metrics.firstVisibleTokenMs)}</span>}
      {metrics.fallbackRetries > 0 && (
        <span className="text-warn">
          {metrics.fallbackRetries} fallback {metrics.fallbackRetries === 1 ? 'retry' : 'retries'}
          {metrics.fallbackReason ? ` · ${metrics.fallbackReason.replace(/_/g, ' ')}` : ''}
        </span>
      )}
      {metrics.scopeCompliant !== undefined && (
        <span className={metrics.scopeCompliant ? 'text-ok' : undefined}>{metrics.scopeCompliant ? 'scope verified' : 'scope violation'}</span>
      )}
    </div>
  );
}
