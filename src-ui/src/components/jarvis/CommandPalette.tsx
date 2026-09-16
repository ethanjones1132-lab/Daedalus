// ═══════════════════════════════════════════════════════════════
// ── CommandPalette — Cmd/Ctrl+K fuzzy view switcher
// ═══════════════════════════════════════════════════════════════
//
// The sidebar has ~20 nav targets with no keyboard navigation. This palette
// fuzzy-searches them and navigates on select. Opens on Cmd/Ctrl+K (wired in
// App), closes on Esc/backdrop; Arrow keys move selection, Enter chooses.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { NavItem, ViewId } from '../../types';

/// Subsequence fuzzy match over label and id. Pure + exported for testing.
export function filterNavItems(items: NavItem[], query: string): NavItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const matches = (raw: string): boolean => {
    const s = raw.toLowerCase();
    let i = 0;
    for (const ch of q) {
      i = s.indexOf(ch, i);
      if (i === -1) return false;
      i += 1;
    }
    return true;
  };
  return items.filter((it) => matches(it.label) || matches(it.id));
}

interface Props {
  open: boolean;
  items: NavItem[];
  onClose: () => void;
  onNavigate: (id: ViewId) => void;
}

export default function CommandPalette({ open, items, onClose, onNavigate }: Props) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeOptionRef = useRef<HTMLLIElement>(null);
  const listId = useId();
  const results = useMemo(() => filterNavItems(items, query), [items, query]);
  const selectedIndex = Math.min(sel, Math.max(results.length - 1, 0));
  const selectedId = results[selectedIndex]?.id;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    setQuery('');
    setSel(0);
    // The combobox is the only tab stop; options use active-descendant focus.
    const containFocus = (e: FocusEvent) => {
      if (e.target !== inputRef.current) inputRef.current?.focus();
    };
    document.addEventListener('focusin', containFocus);
    inputRef.current?.focus();
    return () => {
      document.removeEventListener('focusin', containFocus);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      // Navigation can remove or disable the invoking control.
      if (document.activeElement !== opener || !opener?.isConnected) {
        const tabIndex = document.body.getAttribute('tabindex');
        document.body.setAttribute('tabindex', '-1');
        document.body.focus();
        if (tabIndex === null) document.body.removeAttribute('tabindex');
        else document.body.setAttribute('tabindex', tabIndex);
      }
    };
  }, [open]);

  useEffect(() => {
    if (open) activeOptionRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open, selectedId]);

  if (!open) return null;

  const choose = (id?: ViewId) => {
    const target = id ?? selectedId;
    if (target) {
      onNavigate(target);
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      inputRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(results.length ? Math.min(selectedIndex + 1, results.length - 1) : 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(selectedIndex - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className="w-full max-w-lg mx-4 rounded-xl border border-white/10 bg-[#0d0f14] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSel(0); }}
          placeholder="Jump to view…"
          aria-label="Search views"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={selectedId ? `${listId}-${selectedId}` : undefined}
          className="w-full bg-transparent px-4 py-3 text-sm text-bone placeholder:text-bone/30 outline-none border-b border-white/5"
        />
        <ul id={listId} className="max-h-72 overflow-y-auto py-1" role="listbox" aria-label="Views">
          {results.length === 0 ? (
            <li className="px-4 py-3 text-xs text-bone/40">No matching views</li>
          ) : (
            results.map((it, i) => (
              <li
                key={it.id}
                id={`${listId}-${it.id}`}
                ref={i === selectedIndex ? activeOptionRef : undefined}
                role="option"
                aria-selected={i === selectedIndex}
                onMouseEnter={() => setSel(i)}
                onClick={() => choose(it.id)}
                className={`flex items-center gap-3 px-4 py-2 cursor-pointer text-sm ${
                  i === selectedIndex ? 'bg-white/10 text-bone' : 'text-bone/70'
                }`}
              >
                <span className="w-5 h-5 grid place-items-center rounded bg-white/5 text-[10px] font-mono">
                  {it.icon}
                </span>
                {it.label}
              </li>
            ))
          )}
        </ul>
        <div className="px-4 py-2 border-t border-white/5 text-[10px] font-mono text-bone/30">
          ↑↓ navigate · ↵ open · esc close
        </div>
      </div>
    </div>
  );
}
