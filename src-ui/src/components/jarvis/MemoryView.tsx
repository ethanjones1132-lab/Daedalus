// ═══════════════════════════════════════════════════════════════
// ── MemoryView — Browse, recall, and inspect the memory system ──
// ═══════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { cn, GlassCard, LoadingState, ErrorState, EmptyState, SectionHeader, useToast } from '../ui';

interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  tags: string;
  category: string;
  created_at: string;
  updated_at: string;
  relevance_score: number;
  agent_id: string;
  source: string;
  source_session_id?: string | null;
  source_message_ids: string;
  confidence: number;
  last_used_at?: string | null;
  usage_count: number;
  expires_at?: string | null;
  review_after?: string | null;
  status: 'active' | 'tombstoned' | string;
  supersedes_id?: string | null;
  metadata?: string | null;
}

type Tier = 'hot' | 'warm' | 'cold';

export default function MemoryView() {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [tierStats, setTierStats] = useState<Record<Tier, number> | null>(null);
  const [query, setQuery] = useState('');
  const [tier, setTier] = useState<Tier | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { error: toastError } = useToast();

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, stats] = await Promise.all([
        invoke<MemoryEntry[]>('list_recent_memories'),
        invoke<Record<Tier, number>>('jarvis_get_tier_stats').catch(() => null),
      ]);
      setMemories(list);
      setTierStats(stats);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const search = useCallback(async () => {
    if (!query.trim()) {
      fetch();
      return;
    }
    setLoading(true);
    try {
      const results = await invoke<MemoryEntry[]>('memory_recall_preview', { query });
      setMemories(results);
    } catch (e) {
      toastError(String(e), 'Memory search failed');
    } finally {
      setLoading(false);
    }
  }, [query, fetch, toastError]);

  const filtered = tier === 'all'
    ? memories
    : memories.filter((m) => {
        // The recovered engine puts `tier` in metadata; fall back to "hot".
        if (m.metadata) {
          try {
            const md = JSON.parse(m.metadata);
            if (md.tier) return md.tier === tier;
          } catch { /* ignore */ }
        }
        return tier === 'hot';
      });

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
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder="Recall by query…"
          className="flex-1 px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50"
        />
        <select
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
        {loading ? (
          <LoadingState message="Loading memories…" />
        ) : error ? (
          <ErrorState error={error} onRetry={fetch} />
        ) : filtered.length === 0 ? (
          <EmptyState message="No memories match the current query." />
        ) : (
          <ul className="space-y-2">
            {filtered.map((m) => (
              <li key={m.id}>
                <GlassCard className="p-3 hover:border-white/20 transition-colors">
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <h3 className="text-sm font-medium text-bone">{m.title}</h3>
                    <span className="text-[10px] font-mono text-bone/40">
                      conf {m.confidence.toFixed(2)}
                    </span>
                  </div>
                  <p className="text-xs text-bone/60 line-clamp-2 mb-1.5">
                    {m.content}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                    <span className="rounded-full bg-white/5 border border-white/10 px-1.5 py-0.5 text-bone/60">
                      {m.category}
                    </span>
                    {m.tags && JSON.parse(m.tags || '[]').slice(0, 3).map((t: string) => (
                      <span
                        key={t}
                        className="rounded-full bg-accent/10 border border-accent/20 px-1.5 py-0.5 text-accent/80"
                      >
                        #{t}
                      </span>
                    ))}
                    <span className="ml-auto text-bone/30 font-mono">
                      {new Date(m.updated_at).toLocaleDateString()}
                    </span>
                  </div>
                </GlassCard>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
