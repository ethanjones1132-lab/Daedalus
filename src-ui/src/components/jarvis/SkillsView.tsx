// ═══════════════════════════════════════════════════════════════
// ── SkillsView — Browse, toggle, inspect, and revision-restore skills
// ═══════════════════════════════════════════════════════════════
//
// Backed by the SQLite skills surface in src-tauri/src/commands/skills.rs:
//   list_skills() -> Skill[]
//   enable_skill(name) / disable_skill(name)
//   invoke_skill(name) -> Skill        (returns the full body + metadata)
//   skill_revisions_list(skillId?, limit?) -> SkillRevision[]
//   skill_restore_revision(revisionId) -> bool

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  cn,
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
  LoadingState,
  ErrorState,
  EmptyState,
  useToast,
} from '../ui';
import MarkdownRenderer from './MarkdownRenderer';

// ── Types ──────────────────────────────────────────────────────

interface Skill {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  metadata: string | null;
  body: string;
  version: number;
  last_improved_at?: string | null;
  improvement_score: number;
  created_at: string;
  updated_at: string;
}

interface SkillRevision {
  id: string;
  skill_id: string;
  version: number;
  body_before: string;
  body_after: string;
  change_reason: string;
  source_session_id?: string | null;
  created_at: string;
}

type Filter = 'all' | 'enabled' | 'disabled';

// ── Helpers ────────────────────────────────────────────────────

