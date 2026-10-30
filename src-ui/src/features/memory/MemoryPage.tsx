import MemoryTierCounts from './MemoryTierCounts';
import { lazy, Suspense } from 'react';
import { FeatureModes } from '../workflows/FeatureModes';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RefreshCw, Search } from 'lucide-react';
import {
  AlertLine,
  Button,
  EmptyState,
  IconButton,
  Input,
  Page,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  StatusLine,
  cn,
} from '../../design';
import {
  decodeMemoryRecallResults,
  filterMemoriesByTier,
  type MemoryEntry,
  type Tier,
} from '../../domain/memory-recall-state';
import { MemoryDetail } from './MemoryDetail';
import { MemoryRow } from './MemoryRow';
import { BUCKET_ORDER, dateBucket, recallMetaById, type DateBucket, type RecallMeta } from './memory-format';
import {
  INJECTION_BASIS,
  decodeInjectability,
  type InjectionVerdict,
} from './memory-injectability';

type InjectionState = 'idle' | 'loading' | 'ready' | 'unavailable';

function MemoryPage() {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [recallMeta, setRecallMeta] = useState<Record<string, RecallMeta>>({});
  const [query, setQuery] = useState('');
  const [tier, setTier] = useState<Tier | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailId = useId();
  const inspectionButtons = useRef(new Map<string, HTMLButtonElement>());
  const searchInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  // Read-only injectability for a chosen Session scope. The Overview is an
  // inspection list; without a scope no per-row verdict is claimed.
  const [scopeSessionId, setScopeSessionId] = useState('');
  const [sessionOptions, setSessionOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [injection, setInjection] = useState<Record<string, InjectionVerdict> | null>(null);
  const [injectionState, setInjectionState] = useState<InjectionState>('idle');

  // List and recall share one boundary: neither may overwrite a newer request.
  const load = useCallback(async (requestedQuery: string) => {
    const id = ++requestId.current;
    const recallQuery = requestedQuery.trim() ? requestedQuery : '';
    setSubmittedQuery(recallQuery);
    setLoading(true);
    setError(null);
    setMemories([]);
    setRecallMeta({});
    try {
      if (recallQuery) {
        const results = await invoke<unknown>('memory_recall_preview', { query: recallQuery });
        if (id !== requestId.current) return;
        const entries = decodeMemoryRecallResults(results);
        setMemories(entries);
        setRecallMeta(recallMetaById(results, entries));
      } else {
        const list = await invoke<MemoryEntry[]>('list_recent_memories');
        if (id !== requestId.current) return;
        setMemories(list);
      }
    } catch {
      if (id !== requestId.current) return;
      setError(recallQuery ? `Memory recall failed for "${recallQuery}".` : 'Could not load memories.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load('');
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  // The scope chooser is optional: an unreadable Session list leaves the
  // Overview fully usable and simply offers no injectability verdicts.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await invoke<unknown>('jarvis_list_sessions');
        if (cancelled || !Array.isArray(list)) return;
        const options: Array<{ id: string; label: string }> = [];
        for (const row of list) {
          if (!row || typeof row !== 'object') continue;
          const id = (row as { id?: unknown }).id;
          if (typeof id !== 'string' || !id) continue;
          const name = (row as { name?: unknown }).name;
          options.push({ id, label: typeof name === 'string' && name.trim() ? name : id });
        }
        setSessionOptions(options);
      } catch {
        /* no chooser; the stored-memory list remains readable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const search = () => {
    void load(query);
  };

  const filtered = useMemo(() => filterMemoriesByTier(memories, tier), [memories, tier]);
  const visibleIds = useMemo(() => filtered.slice(0, 100).map((memory) => memory.id), [filtered]);
  const recalling = submittedQuery !== '';

  // Evaluate admission only for the visible rows, only in the stored-memory
  // view, and only when an exact Session scope is chosen. The read is bounded
  // to 100 ids natively.
  useEffect(() => {
    if (recalling || !scopeSessionId || visibleIds.length === 0) {
      setInjection(null);
      setInjectionState('idle');
      return;
    }
    let cancelled = false;
    setInjectionState('loading');
    setInjection(null);
    void (async () => {
      try {
        const result = await invoke<unknown>('memory_injectability', {
          request: {
            session_id: scopeSessionId,
            ids: visibleIds,
            include_user_scope: false,
          },
        });
        if (cancelled) return;
        const decoded = decodeInjectability(result);
        setInjection(decoded);
        setInjectionState(decoded ? 'ready' : 'unavailable');
      } catch {
        if (cancelled) return;
        setInjection(null);
        setInjectionState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scopeSessionId, visibleIds, recalling]);
  const selected = selectedId ? (filtered.find((memory) => memory.id === selectedId) ?? null) : null;

  useEffect(() => {
    if (!selectedId || selected) return;
    const opener = inspectionButtons.current.get(selectedId);
    setSelectedId(null);
    if (opener && !opener.isConnected) searchInput.current?.focus();
  }, [selected, selectedId]);

  const closeInspection = () => {
    const opener = selectedId ? inspectionButtons.current.get(selectedId) : null;
    setSelectedId(null);
    if (opener?.isConnected) opener.focus();
    else searchInput.current?.focus();
  };

  // Recall results keep the server's relevance order; recent memories group by day.
  const groups = useMemo(() => {
    if (recalling) return [{ label: null as DateBucket | null, items: filtered }];
    const buckets = new Map<DateBucket, MemoryEntry[]>();
    for (const memory of filtered) {
      const bucket = dateBucket(memory.updated_at);
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), memory]);
    }
    return BUCKET_ORDER.filter((b) => buckets.has(b)).map((b) => ({ label: b as DateBucket | null, items: buckets.get(b)! }));
  }, [filtered, recalling]);

  // Arrow keys walk the list of inspection buttons.
  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const target = event.target as HTMLElement;
    const index = filtered.findIndex((m) => inspectionButtons.current.get(m.id) === target);
    if (index < 0) return;
    const next = filtered[index + (event.key === 'ArrowDown' ? 1 : -1)];
    const node = next ? inspectionButtons.current.get(next.id) : null;
    if (!node) return;
    event.preventDefault();
    node.focus();
  };

  return (
    <Page wide>
      <PageHeader
        eyebrow="Build"
        title="Memory"
        description="What Jarvis remembers — recall by query, browse recent memories, and inspect where each one came from."
        actions={
          <IconButton aria-label="Refresh memories" variant="secondary" onClick={() => void load(submittedQuery)}>
            <RefreshCw aria-hidden="true" />
          </IconButton>
        }
      />

      <Panel ticks className="mb-8 flex flex-col gap-4 p-5">
        <div>
          <span className="d-label text-accent">Recall</span>
          <p className="d-display mt-1 text-[28px] leading-tight text-ink">Ask what Jarvis remembers…</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[260px] flex-1">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
            <Input
              ref={searchInput}
              type="text"
              aria-label="Recall query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && search()}
              placeholder="Recall by query…"
              className="h-12 rounded-[9px] pl-10 text-[15px]"
            />
          </div>
          <Select
            aria-label="Memory tier"
            value={tier}
            onChange={(e) => setTier(e.target.value as Tier | 'all')}
            className="h-12 w-auto rounded-[9px]"
          >
            <option value="all">All tiers</option>
            <option value="hot">Hot</option>
            <option value="warm">Warm</option>
            <option value="cold">Cold</option>
          </Select>
          <Select
            aria-label="Recall scope Session"
            value={scopeSessionId}
            onChange={(e) => setScopeSessionId(e.target.value)}
            className="h-12 w-auto max-w-[240px] rounded-[9px]"
            disabled={recalling}
            title="Evaluate which stored rows this Session could recall"
          >
            <option value="">No recall scope</option>
            {sessionOptions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.label}
              </option>
            ))}
          </Select>
          <Button variant="primary" size="md" className="h-12 px-6 text-[14px]" onClick={search}>
            Search
          </Button>
        </div>
        <MemoryTierCounts />
      </Panel>

      <div className={cn(selected && 'grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_460px]')}>
        <div className="min-w-0">
          {!loading && !error && (
            <div className="mb-4 flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="d-label">{submittedQuery ? `Results for "${submittedQuery}"` : 'Recent memories'}</p>
                {filtered.length > 0 && <span className="font-mono text-[11px] text-ink-3 tabular">{filtered.length} shown</span>}
              </div>
              {!submittedQuery && (
                <p className="text-[11.5px] text-ink-3">
                  All stored memories — not necessarily what will be recalled.
                </p>
              )}
              {!submittedQuery && scopeSessionId && (
                <p className="text-[11px] text-ink-4">
                  {injectionState === 'loading'
                    ? 'Checking injectability for this Session…'
                    : injectionState === 'unavailable'
                      ? 'Injectability is unavailable for this Session; no per-row verdict is claimed.'
                      : INJECTION_BASIS}
                </p>
              )}
            </div>
          )}
          {loading ? (
            <div className="flex flex-col gap-3">
              <StatusLine>{submittedQuery ? `Recalling memories for "${submittedQuery}"…` : 'Loading memories…'}</StatusLine>
              <div aria-hidden="true" className="flex flex-col gap-3">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="h-16 rounded-lg" />
                ))}
              </div>
            </div>
          ) : error ? (
            <AlertLine onRetry={() => void load(submittedQuery)}>{error}</AlertLine>
          ) : filtered.length === 0 ? (
            <EmptyState title="No memories match the current query." />
          ) : (
            <div className="flex flex-col gap-5" onKeyDown={onListKeyDown}>
              {groups.map((group) => (
                <section key={group.label ?? 'results'} aria-label={group.label ?? undefined}>
                  {group.label && (
                    <h3 className="mb-1.5 flex items-center gap-3 font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-3">
                      {group.label}
                      <span aria-hidden="true" className="h-px flex-1 bg-line" />
                    </h3>
                  )}
                  <Panel flush>
                    <ul className="divide-y divide-line">
                      {group.items.map((m) => (
                        <MemoryRow
                          key={m.id}
                          memory={m}
                          selected={selectedId === m.id}
                          regionId={`${detailId}-${m.id}`}
                          recall={recalling ? (recallMeta[m.id] ?? null) : null}
                          injection={!recalling ? (injection?.[m.id] ?? null) : null}
                          inspectRef={(node) => {
                            if (node) inspectionButtons.current.set(m.id, node);
                            else inspectionButtons.current.delete(m.id);
                          }}
                          onSelect={() => setSelectedId(m.id)}
                        />
                      ))}
                    </ul>
                  </Panel>
                </section>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <div className="min-w-0 xl:sticky xl:top-0">
            <MemoryDetail memory={selected} regionId={`${detailId}-${selected.id}`} onClose={closeInspection} />
          </div>
        )}
      </div>
    </Page>
  );
}


const AdvancedMemoryPage = lazy(() => import('./ScopedMemoryPage'));
export default function MemoryPageSurface() { return <FeatureModes label="Scoped controls" primary={<MemoryPage />} advanced={<Suspense fallback={<div role="status">Loading controls…</div>}><AdvancedMemoryPage /></Suspense>} />; }
