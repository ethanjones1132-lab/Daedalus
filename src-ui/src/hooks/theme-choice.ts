// ═══════════════════════════════════════════════════════════════
// ── theme-choice — did the theme choice actually get stored? ──
//
// The shell's theme toggle writes the operator's choice to two places with two
// different durability claims: `localStorage`, in a `try`/`catch` that ignored
// the failure, and the native `set_setting` command, in a `.catch` whose comment
// called it best-effort. Neither claim was visible anywhere, so an operator who
// flipped the toggle could not learn that the choice was not stored — and the
// next launch's reconcile applied the durable value silently over the local one.
//
// This module is the whole of that claim, in the shape
// `registry-alert-channel.ts` established: an attempt-fenced reducer over the
// two reads, and a projection into fixed copy that no caught value can reach.
//
// Three facts about a write are kept apart on purpose, because collapsing them
// is the bug this replaces:
//
// - `attempted` — the command was issued. Nothing is known yet.
// - `settled`   — it came back, one way or the other.
// - `confirmed` — it came back saying the row is committed.
//
// And a read is three more, because "the store holds no preference" and "the
// store could not be asked" are different facts that used to look identical:
//
// - `pending`   — the read has not come back; it makes no claim.
// - `confirmed` — the read came back, with or without a stored value.
// - `failed`    — the read could not be made; the durable state is unknown.
// ═══════════════════════════════════════════════════════════════

export type Theme = 'dark' | 'light';

export type ThemeReadStatus = 'pending' | 'confirmed' | 'failed';
export type ThemeWriteStatus = 'idle' | 'attempted' | 'confirmed' | 'failed';
/** Whether the browser profile kept its own copy, which is a separate fact from
 *  the settings store: a full or blocked profile fails while the store is fine. */
export type ThemeLocalStatus = 'kept' | 'failed';
export type ThemeChoiceStatus = 'quiet' | 'saving' | 'not-stored' | 'stored-unknown';

export const THEME_SAVING_COPY = 'Saving theme choice…';
export const THEME_NOT_STORED_COPY =
  'Daedalus could not store this theme in its own settings, so it is only kept by this browser profile.';
export const THEME_NOT_KEPT_COPY =
  'Daedalus could not store this theme anywhere. It may not be there next time you open the app.';
export const THEME_STORED_UNKNOWN_COPY =
  'Daedalus could not read its stored theme, so the choice shown here may not be the one you saved.';

export interface ThemeReadState {
  attempt: number;
  status: ThemeReadStatus;
  /** The value the store was confirmed to hold, or null when it holds none. */
  stored: Theme | null;
}

export interface ThemeWriteState {
  attempt: number;
  status: ThemeWriteStatus;
  theme: Theme | null;
  local: ThemeLocalStatus;
}

export interface ThemeChoiceState {
  /** Highest attempt issued in either direction, so a settlement can be matched
   *  against the operation that is still current. */
  attempt: number;
  theme: Theme;
  read: ThemeReadState;
  write: ThemeWriteState;
}

export type ThemeChoiceEvent =
  | { type: 'sync-theme'; theme: Theme }
  | { type: 'read-start'; attempt: number }
  | { type: 'read-confirmed'; attempt: number; stored: string | null }
  | { type: 'read-failed'; attempt: number }
  | { type: 'write-start'; attempt: number; theme: Theme; local: ThemeLocalStatus }
  | { type: 'write-confirmed'; attempt: number }
  | { type: 'write-failed'; attempt: number };

export interface ThemeChoiceView {
  status: ThemeChoiceStatus;
  /** One fixed sentence, or null when there is nothing to say. */
  message: string | null;
  theme: Theme;
  /** The value the settings store is known to hold, or null when nothing has
   *  confirmed one. Never inferred from the choice on screen. */
  durable: Theme | null;
  readStatus: ThemeReadStatus;
  writeStatus: ThemeWriteStatus;
  attempted: boolean;
  settled: boolean;
  confirmed: boolean;
}

