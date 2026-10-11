import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';
type Size = 'xs' | 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Leading icon (a lucide element). */
  icon?: ReactNode;
  /** Trailing adornment, e.g. a <Kbd>. */
  trailing?: ReactNode;
  /** Shows a spinner in place of the icon; does NOT disable (callers decide). */
  busy?: boolean;
}

const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-ink border-transparent hover:bg-accent-hot shadow-[0_1px_0_rgba(255,255,255,0.18)_inset,0_6px_18px_-8px_var(--d-accent)] font-medium',
  secondary: 'bg-raised text-ink border-line-strong hover:bg-overlay hover:border-ink-4',
  ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-hover hover:text-ink',
  quiet: 'bg-transparent text-ink-3 border-transparent hover:text-ink px-1!',
  danger: 'bg-err-wash text-err border-err/30 hover:bg-err/20 hover:border-err/50',
};

const sizes: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11.5px] gap-1 rounded-[5px]',
  sm: 'h-7 px-2.5 text-[12.5px] gap-1.5 rounded-md',
  md: 'h-8.5 px-3.5 text-[13px] gap-2 rounded-[7px]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'sm', icon, trailing, busy, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap border select-none',
        'transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out',
        'active:translate-y-px disabled:pointer-events-none disabled:opacity-45',
        '[&_svg]:size-[1.1em] [&_svg]:shrink-0',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {busy ? <Spinner /> : icon}
      {children}
      {trailing}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon-only controls must carry an accessible name. */
  'aria-label': string;
  variant?: 'ghost' | 'secondary' | 'danger';
  size?: 'xs' | 'sm' | 'md';
  active?: boolean;
}

const iconSizes = { xs: 'size-6 rounded-[5px]', sm: 'size-7 rounded-md', md: 'size-8.5 rounded-[7px]' };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', size = 'sm', active, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center border transition-colors duration-150',
        'disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-[15px]',
        variant === 'ghost' && 'border-transparent text-ink-3 hover:bg-hover hover:text-ink',
        variant === 'secondary' && 'border-line-strong bg-raised text-ink-2 hover:text-ink hover:bg-overlay',
        variant === 'danger' && 'border-transparent text-ink-3 hover:bg-err-wash hover:text-err',
        active && 'bg-accent-wash text-accent-hot border-accent-line',
        iconSizes[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
