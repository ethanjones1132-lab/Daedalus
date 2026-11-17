import { describe, expect, it } from 'vitest';
import {
  clearSubmittedSessionDraft,
  createSessionDraftStore,
  getSessionDraft,
  getSessionDraftSnapshot,
  moveSubmittedSessionDraft,
  restoreFailedSessionDraft,
  updateSessionDraft,
} from './session-draft-state';

describe('session draft ownership', () => {
  it('keeps existing Sessions and the New slot independent', () => {
    let store = createSessionDraftStore();
    store = updateSessionDraft(store, 'Alpha', 'alpha draft');
    store = updateSessionDraft(store, 'Beta', 'beta draft');
    store = updateSessionDraft(store, null, 'new draft');

    expect(getSessionDraft(store, 'Alpha')).toEqual({ text: 'alpha draft', revision: 1 });
    expect(getSessionDraft(store, 'Beta')).toEqual({ text: 'beta draft', revision: 1 });
    expect(getSessionDraft(store, null)).toEqual({ text: 'new draft', revision: 1 });
  });

  it('assigns a new revision to every edit and clears only the submitted revision', () => {
    let store = createSessionDraftStore();
    store = updateSessionDraft(store, 'Alpha', 'first');
    const submitted = getSessionDraftSnapshot(store, 'Alpha');
    store = updateSessionDraft(store, 'Alpha', 'second');

    expect(getSessionDraft(store, 'Alpha')).toEqual({ text: 'second', revision: 2 });
    expect(clearSubmittedSessionDraft(store, submitted)).toEqual({
      Alpha: { text: 'second', revision: 2 },
    });

    const current = getSessionDraftSnapshot(store, 'Alpha');
    store = clearSubmittedSessionDraft(store, current);
    expect(getSessionDraft(store, 'Alpha')).toEqual({ text: '', revision: 3, acceptedRevision: 2 });
  });

  it('preserves an identical newer draft when an older submission is accepted', () => {
    let store = createSessionDraftStore();
    store = updateSessionDraft(store, 'Alpha', 'same text');
    const submitted = getSessionDraftSnapshot(store, 'Alpha');
    store = updateSessionDraft(store, 'Alpha', 'temporary edit');
    store = updateSessionDraft(store, 'Alpha', 'same text');

    const preserved = clearSubmittedSessionDraft(store, submitted);
    expect(getSessionDraft(preserved, 'Alpha')).toEqual({ text: 'same text', revision: 3 });
  });

  it('restores a failed draft only when its Session slot has not changed', () => {
    let store = createSessionDraftStore();
    store = updateSessionDraft(store, 'Alpha', 'retry me');
    const submitted = getSessionDraftSnapshot(store, 'Alpha');
    store = updateSessionDraft(store, 'Beta', 'other Session');
    store = clearSubmittedSessionDraft(store, submitted);

    const restored = restoreFailedSessionDraft(store, submitted);
    expect(getSessionDraft(restored, 'Alpha')).toEqual({ text: 'retry me', revision: 3 });
    expect(getSessionDraft(restored, 'Beta')).toEqual({ text: 'other Session', revision: 1 });

    const stale = getSessionDraftSnapshot(restored, 'Alpha');
    store = updateSessionDraft(restored, 'Alpha', 'newer draft');
    expect(restoreFailedSessionDraft(store, stale)).toEqual(store);
  });

  it('keeps an empty New slot distinct from an existing Session with the same text', () => {
    let store = createSessionDraftStore();
    store = updateSessionDraft(store, null, 'new draft');
    store = updateSessionDraft(store, 'Alpha', 'new draft');

    expect(getSessionDraft(store, null).revision).toBe(1);
    expect(getSessionDraft(store, 'Alpha').revision).toBe(1);
    expect(getSessionDraftSnapshot(store, null).key).not.toBe(getSessionDraftSnapshot(store, 'Alpha').key);
  });

  it('moves a submitted New-chat draft onto the Session the send created', () => {
    let store = createSessionDraftStore();
    store = updateSessionDraft(store, null, 'first send');
    const submitted = getSessionDraftSnapshot(store, null);

    const moved = moveSubmittedSessionDraft(store, submitted, 'created-session');
    expect(getSessionDraft(moved.store, null)).toEqual({ text: '', revision: 0 });
    expect(getSessionDraft(moved.store, 'created-session')).toEqual({ text: 'first send', revision: 1 });
    expect(moved.submitted).toMatchObject({ key: 'created-session', sessionId: 'created-session', text: 'first send', revision: 1 });

    // The moved snapshot still clears exactly the submitted revision ...
    const cleared = clearSubmittedSessionDraft(moved.store, moved.submitted);
    expect(getSessionDraft(cleared, 'created-session')).toEqual({ text: '', revision: 2, acceptedRevision: 1 });

    // ... and still restores a failed first send into the Session slot.
    const restored = restoreFailedSessionDraft(cleared, moved.submitted);
    expect(getSessionDraft(restored, 'created-session')).toEqual({ text: 'first send', revision: 3 });
    expect(getSessionDraft(restored, null).text).toBe('');
  });

  it('never moves a New-chat draft the operator has typed since submitting', () => {
    let store = createSessionDraftStore();
    store = updateSessionDraft(store, null, 'first send');
    const submitted = getSessionDraftSnapshot(store, null);
    store = updateSessionDraft(store, null, 'first send edited');

    const moved = moveSubmittedSessionDraft(store, submitted, 'created-session');
    expect(moved.store).toBe(store);
    expect(moved.submitted).toBe(submitted);
    expect(getSessionDraft(store, 'created-session').text).toBe('');
    expect(getSessionDraft(store, null).text).toBe('first send edited');
  });

  it('leaves an already-drafted Session slot alone when re-keying', () => {
    let store = createSessionDraftStore();
    store = updateSessionDraft(store, null, 'first send');
    const submitted = getSessionDraftSnapshot(store, null);
    store = updateSessionDraft(store, 'created-session', 'typed on the Session');

    const moved = moveSubmittedSessionDraft(store, submitted, 'created-session');
    expect(moved.store).toBe(store);
    expect(getSessionDraft(moved.store, 'created-session').text).toBe('typed on the Session');
  });

  it('does not re-key a snapshot that is already bound to the target Session', () => {
    let store = createSessionDraftStore();
    store = updateSessionDraft(store, 'Alpha', 'sent from Alpha');
    const submitted = getSessionDraftSnapshot(store, 'Alpha');

    const moved = moveSubmittedSessionDraft(store, submitted, 'Alpha');
    expect(moved.store).toBe(store);
    expect(moved.submitted).toBe(submitted);
  });
});
