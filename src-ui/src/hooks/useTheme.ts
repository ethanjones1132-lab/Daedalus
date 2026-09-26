// ── useTheme — dark/light theme with durable persistence ──
//
// The Mythos palette in index.css defines a full [data-theme="light"] override,
// but nothing activated it. This hook flips `data-theme` on <html> and persists
// the choice to both localStorage (instant, flash-free boot) and the native
// `set_setting` command (durable across machines / DB-backed).
//
// What changed is the second half: the durable write used to be a `.catch` with
// a comment calling it best-effort, so a choice that was never stored looked
// exactly like one that was, and the next launch's reconcile applied the stored
// value silently over the operator's. The write is now a lifecycle with three
// separate facts — attempted, settled, confirmed — projected into fixed copy by
// `theme-choice.ts`, so the toggle can say what it knows and nothing more.

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

import {
  initialThemeChoice,
  projectThemeChoice,
  reduceThemeChoice,
  type Theme,
  type ThemeChoiceEvent,
  type ThemeChoiceState,
  type ThemeChoiceView,
  type ThemeLocalStatus,
} from './theme-choice';

export type { Theme } from './theme-choice';

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

export function useTheme(): {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggle: () => void;
  /** What is known about the two durable reads, and the one sentence the toggle
   *  owes the operator. Additive: the three original members are unchanged. */
  choice: ThemeChoiceView;
} {
  // One counter for both directions, so a settlement can be told apart from the
  // operation that is still current (see `reduceThemeChoice`).
  const attemptRef = useRef(0);
  const [state, dispatch] = useReducer<ThemeChoiceState, null, [ThemeChoiceEvent]>(
    reduceThemeChoice,
    null,
    (): ThemeChoiceState => {
      const local = readLocal();
      // Flash-free boot: the attribute is set during the first render, exactly
      // as the previous `useState` initializer did it.
      applyTheme(local);
      return initialThemeChoice(local);
    },
  );

  // The attribute follows the state, so the mount reconcile and a toggle reach
  // the DOM by the same path instead of each remembering to call `applyTheme`.
  useEffect(() => {
    applyTheme(state.theme);
  }, [state.theme]);

  // Reconcile once with the durable backend setting (authoritative if present).
  useEffect(() => {
    const attempt = (attemptRef.current += 1);
    dispatch({ type: 'read-start', attempt });
    let cancelled = false;
    invoke<string | null>('get_setting', { key: SETTING_KEY })
      .then((v) => {
        if (cancelled) return;
        dispatch({ type: 'read-confirmed', attempt, stored: v });
      })
      .catch(() => {
        // The reason is not the operator's to read, and "the store could not be
        // asked" is a different fact from "the store holds no preference" —
        // `projectThemeChoice` keeps them apart.
        if (cancelled) return;
        dispatch({ type: 'read-failed', attempt });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const store = useCallback((next: Theme) => {
    let local: ThemeLocalStatus = 'kept';
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A blocked or full profile is its own fact: it decides which sentence
      // the write can honestly make, so it is recorded rather than swallowed.
      local = 'failed';
    }
    const attempt = (attemptRef.current += 1);
    dispatch({ type: 'write-start', attempt, theme: next, local });
    invoke('set_setting', { key: SETTING_KEY, value: next })
      .then(() => dispatch({ type: 'write-confirmed', attempt }))
      .catch(() => dispatch({ type: 'write-failed', attempt }));
  }, []);

  const setTheme = useCallback(
    (next: Theme) => {
      store(next);
    },
    [store],
  );

  const toggle = useCallback(() => {
    store(state.theme === 'dark' ? 'light' : 'dark');
  }, [state.theme, store]);

  return { theme: state.theme, setTheme, toggle, choice: projectThemeChoice(state) };
}
