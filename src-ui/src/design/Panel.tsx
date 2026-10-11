import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  /** Corner registration ticks — reserve for the one hero panel per page. */
  ticks?: boolean;
  /** Remove inner padding (for lists / tables that run edge to edge). */
  flush?: boolean;
  as?: 'section' | 'div' | 'article' | 'li';
  interactive?: boolean;
}

/** The base surface: a sheet on the drafting table. */
export function Panel({ ticks, flush, as: Tag = 'section', interactive, className, children, ...rest }: PanelProps) {
  return (
    <Tag
      className={cn(
        'rounded-[10px] border border-line bg-surface shadow-card',
        !flush && 'p-4',
        ticks && 'd-ticks',
        interactive && 'transition-colors duration-150 hover:border-line-strong hover:bg-raised',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export interface PanelHeaderProps {
  title: ReactNode;
  /** Small mono annotation after the title, e.g. a count. */
  meta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
  /** Heading level for the title (defaults to h3). */
  level?: 2 | 3 | 4;
}

export function PanelHeader({ title, meta, description, actions, icon, className, level = 3 }: PanelHeaderProps) {
  const H = `h${level}` as 'h2' | 'h3' | 'h4';
  return (
    <header className={cn('mb-3 flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {icon && <span className="text-ink-3 [&_svg]:size-3.5">{icon}</span>}
          <H className="truncate text-[13px] font-semibold tracking-[-0.005em] text-ink">{title}</H>
          {meta !== undefined && meta !== null && <span className="font-mono text-[11px] text-ink-3 tabular">{meta}</span>}
        </div>
        {description && <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}

/** A big number with an annotation label — the instrument readout. */
export function Stat({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'ok' | 'warn' | 'error' | 'accent';
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="d-label">{label}</span>
      <span
        className={cn(
          'd-display tabular text-[34px] leading-none text-ink',
          tone === 'ok' && 'text-ok',
          tone === 'warn' && 'text-warn',
          tone === 'error' && 'text-err',
          tone === 'accent' && 'text-accent-hot',
        )}
      >
        {value}
      </span>
      {sub && <span className="truncate text-[11.5px] text-ink-3">{sub}</span>}
    </div>
  );
}

/** Definition list in two columns: mono key, value. */
export function KeyValue({ items, className }: { items: Array<[ReactNode, ReactNode]>; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(90px,auto)_1fr] gap-x-4 gap-y-1.5 text-[12.5px]', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 leading-[1.6]">{k}</dt>
          <dd className="min-w-0 truncate text-ink-2">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Hairline-separated list container. */
export function RowList({ className, children, ...rest }: HTMLAttributes<HTMLUListElement>) {
  return (
    <ul className={cn('divide-y divide-line', className)} {...rest}>
      {children}
    </ul>
  );
}

export function Divider({ className, label }: { className?: string; label?: ReactNode }) {
  if (!label) return <hr className={cn('my-4 h-px border-0 bg-line', className)} />;
  return (
    <div className={cn('my-4 flex items-center gap-3', className)}>
      <span className="h-px flex-1 bg-line" />
      <span className="d-label">{label}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
