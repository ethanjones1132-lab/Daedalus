import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
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

interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  api_base: string;
  max_tokens: number;
  temperature: number;
  top_p: number;
  system_prompt: string;
  is_active: boolean;
  engine: string;
  created_at: string;
}

interface NewProfileForm {
  name: string;
  provider: string;
  model: string;
  api_base: string;
  max_tokens: number;
  temperature: number;
  engine: string;
}

const DEFAULT_FORM: NewProfileForm = {
  name: '',
  provider: 'openrouter',
  model: '',
  api_base: 'https://openrouter.ai/api/v1',
  max_tokens: 4096,
  temperature: 0.7,
  engine: 'native',
};

export function ModelProfilesView() {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState<NewProfileForm>(DEFAULT_FORM);
  const [creating, setCreating] = useState(false);
  const { success, error: toastError } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<ModelProfile[]>('list_model_profiles');
      setProfiles(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const activate = useCallback(async (profile: ModelProfile) => {
    setProfiles(prev => prev.map(p => ({ ...p, is_active: p.id === profile.id })));
    try {
      await invoke('set_active_profile', { id: profile.id });
      success(`Activated "${profile.name}"`);
      await load();
    } catch (e) {
      toastError(String(e), 'Activation failed');
      await load();
    }
  }, [load, success, toastError]);

  const remove = useCallback(async (profile: ModelProfile) => {
    if (!window.confirm(`Delete profile "${profile.name}"?`)) return;
    try {
      await invoke('delete_profile', { id: profile.id });
      success(`Deleted "${profile.name}"`);
      await load();
    } catch (e) {
      toastError(String(e), 'Delete failed');
    }
  }, [load, success, toastError]);

  const create = useCallback(async () => {
    if (!form.name.trim() || !form.model.trim()) {
      toastError('Name and model are required.', 'Validation error');
      return;
    }
    setCreating(true);
    try {
      // The Rust `create_profile` command takes flat args (and names the provider
      // `backend`), not a wrapped `profile` object — sending `{ profile }` failed
      // arg-deserialization, so Create silently never worked.
      await invoke('create_profile', {
        name: form.name,
        backend: form.provider,
        model: form.model,
        temperature: form.temperature,
        max_tokens: form.max_tokens,
        top_p: 1.0,
        engine: form.engine,
      });
      success(`Created "${form.name}"`);
      setForm(DEFAULT_FORM);
      setShowNew(false);
      await load();
    } catch (e) {
      toastError(String(e), 'Create failed');
    } finally {
      setCreating(false);
    }
  }, [form, load, success, toastError]);

  const activeProfile = profiles.find(p => p.is_active) ?? null;

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="Model Profiles"
        subtitle="Saved inference configurations — activate one to make it the default"
        action={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={load}
              className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-bone/60 hover:text-bone transition-colors"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setShowNew(s => !s)}
              className={cn(
                'px-3 py-1.5 text-xs rounded-lg border transition-colors',
                showNew
                  ? 'bg-white/10 border-white/20 text-bone'
                  : 'border-white/10 text-bone/60 hover:text-bone',
              )}
            >
              {showNew ? '✕ Cancel' : '+ New profile'}
            </button>
          </div>
        }
      />

      {/* New-profile form */}
      {showNew && (
        <GlassCard className="p-4 space-y-3">
          <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40 mb-1">
            New profile
          </div>
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                { key: 'name', label: 'Name', placeholder: 'My profile' },
                { key: 'provider', label: 'Provider', placeholder: 'openrouter' },
                { key: 'model', label: 'Model ID', placeholder: 'qwen/qwen3-coder:free' },
                { key: 'api_base', label: 'API Base', placeholder: 'https://openrouter.ai/api/v1' },
              ] as const
            ).map(({ key, label, placeholder }) => (
              <div key={key}>
                <label className="block text-[10px] font-mono text-bone/50 mb-1">{label}</label>
                <input
                  type="text"
                  value={form[key]}
                  onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  className="w-full px-2 py-1.5 text-xs font-mono bg-white/5 border border-white/10 rounded text-bone placeholder:text-bone/30 focus:outline-none focus:border-white/20 transition-colors"
                />
              </div>
            ))}
            <div>
              <label className="block text-[10px] font-mono text-bone/50 mb-1">Max tokens</label>
              <input
                type="number"
                value={form.max_tokens}
                onChange={e => setForm(f => ({ ...f, max_tokens: parseInt(e.target.value) || 4096 }))}
                className="w-full px-2 py-1.5 text-xs font-mono bg-white/5 border border-white/10 rounded text-bone focus:outline-none focus:border-white/20 transition-colors"
              />
            </div>
            <div>
              <label className="block text-[10px] font-mono text-bone/50 mb-1">Temperature</label>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={form.temperature}
                onChange={e => setForm(f => ({ ...f, temperature: parseFloat(e.target.value) || 0.7 }))}
                className="w-full px-2 py-1.5 text-xs font-mono bg-white/5 border border-white/10 rounded text-bone focus:outline-none focus:border-white/20 transition-colors"
              />
            </div>
          </div>
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={create}
              disabled={creating}
              className="px-4 py-1.5 text-xs font-mono rounded-lg border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-50 transition-colors"
            >
              {creating ? 'Creating…' : 'Create profile'}
            </button>
          </div>
        </GlassCard>
      )}

      <div className="flex-1 overflow-y-auto min-h-0 space-y-2">
        {loading ? (
          <LoadingState message="Loading profiles…" />
        ) : error ? (
          <ErrorState error={error} onRetry={load} />
        ) : profiles.length === 0 ? (
          <EmptyState message="No model profiles yet. Create one above to get started." />
        ) : (
          <>
            {activeProfile && (
              <div className="text-[10px] font-mono text-bone/40 px-1 mb-1">
                Active: <span className="text-emerald-300">{activeProfile.name}</span>
                {' · '}{activeProfile.model}
              </div>
            )}
            {profiles.map(profile => (
              <GlassCard
                key={profile.id}
                className={cn('p-3', profile.is_active && 'border-emerald-500/30 bg-white/[0.05]')}
              >
                <div className="flex items-center gap-2">
                  <StatusDot ok={profile.is_active} warn={!profile.is_active} />
                  <span className="text-sm font-medium text-bone truncate">{profile.name}</span>
                  <Pill variant="info">{profile.provider}</Pill>
                  <Pill variant="default">{profile.model}</Pill>
                  {profile.is_active && <Pill variant="success">active</Pill>}
                  <div className="ml-auto flex items-center gap-1 shrink-0">
                    {!profile.is_active && (
                      <button
                        type="button"
                        onClick={() => activate(profile)}
                        className="px-2 py-0.5 text-[11px] font-mono rounded border border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10 transition-colors"
                      >
                        Activate
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(profile)}
                      className="px-2 py-0.5 text-[11px] font-mono rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <div className="mt-1.5 text-[10px] font-mono text-bone/35">
                  engine: {profile.engine}
                  {' · '}temp {profile.temperature}
                  {' · '}{profile.max_tokens} tok
                  {profile.api_base && ` · ${profile.api_base}`}
                </div>
              </GlassCard>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export default ModelProfilesView;
