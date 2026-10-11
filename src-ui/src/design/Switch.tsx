import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onChange?: (next: boolean) => void;
  /** Use aria-pressed (toggle button) instead of role=switch, for legacy contracts. */
  pressed?: boolean;
  size?: 'sm' | 'md';
}

/** A brass-lit toggle. Defaults to role="switch" + aria-checked. */
export function Switch({ checked, onChange, pressed, size = 'md', className, onClick, disabled, ...rest }: SwitchProps) {
  const a11y = pressed ? { 'aria-pressed': checked } : { role: 'switch' as const, 'aria-checked': checked };
  const track = size === 'md' ? 'h-[18px] w-[32px]' : 'h-[14px] w-[25px]';
  const knob = size === 'md' ? 'size-[12px]' : 'size-[9px]';
  const shift = size === 'md' ? 'translate-x-[14px]' : 'translate-x-[11px]';
  return (
    <button
      type="button"
      disabled={disabled}
      {...a11y}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onChange?.(!checked);
      }}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full border p-[2px] transition-colors duration-200',
        'disabled:cursor-not-allowed disabled:opacity-45',
        checked ? 'border-accent-line bg-accent-wash' : 'border-line-strong bg-sunken',
        track,
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          'rounded-full transition-[transform,background-color] duration-200 ease-[var(--ease-out-quint)]',
          knob,
          checked ? cn('bg-accent shadow-[0_0_8px_var(--d-accent)]', shift) : 'bg-ink-4',
        )}
      />
    </button>
  );
}
