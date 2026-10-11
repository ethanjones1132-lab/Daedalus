import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { initialRegistryState, reduceRegistryState } from '../../domain/action-registry-state';

export interface ResourceLoadResult<S> {
  snapshot: S | null;
  accepted: boolean;
  failed: boolean;
}

/**
 * One Native read with its own observation lifetime. Reads are single-flight
 * unless `supersede` is passed; post-operation reads may supersede pending
 * ones, and only the newest completion can publish a snapshot. A failed read
 * never erases a known snapshot.
 */
export function useObservedResource<S>(command: string) {
  const [state, setState] = useState(initialRegistryState<S>);
  const request = useRef(0);
  const pending = useRef(false);

  const loadDetailed = useCallback(
    async (supersede = false): Promise<ResourceLoadResult<S> | null> => {
      if (pending.current && !supersede) return null;
      pending.current = true;
      const requestId = ++request.current;
      setState((prev) => reduceRegistryState(prev, { type: 'pending', requestId }));
      try {
        const snapshot = await invoke<S>(command);
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

  /** Fence every read issued so far (call before a write whose readback must win). */
  const invalidate = useCallback(() => {
    const requestId = ++request.current;
    pending.current = false;
    setState((prev) => ({ ...prev, requestId, loading: false }));
  }, []);

  return { ...state, load, loadDetailed, invalidate };
}
