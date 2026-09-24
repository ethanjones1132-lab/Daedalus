// ═══════════════════════════════════════════════════════════════
// ── MemoryView — Browse, recall, and inspect the memory system ──
// ═══════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback, useId, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { cn, GlassCard, LoadingState, ErrorState, EmptyState, SectionHeader } from '../ui';
import {
  decodeMemoryRecallResults,
  filterMemoriesByTier,
  getMemoryTier,
  type MemoryEntry,
  type Tier,
} from './memory-recall-state';

// Defensive formatters — the memory backend has drifted shape during recovery, so the
// render must never throw on a missing/oddly-typed field (that blanks the whole page).
function safeTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function safeMessageIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function displayValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return 'Not supplied';
  }
  return String(value);
}

function fmtConfidence(c: number | undefined | null): string {
  return typeof c === 'number' && Number.isFinite(c) ? c.toFixed(2) : '—';
}

function fmtDate(value: string | undefined | null): string {
  if (!value) return '';
  const t = Date.parse(value);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString();
}

export default function MemoryView() {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
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
    try {
      if (recallQuery) {
        const results = await invoke<unknown>('memory_recall_preview', { query: recallQuery });
        if (id !== requestId.current) return;
        setMemories(decodeMemoryRecallResults(results));
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
    return () => { requestId.current += 1; };
  }, [load]);

  const search = () => { void load(query); };

  const filtered = filterMemoriesByTier(memories, tier);

  const selected = selectedId ? filtered.find((memory) => memory.id === selectedId) ?? null : null;

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

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="Memory"
        subtitle="Browse, recall, and inspect the memory system"
        count={memories.length}
        action={
          <div className="flex gap-2">
            {tierStats && (
              <div className="flex gap-1.5 text-[10px]">
                {(['hot', 'warm', 'cold'] as Tier[]).map((t) => (
                  <span
                    key={t}
                    className={cn(
                      'rounded-full border px-2 py-0.5 font-mono uppercase tracking-wider',
                      t === 'hot' && 'border-amber-500/30 text-amber-200',
                      t === 'warm' && 'border-cyan-500/30 text-cyan-200',
                      t === 'cold' && 'border-bone/20 text-bone/50',
                    )}
                  >
                    {t} {tierStats[t] ?? 0}
                  </span>
                ))}
              </div>
            )}
          </div>
        }
      />

      <div className="flex gap-2">
        <input
          ref={searchInput}
          type="text"
          aria-label="Recall query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder="Recall by query…"
          className="flex-1 px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50"
        />
        <select
          aria-label="Memory tier"
          value={tier}
          onChange={(e) => setTier(e.target.value as Tier | 'all')}
          className="px-2 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone"
        >
          <option value="all">All tiers</option>
          <option value="hot">Hot</option>
          <option value="warm">Warm</option>
          <option value="cold">Cold</option>
        </select>
        <button
          type="button"
          onClick={search}
          className="px-4 py-2 text-sm rounded-lg bg-accent text-bone hover:bg-accent/80 transition-colors"
        >
          Search
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {!loading && !error && (
          <p className="text-xs text-bone/50 mb-2">
            {submittedQuery ? `Results for "${submittedQuery}"` : 'Recent memories'}
          </p>
        )}
        {loading ? (
          <div role="status">
            <LoadingState message={submittedQuery ? `Recalling memories for "${submittedQuery}"…` : 'Loading memories…'} />
          </div>
        ) : error ? (
          <div role="alert">
            <ErrorState error={error} onRetry={() => { void load(submittedQuery); }} />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState message="No memories match the current query." />
        ) : (
          <>
            <ul className="space-y-2">
              {filtered.map((m) => {
                const isSelected = selectedId === m.id;
                const regionId = `${detailId}-${m.id}`;
                return (
                  <li key={m.id}>
                    <GlassCard
                      onClick={() => setSelectedId(m.id)}
                      className="p-3 hover:border-white/20 transition-colors"
                    >
                      <div className="flex items-baseline justify-between gap-2 mb-1">
                        <h3 className="text-sm font-medium text-bone min-w-0">
                          <button
                            ref={(node) => {
                              if (node) inspectionButtons.current.set(m.id, node);
                              else inspectionButtons.current.delete(m.id);
                            }}
                            type="button"
                            aria-label={`Inspect memory: ${m.title || m.id}`}
                            aria-expanded={isSelected}
                            aria-pressed={isSelected}
                            aria-controls={regionId}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedId(m.id);
                            }}
                            className="max-w-full truncate text-left rounded cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-neon focus-visible:outline-offset-2"
                          >
                            {m.title || 'Untitled memory'}
                          </button>
                        </h3>
                        <span className="text-[10px] font-mono text-bone/40 shrink-0">
                          conf {fmtConfidence(m.confidence)}
                        </span>
                      </div>
                      <p className="text-xs text-bone/60 line-clamp-2 mb-1.5">
                        {m.content}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                        <span className="rounded-full bg-white/5 border border-white/10 px-1.5 py-0.5 text-bone/60">
                          {m.category}
                        </span>
                        {safeTags(m.tags).slice(0, 3).map((t: string) => (
                          <span
                            key={t}
                            className="rounded-full bg-accent/10 border border-accent/20 px-1.5 py-0.5 text-accent/80"
                          >
                            #{t}
                          </span>
                        ))}
                        <span className="ml-auto text-bone/30 font-mono">
                          {fmtDate(m.updated_at)}
                        </span>
                      </div>
                    </GlassCard>
                  </li>
                );
              })}
            </ul>
            {selected && (
              <section
                id={`${detailId}-${selected.id}`}
                role="region"
                aria-label={`Memory details: ${selected.title || selected.id}`}
                className="mt-4"
              >
                <GlassCard className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium text-bone">Full memory</h3>
                      <p className="text-xs text-bone/50 break-words">{selected.title || selected.id}</p>
                    </div>
                    <button
                      type="button"
                      onClick={closeInspection}
                      className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-bone/70 hover:text-bone"
                    >
                      Close
                    </button>
                  </div>
                  <p
                    aria-label="Full memory content"
                    className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-black/20 p-3 text-sm leading-6 text-bone/80"
                  >
                    {displayValue(selected.content)}
                  </p>
                  <h4 className="mt-4 text-xs font-medium text-bone/70">Provenance</h4>
                   <dl aria-label="Memory provenance" className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
                     <div>
                       <dt className="text-bone/40">ID</dt>
                       <dd className="text-bone/75 break-words">{displayValue(selected.id)}</dd>
                     </div>
                     <div>
                       <dt className="text-bone/40">Source</dt>
                      <dd className="text-bone/75 break-words">{displayValue(selected.source)}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Agent</dt>
                      <dd className="text-bone/75 break-words">{displayValue(selected.agent_id)}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Source Session</dt>
                      <dd className="text-bone/75 break-words">{displayValue(selected.source_session_id)}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Source message IDs</dt>
                      <dd className="text-bone/75 break-words">{safeMessageIds(selected.source_message_ids).join(', ') || 'Not supplied'}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Category</dt>
                      <dd className="text-bone/75 break-words">{displayValue(selected.category)}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Status</dt>
                      <dd className="text-bone/75 break-words">{displayValue(selected.status)}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Tier</dt>
                      <dd className="text-bone/75 break-words">{getMemoryTier(selected) ?? 'Not supplied'}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Tags</dt>
                      <dd className="text-bone/75 break-words">{safeTags(selected.tags).join(', ') || 'Not supplied'}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Created</dt>
                      <dd className="text-bone/75 break-words">{displayValue(selected.created_at)}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Updated</dt>
                      <dd className="text-bone/75 break-words">{displayValue(selected.updated_at)}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Last used</dt>
                      <dd className="text-bone/75 break-words">{displayValue(selected.last_used_at)}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Expires</dt>
                      <dd className="text-bone/75 break-words">{displayValue(selected.expires_at)}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Review after</dt>
                      <dd className="text-bone/75 break-words">{displayValue(selected.review_after)}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Supersedes</dt>
                      <dd className="text-bone/75 break-words">{displayValue(selected.supersedes_id)}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Usage count</dt>
                      <dd className="text-bone/75">{displayValue(selected.usage_count)}</dd>
                    </div>
                    <div>
                      <dt className="text-bone/40">Confidence</dt>
                      <dd className="text-bone/75">{fmtConfidence(selected.confidence)}</dd>
                    </div>
                  </dl>
                </GlassCard>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
