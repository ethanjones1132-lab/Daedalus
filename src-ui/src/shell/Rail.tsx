import { motion } from 'framer-motion';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn, IconButton, Mark } from '../design';
import { GROUP_ORDER, ROUTES, type RouteId } from './routes';
import CompanionDock from '../features/companion/CompanionDock';

export interface RailProps {
  route: RouteId;
  onNavigate: (id: RouteId) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/**
 * The navigation rail. Expanded it reads like the index of a bound folio;
 * collapsed it is a column of instrument glyphs with hover labels.
 */
export function Rail({ route, onNavigate, collapsed, onToggleCollapsed }: RailProps) {
  return (
    <aside
      aria-label="Primary"
      className={cn(
        'relative flex h-full shrink-0 flex-col border-r border-line bg-sunken transition-[width] duration-300 ease-[var(--ease-out-quint)]',
        collapsed ? 'w-[60px]' : 'w-[232px]',
      )}
    >
      {/* Masthead */}
      <div className={cn('flex h-[52px] shrink-0 items-center gap-2.5', collapsed ? 'justify-center px-0' : 'px-4')} data-tauri-drag-region>
        <Mark size={22} />
        {!collapsed && (
          <div className="flex min-w-0 flex-col leading-none">
            <span className="d-display text-[22px] text-ink">Jarvis</span>
            <span className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-ink-4">home-base</span>
          </div>
        )}
      </div>

      <nav aria-label="Surfaces" className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 pb-3">
        {GROUP_ORDER.map((group, gi) => {
          const items = ROUTES.filter((r) => r.group === group);
          return (
            <div key={group} className={cn(gi > 0 && 'mt-3.5')}>
              {collapsed ? (
                gi > 0 && <div aria-hidden="true" className="mx-2 mb-3 h-px bg-line" />
              ) : (
                <div className="d-label mb-1 px-2 text-[9.5px] text-ink-4">{group}</div>
              )}
              <ul className="flex flex-col gap-px">
                {items.map((item) => {
                  const active = item.id === route;
                  const Icon = item.icon;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => onNavigate(item.id)}
                        aria-current={active ? 'page' : undefined}
                        aria-label={collapsed ? item.label : undefined}
                        title={collapsed ? item.label : undefined}
                        className={cn(
                          'group relative flex h-[30px] w-full items-center gap-2.5 rounded-md text-[13px] transition-colors duration-150',
                          collapsed ? 'justify-center' : 'px-2',
                          active ? 'bg-raised text-ink shadow-card' : 'text-ink-3 hover:bg-hover hover:text-ink-2',
                          item.legacy && !active && 'opacity-60',
                        )}
                      >
                        {active && (
                          <motion.span
                            layoutId="rail-active"
                            aria-hidden="true"
                            className="absolute -left-2.5 top-[7px] bottom-[7px] w-[2px] rounded-r bg-accent shadow-[0_0_10px_var(--d-accent)]"
                            transition={{ type: 'spring', stiffness: 520, damping: 42 }}
                          />
                        )}
                        <Icon
                          aria-hidden="true"
                          strokeWidth={1.7}
                          className={cn('size-[16px] shrink-0 transition-colors', active ? 'text-accent' : 'text-ink-4 group-hover:text-ink-3')}
                        />
                        {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>}
                        {!collapsed && item.legacy && <span className="font-mono text-[9px] uppercase tracking-wider text-ink-4">legacy</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className={cn('flex shrink-0 items-center gap-2 border-t border-line', collapsed ? 'flex-col px-2 py-2' : 'px-3 py-2')}>
        <div className="min-w-0 flex-1">
          <CompanionDock collapsed={collapsed} />
        </div>
        <IconButton
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand navigation (Ctrl+\\)' : 'Collapse navigation (Ctrl+\\)'}
          onClick={onToggleCollapsed}
          size="xs"
        >
          {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
        </IconButton>
      </div>
    </aside>
  );
}
