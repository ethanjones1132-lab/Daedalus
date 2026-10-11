import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { initialRegistryState, reduceRegistryState } from '../../domain/action-registry-state';

// Each native resource owns its observation lifetime. Post-operation reads may
// supersede pending reads; only the newest completion can publish a snapshot.
export interface ResourceLoadResult<S> {
  snapshot: S | null;
  accepted: boolean;
  failed: boolean;
}

/**
 * One request-id-fenced Tauri read. Single-flight unless `supersede`; a
 * response that is not the newest is dropped; a failed read never erases the
 * last known snapshot (the surface marks it stale instead). `parse` turns a
 * malformed payload into a failure rather than a successful empty observation.
 */
export function useNativeResource<S>(command: string, parse: (value: unknown) => S | null) {
  const [state, setState] = useState(initialRegistryState<S>);
  const request = useRef(0);
  const pending = useRef(false);
  const parseRef = useRef(parse);
  parseRef.current = parse;

  const loadDetailed = useCallback(
    async (supersede = false): Promise<ResourceLoadResult<S> | null> => {
      if (pending.current && !supersede) return null;
      pending.current = true;
      const requestId = ++request.current;
      setState((prev) => reduceRegistryState(prev, { type: 'pending', requestId }));
      try {
        const raw = await invoke<unknown>(command);
        const snapshot = raw == null ? null : parseRef.current(raw);
        if (snapshot == null) throw new Error('Missing observation');
        if (request.current !== requestId) return { snapshot: null, accepted: false, failed: false };
        setState((prev) => reduceRegistryState(prev, { type: 'success', requestId, snapshot }));
        return { snapshot, accepted: true, failed: false };
      } catch {
        if (request.current !== requestId) return { snapshot: null, accepted: false, failed: false };
        setState((prev) => reduceRegistryState(prev, { type: 'failure', requestId }));
        return { snapshot: null, accepted: true, failed: true };
      } finally {
        if (request.current === requestId) pending.current = false;
      }
    },
    [command],
  );

  const load = useCallback(
    async (supersede = false) => {
      const result = await loadDetailed(supersede);
      return result?.snapshot ?? null;
    },
    [loadDetailed],
  );

  /** Drop any in-flight read so an older completion can no longer publish. */
  const invalidate = useCallback(() => {
    const requestId = ++request.current;
    pending.current = false;
    setState((prev) => ({ ...prev, requestId, loading: false }));
  }, []);

  return { ...state, load, loadDetailed, invalidate };
}

export type NativeResource<S> = ReturnType<typeof useNativeResource<S>>;
