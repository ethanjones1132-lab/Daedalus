import { useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { EmptyState, KeyValue, Tabs, cn } from '../../design';
import { formatRunDuration } from '../../domain/chat-state';
import { formatSessionStatsLine, shouldShowSessionStats } from '../../domain/session-stats';
import { ActivityFeed, RunMetricsBar } from './ActivityFeed';
import SessionRunsView from './SessionRunsView';
import type { SessionTurn } from './useSessionTurn';

type InspectorTab = 'activity' | 'run' | 'runs';

/** The reasoning trace ("Thinking"): collapsed until `reasoning_complete`. */
function Thinking({ text, open, setOpen }: { text: string; open: boolean; setOpen: (f: (v: boolean) => boolean) => void }) {
  return (
    <section className="rounded-[10px] border border-line bg-canvas/40">
      <button
        type="button"
        onClick={() => setOpen((r) => !r)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left hover:bg-hover"
      >
        <ChevronRight aria-hidden="true" className={cn('size-3.5 text-ink-4 transition-transform', open && 'rotate-90')} />
        <Brain aria-hidden="true" className="size-3.5 text-ink-3" />
        <span className="text-[12.5px] font-semibold text-ink">Thinking</span>
        <span className="ml-auto font-mono text-[10.5px] text-ink-3 tabular">{text.length.toLocaleString()} chars</span>
      </button>
      {open && (
        <div className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-line px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink-3">
          {text}
        </div>
      )}
    </section>
  );
}

function RunPanel({ turn }: { turn: SessionTurn }) {
  const { runMetrics, turnCost, reasoningText, showReasoning, setShowReasoning, sessionStats, displayedRoute, isStreaming, turnElapsedMs } = turn;
  const hasRun = Boolean(runMetrics || turnCost || reasoningText || isStreaming);
  if (!hasRun) {
    return (
      <EmptyState
        compact
        title="No turn has run yet"
        description="Route, timing, tokens and the reasoning trace of the latest Session turn appear here."
      />
    );
  }
  const items: Array<[string, string]> = [
    ['Route', displayedRoute],
    ['Duration', runMetrics ? formatRunDuration(runMetrics.durationMs) : formatRunDuration(turnElapsedMs)],
  ];
  if (runMetrics?.firstVisibleTokenMs !== undefined) items.push(['TTFT', formatRunDuration(runMetrics.firstVisibleTokenMs)]);
  const tokens = runMetrics?.tokens ?? turnCost?.tokens;
  if (tokens !== undefined) items.push(['Tokens', tokens.toLocaleString()]);
  if (turnCost && turnCost.costUsd > 0) items.push(['Cost', `$${turnCost.costUsd.toFixed(4)}`]);
  if (runMetrics) items.push(['Tools', String(runMetrics.tools)]);
  if (runMetrics && runMetrics.fallbackRetries > 0) {
    items.push(['Fallback', `${runMetrics.fallbackRetries}${runMetrics.fallbackReason ? ` · ${runMetrics.fallbackReason.replace(/_/g, ' ')}` : ''}`]);
  }
  if (runMetrics?.scopeCompliant !== undefined) items.push(['Scope', runMetrics.scopeCompliant ? 'verified' : 'violation']);
  if (shouldShowSessionStats(sessionStats.turnCount)) items.push(['Session', formatSessionStatsLine(sessionStats)]);

  return (
    <div className="space-y-3">
      <div className="rounded-[10px] border border-line bg-surface p-3.5">
        <div className="d-label mb-2.5 text-[9.5px]">{isStreaming ? 'This turn · live' : 'Latest turn'}</div>
        <KeyValue items={items} className="text-[12px]" />
      </div>
      {reasoningText && <Thinking text={reasoningText} open={showReasoning} setOpen={setShowReasoning} />}
    </div>
  );
}

export function Inspector({ turn }: { turn: SessionTurn }) {
  const [tab, setTab] = useState<InspectorTab>('activity');
  const { activityFeed, isStreaming, turnElapsedMs, recursionDepth, runMetrics, selectedSessionId } = turn;

  return (
    <aside aria-label="Session inspector" className="flex w-[300px] shrink-0 flex-col border-l border-line bg-sunken/60 min-[1440px]:w-[340px]">
      <Tabs
        aria-label="Inspector"
        idBase="session-inspector"
        size="sm"
        value={tab}
        onChange={setTab}
        className="h-10 shrink-0 items-end px-3"
        items={[
          { id: 'activity', label: 'Activity', meta: activityFeed.length > 0 ? activityFeed.length : undefined },
          { id: 'run', label: 'Run' },
          { id: 'runs', label: 'Recorded runs' },
        ]}
      />
      <div
        role="tabpanel"
        id={`session-inspector-panel-${tab}`}
        aria-labelledby={`session-inspector-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto p-3"
      >
        {tab === 'activity' && (
          <div className="space-y-3">
            {activityFeed.length > 0 && (
              <ActivityFeed items={activityFeed} isStreaming={isStreaming} turnElapsedMs={turnElapsedMs} recursionDepth={recursionDepth} />
            )}
            {runMetrics && <RunMetricsBar metrics={runMetrics} />}
            {activityFeed.length === 0 && !runMetrics && (
              <EmptyState
                compact
                title={isStreaming ? 'Waiting for the first activity' : 'No turn activity yet'}
                description="Orchestrator stages, tool calls, results and Conductor directives appear here as a Session turn runs."
              />
            )}
          </div>
        )}
        {tab === 'run' && <RunPanel turn={turn} />}
        {tab === 'runs' &&
          (selectedSessionId ? (
            <div className="rounded-[10px] border border-line bg-surface p-3.5">
              <div className="d-label mb-3 text-[9.5px]">Recorded by Native</div>
              <SessionRunsView key={selectedSessionId} sessionId={selectedSessionId} />
            </div>
          ) : (
            <EmptyState compact title="No Session selected" description="Recorded runs belong to a Session. Start a turn or pick a Session." />
          ))}
      </div>
    </aside>
  );
}
