import { useCallback, useEffect, useRef, useState } from 'react';
import { initialRegistryState, reduceRegistryState } from '../../domain/action-registry-state';
import {
  candidatePerformanceView,
  initialCandidatePerformanceState,
  reduceCandidatePerformance,
  type CandidatePerformanceState,
} from '../../domain/skill-candidate-performance';
import { readCandidatePerformance } from './skill-model';

// Optional observations never own the native list's loading lifetime. Refreshes
// supersede older reads; Retry is guarded and only repeats this resource's read.
export function useSkillObservation<S>(read: () => Promise<S>) {
  const [state, setState] = useState(initialRegistryState<S>);
  const requestId = useRef(0);
  const pending = useRef(false);
  const current = useRef(false);
  const refresh = useCallback(
    async (retry = false): Promise<S | null> => {
      if (retry && pending.current) return null;
      const id = ++requestId.current;
      pending.current = true;
      current.current = false;
      setState((prev) => reduceRegistryState(prev, { type: 'pending', requestId: id }));
      try {
        const snapshot = await read();
        if (id === requestId.current) current.current = true;
        setState((prev) => reduceRegistryState(prev, { type: 'success', requestId: id, snapshot }));
        return snapshot;
      } catch {
        setState((prev) => reduceRegistryState(prev, { type: 'failure', requestId: id }));
        return null;
      } finally {
        if (id === requestId.current) pending.current = false;
      }
    },
    [read],
  );
  return { state, refresh, current };
}

/**
 * One guarded read of a promoted candidate's performance window. Passing
 * `null` (candidate not promoted / not observed) invalidates any in-flight
 * read so a late response can never paint a stale measurement.
 */
export function useCandidatePerformance(candidateId: string | null) {
  const [state, setState] = useState<CandidatePerformanceState>(initialCandidatePerformanceState);
  const requestId = useRef(0);
  const pending = useRef(false);
  const read = useCallback(
    async (retry: boolean) => {
      if (retry && pending.current) return;
      const id = ++requestId.current;
      pending.current = true;
      if (!candidateId) {
        setState((prev) => reduceCandidatePerformance(prev, { type: 'invalidate', requestId: id }));
        pending.current = false;
        return;
      }
      setState((prev) => reduceCandidatePerformance(prev, { type: 'start', requestId: id }));
      const response = await readCandidatePerformance(candidateId);
      setState((prev) => reduceCandidatePerformance(prev, { type: 'settle', requestId: id, response }));
      if (id === requestId.current) pending.current = false;
    },
    [candidateId],
  );

  useEffect(() => {
    void read(false);
  }, [read]);

  return { view: candidatePerformanceView(state), performance: state.performance, retry: () => void read(true) };
}
