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
  StatusDot,
  StatusLine,
  cn,
  type Tone,
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

const TIER_TONE: Record<Tier, Tone> = { hot: 'warn', warm: 'info', cold: 'muted' };
const TIERS: Tier[] = ['hot', 'warm', 'cold'];

function MemoryPage() {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [recallMeta, setRecallMeta] = useState<Record<string, RecallMeta>>({});
  const [tierStats, setTierStats] = useState<Record<Tier, number> | null>(null);
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
        const [list, stats] = await Promise.all([
          invoke<MemoryEntry[]>('list_recent_memories'),
          invoke<Record<Tier, number>>('jarvis_get_tier_stats').catch(() => null),
        ]);
        if (id !== requestId.current) return;
        setMemories(list);
        setTierStats(stats);
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

  const search = () => {
    void load(query);
  };

  const filtered = useMemo(() => filterMemoriesByTier(memories, tier), [memories, tier]);
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
  const recalling = submittedQuery !== '';
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
          <Button variant="primary" size="md" className="h-12 px-6 text-[14px]" onClick={search}>
            Search
          </Button>
        </div>
        {tierStats && (
          <ul aria-label="Memory tiers" className="flex flex-wrap items-center gap-x-6 gap-y-1.5">
            {TIERS.map((t) => (
              <li key={t} className="flex items-center gap-2 text-[12px] text-ink-2">
                <StatusDot tone={TIER_TONE[t]} />
                <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">{t}</span>
                <span className="tabular font-mono text-[13px] text-ink">{tierStats[t] ?? 0}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className={cn(selected && 'grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_460px]')}>
        <div className="min-w-0">
          {!loading && !error && (
            <div className="mb-4 flex items-baseline justify-between gap-3">
              <p className="d-label">{submittedQuery ? `Results for "${submittedQuery}"` : 'Recent memories'}</p>
              {filtered.length > 0 && <span className="font-mono text-[11px] text-ink-3 tabular">{filtered.length} shown</span>}
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
