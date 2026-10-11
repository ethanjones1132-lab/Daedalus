import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Moon, Search, Sun } from 'lucide-react';
import { cn, ErrorBoundary, IconButton, Kbd, Spinner } from '../design';
import { useTheme } from '../hooks/useTheme';
import { useNavigation } from './navigation';
import { ROUTES, routeById, type RouteId } from './routes';
import { Rail } from './Rail';
import CommandPalette, { type PaletteItem } from './CommandPalette';
import HealthBanner from '../features/system/HealthBanner';
import SystemStatusBar from '../features/system/SystemStatusBar';
import BuildBadge from '../features/system/BuildBadge';
import { useAppSignals } from './useAppSignals';

const RAIL_KEY = 'jarvis-rail-collapsed';

function readCollapsed() {
  try {
    return localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The application frame:
 *
 *   ┌──────┬──────────────────────────────────────────┐
 *   │      │ titlebar · breadcrumb · ⌘K · build · theme│
 *   │ rail ├──────────────────────────────────────────┤
 *   │      │ health banner (self-hiding)              │
 *   │      │ page                                     │
 *   │      ├──────────────────────────────────────────┤
 *   │      │ status strip (system telemetry)          │
 *   └──────┴──────────────────────────────────────────┘
 */
export function Shell() {
  const { route, navigate } = useNavigation();
  const { theme, toggle } = useTheme();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useAppSignals();

  const current = routeById(route);
  const Page = current.component;

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(RAIL_KEY, c ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !c;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        // The Sessions composer owns ⌘K ("new session") while it has focus.
        const target = e.target as HTMLElement | null;
        if (target?.closest?.('[data-owns-mod-k]')) return;
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCollapsed]);

  const paletteItems = useMemo<PaletteItem[]>(
    () =>
      ROUTES.map((r) => ({
        id: r.id,
        label: r.label,
        Icon: r.icon,
        description: r.description,
        group: r.group,
        keywords: r.keywords,
      })),
    [],
  );

  return (
    <div className="flex h-full w-full overflow-hidden bg-canvas text-ink">
      <Rail route={route} onNavigate={navigate} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-4 border-b border-line bg-canvas/80 px-4" data-tauri-drag-region>
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[12.5px]">
            <span className="d-label text-[10px] text-ink-4">{current.group}</span>
            <span aria-hidden="true" className="text-ink-4">
              /
            </span>
            <h1 className="truncate font-medium text-ink">{current.label}</h1>
          </nav>

          <button
            type="button"
            aria-label="Open command palette"
            onClick={() => setPaletteOpen(true)}
            className="mx-auto flex h-7 w-full max-w-[340px] items-center gap-2 rounded-md border border-line bg-sunken px-2.5 text-[12px] text-ink-4 transition-colors hover:border-line-strong hover:text-ink-3"
          >
            <Search aria-hidden="true" className="size-3.5" />
            <span className="flex-1 text-left">Jump to…</span>
            <Kbd>⌘K</Kbd>
          </button>

          <div className="flex shrink-0 items-center gap-1.5">
            <BuildBadge />
            <IconButton
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={toggle}
            >
              {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
            </IconButton>
          </div>
        </header>

        <HealthBanner />

        <main
          aria-label="Application workspace"
          className={cn('relative min-h-0 flex-1 overflow-hidden', route !== 'sessions' && 'd-drafting')}
        >
          <div data-testid="main-surface-viewport" className="h-full min-h-0">
            <ErrorBoundary key={route} label={current.label}>
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <Spinner size={18} />
                  </div>
                }
              >
                <Page />
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>

        <footer className="flex h-7 shrink-0 items-center border-t border-line bg-sunken px-3">
          <SystemStatusBar />
        </footer>
      </div>

      <CommandPalette
        open={paletteOpen}
        items={paletteItems}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(id) => navigate(id as RouteId)}
      />
    </div>
  );
}
