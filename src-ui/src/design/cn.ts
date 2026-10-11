import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The Daedalus tone scale. Every status surface picks exactly one tone, and
 * every tone is paired with words — colour is never the only signal.
 */
export type Tone = 'neutral' | 'accent' | 'ok' | 'info' | 'warn' | 'error' | 'muted';

/** Map the legacy domain `StatusVariant` vocabulary onto tones. */
export function toneOf(variant: string | undefined | null): Tone {
  switch (variant) {
    case 'success':
    case 'ok':
      return 'ok';
    case 'info':
      return 'info';
    case 'warn':
    case 'warning':
      return 'warn';
    case 'error':
    case 'danger':
      return 'error';
    case 'accent':
    case 'active':
      return 'accent';
    case 'muted':
      return 'muted';
    default:
      return 'neutral';
  }
}

export const toneText: Record<Tone, string> = {
  neutral: 'text-ink-2',
  muted: 'text-ink-3',
  accent: 'text-accent',
  ok: 'text-ok',
  info: 'text-info',
  warn: 'text-warn',
  error: 'text-err',
};

export const toneBg: Record<Tone, string> = {
  neutral: 'bg-ink-3',
  muted: 'bg-ink-4',
  accent: 'bg-accent',
  ok: 'bg-ok',
  info: 'bg-info',
  warn: 'bg-warn',
  error: 'bg-err',
};

export const toneWash: Record<Tone, string> = {
  neutral: 'bg-hover border-line-strong text-ink-2',
  muted: 'bg-transparent border-line text-ink-3',
  accent: 'bg-accent-wash border-accent-line text-accent-hot',
  ok: 'bg-ok-wash border-ok/30 text-ok',
  info: 'bg-info-wash border-info/30 text-info',
  warn: 'bg-warn-wash border-warn/30 text-warn',
  error: 'bg-err-wash border-err/30 text-err',
};
