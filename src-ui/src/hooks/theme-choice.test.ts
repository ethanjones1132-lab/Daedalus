// Does the theme choice actually get stored?
//
// `useTheme` wrote the choice to two places with two different durability claims:
// `localStorage` in a `try`/`catch` that ignored the failure, then
// `invoke('set_setting', …).catch(() => { /* best-effort */ })`. Both claims
// were unverifiable from the surface: the hook returned only `{ theme, setTheme,
// toggle }`, so an operator who flipped the toggle had no way to learn that the
// choice was not stored and would silently find it reverted on the next launch.
//
// This module is the whole of that claim, in the shape
// `registry-alert-channel.ts` established: an attempt-fenced reducer over the two
// reads, and a projection into fixed copy that no caught value can reach.
//
// Attempt numbering mirrors the hook exactly — the mount reconcile takes 1, so
// the first toggle takes 2 and any settlement that arrives after a newer toggle
// can be told apart from the newest one.

import { describe, expect, it } from 'vitest';
import {
  initialThemeChoice,
  projectThemeChoice,
  reduceThemeChoice,
  THEME_NOT_KEPT_COPY,
  THEME_NOT_STORED_COPY,
  THEME_SAVING_COPY,
  THEME_STORED_UNKNOWN_COPY,
  type ThemeChoiceEvent,
  type ThemeChoiceState,
} from './theme-choice';
const settle = (state: ThemeChoiceState, ...events: ThemeChoiceEvent[]): ThemeChoiceState =>
  events.reduce(reduceThemeChoice, state);

// The mount reconcile: attempt 1 starts, then answers.
const read = (state: ThemeChoiceState, stored: string | null): ThemeChoiceState =>
  settle(state, { type: 'read-start', attempt: 1 }, { type: 'read-confirmed', attempt: 1, stored });

// The first toggle after mount: attempt 2.
const write = (
  state: ThemeChoiceState,
  theme: 'dark' | 'light',
  local: 'kept' | 'failed' = 'kept',
): ThemeChoiceState =>
  settle(state, { type: 'write-start', attempt: 2, theme, local });

describe('a theme choice that has not been read from or written to', () => {
  it('names every state in one fixed sentence, with the reason withheld', () => {
    // The copy is the contract the operator reads, so it is written out here
    // rather than only compared against the constants above: changing a sentence
    // is then a deliberate edit in one place instead of a silent follow.
    expect(THEME_SAVING_COPY).toBe('Saving theme choice…');
    expect(THEME_NOT_STORED_COPY).toBe(
      'Daedalus could not store this theme in its own settings, so it is only kept by this browser profile.',
    );
    expect(THEME_NOT_KEPT_COPY).toBe(
      'Daedalus could not store this theme anywhere. It may not be there next time you open the app.',
    );
    expect(THEME_STORED_UNKNOWN_COPY).toBe(
      'Daedalus could not read its stored theme, so the choice shown here may not be the one you saved.',
    );
  });

  it('presents the local choice and claims nothing about storage', () => {
    const state = initialThemeChoice('light');

    expect(state.theme).toBe('light');
    expect(state.read.status).toBe('pending');
    expect(state.write.status).toBe('idle');

    const view = projectThemeChoice(state);
    expect(view.status).toBe('quiet');
    expect(view.message).toBeNull();
    expect(view.durable).toBeNull();
    expect(view.attempted).toBe(false);
    expect(view.settled).toBe(false);
    expect(view.confirmed).toBe(false);
  });

  it('claims nothing while the durable read is still in flight', () => {
    const view = projectThemeChoice(settle(initialThemeChoice('dark'), { type: 'read-start', attempt: 1 }));

    expect(view.readStatus).toBe('pending');
    expect(view.status).toBe('quiet');
    expect(view.message).toBeNull();
  });
});