function formatDate(ts?: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function categoryOf(skill: Skill): string | null {
  if (!skill.metadata) return null;
  try {
    const md = JSON.parse(skill.metadata);
    if (typeof md.category === 'string') return md.category;
  } catch {
    /* ignore malformed metadata */
  }
  return null;
}

// ── Detail panel ───────────────────────────────────────────────

function SkillDetail({
  skill,
  onClose,
  onToggle,
  onChanged,
}: {
  skill: Skill;
  onClose: () => void;
  onToggle: (skill: Skill) => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'body' | 'revisions'>('body');
  const [revisions, setRevisions] = useState<SkillRevision[] | null>(null);
  const [loadingRevs, setLoadingRevs] = useState(false);
  const [revError, setRevError] = useState<string | null>(null);
  const { success, error: toastError } = useToast();

  const loadRevisions = useCallback(async () => {
    setLoadingRevs(true);
    setRevError(null);
    try {
      const revs = await invoke<SkillRevision[]>('skill_revisions_list', {
        skillId: skill.id,
        limit: 50,
      });
      setRevisions(revs);
    } catch (e) {
      setRevError(String(e));
    } finally {
      setLoadingRevs(false);
    }
  }, [skill.id]);

  useEffect(() => {
    if (tab === 'revisions' && revisions === null) loadRevisions();
  }, [tab, revisions, loadRevisions]);

  const restore = useCallback(
    async (rev: SkillRevision) => {
      try {
        await invoke<boolean>('skill_restore_revision', { revisionId: rev.id });
        success(`Restored ${skill.name} to v${rev.version}`, 'Revision restored');
        await loadRevisions();
        onChanged();
      } catch (e) {
        toastError(String(e), 'Restore failed');
      }
    },
    [skill.name, loadRevisions, onChanged, success, toastError],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot ok={skill.enabled} warn={!skill.enabled} />
            <h3 className="text-base font-semibold text-bone truncate">{skill.name}</h3>
            <Pill variant="default">v{skill.version}</Pill>
          </div>
          <p className="text-xs text-bone/50 mt-1">{skill.description}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-bone/40 hover:text-bone text-lg leading-none px-2"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <button
          type="button"
          onClick={() => onToggle(skill)}
          className={cn(
            'px-3 py-1.5 text-xs rounded-lg border transition-colors',
            skill.enabled
              ? 'border-amber-500/30 text-amber-200 hover:bg-amber-500/10'
              : 'border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10',
          )}
        >
          {skill.enabled ? 'Disable' : 'Enable'}
        </button>
        <div className="ml-auto flex gap-1 text-[11px]">
          <button
            type="button"
            onClick={() => setTab('body')}
            className={cn(
              'px-2.5 py-1 rounded-md transition-colors',
              tab === 'body' ? 'bg-white/10 text-bone' : 'text-bone/40 hover:text-bone/70',
            )}
          >
            Body
          </button>
          <button
            type="button"
            onClick={() => setTab('revisions')}
            className={cn(
              'px-2.5 py-1 rounded-md transition-colors',
              tab === 'revisions' ? 'bg-white/10 text-bone' : 'text-bone/40 hover:text-bone/70',
            )}
          >
            Revisions
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {tab === 'body' ? (
          skill.body ? (
            <GlassCard className="p-4">
              <MarkdownRenderer content={skill.body} />
            </GlassCard>
          ) : (
            <EmptyState message="This skill has no stored body." />
          )
        ) : loadingRevs ? (
          <LoadingState message="Loading revisions…" />
        ) : revError ? (
          <ErrorState error={revError} onRetry={loadRevisions} />
        ) : !revisions || revisions.length === 0 ? (
          <EmptyState message="No revision history for this skill yet." />
        ) : (
          <ul className="space-y-2">
            {revisions.map((rev) => (
              <li key={rev.id}>
                <GlassCard className="p-3">
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <span className="text-xs font-medium text-bone">
                      v{rev.version}
                      <span className="ml-2 text-[10px] font-mono text-bone/30">
                        {formatDate(rev.created_at)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => restore(rev)}
                      className="text-[11px] px-2 py-0.5 rounded-md border border-royal/40 text-royal-light hover:bg-royal/10 transition-colors"
                    >
                      Restore
                    </button>
                  </div>
                  <p className="text-xs text-bone/60">{rev.change_reason || 'No reason recorded.'}</p>
                </GlassCard>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────

export function SkillsView() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { success, error: toastError } = useToast();

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<Skill[]>('list_skills');
      setSkills(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const toggle = useCallback(
    async (skill: Skill) => {
      const next = !skill.enabled;
      // Optimistic update so the toggle feels instant.
      setSkills((prev) => prev.map((s) => (s.id === skill.id ? { ...s, enabled: next } : s)));
      try {
        await invoke(next ? 'enable_skill' : 'disable_skill', { name: skill.name });
        success(`${next ? 'Enabled' : 'Disabled'} ${skill.name}`);
      } catch (e) {
        // Roll back on failure.
        setSkills((prev) => prev.map((s) => (s.id === skill.id ? { ...s, enabled: !next } : s)));
        toastError(String(e), 'Toggle failed');
      }
    },
    [success, toastError],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (filter === 'enabled' && !s.enabled) return false;
      if (filter === 'disabled' && s.enabled) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (categoryOf(s)?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [skills, query, filter]);

  const selected = useMemo(
    () => skills.find((s) => s.id === selectedId) ?? null,
    [skills, selectedId],
  );

  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="Skills"
        subtitle="Browse, toggle, inspect, and restore skill revisions"
        count={skills.length}
        action={
          <Pill variant={enabledCount > 0 ? 'success' : 'default'}>
            {enabledCount} enabled
          </Pill>
        }
      />

      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills…"
          className="flex-1 px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          className="px-2 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone"
        >
          <option value="all">All</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>

      <div className="flex-1 flex gap-4 min-h-0">
        <div className={cn('overflow-y-auto min-h-0', selected ? 'w-1/2' : 'flex-1')}>
          {loading ? (
            <LoadingState message="Loading skills…" />
          ) : error ? (
            <ErrorState error={error} onRetry={fetchSkills} />
          ) : filtered.length === 0 ? (
            <EmptyState message="No skills match the current filter." />
          ) : (
            <ul className="space-y-2">
              {filtered.map((s) => {
                const category = categoryOf(s);
                return (
                  <li key={s.id}>
                    <GlassCard
                      onClick={() => setSelectedId(s.id)}
                      hoverable
                      className={cn(
                        'p-3',
                        selectedId === s.id && 'border-accent/40 bg-white/[0.06]',
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <StatusDot ok={s.enabled} warn={!s.enabled} />
                        <h3 className="text-sm font-medium text-bone truncate">{s.name}</h3>
                        {category && (
                          <span className="text-[10px] rounded-full bg-white/5 border border-white/10 px-1.5 py-0.5 text-bone/50">
                            {category}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(s);
                          }}
                          className={cn(
                            'ml-auto text-[11px] px-2 py-0.5 rounded-md border transition-colors',
                            s.enabled
                              ? 'border-amber-500/30 text-amber-200 hover:bg-amber-500/10'
                              : 'border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10',
                          )}
                        >
                          {s.enabled ? 'Disable' : 'Enable'}
                        </button>
                      </div>
                      <p className="text-xs text-bone/60 line-clamp-2">{s.description}</p>
                      <div className="flex items-center gap-2 mt-1.5 text-[10px] font-mono text-bone/30">
                        <span>v{s.version}</span>
                        {s.improvement_score > 0 && (
                          <span>score {s.improvement_score.toFixed(2)}</span>
                        )}
                        <span className="ml-auto">{formatDate(s.updated_at)}</span>
                      </div>
                    </GlassCard>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {selected && (
          <div className="w-1/2 min-h-0">
            <GlassCard className="p-4 h-full">
              <SkillDetail
                skill={selected}
                onClose={() => setSelectedId(null)}
                onToggle={toggle}
                onChanged={fetchSkills}
              />
            </GlassCard>
          </div>
        )}
      </div>
    </div>
  );
}

export default SkillsView;
