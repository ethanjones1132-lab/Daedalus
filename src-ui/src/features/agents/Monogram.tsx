import { cn } from '../../design';

/** An Agent's avatar: its initial, in serif, inside a brass hairline tile. */
export function Monogram({
  name,
  size = 'md',
  muted,
  className,
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  muted?: boolean;
  className?: string;
}) {
  const initial = (name.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={cn(
        'd-display inline-flex shrink-0 select-none items-center justify-center border bg-sunken',
        size === 'sm' && 'size-7 rounded-[6px] text-[16px]',
        size === 'md' && 'size-9 rounded-[8px] text-[20px]',
        size === 'lg' && 'size-14 rounded-[11px] text-[32px]',
        muted ? 'border-line-strong text-ink-3' : 'border-accent-line text-accent-hot',
        className,
      )}
    >
      {initial}
    </span>
  );
}
