import { useCallback, useEffect, useReducer, useRef } from 'react';
import { COPY_SUCCESS_TIMEOUT_MS, initialCopyOutcome, projectCopyOutcome, reduceCopyOutcome } from '../domain/copy-outcome';
/** Each clipboard result belongs to the exact text and attempt that issued it. */
export function useCopyOutcome(text: string) {
  const [state, dispatch] = useReducer(reduceCopyOutcome, undefined, initialCopyOutcome);
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    dispatch({ type: 'reset', attempt: ++attempt.current });
    return () => { attempt.current += 1; if (timer.current) clearTimeout(timer.current); };
  }, [text]);
  const copy = useCallback(async () => {
    const id = ++attempt.current;
    if (timer.current) clearTimeout(timer.current);
    dispatch({ type: 'attempt', attempt: id });
    try {
      await navigator.clipboard.writeText(text);
      if (id !== attempt.current) return;
      dispatch({ type: 'confirmed', attempt: id });
      timer.current = setTimeout(() => dispatch({ type: 'expired', attempt: id }), COPY_SUCCESS_TIMEOUT_MS);
    } catch { if (id === attempt.current) dispatch({ type: 'failed', attempt: id }); }
  }, [text]);
  return { view: projectCopyOutcome(state), copy };
}