export function initialThemeChoice(local: Theme): ThemeChoiceState {
  return {
    attempt: 0,
    theme: local,
    read: { attempt: 0, status: 'pending', stored: null },
    write: { attempt: 0, status: 'idle', theme: null, local: 'kept' },
  };
}

function asTheme(value: string | null): Theme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

export function reduceThemeChoice(
  state: ThemeChoiceState,
  event: ThemeChoiceEvent,
): ThemeChoiceState {
  if (event.type === 'sync-theme') return event.theme === state.theme ? state : { ...state, theme: event.theme };
  const attempt = Math.max(state.attempt, event.attempt);

  switch (event.type) {
    case 'read-start':
      // A new read re-arms the read direction only. Write facts survive it: a
      // re-read must never un-confirm a write the operator already made.
      if (event.attempt < state.read.attempt) return state;
      return {
        ...state,
        attempt,
        read: { attempt: event.attempt, status: 'pending', stored: state.read.stored },
      };

    case 'read-confirmed':
    case 'read-failed': {
      if (event.attempt !== state.read.attempt) return state;
      // A read describes what the store held before this session's writes. Once
      // the operator has written, it is evidence about a superseded state, so it
      // is dropped rather than allowed to move the choice they just made.
      if (state.write.attempt > event.attempt) return state;
      if (event.type === 'read-failed') {
        return {
          ...state,
          attempt,
          read: { attempt: event.attempt, status: 'failed', stored: state.read.stored },
        };
      }
      const stored = asTheme(event.stored);
      return {
        ...state,
        attempt,
        read: { attempt: event.attempt, status: 'confirmed', stored },
        // The durable setting is authoritative on mount, so a stored value the
        // local choice disagrees with is applied. A store that holds no
        // preference is not a store that says "dark".
        theme: stored ?? state.theme,
      };
    }

    case 'write-start':
      if (event.attempt <= state.write.attempt) return state;
      return {
        ...state,
        attempt,
        theme: event.theme,
        write: {
          attempt: event.attempt,
          status: 'attempted',
          theme: event.theme,
          local: event.local,
        },
      };

    case 'write-confirmed':
    case 'write-failed':
      // A settlement from a write a newer toggle has replaced is not news about
      // the choice the operator ended on: neither a confirmation nor an alarm.
      if (event.attempt !== state.write.attempt) return state;
      return {
        ...state,
        attempt,
        write: {
          ...state.write,
          status: event.type === 'write-confirmed' ? 'confirmed' : 'failed',
        },
      };
  }
}

export function projectThemeChoice(state: ThemeChoiceState): ThemeChoiceView {
  const attempted = state.write.status !== 'idle';
  const settled = state.write.status === 'confirmed' || state.write.status === 'failed';
  const confirmed = state.write.status === 'confirmed';

  // The value the store is known to hold: a confirmed write supersedes the
  // mount read, and a failed one leaves whatever the read confirmed there.
  const durable = confirmed
    ? state.write.theme
    : state.read.status === 'confirmed'
      ? state.read.stored
      : null;

  // Precedence, most recent fact about the operator's own choice first: a write
  // that did not land, then a read that could not be made, then a write in
  // flight, then nothing to say.
  let status: ThemeChoiceStatus = 'quiet';
  let message: string | null = null;
  if (state.write.status === 'failed') {
    status = 'not-stored';
    message = state.write.local === 'kept' ? THEME_NOT_STORED_COPY : THEME_NOT_KEPT_COPY;
  } else if (state.read.status === 'failed') {
    status = 'stored-unknown';
    message = THEME_STORED_UNKNOWN_COPY;
  } else if (state.write.status === 'attempted') {
    status = 'saving';
    message = THEME_SAVING_COPY;
  }

  return {
    status,
    message,
    theme: state.theme,
    durable,
    readStatus: state.read.status,
    writeStatus: state.write.status,
    attempted,
    settled,
    confirmed,
  };
}
