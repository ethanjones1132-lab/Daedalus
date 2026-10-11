import { Check, X } from 'lucide-react';
import { cn } from '../../design';
import type { Station, StationState } from './lifecycle-stations';

/*
 * The Agent lifecycle as a four-station track: discover -> validate ->
 * project -> activate. Done = brass, filled. Current = brass ring, pulsing.
 * Failed = ember. Pending = hollow. The state is always spelled out in words
 * beneath the station, so colour is never the only signal.
 */

const WORD: Record<StationState, string> = {
  done: 'done',
  current: 'in progress',
  failed: 'failed',
  pending: 'pending',
};

function Node({ state, size }: { state: StationState; size: number }) {
  const common = 'relative z-10 flex shrink-0 items-center justify-center rounded-full border';
  const style = { width: size, height: size };
  if (state === 'done') {
    return (
      <span aria-hidden="true" style={style} className={cn(common, 'border-accent bg-accent text-accent-ink')}>
        <Check className="size-[60%]" strokeWidth={3} />
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span aria-hidden="true" style={style} className={cn(common, 'border-err bg-err-wash text-err')}>
        <X className="size-[60%]" strokeWidth={3} />
      </span>
    );
  }
  if (state === 'current') {
    return (
      <span aria-hidden="true" style={style} className={cn(common, 'border-accent bg-canvas')}>
        <span className="absolute -inset-[3px] rounded-full border border-accent-line d-pulse" />
        <span className="size-[38%] rounded-full bg-accent" />
      </span>
    );
  }
  return <span aria-hidden="true" style={style} className={cn(common, 'border-line-strong bg-sunken')} />;
}

const wordTone: Record<StationState, string> = {
  done: 'text-accent-hot',
  current: 'text-accent-hot',
  failed: 'text-err',
  pending: 'text-ink-4',
};

export function LifecycleTrack({
  stations,
  compact,
  label = 'Agent lifecycle',
}: {
  stations: Station[];
  compact?: boolean;
  label?: string;
}) {
  const size = compact ? 18 : 22;
  return (
    <ol aria-label={label} className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4 sm:gap-x-0">
      {stations.map((s, i) => {
        const next = stations[i + 1];
        // The hairline leaving a station is brass only when both ends are done.
        const lit = s.state === 'done' && next?.state === 'done';
        const leadsOn = s.state === 'done' && next?.state !== undefined && next.state !== 'pending';
        return (
          <li key={s.key} className="min-w-0 pr-4 last:pr-0">
            <div className="flex items-center" style={{ height: size }}>
              <Node state={s.state} size={size} />
              {i < stations.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'ml-1 hidden h-px flex-1 sm:block',
                    lit ? 'bg-accent' : leadsOn ? 'bg-gradient-to-r from-accent to-line-strong' : 'bg-line-strong',
                  )}
                />
              )}
            </div>
            <div className="mt-2.5 flex items-baseline gap-2">
              <span className={cn('d-label', s.state === 'pending' ? 'text-ink-3' : 'text-ink')}>{s.label}</span>
              <span className={cn('font-mono text-[10px] lowercase tracking-wide', wordTone[s.state])}>{WORD[s.state]}</span>
            </div>
            <p className={cn('mt-1 break-words text-ink-3', compact ? 'text-[11.5px] leading-snug' : 'text-[12.5px] leading-snug')}>{s.result}</p>
          </li>
        );
      })}
    </ol>
  );
}

/** Four small stations on a hairline, for list rows. Decorative; carries a text alternative. */
export function MiniTrack({ stations }: { stations: Station[] }) {
  const done = stations.filter((s) => s.state === 'done').length;
  const failed = stations.some((s) => s.state === 'failed');
  return (
    <span
      role="img"
      aria-label={`Lifecycle: ${done} of 4 stations done${failed ? ', one failed' : ''}`}
      className="relative inline-flex items-center gap-[7px]"
    >
      <span aria-hidden="true" className="absolute inset-x-[3px] top-1/2 h-px bg-line-strong" />
      {stations.map((s) => (
        <span
          key={s.key}
          aria-hidden="true"
          className={cn(
            'relative size-[7px] rounded-full border',
            s.state === 'done' && 'border-accent bg-accent',
            s.state === 'current' && 'border-accent bg-canvas ring-2 ring-accent-wash d-pulse',
            s.state === 'failed' && 'border-err bg-err',
            s.state === 'pending' && 'border-line-strong bg-surface',
          )}
        />
      ))}
    </span>
  );
}
