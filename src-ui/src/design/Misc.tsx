import { Component, useState, type ErrorInfo, type HTMLAttributes, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from './cn';
import { AlertLine } from './Feedback';

export function Kbd({ className, children, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line-strong border-b-2 bg-raised px-1 font-mono text-[10px] text-ink-3',
        className,
      )}
      {...rest}
    >
      {children}
    </kbd>
  );
}

export interface PageHeaderProps {
  /** Small mono eyebrow (the rail group). */
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Content under the title row, e.g. Tabs. */
  children?: ReactNode;
  className?: string;
}

/** Page masthead: serif title over a hairline, with actions on the right. */
export function PageHeader({ eyebrow, title, description, actions, children, className }: PageHeaderProps) {
  return (
    <header className={cn('mb-6', className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {eyebrow && <div className="d-label mb-2 text-accent">{eyebrow}</div>}
          <h1 className="d-display text-[38px] text-ink">{title}</h1>
          {description && <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-ink-3">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-5">{children}</div>}
    </header>
  );
}

/** Scrollable page body with the standard measure and gutters. */
export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={cn('mx-auto w-full px-8 pb-16 pt-8', wide ? 'max-w-[1400px]' : 'max-w-[1120px]', className)}>{children}</div>
    </div>
  );
}

export interface DisclosureProps {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Accessible name for the toggle button when summary is not plain text. */
  label?: string;
  className?: string;
  trailing?: ReactNode;
  id?: string;
}

export function Disclosure({ summary, children, defaultOpen, open, onOpenChange, label, className, trailing, id }: DisclosureProps) {
  const [inner, setInner] = useState(Boolean(defaultOpen));
  const isOpen = open ?? inner;
  const panelId = id ?? undefined;
  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          aria-label={label}
          onClick={() => {
            const next = !isOpen;
            setInner(next);
            onOpenChange?.(next);
          }}
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12.5px] text-ink-2 hover:text-ink"
        >
          <ChevronRight aria-hidden="true" className={cn('size-3.5 shrink-0 text-ink-4 transition-transform duration-200', isOpen && 'rotate-90')} />
          <span className="min-w-0 flex-1 truncate">{summary}</span>
        </button>
        {trailing}
      </div>
      <div id={panelId} hidden={!isOpen} className="mt-2">
        {isOpen && children}
      </div>
    </div>
  );
}

interface BoundaryState {
  error: Error | null;
}

/** Catches render errors in one view so the shell survives. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-8">
          <AlertLine onRetry={() => this.setState({ error: null })} retryText="Try again">
            {this.props.label ?? 'This view'} failed to render: {this.state.error.message}
          </AlertLine>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Relative age: "just now", "42s ago", "5m ago", "3h 12m ago", "2d 4h ago". */
export function formatAge(ms: number): string {
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ago`;
  if (h > 0) return `${h}h ${m % 60}m ago`;
  if (m > 0) return `${m}m ago`;
  if (s < 5) return 'just now';
  return `${s}s ago`;
}

export function formatIsoAge(value: string | null | undefined): string {
  if (!value) return 'unknown';
  const t = Date.parse(value);
  if (Number.isNaN(t)) return 'unknown';
  return formatAge(Date.now() - t);
}

/** 1234 → "1.2K", 1_250_000 → "1.3M". */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
