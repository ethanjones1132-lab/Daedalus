import { useEffect, useMemo, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { cn, Panel, PanelHeader } from '../../design';
import { formatWhen, type CronJob } from './cron-model';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Markers closer than this (percent of the ruler) stack into another lane. */
const LANE_GAP_PCT = 3.2;
const LANES = 3;

export interface TimelineMarker {
  job: CronJob;
  at: number;
  pct: number;
  lane: number;
}

/** Enabled jobs whose next run falls in (now, now + 24h], placed on the ruler. */
export function planTimeline(jobs: CronJob[], now: number): TimelineMarker[] {
  const upcoming = jobs
    .filter((job) => job.enabled && job.next_run)
    .map((job) => ({ job, at: new Date(job.next_run as string).getTime() }))
    .filter(({ at }) => !Number.isNaN(at) && at > now && at <= now + WINDOW_MS)
    .sort((a, b) => a.at - b.at);

  const laneEnds: number[] = Array.from({ length: LANES }, () => -Infinity);
  return upcoming.map(({ job, at }) => {
    const pct = ((at - now) / WINDOW_MS) * 100;
    let lane = laneEnds.findIndex((end) => pct - end >= LANE_GAP_PCT);
    if (lane < 0) lane = laneEnds.indexOf(Math.min(...laneEnds));
    laneEnds[lane] = pct;
    return { job, at, pct, lane };
  });
}

function hourTicks(now: number) {
  const first = Math.ceil(now / HOUR_MS) * HOUR_MS;
  const ticks: Array<{ pct: number; label: string | null }> = [];
  for (let t = first; t <= now + WINDOW_MS; t += HOUR_MS) {
    const hour = new Date(t).getHours();
    ticks.push({
      pct: ((t - now) / WINDOW_MS) * 100,
      label: hour % 3 === 0 ? `${String(hour).padStart(2, '0')}:00` : null,
    });
  }
  return ticks;
}

function clockTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * The next-runs timeline: a 24h ruler starting at "now" (the brass needle),
 * with one marker per enabled job at its next run. Hover or focus a marker to
 * read its name; click to jump to the job's row.
 */
export function CronTimeline({
  jobs,
  inFlightIds,
  onSelect,
}: {
  jobs: CronJob[];
  inFlightIds: Set<string>;
  onSelect: (jobId: string) => void;
}) {
  const now = useNow(30_000);
  const markers = useMemo(() => planTimeline(jobs, now), [jobs, now]);
  const ticks = useMemo(() => hourTicks(now), [now]);
  const [active, setActive] = useState<string | null>(null);
  const next = markers[0];

  return (
    <Panel ticks className="mb-6" aria-label="Next runs timeline">
      <PanelHeader
        icon={<CalendarClock />}
        title="Next 24 hours"
        meta={markers.length}
        description={
          next ? (
            <>
              Next up: <span className="text-ink-2">{next.job.name}</span> {formatWhen(next.job.next_run, now)}
              {markers.length > 1 ? `, then ${markers.length - 1} more.` : '.'}
            </>
          ) : (
            'No enabled job is scheduled to run in the next 24 hours.'
          )
        }
      />
      <div className="relative mx-3 mt-1 h-[92px] select-none" role="group" aria-label="Scheduled runs, next 24 hours">
        {/* baseline */}
        <div className="absolute inset-x-0 bottom-5 h-px bg-line-strong" />
        {ticks.map((tick) => (
          <div key={tick.pct} className="absolute bottom-5 flex flex-col items-center" style={{ left: `${tick.pct}%` }}>
            <span className={cn('block w-px bg-line-strong', tick.label ? 'h-2' : 'h-1')} />
            {tick.label && (
              <span className="absolute top-3 -translate-x-1/2 font-mono text-[10px] tracking-[0.06em] text-ink-4 tabular">
                {tick.label}
              </span>
            )}
          </div>
        ))}

        {/* now needle */}
        <div className="absolute bottom-5 left-0 top-0 w-px bg-accent shadow-[0_0_10px_var(--d-accent)]" aria-hidden="true" />
        <span className="d-label absolute -top-0.5 left-2 text-accent" aria-hidden="true">
          Now
        </span>

        {markers.map(({ job, at, pct, lane }) => {
          const running = inFlightIds.has(job.id);
          const showing = active === job.id;
          const alignRight = pct > 70;
          return (
            <div
              key={job.id}
              className="absolute bottom-5 -translate-x-1/2"
              style={{ left: `${pct}%`, height: `${22 + lane * 22}px` }}
            >
              <span aria-hidden="true" className="absolute bottom-0 left-1/2 top-2 w-px -translate-x-1/2 bg-accent-line" />
              <button
                type="button"
                aria-label={`${job.name}, next run ${formatWhen(job.next_run, now)} at ${clockTime(at)}`}
                onClick={() => onSelect(job.id)}
                onMouseEnter={() => setActive(job.id)}
                onMouseLeave={() => setActive((current) => (current === job.id ? null : current))}
                onFocus={() => setActive(job.id)}
                onBlur={() => setActive((current) => (current === job.id ? null : current))}
                className={cn(
                  'absolute left-1/2 top-0 size-[11px] -translate-x-1/2 rotate-45 border border-accent bg-canvas transition-colors',
                  'hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  running && 'bg-accent',
                )}
              />
              {showing && (
                <div
                  className={cn(
                    'pointer-events-none absolute -top-9 z-10 whitespace-nowrap rounded-md border border-line-strong bg-overlay px-2 py-1 shadow-pop',
                    alignRight ? 'right-[-6px]' : 'left-[-6px]',
                  )}
                >
                  <div className="text-[12px] font-medium text-ink">{job.name}</div>
                  <div className="font-mono text-[10.5px] text-ink-3 tabular">
                    {clockTime(at)} · {formatWhen(job.next_run, now)}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
