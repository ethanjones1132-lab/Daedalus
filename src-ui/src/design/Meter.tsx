import { useId, type ReactNode } from 'react';
import { cn, type Tone } from './cn';

const stroke: Record<Tone, string> = {
  neutral: 'var(--d-ink-3)',
  muted: 'var(--d-ink-4)',
  accent: 'var(--d-accent)',
  ok: 'var(--d-ok)',
  info: 'var(--d-info)',
  warn: 'var(--d-warn)',
  error: 'var(--d-err)',
};

/** Threshold tone for utilisation-style percentages. */
export function loadTone(pct: number | null | undefined, warnAt = 75, errorAt = 90): Tone {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return 'muted';
  if (pct >= errorAt) return 'error';
  if (pct >= warnAt) return 'warn';
  return 'ok';
}

const clamp = (v: number) => Math.max(0, Math.min(100, v));

/** Hairline bar meter with tick marks every 25 %. */
export function Meter({
  value,
  tone = 'accent',
  label,
  className,
}: {
  value: number | null | undefined;
  tone?: Tone;
  /** Accessible name; when given the bar is exposed as role=meter. */
  label?: string;
  className?: string;
}) {
  const v = value === null || value === undefined || Number.isNaN(value) ? null : clamp(value);
  return (
    <div
      role={label ? 'meter' : undefined}
      aria-label={label}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      aria-valuenow={label && v !== null ? Math.round(v) : undefined}
      aria-hidden={label ? undefined : true}
      className={cn('relative h-[5px] w-full overflow-hidden rounded-full bg-sunken ring-1 ring-inset ring-line', className)}
    >
      {[25, 50, 75].map((t) => (
        <span key={t} className="absolute inset-y-0 w-px bg-line-strong" style={{ left: `${t}%` }} />
      ))}
      {v !== null && (
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-[var(--ease-out-quint)]"
          style={{ width: `${v}%`, background: stroke[tone] }}
        />
      )}
    </div>
  );
}

/**
 * Instrument dial: a 270° arc gauge with graduations. Decorative by default —
 * always render the value as text next to or inside it.
 */
export function Dial({
  value,
  tone = 'accent',
  size = 92,
  children,
  className,
}: {
  value: number | null | undefined;
  tone?: Tone;
  size?: number;
  children?: ReactNode;
  className?: string;
}) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const sweep = 0.75;
  const v = value === null || value === undefined || Number.isNaN(value) ? 0 : clamp(value) / 100;
  const ticks = Array.from({ length: 28 }, (_, i) => i);
  return (
    <div className={cn('relative inline-flex items-center justify-center', className)} style={{ width: size, height: size }}>
      <svg aria-hidden="true" viewBox="0 0 100 100" className="absolute inset-0 -rotate-[225deg]">
        {ticks.map((i) => {
          const a = (i / (ticks.length - 1)) * sweep * 2 * Math.PI;
          const major = i % 9 === 0;
          const r1 = 47;
          const r2 = major ? 43.5 : 45.2;
          return (
            <line
              key={i}
              x1={50 + r1 * Math.cos(a)}
              y1={50 + r1 * Math.sin(a)}
              x2={50 + r2 * Math.cos(a)}
              y2={50 + r2 * Math.sin(a)}
              stroke="var(--d-line-strong)"
              strokeWidth={major ? 1.1 : 0.7}
            />
          );
        })}
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--d-line)" strokeWidth="3" strokeDasharray={`${c * sweep} ${c}`} strokeLinecap="round" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke={stroke[tone]}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${c * sweep * v} ${c}`}
          style={{ transition: 'stroke-dasharray 900ms var(--ease-out-quint)' }}
        />
      </svg>
      <div className="relative flex flex-col items-center">{children}</div>
    </div>
  );
}

/** Minimal sparkline (area + line). Decorative; values are relative. */
export function Sparkline({
  values,
  tone = 'accent',
  width = 120,
  height = 28,
  className,
}: {
  values: number[];
  tone?: Tone;
  width?: number;
  height?: number;
  className?: string;
}) {
  const gid = `spark${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  if (values.length < 2) return <div aria-hidden="true" style={{ width, height }} className={className} />;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, height - 2 - ((v - min) / span) * (height - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg aria-hidden="true" width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className}>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke[tone]} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke[tone]} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={stroke[tone]} strokeWidth="1.25" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2" fill={stroke[tone]} />
    </svg>
  );
}
