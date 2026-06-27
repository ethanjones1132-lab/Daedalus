import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  cn,
  GlassCard,
  SectionHeader,
  LoadingState,
  ErrorState,
  EmptyState,
  useToast,
} from '../ui';

export function SettingsView() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const { success, error: toastError } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await invoke<Record<string, string>>('get_all_settings');
      setSettings(s);
      setEditing(s);
      setDirty(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleChange = (key: string, value: string) => {
    setEditing(prev => ({ ...prev, [key]: value }));
    setDirty(prev => {
      const next = new Set(prev);
      if (value !== settings[key]) next.add(key); else next.delete(key);
      return next;
    });
  };

  const saveKey = async (key: string) => {
    setSaving(prev => new Set(prev).add(key));
    try {
      await invoke('set_setting', { key, value: editing[key] });
      setSettings(prev => ({ ...prev, [key]: editing[key] }));
      setDirty(prev => { const n = new Set(prev); n.delete(key); return n; });
      success(`Saved ${key}`);
    } catch (e) {
      toastError(String(e), `Failed to save ${key}`);
    } finally {
      setSaving(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  const filteredKeys = Object.keys(editing)
    .filter(k => !filter || k.toLowerCase().includes(filter.toLowerCase()) || editing[k].toLowerCase().includes(filter.toLowerCase()))
    .sort();

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="Settings"
        subtitle="Raw key-value settings persisted in the Jarvis SQLite database"
        action={
          <button
            type="button"
            onClick={load}
            className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-bone/60 hover:text-bone transition-colors"
          >
            Reload
          </button>
        }
      />

      {!loading && !error && (
        <input
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter settings…"
          className="w-full px-3 py-2 text-xs font-mono bg-white/5 border border-white/10 rounded-lg text-bone placeholder:text-bone/30 focus:outline-none focus:border-white/20 transition-colors"
        />
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <LoadingState message="Loading settings…" />
        ) : error ? (
          <ErrorState error={error} onRetry={load} />
        ) : filteredKeys.length === 0 ? (
          <EmptyState message={filter ? `No settings match "${filter}".` : 'No settings stored yet.'} />
        ) : (
          <ul className="space-y-2">
            {filteredKeys.map(key => {
              const isDirty = dirty.has(key);
              const isSaving = saving.has(key);
              const isLong = (editing[key] ?? '').length > 60;
              return (
                <li key={key}>
                  <GlassCard className={cn('p-3', isDirty && 'border-amber-400/30')}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[10px] font-mono text-bone/60 truncate flex-1">{key}</span>
                      {isDirty && (
                        <button
                          type="button"
                          onClick={() => saveKey(key)}
                          disabled={isSaving}
                          className="px-2 py-0.5 text-[10px] font-mono rounded border border-amber-400/40 text-amber-300 hover:bg-amber-400/10 disabled:opacity-50 transition-colors shrink-0"
                        >
                          {isSaving ? 'Saving…' : 'Save'}
                        </button>
                      )}
                    </div>
                    {isLong ? (
                      <textarea
                        value={editing[key] ?? ''}
                        onChange={e => handleChange(key, e.target.value)}
                        rows={3}
                        className="w-full px-2 py-1.5 text-xs font-mono bg-white/5 border border-white/10 rounded text-bone resize-y focus:outline-none focus:border-white/20 transition-colors"
                      />
                    ) : (
                      <input
                        type="text"
                        value={editing[key] ?? ''}
                        onChange={e => handleChange(key, e.target.value)}
                        className="w-full px-2 py-1.5 text-xs font-mono bg-white/5 border border-white/10 rounded text-bone focus:outline-none focus:border-white/20 transition-colors"
                      />
                    )}
                  </GlassCard>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {dirty.size > 0 && (
        <div className="shrink-0 text-[10px] font-mono text-amber-300/70 text-center">
          {dirty.size} unsaved change{dirty.size > 1 ? 's' : ''} — click Save on each row to persist
        </div>
      )}
    </div>
  );
}

export default SettingsView;