describe('the durable read', () => {
  it('is authoritative over a local choice it disagrees with', () => {
    const state = read(initialThemeChoice('light'), 'dark');

    expect(state.theme).toBe('dark');
    const view = projectThemeChoice(state);
    expect(view.readStatus).toBe('confirmed');
    expect(view.durable).toBe('dark');
    expect(view.status).toBe('quiet');
  });

  it('records a store that holds no preference as confirmed, not as failed', () => {
    const view = projectThemeChoice(read(initialThemeChoice('light'), null));

    expect(view.readStatus).toBe('confirmed');
    // The distinction the row exists on: "there is no stored preference" and
    // "the read could not be made" are different facts, and only one of them
    // has to be announced.
    expect(view.theme).toBe('light');
    expect(view.durable).toBeNull();
    expect(view.status).toBe('quiet');
    expect(view.message).toBeNull();
  });

  it('reads a stored value that is not a theme as no preference', () => {
    const view = projectThemeChoice(read(initialThemeChoice('light'), 'chartreuse'));

    expect(view.readStatus).toBe('confirmed');
    expect(view.durable).toBeNull();
    expect(view.theme).toBe('light');
  });

  it('announces a read that could not be made, in one fixed sentence', () => {
    const view = projectThemeChoice(
      settle(initialThemeChoice('light'), { type: 'read-start', attempt: 1 }, { type: 'read-failed', attempt: 1 }),
    );

    expect(view.readStatus).toBe('failed');
    expect(view.status).toBe('stored-unknown');
    expect(view.message).toBe(THEME_STORED_UNKNOWN_COPY);
    // The local choice is still what the operator sees; only the durable
    // authority is missing, and the sentence says exactly that.
    expect(view.theme).toBe('light');
    expect(view.durable).toBeNull();
  });

  it('ignores a read that answers after the operator has already written', () => {
    const state = settle(
      initialThemeChoice('dark'),
      { type: 'read-start', attempt: 1 },
      { type: 'write-start', attempt: 2, theme: 'light', local: 'kept' },
      { type: 'read-confirmed', attempt: 1, stored: 'dark' },
    );

    // The read describes a state the operator has since superseded.
    expect(state.theme).toBe('light');
    expect(state.read.status).toBe('pending');
  });

  it('ignores a torn-down read attempt', () => {
    const state = settle(
      initialThemeChoice('dark'),
      { type: 'read-start', attempt: 1 },
      { type: 'read-start', attempt: 2 },
      { type: 'read-confirmed', attempt: 1, stored: 'light' },
    );

    expect(state.theme).toBe('dark');
    expect(state.read.status).toBe('pending');
  });

  it('does not forget a confirmed write when a new read is armed', () => {
    const state = settle(
      write(initialThemeChoice('dark'), 'light'),
      { type: 'write-confirmed', attempt: 2 },
      { type: 'read-start', attempt: 3 },
    );

    expect(state.write.status).toBe('confirmed');
    expect(projectThemeChoice(state).durable).toBe('light');
  });
});

