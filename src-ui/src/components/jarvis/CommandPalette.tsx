// ═══════════════════════════════════════════════════════════════
// ── CommandPalette — Cmd/Ctrl+K fuzzy view switcher
// ═══════════════════════════════════════════════════════════════
//
// The sidebar has ~20 nav targets with no keyboard navigation. This palette
// fuzzy-searches them and navigates on select. Opens on Cmd/Ctrl+K (wired in
// App), closes on Esc/backdrop; Arrow keys move selection, Enter chooses.

import { useEffect, useMemo, useRef, useState } from 'react';
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
  const results = useMemo(() => filterNavItems(items, query), [items, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSel(0);
      // Focus after paint so the input is ready for typing.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    setSel(0);
  }, [query]);

  if (!open) return null;

  const choose = (id?: ViewId) => {
    const target = id ?? results[sel]?.id;
    if (target) {
      onNavigate(target);
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => (results.length ? Math.min(s + 1, results.length - 1) : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
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
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Jump to view…"
          aria-label="Search views"
          className="w-full bg-transparent px-4 py-3 text-sm text-bone placeholder:text-bone/30 outline-none border-b border-white/5"
        />
        <ul className="max-h-72 overflow-y-auto py-1" role="listbox" aria-label="Views">
          {results.length === 0 ? (
            <li className="px-4 py-3 text-xs text-bone/40">No matching views</li>
          ) : (
            results.map((it, i) => (
              <li
                key={it.id}
                role="option"
                aria-selected={i === sel}
                onMouseEnter={() => setSel(i)}
                onClick={() => choose(it.id)}
                className={`flex items-center gap-3 px-4 py-2 cursor-pointer text-sm ${
                  i === sel ? 'bg-white/10 text-bone' : 'text-bone/70'
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
