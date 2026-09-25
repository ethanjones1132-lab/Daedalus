export const NEW_SESSION_DRAFT_KEY = '__jarvis_new_session__';

export interface SessionDraft {
  text: string;
  revision: number;
  acceptedRevision?: number;
}

export type SessionDraftStore = Readonly<Record<string, SessionDraft>>;

export interface SessionDraftSnapshot extends SessionDraft {
  key: string;
  sessionId: string | null;
}

export function sessionDraftKey(sessionId: string | null | undefined): string {
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : NEW_SESSION_DRAFT_KEY;
}

export function createSessionDraftStore(): SessionDraftStore {
  return {};
}

export function getSessionDraft(store: SessionDraftStore, sessionId: string | null | undefined): SessionDraft {
  return store[sessionDraftKey(sessionId)] ?? { text: '', revision: 0 };
}

export function getSessionDraftSnapshot(
  store: SessionDraftStore,
  sessionId: string | null | undefined,
): SessionDraftSnapshot {
  const normalizedSessionId = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  const draft = getSessionDraft(store, normalizedSessionId);
  return {
    key: sessionDraftKey(normalizedSessionId),
    sessionId: normalizedSessionId,
    text: draft.text,
    revision: draft.revision,
  };
}

export function updateSessionDraft(
  store: SessionDraftStore,
  sessionId: string | null | undefined,
  text: string,
): SessionDraftStore {
  const key = sessionDraftKey(sessionId);
  const current = getSessionDraft(store, sessionId);
  return {
    ...store,
    [key]: {
      text,
      revision: current.revision + 1,
    },
  };
}

export function clearSubmittedSessionDraft(
  store: SessionDraftStore,
  submitted: SessionDraftSnapshot,
): SessionDraftStore {
  const current = getSessionDraft(store, submitted.key);
  if (current.revision !== submitted.revision || current.text.trim() !== submitted.text.trim()) return store;
  return {
    ...store,
    [submitted.key]: {
      text: '',
      revision: current.revision + 1,
      acceptedRevision: submitted.revision,
    },
  };
}

export function restoreFailedSessionDraft(
  store: SessionDraftStore,
  submitted: SessionDraftSnapshot,
): SessionDraftStore {
  const current = getSessionDraft(store, submitted.key);
  const acceptedClear = current.acceptedRevision === submitted.revision;
  if (current.text.trim() || (current.revision !== submitted.revision && !acceptedClear)) return store;
  return updateSessionDraft(store, submitted.key, submitted.text);
}
