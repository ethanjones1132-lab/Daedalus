import type { HTMLAttributes, ReactNode } from 'react';
import { cn, toneBg, toneOf, toneText, toneWash, type Tone } from './cn';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Accepts legacy StatusVariant strings too (success / warning / …). */
  variant?: string;
  icon?: ReactNode;
  /** Draw a status dot before the label. */
  dot?: boolean;
  size?: 'xs' | 'sm';
}

/** Compact, mono, uppercase status tag. */
export function Badge({ tone, variant, icon, dot, size = 'sm', className, children, ...rest }: BadgeProps) {
  const t = tone ?? toneOf(variant);
  return (
    <span
      className={cn(
        'inline-flex max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap border font-mono uppercase',
        size === 'sm' ? 'h-[20px] rounded-[4px] px-1.5 text-[10px] tracking-[0.08em]' : 'h-4 rounded-[3px] px-1 text-[9px] tracking-[0.08em]',
        toneWash[t],
        '[&_svg]:size-3',
        className,
      )}
      {...rest}
    >
      {dot && <span aria-hidden="true" className={cn('size-1.5 rounded-full', toneBg[t])} />}
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Neutral metadata chip (model ids, backends, paths) — not a status. */
export function Chip({ className, children, mono = true, ...rest }: HTMLAttributes<HTMLSpanElement> & { mono?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full shrink-0 items-center gap-1 truncate rounded-[5px] border border-line bg-sunken px-1.5 py-px text-[11px] text-ink-2',
        mono && 'font-mono',
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  variant?: string;
  /** Pulsing ring for live / in-progress state. */
  live?: boolean;
  size?: 'sm' | 'md';
}

/** Decorative dot. Always pair it with a text label nearby. */
export function StatusDot({ tone, variant, live, size = 'sm', className, ...rest }: StatusDotProps) {
  const t = tone ?? toneOf(variant);
  const s = size === 'sm' ? 'size-[7px]' : 'size-[9px]';
  return (
    <span aria-hidden="true" className={cn('relative inline-flex shrink-0', s, className)} {...rest}>
      {live && <span className={cn('absolute inset-0 rounded-full animate-[d-ping_1.8s_ease-out_infinite]', toneBg[t])} />}
      <span className={cn('relative inline-flex rounded-full', s, toneBg[t])} />
    </span>
  );
}

/** Coloured text without any chrome — for inline outcome words. */
export function ToneText({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cn(toneText[tone], className)} {...rest} />;
}
