// ── useTheme — dark/light theme with durable persistence ──
//
// The Mythos palette in index.css defines a full [data-theme="light"] override,
// but nothing activated it. This hook flips `data-theme` on <html> and persists
// the choice to both localStorage (instant, flash-free boot) and the native
// `set_setting` command (durable across machines / DB-backed).

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'jarvis-theme';
const SETTING_KEY = 'theme';

function applyTheme(theme: Theme) {
  const el = document.documentElement;
  // Dark is the default `:root` palette; light is an explicit override.
  if (theme === 'light') el.setAttribute('data-theme', 'light');
  else el.removeAttribute('data-theme');
}

function readLocal(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* ignore */
  }
  return 'dark';
}

function persist(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
  invoke('set_setting', { key: SETTING_KEY, value: theme }).catch(() => {
    /* best-effort; localStorage already holds the choice */
  });
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const t = readLocal();
    applyTheme(t);
    return t;
  });

  // Reconcile once with the durable backend setting (authoritative if present).
  useEffect(() => {
    let cancelled = false;
    invoke<string | null>('get_setting', { key: SETTING_KEY })
      .then((v) => {
        if (cancelled || (v !== 'light' && v !== 'dark')) return;
        setThemeState(v);
        applyTheme(v);
      })
      .catch(() => {
        /* native layer unavailable — keep the localStorage choice */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
    persist(next);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      persist(next);
      return next;
    });
  }, []);

  return { theme, setTheme, toggle };
}
