import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn, Kbd } from '../design';

/*
 * ⌘K palette. Contract (tested by CommandPalette*.test):
 *  - role=dialog aria-modal (the backdrop element; clicking it closes)
 *  - input is role=combobox, the only tab stop; Tab is swallowed; focus that
 *    escapes is pulled back; options use aria-activedescendant with ids
 *    `${listId}-${itemId}` that are stable through filtering and reopening
 *  - ArrowUp/Down clamp (no wrap); Enter chooses; Esc closes (propagation stopped)
 *  - choose → onNavigate(id) then onClose, each exactly once
 *  - on close, focus returns to the opener, else to <body> via a transient tabindex
 *  - callback identity changes never refocus
 */

export interface PaletteItem {
  id: string;
  label: string;
  /** Legacy single-letter glyph, or omitted when `Icon` is given. */
  icon?: string;
  Icon?: LucideIcon;
  description?: string;
  group?: string;
  keywords?: string[];
}

function isSubsequence(needle: string, hay: string) {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** Case-insensitive subsequence match on label, id, or keywords. */
export function filterNavItems<T extends Pick<PaletteItem, 'id' | 'label' | 'keywords'>>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (it) =>
      isSubsequence(q, it.label.toLowerCase()) ||
      isSubsequence(q, it.id.toLowerCase()) ||
      (it.keywords ?? []).some((k) => k.toLowerCase().startsWith(q)),
  );
}

export interface CommandPaletteProps {
  open: boolean;
  items: PaletteItem[];
  onClose: () => void;
  onNavigate: (id: string) => void;
}

export default function CommandPalette({ open, items, onClose, onNavigate }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeOptionRef = useRef<HTMLLIElement | null>(null);
  const listId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;

  const results = useMemo(() => filterNavItems(items, query), [items, query]);
  const active = results.length ? Math.min(selected, results.length - 1) : -1;
  const activeItem = active >= 0 ? results[active] : undefined;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    const opener = document.activeElement;
    const contain = (e: FocusEvent) => {
      if (e.target !== inputRef.current) inputRef.current?.focus();
    };
    document.addEventListener('focusin', contain);
    inputRef.current?.focus();
    return () => {
      document.removeEventListener('focusin', contain);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      if (document.activeElement !== opener || !(opener as HTMLElement | null)?.isConnected) {
        const prev = document.body.getAttribute('tabindex');
        document.body.setAttribute('tabindex', '-1');
        document.body.focus();
        if (prev === null) document.body.removeAttribute('tabindex');
        else document.body.setAttribute('tabindex', prev);
      }
    };
  }, [open]);

  useEffect(() => {
    if (open) activeOptionRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  if (!open) return null;

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    navigateRef.current(item.id);
    closeRef.current();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelected(Math.min(active + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelected(Math.max(active - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        choose(activeItem);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        break;
      case 'Tab':
        e.preventDefault();
        break;
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={() => closeRef.current()}
      className="fixed inset-0 z-[75] flex items-start justify-center bg-[rgba(8,6,4,0.55)] px-4 pt-[14vh] backdrop-blur-[3px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="d-rise d-ticks w-full max-w-[580px] overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-pop"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search aria-hidden="true" className="size-4 text-accent" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Search views"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeItem ? `${listId}-${activeItem.id}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Jump to a surface…"
            className="h-13 flex-1 bg-transparent text-[15px] text-ink placeholder:text-ink-4 focus:outline-none focus-visible:outline-none"
          />
          <Kbd>esc</Kbd>
        </div>
        <ul id={listId} role="listbox" aria-label="Views" className="max-h-[52vh] overflow-y-auto p-1.5">
          {results.map((item, i) => {
            const isActive = i === active;
            const Icon = item.Icon;
            return (
              <li
                key={item.id}
                id={`${listId}-${item.id}`}
                ref={isActive ? activeOptionRef : undefined}
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setSelected(i)}
                onClick={() => choose(item)}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 transition-colors duration-100',
                  isActive ? 'bg-raised' : 'hover:bg-hover',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-md border font-mono text-[11px]',
                    isActive ? 'border-accent-line bg-accent-wash text-accent-hot' : 'border-line bg-sunken text-ink-3',
                  )}
                >
                  {Icon ? <Icon className="size-3.5" /> : item.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-[13px]', isActive ? 'text-ink' : 'text-ink-2')}>{item.label}</span>
                  {item.description && <span className="block truncate text-[11.5px] text-ink-3">{item.description}</span>}
                </span>
                {item.group && <span className="d-label shrink-0 text-[9.5px] text-ink-4">{item.group}</span>}
                {isActive && <CornerDownLeft aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />}
              </li>
            );
          })}
          {results.length === 0 && <li className="px-3 py-8 text-center text-[12.5px] text-ink-3">No matching views</li>}
        </ul>
        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-ink-4">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> open
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
