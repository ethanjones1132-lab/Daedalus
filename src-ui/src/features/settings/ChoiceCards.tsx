import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../design';

export interface Choice<T extends string> {
  id: T;
  title: ReactNode;
  description?: ReactNode;
  /** Small trailing tag, e.g. a local / cloud Badge. */
  badge?: ReactNode;
  /** `danger` tints the selected state with the error tone (spends real money / quota). */
  tone?: 'default' | 'danger';
}

/**
 * A row of mutually exclusive option cards (aria-pressed buttons). Proposed for
 * design/ — Segmented is too compact for options that need a sentence each.
 */
export function ChoiceCards<T extends string>({
  options,
  value,
  onChange,
  columns = 2,
  className,
  ...rest
}: {
  options: Array<Choice<T>>;
  value: T | null | undefined;
  onChange: (id: T) => void;
  columns?: 2 | 3 | 4;
  className?: string;
  'aria-label': string;
}) {
  return (
    <div
      role="group"
      aria-label={rest['aria-label']}
      className={cn(
        'grid gap-2.5',
        columns === 2 && 'grid-cols-1 sm:grid-cols-2',
        columns === 3 && 'grid-cols-1 sm:grid-cols-3',
        columns === 4 && 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4',
        className,
      )}
    >
      {options.map((o) => {
        const on = o.id === value;
        const danger = o.tone === 'danger';
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.id)}
            className={cn(
              'group relative flex min-w-0 flex-col items-start gap-1.5 rounded-lg border p-3 text-left',
              'transition-[background-color,border-color,box-shadow] duration-150',
              'disabled:cursor-not-allowed disabled:opacity-60',
              on
                ? danger
                  ? 'border-err/50 bg-err-wash shadow-[0_0_0_1px_var(--d-err)_inset]'
                  : 'border-accent-line bg-accent-wash shadow-[0_0_0_1px_var(--d-accent-line)_inset]'
                : 'border-line-strong bg-sunken hover:border-ink-4 hover:bg-raised',
            )}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span className={cn('text-[13px] font-medium', on ? 'text-ink' : 'text-ink-2')}>{o.title}</span>
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-full border',
                  on ? (danger ? 'border-err bg-err text-canvas' : 'border-accent bg-accent text-accent-ink') : 'border-line-strong text-transparent',
                )}
              >
                <Check className="size-2.5" strokeWidth={3} />
              </span>
            </span>
            {o.description && <span className="text-[11.5px] leading-snug text-ink-3">{o.description}</span>}
            {o.badge && <span className="mt-0.5">{o.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
