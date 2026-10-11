import { forwardRef, type ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { cn } from './cn';
import { Spinner } from './Spinner';

/*
 * Honest-state primitives.
 *
 * Jarvis surfaces follow one rule: pending is not empty, failed is not empty,
 * and stale data is labelled as stale with a Retry. These components are the
 * only way views should express those states, so the voice stays uniform:
 *   <StatusLine>  role=status — pending / refreshing / confirming
 *   <AlertLine>   role=alert  — failed, optionally stale, with Retry
 *   <EmptyState>  only after a successful observation returned nothing
 */

export interface StatusLineProps {
  /** Accessible name for the live region (many tests address it by name). */
  label?: string;
  children: ReactNode;
  /** Show the compass spinner (default true). */
  busy?: boolean;
  className?: string;
  tone?: 'neutral' | 'ok' | 'warn';
}

export const StatusLine = forwardRef<HTMLDivElement, StatusLineProps>(function StatusLine(
  { label, children, busy = true, className, tone = 'neutral' },
  ref,
) {
  return (
    <div
      ref={ref}
      role="status"
      aria-label={label}
      className={cn(
        'flex items-center gap-2 text-[12px]',
        tone === 'neutral' && 'text-ink-3',
        tone === 'ok' && 'text-ok',
        tone === 'warn' && 'text-warn',
        className,
      )}
    >
      {busy && <Spinner size={12} />}
      <span>{children}</span>
    </div>
  );
});

export interface AlertLineProps {
  label?: string;
  children: ReactNode;
  onRetry?: () => void;
  /** Visible text of the retry button. */
  retryText?: string;
  /** Accessible name of the retry button (defaults to retryText). */
  retryLabel?: string;
  retryDisabled?: boolean;
  /** 'error' (default) or 'warn' for degraded-but-usable. */
  tone?: 'error' | 'warn';
  className?: string;
  /** Extra controls rendered next to Retry. */
  actions?: ReactNode;
}

export function AlertLine({
  label,
  children,
  onRetry,
  retryText = 'Retry',
  retryLabel,
  retryDisabled,
  tone = 'error',
  className,
  actions,
}: AlertLineProps) {
  return (
    <div
      role="alert"
      aria-label={label}
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-[12.5px] leading-snug',
        tone === 'error' ? 'border-err/25 bg-err-wash text-ink' : 'border-warn/25 bg-warn-wash text-ink',
        className,
      )}
    >
      <AlertTriangle aria-hidden="true" className={cn('mt-[1px] size-3.5 shrink-0', tone === 'error' ? 'text-err' : 'text-warn')} />
      <div className="min-w-0 flex-1">{children}</div>
      {(onRetry || actions) && (
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retryDisabled}
              aria-label={retryLabel}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-[5px] border px-2 text-[11.5px] font-medium transition-colors',
                'disabled:pointer-events-none disabled:opacity-45',
                tone === 'error'
                  ? 'border-err/30 text-err hover:bg-err/15'
                  : 'border-warn/30 text-warn hover:bg-warn/15',
              )}
            >
              <RotateCw aria-hidden="true" className="size-3" />
              {retryText}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

/** Only render after a successful observation that returned nothing. */
export function EmptyState({ title, description, icon, action, className, compact }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'gap-1.5 py-6' : 'gap-2.5 py-14', className)}>
      {icon && (
        <div
          aria-hidden="true"
          className="mb-1 flex size-10 items-center justify-center rounded-full border border-dashed border-line-strong text-ink-4 [&_svg]:size-4"
        >
          {icon}
        </div>
      )}
      <p className={cn('text-ink-2', compact ? 'text-[12.5px]' : 'd-display text-[22px]')}>{title}</p>
      {description && <p className="max-w-sm text-[12.5px] leading-relaxed text-ink-3">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('d-skeleton h-3', className)} />;
}

/** Visually hidden, still announced. */
export function VisuallyHidden({ children, as: Tag = 'span' }: { children: ReactNode; as?: 'span' | 'div' | 'h2' | 'h3' }) {
  return <Tag className="sr-only">{children}</Tag>;
}
