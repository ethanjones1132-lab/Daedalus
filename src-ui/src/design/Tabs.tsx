import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn';

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Small trailing count / badge. */
  meta?: ReactNode;
}

export interface TabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  'aria-label': string;
  className?: string;
  /** id prefix for aria-controls wiring: panel ids are `${idBase}-panel-${id}`. */
  idBase?: string;
  size?: 'sm' | 'md';
}

/**
 * Underline tabs with roving focus (ArrowLeft/Right, Home/End), real
 * role=tablist/tab semantics and aria-selected.
 */
export function Tabs<T extends string>({ items, value, onChange, className, idBase, size = 'md', ...rest }: TabsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(items[next].id);
  };

  return (
    <div role="tablist" aria-label={rest['aria-label']} className={cn('flex items-stretch gap-1 overflow-x-auto border-b border-line', className)}>
      {items.map((item, i) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={idBase ? `${idBase}-tab-${item.id}` : undefined}
            aria-controls={idBase ? `${idBase}-panel-${item.id}` : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'relative -mb-px inline-flex shrink-0 items-center gap-1.5 border-b px-2.5 font-medium transition-colors duration-150',
              size === 'md' ? 'h-9 text-[12.5px]' : 'h-8 text-[12px]',
              '[&_svg]:size-3.5',
              selected ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:text-ink-2',
            )}
          >
            {item.icon}
            {item.label}
            {item.meta !== undefined && item.meta !== null && (
              <span className={cn('font-mono text-[10.5px] tabular', selected ? 'text-accent' : 'text-ink-4')}>{item.meta}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Segmented control for 2–4 mutually exclusive options (uses aria-pressed). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  disabled,
  ...rest
}: {
  options: Array<{ id: T; label: ReactNode; description?: ReactNode }>;
  value: T;
  onChange: (id: T) => void;
  className?: string;
  disabled?: boolean;
  'aria-label': string;
}) {
  return (
    <div role="group" aria-label={rest['aria-label']} className={cn('inline-flex rounded-lg border border-line-strong bg-sunken p-0.5', className)}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(o.id)}
            className={cn(
              'flex min-w-0 flex-1 flex-col items-start rounded-md px-3 py-1.5 text-left transition-colors duration-150 disabled:opacity-50',
              on ? 'bg-raised text-ink shadow-card ring-1 ring-accent-line' : 'text-ink-3 hover:text-ink-2',
            )}
          >
            <span className="text-[12.5px] font-medium">{o.label}</span>
            {o.description && <span className="text-[11px] text-ink-3">{o.description}</span>}
          </button>
        );
      })}
    </div>
  );
}