describe('the durable write', () => {
  it('keeps attempted, settled and confirmed as three separate facts', () => {
    const idle = projectThemeChoice(initialThemeChoice('dark'));
    expect([idle.attempted, idle.settled, idle.confirmed]).toEqual([false, false, false]);

    const inFlight = projectThemeChoice(write(initialThemeChoice('dark'), 'light'));
    expect([inFlight.attempted, inFlight.settled, inFlight.confirmed]).toEqual([true, false, false]);

    const confirmed = projectThemeChoice(settle(write(initialThemeChoice('dark'), 'light'), { type: 'write-confirmed', attempt: 2 }));
    expect([confirmed.attempted, confirmed.settled, confirmed.confirmed]).toEqual([true, true, true]);

    // A newer write re-arms the claim: the newest one has not settled, so the
    // hook must not keep reading as saved on the strength of the older one.
    const reArmed = projectThemeChoice(
      settle(
        settle(write(initialThemeChoice('dark'), 'light'), { type: 'write-confirmed', attempt: 2 }),
        { type: 'write-start', attempt: 3, theme: 'dark', local: 'kept' },
      ),
    );
    expect([reArmed.attempted, reArmed.settled, reArmed.confirmed]).toEqual([true, false, false]);
    expect(reArmed.status).toBe('saving');
  });

  it('announces an in-flight write without claiming it was stored', () => {
    const view = projectThemeChoice(write(initialThemeChoice('dark'), 'light'));

    expect(view.status).toBe('saving');
    expect(view.message).toBe(THEME_SAVING_COPY);
    expect(view.confirmed).toBe(false);
    expect(view.theme).toBe('light');
  });

  it('applies the choice immediately, before the store has answered', () => {
    const state = write(initialThemeChoice('dark'), 'light');

    expect(state.theme).toBe('light');
    expect(state.write.theme).toBe('light');
    expect(state.write.local).toBe('kept');
  });

  it('reports nothing alarming once the store has confirmed the value', () => {
    const view = projectThemeChoice(
      settle(write(initialThemeChoice('dark'), 'light'), { type: 'write-confirmed', attempt: 2 }),
    );

    expect(view.status).toBe('quiet');
    expect(view.message).toBeNull();
    expect(view.confirmed).toBe(true);
    // The confirmed half: the store is now known to hold the choice, so it is
    // the durable value rather than the local one.
    expect(view.durable).toBe('light');
    expect(view.theme).toBe('light');
  });

  it('announces a rejected write in one fixed sentence and does not read as saved', () => {
    const view = projectThemeChoice(
      settle(write(initialThemeChoice('dark'), 'light'), { type: 'write-failed', attempt: 2 }),
    );

    expect(view.status).toBe('not-stored');
    expect(view.message).toBe(THEME_NOT_STORED_COPY);
    expect(view.confirmed).toBe(false);
    expect(view.settled).toBe(true);
    // The choice is still applied in this window — the sentence is about storage,
    // not about the toggle having failed.
    expect(view.theme).toBe('light');
  });

  it('says the stronger sentence when the local copy did not land either', () => {
    const view = projectThemeChoice(
      settle(write(initialThemeChoice('dark'), 'light', 'failed'), { type: 'write-failed', attempt: 2 }),
    );

    expect(view.message).toBe(THEME_NOT_KEPT_COPY);
    // The two sentences must not be interchangeable: the first claims the
    // browser profile kept the choice, which a failed local write makes false.
    expect(view.message).not.toBe(THEME_NOT_STORED_COPY);
  });

  it('ignores a settlement from a write a newer toggle has replaced', () => {
    const afterStaleConfirm = settle(
      write(initialThemeChoice('dark'), 'light'),
      { type: 'write-start', attempt: 3, theme: 'dark', local: 'kept' },
      { type: 'write-confirmed', attempt: 2 },
    );

    expect(afterStaleConfirm.write.status).toBe('attempted');
    expect(projectThemeChoice(afterStaleConfirm).confirmed).toBe(false);

    const afterStaleFailure = settle(
      write(initialThemeChoice('dark'), 'light'),
      { type: 'write-start', attempt: 3, theme: 'dark', local: 'kept' },
      { type: 'write-failed', attempt: 2 },
    );

    // The older rejection is not news about the newer choice: nothing alarming,
    // and the newer write is still in flight.
    expect(afterStaleFailure.write.status).toBe('attempted');
    expect(projectThemeChoice(afterStaleFailure).status).toBe('saving');
  });

  it('ignores a duplicated write attempt', () => {
    const once = write(initialThemeChoice('dark'), 'light');
    const twice = settle(once, { type: 'write-start', attempt: 2, theme: 'light', local: 'kept' });

    expect(twice.write).toEqual(once.write);
  });

  it('keeps the confirmed read as the durable value when a later write does not land', () => {
    const view = projectThemeChoice(
      settle(
        settle(read(initialThemeChoice('dark'), 'light'), { type: 'write-start', attempt: 2, theme: 'dark', local: 'kept' }),
        { type: 'write-failed', attempt: 2 },
      ),
    );

    // The store still holds the read's value; the failed write changed nothing
    // there, so reporting `dark` as durable would be a claim nobody confirmed.
    expect(view.durable).toBe('light');
    expect(view.theme).toBe('dark');
    expect(view.status).toBe('not-stored');
  });

  it('reports the newest write as the durable value once it is confirmed', () => {
    const view = projectThemeChoice(
      settle(
        settle(read(initialThemeChoice('dark'), 'light'), { type: 'write-start', attempt: 2, theme: 'dark', local: 'kept' }),
        { type: 'write-confirmed', attempt: 2 },
      ),
    );

    expect(view.durable).toBe('dark');
    expect(view.status).toBe('quiet');
  });
});

describe('what the toggle shows when both reads have failed', () => {
  it('leads with the write the operator just made', () => {
    const view = projectThemeChoice(
      settle(
        settle(initialThemeChoice('dark'), { type: 'read-start', attempt: 1 }, { type: 'read-failed', attempt: 1 }),
        { type: 'write-start', attempt: 2, theme: 'light', local: 'kept' },
        { type: 'write-failed', attempt: 2 },
      ),
    );

    expect(view.readStatus).toBe('failed');
    expect(view.writeStatus).toBe('failed');
    expect(view.status).toBe('not-stored');
    expect(view.message).toBe(THEME_NOT_STORED_COPY);
  });

  it('leads with the unreadable stored choice when no write has failed', () => {
    const view = projectThemeChoice(
      settle(
        settle(initialThemeChoice('dark'), { type: 'read-start', attempt: 1 }, { type: 'read-failed', attempt: 1 }),
        { type: 'write-start', attempt: 2, theme: 'light', local: 'kept' },
        { type: 'write-confirmed', attempt: 2 },
      ),
    );

    // A confirmed write makes the durable value known again, but it does not
    // make the *read* have happened; that is still a fact the operator lacks.
    expect(view.durable).toBe('light');
    expect(view.status).toBe('stored-unknown');
    expect(view.message).toBe(THEME_STORED_UNKNOWN_COPY);
  });
});
