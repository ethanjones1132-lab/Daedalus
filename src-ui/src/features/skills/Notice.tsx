import type { ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '../../design';

/**
 * Compact inline notice used inside cards and detail panels. Unlike the
 * design `AlertLine` the live-region role is caller-chosen, because the
 * pinned contracts mix `alert` (row) and `status` (inspector) for the same
 * candidate-lifecycle sentence.
 */
export function Notice({
  role = 'alert',
  label,
  tone = 'error',
  children,
  onRetry,
  retryDisabled,
  className,
}: {
  role?: 'alert' | 'status';
  label?: string;
  tone?: 'error' | 'warn';
  children: ReactNode;
  onRetry?: () => void;
  retryDisabled?: boolean;
  className?: string;
}) {
  const Icon = role === 'alert' ? AlertTriangle : Info;
  return (
    <div
      role={role}
      aria-label={label}
      className={cn(
        'flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[12px] leading-snug text-ink-2',
        tone === 'error' ? 'border-err/25 bg-err-wash' : 'border-warn/25 bg-warn-wash',
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn('mt-[1px] size-3.5 shrink-0', tone === 'error' ? 'text-err' : 'text-warn')} />
      <span className="min-w-0 flex-1">{children}</span>
      {onRetry && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRetry();
          }}
          disabled={retryDisabled}
          className={cn(
            'shrink-0 rounded-[4px] border px-1.5 text-[11.5px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-45',
            tone === 'error' ? 'border-err/30 text-err hover:bg-err/15' : 'border-warn/30 text-warn hover:bg-warn/15',
          )}
        >
          Retry
        </button>
      )}
    </div>
  );
}
