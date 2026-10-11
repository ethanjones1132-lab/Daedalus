import type { CSSProperties } from 'react';
import { cn } from './cn';

/**
 * The Jarvis mark: a square labyrinth spiral, Daedalus' signature. It draws
 * itself in on mount; when `live`, the core pulses (a turn is running).
 */
export function Mark({ size = 22, live, className, draw = true }: { size?: number; live?: boolean; className?: string; draw?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn('shrink-0 text-accent', className)}
    >
      <path
        d="M3.5 20.5V3.5h17v17H7.5v-13h9v9h-5v-5h1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="square"
        strokeLinejoin="miter"
        style={
          draw
            ? ({
                strokeDasharray: 120,
                ['--d-draw-length' as string]: 120,
                animation: 'd-draw 1.4s cubic-bezier(0.22,1,0.36,1) both',
              } as CSSProperties)
            : undefined
        }
      />
      <rect x="11" y="11" width="2" height="2" fill="currentColor" className={live ? 'd-pulse' : undefined} />
    </svg>
  );
}
