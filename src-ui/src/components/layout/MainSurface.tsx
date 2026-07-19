import type { ReactNode } from 'react';

/**
 * Constrains feature views to the desktop viewport. Views such as Jarvis Chat
 * can then keep their controls present while their transcript owns scrolling;
 * long document-style views still overflow through this main surface.
 */
export function MainSurface({ children }: { children: ReactNode }) {
  return (
    <main
      aria-label="Application workspace"
      className="flex-1 min-h-0 overflow-y-auto p-6"
    >
      <div data-testid="main-surface-viewport" className="h-full min-h-0">
        {children}
      </div>
    </main>
  );
}
