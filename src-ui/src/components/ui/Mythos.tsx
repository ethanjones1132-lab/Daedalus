... 269 lines not shown ...
   /* ── MetricBlock ──────────────────────────────────────────
   The "value + label" stat tile. The Mythos standard.
   ──────────────────────────────────────────────────────── */

export type MetricBlockProps = {
  value: number | string;
  label: string;
  unit?: string;
  format?: (n: number) => string;
  tone?: 'cyan' | 'royal' | 'amber' | 'bone' | 'success';
     icon?: string;
  className?: string;
};

const metricTone: Record<NonNullable<MetricBlockProps['tone']>, string> = {
  cyan: 'text-cyan-glow',
  royal: 'text-royal-light',
  amber: 'text-amber-400',
  bone: 'text-bone',
  success: 'text-success',
   };

export function MetricBlock({ value, label, unit, format, tone = 'cyan', icon, className }: MetricBlockProps) {
  const isNumber = typeof value === 'number';
  return (
    <div className={cn('flex flex-col items-start gap-1.5', className)}>
      {icon && <span className="text-base opacity-60">{icon}</span>}
      <div className="flex items-baseline gap-1">
        {isNumber ? (
          <AnimatedNumber
... 155 lines not shown ...