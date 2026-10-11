import { Badge, cn, Sparkline } from '../../design';
import type { CandidatePerformance, CandidatePerformanceView } from '../../domain/skill-candidate-performance';
import { Notice } from './Notice';

/**
 * "Since promotion" readout for a promoted candidate. Pending, failed (with
 * the last confirmed measurement kept and labelled stale), unmeasured and
 * measured are four different things and never collapse into an absent panel.
 */
export function PerformanceReadout({
  view,
  performance,
  onRetry,
  className,
}: {
  view: CandidatePerformanceView;
  performance: CandidatePerformance | null;
  onRetry: () => void;
  className?: string;
}) {
  const rates = performance && [performance.before.success_rate, performance.after.success_rate];
  const series = rates && rates.every((r): r is number => typeof r === 'number') ? rates : null;
  return (
    <div role="group" aria-label="Skill performance since promotion" className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="d-label">Since promotion</span>
        {view.measured && (
          <>
            <span className="d-display tabular text-[24px] leading-none text-ink">
              {view.measured.before.rate}
              {' → '}
              {view.measured.after.rate}
            </span>
            {view.measured.delta ? (
              <Badge tone={view.measured.delta.positive ? 'ok' : 'error'}>{view.measured.delta.text}</Badge>
            ) : (
              <span className="text-[12px] text-ink-3">delta —</span>
            )}
            {series && view.kind !== 'pending' && <Sparkline values={series} tone={view.measured.delta?.positive === false ? 'error' : 'ok'} width={96} height={28} />}
          </>
        )}
      </div>
      {view.measured && <p className="text-[12px] text-ink-3">{view.measured.text}</p>}
      {view.kind === 'pending' && (
        <p role="status" className="text-[12px] text-ink-3">
          {view.text}
        </p>
      )}
      {view.failureText && (
        <Notice role="alert" tone="warn" onRetry={onRetry} retryDisabled={view.kind === 'pending'}>
          {view.failureText}
        </Notice>
      )}
      {view.kind === 'unmeasured' && <p className="text-[12px] text-ink-3">{view.text}</p>}
    </div>
  );
}
