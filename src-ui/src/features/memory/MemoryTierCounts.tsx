import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertLine, Button, StatusLine } from '../../design';
import { beginTierStatsRead, formatTierCount, initialTierStatsState, rejectTierStatsRead, resolveTierStatsRead, tierStatsView } from '../../domain/memory-tier-stats';
/** Tier counts are an independent native observation, never inferred from visible rows. */
export default function MemoryTierCounts() {
  const [state, setState] = useState(initialTierStatsState);
  const sequence = useRef(0);
  const pending = useRef<number | null>(null);
  const load = useCallback(async () => {
    if (pending.current !== null) return;
    const id = ++sequence.current;
    pending.current = id;
    setState(current => beginTierStatsRead(current, id));
    try { const raw = await invoke<unknown>('jarvis_get_tier_stats'); if (id === sequence.current) setState(current => resolveTierStatsRead(current, id, raw)); }
    catch { if (id === sequence.current) setState(current => rejectTierStatsRead(current, id)); }
    finally { if (pending.current === id) pending.current = null; }
  }, []);
  useEffect(() => { void load(); return () => { sequence.current += 1; pending.current = null; }; }, [load]);
  const view = tierStatsView(state);
  return <section aria-label="Memory tier counts" className="space-y-2 text-xs"><div className="flex items-center gap-6">{state.readings?.map(reading => <span key={reading.tier} className="font-mono text-ink-3">{reading.tier} <span className="text-ink">{formatTierCount(reading)}</span></span>)}<Button size="xs" disabled={state.pending} onClick={() => void load()} aria-label="Retry tier counts">Refresh tier counts</Button></div>{view.kind === 'pending' && <StatusLine label="Memory tier counts">{view.message}</StatusLine>}{view.kind === 'unavailable' && <AlertLine label="Memory tier counts" onRetry={() => void load()}>{view.message}</AlertLine>}{state.failure && state.readings && <p>Previously observed tier counts may be stale.</p>}</section>;
}
