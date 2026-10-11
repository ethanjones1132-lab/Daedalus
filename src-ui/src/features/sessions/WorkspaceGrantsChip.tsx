import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderOpen, RotateCw, X } from 'lucide-react';
import { Spinner, cn } from '../../design';
import { parseSessionGrantsResponse } from '../../domain/workspace-grants-state';

type GrantError = 'read' | 'revoke';

interface GrantsState {
  ownerSessionId: string;
  grants: string[] | null;
  loading: boolean;
  error: GrantError | null;
  requestId: number;
}

interface PendingRevoke {
  id: number;
  sessionId: string;
  root: string;
}

export default function WorkspaceGrantsChip({
  sessionId,
  isStreaming,
}: {
  sessionId: string;
  isStreaming: boolean;
}) {
  const [state, setState] = useState<GrantsState>({
    ownerSessionId: sessionId,
    grants: null,
    loading: Boolean(sessionId),
    error: null,
    requestId: 0,
  });
  const [pendingRevoke, setPendingRevoke] = useState<PendingRevoke | null>(null);
  const sessionIdRef = useRef(sessionId);
  const requestIdRef = useRef(0);
  const revokeIdRef = useRef(0);
  const mountedRef = useRef(true);
  const readInFlightRef = useRef<{ sessionId: string; requestId: number } | null>(null);
  const pendingRevokeRef = useRef<PendingRevoke | null>(null);
  const streamingRef = useRef(isStreaming);
  const streamSessionRef = useRef(sessionId);

  sessionIdRef.current = sessionId;

  const refresh = useCallback(async () => {
    const targetSessionId = sessionId;
    if (readInFlightRef.current?.sessionId === targetSessionId) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    readInFlightRef.current = { sessionId: targetSessionId, requestId };

    if (!targetSessionId) {
      setState({ ownerSessionId: '', grants: null, loading: false, error: null, requestId });
      readInFlightRef.current = null;
      return;
    }

    setState(previous => ({
      ownerSessionId: targetSessionId,
      grants: previous.ownerSessionId === targetSessionId ? previous.grants : null,
      loading: true,
      error: null,
      requestId,
    }));

    try {
      const response = await invoke<unknown>('jarvis_get_session_grants', { sessionId: targetSessionId });
      if (!mountedRef.current || requestId !== requestIdRef.current || sessionIdRef.current !== targetSessionId) return;
      const grants = parseSessionGrantsResponse(response, targetSessionId);
      if (!grants) throw new Error('Invalid workspace grants response');
      setState({ ownerSessionId: targetSessionId, grants, loading: false, error: null, requestId });
    } catch {
      if (!mountedRef.current || requestId !== requestIdRef.current || sessionIdRef.current !== targetSessionId) return;
      setState(previous => ({
        ownerSessionId: targetSessionId,
        grants: previous.ownerSessionId === targetSessionId ? previous.grants : null,
        loading: false,
        error: 'read',
        requestId,
      }));
    } finally {
      if (readInFlightRef.current?.requestId === requestId) readInFlightRef.current = null;
    }
  }, [sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      if (readInFlightRef.current?.sessionId === sessionId) readInFlightRef.current = null;
    };
  }, [refresh, sessionId]);

  useEffect(() => {
    const sessionChanged = streamSessionRef.current !== sessionId;
    const streamEnded = !sessionChanged && streamingRef.current && !isStreaming;
    streamSessionRef.current = sessionId;
    streamingRef.current = isStreaming;
    if (streamEnded) void refresh();
  }, [isStreaming, refresh, sessionId]);

  useEffect(() => {
    const pending = pendingRevokeRef.current;
    if (pending && pending.sessionId !== sessionId) {
      pendingRevokeRef.current = null;
      setPendingRevoke(null);
    }
  }, [sessionId]);

  const revoke = useCallback(async (root: string) => {
    if (!sessionId || isStreaming || pendingRevokeRef.current) return;
    const mutation: PendingRevoke = { id: ++revokeIdRef.current, sessionId, root };
    pendingRevokeRef.current = mutation;
    setPendingRevoke(mutation);
    readInFlightRef.current = null;
    requestIdRef.current += 1;

    try {
      const response = await invoke<unknown>('jarvis_revoke_session_grant', { sessionId, root });
      if (
        !mountedRef.current ||
        sessionIdRef.current !== sessionId ||
        pendingRevokeRef.current?.id !== mutation.id
      ) return;
      const grants = parseSessionGrantsResponse(response, sessionId);
      if (!grants) throw new Error('Invalid workspace grant revoke response');
      setState({ ownerSessionId: sessionId, grants, loading: false, error: null, requestId: requestIdRef.current });
    } catch {
      if (
        !mountedRef.current ||
        sessionIdRef.current !== sessionId ||
        pendingRevokeRef.current?.id !== mutation.id
      ) return;
      setState(previous => ({
        ownerSessionId: sessionId,
        grants: previous.ownerSessionId === sessionId ? previous.grants : null,
        loading: false,
        error: 'revoke',
        requestId: requestIdRef.current,
      }));
    } finally {
      if (pendingRevokeRef.current?.id === mutation.id) {
        pendingRevokeRef.current = null;
        setPendingRevoke(null);
      }
    }
  }, [isStreaming, sessionId]);

  const currentState = state.ownerSessionId === sessionId ? state : null;
  const grants = currentState?.grants ?? null;
  const loading = Boolean(sessionId) && (!currentState || currentState.loading);
  const error = currentState?.error ?? null;
  const activeRevoke = pendingRevoke?.sessionId === sessionId ? pendingRevoke : null;

  if (!sessionId) return null;
  if (!loading && !error && grants?.length === 0) return null;

  const errorMessage = error === 'revoke'
    ? 'Could not confirm workspace grant revoke. Showing the previous grants; they may be stale.'
    : grants === null
      ? 'Could not load workspace grants.'
      : 'Could not refresh workspace grants. Showing previously loaded grants; they may be stale.';

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-[11.5px]"
      aria-label="Session-granted filesystem roots"
      aria-busy={loading || activeRevoke !== null}
    >
      {loading && (
        <span role="status" aria-label="Workspace grants loading" className="inline-flex items-center gap-1.5 text-ink-3">
          <Spinner size={11} />
          {grants === null ? 'Loading workspace grants…' : 'Refreshing workspace grants…'}
        </span>
      )}
      {activeRevoke && (
        <span role="status" aria-label="Workspace grant revoke pending" className="inline-flex items-center gap-1.5 text-ink-3">
          <Spinner size={11} />
          Revoking grant…
        </span>
      )}
      {error && (
        <span role="alert" className="inline-flex flex-wrap items-center gap-2 text-warn">
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || activeRevoke !== null}
            aria-label="Retry workspace grants"
            className="inline-flex items-center gap-1 rounded-[4px] border border-warn/30 px-1.5 py-px text-[11px] hover:bg-warn-wash disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCw aria-hidden="true" className="size-3" />
            Retry
          </button>
        </span>
      )}
      {grants !== null && grants.length > 0 && (
        <>
          <span className="d-label inline-flex items-center gap-1 text-[9.5px] text-warn">
            <FolderOpen aria-hidden="true" className="size-3" />
            workspace grants
          </span>
          {grants.map(root => (
            <span
              key={root}
              className={cn(
                'inline-flex max-w-[240px] items-center gap-1 rounded-[5px] border border-warn/25 bg-warn-wash py-px pl-1.5 pr-0.5 font-mono text-[11px] text-ink-2',
                activeRevoke?.root === root && 'opacity-60',
              )}
            >
              {/* Long roots keep their tail visible: the folder name matters most. */}
              <span className="truncate [direction:rtl]" title={root}>
                <span dir="ltr">{root}</span>
              </span>
              <button
                type="button"
                onClick={() => void revoke(root)}
                disabled={loading || isStreaming || activeRevoke !== null}
                aria-busy={activeRevoke?.root === root}
                aria-label={`Revoke grant for ${root}`}
                title={activeRevoke?.root === root ? 'Revoking this grant' : 'Revoke this grant'}
                className="flex size-4 shrink-0 items-center justify-center rounded-[3px] text-ink-4 transition-colors hover:bg-err-wash hover:text-err disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </span>
          ))}
        </>
      )}
    </div>
  );
}
