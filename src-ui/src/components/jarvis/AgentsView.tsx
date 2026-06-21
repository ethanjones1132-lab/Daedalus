// ═══════════════════════════════════════════════════════════════
// ── AgentsView — Manage agents: create, edit, enable, bind channels
// ═══════════════════════════════════════════════════════════════
//
// Backed by the SQLite agent surface in src-tauri/src/commands/agents.rs:
//   list_agents() -> Agent[]
//   add_agent(name, model, description?, backend?, systemPrompt?) -> Agent
//   set_agent_identity(id, name?, description?, systemPrompt?, model?)
//   set_agent_enabled(id, enabled)
//   delete_agent(id)
//   bind_agent_channel(agentId, channelId) / unbind_agent_channel(agentId, channelId)
// plus list_channels() for the binding picker.

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

// ── Types ──────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  description: string;
  model: string;
  backend: string;
  system_prompt: string;
  enabled: boolean;
  config: string | null;
  created_at: string;
  updated_at: string;
}

interface Channel {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

interface AgentDraft {
  name: string;
  model: string;
  description: string;
  system_prompt: string;
}

const EMPTY_DRAFT: AgentDraft = { name: '', model: '', description: '', system_prompt: '' };

// ── Helpers ────────────────────────────────────────────────────

function boundChannelIds(agent: Agent): string[] {
  if (!agent.config) return [];
  try {
    const parsed = JSON.parse(agent.config);
    if (Array.isArray(parsed.channels)) {
      return parsed.channels.filter((c: unknown): c is string => typeof c === 'string');
    }
  } catch {
    /* ignore malformed config */
  }
  return [];
}

// ── Editor (create + edit) ─────────────────────────────────────

function AgentEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: AgentDraft;
  onSave: (draft: AgentDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(initial);
  const [saving, setSaving] = useState(false);

  const field = (key: keyof AgentDraft, value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = async () => {
    if (!draft.name.trim() || !draft.model.trim()) return;
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    'w-full px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50';

  return (
    <GlassCard className="p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <input
          className={inputCls}
          placeholder="Name *"
          value={draft.name}
          onChange={(e) => field('name', e.target.value)}
        />
        <input
          className={inputCls}
          placeholder="Model * (e.g. qwen2.5-coder:7b)"
          value={draft.model}
          onChange={(e) => field('model', e.target.value)}
        />
      </div>
      <input
        className={inputCls}
        placeholder="Description"
        value={draft.description}
        onChange={(e) => field('description', e.target.value)}
      />
      <textarea
        className={cn(inputCls, 'resize-none h-24')}
        placeholder="System prompt"
        value={draft.system_prompt}
        onChange={(e) => field('system_prompt', e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-bone/60 hover:text-bone transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={saving || !draft.name.trim() || !draft.model.trim()}
          className="px-3 py-1.5 text-xs rounded-lg bg-accent text-bone hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </GlassCard>
  );
}

// ── Channel binding picker ─────────────────────────────────────

function ChannelBindings({
  agent,
  channels,
  onChanged,
}: {
  agent: Agent;
  channels: Channel[];
  onChanged: () => void;
}) {
  const { error: toastError } = useToast();
  const bound = useMemo(() => new Set(boundChannelIds(agent)), [agent]);

  const toggle = useCallback(
    async (channel: Channel) => {
      const isBound = bound.has(channel.id);
      try {
        await invoke(isBound ? 'unbind_agent_channel' : 'bind_agent_channel', {
          agentId: agent.id,
          channelId: channel.id,
        });
        onChanged();
      } catch (e) {
        toastError(String(e), 'Channel binding failed');
      }
    },
    [agent.id, bound, onChanged, toastError],
  );

  if (channels.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {channels.map((c) => {
        const isBound = bound.has(c.id);
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => toggle(c)}
            className={cn(
              'text-[11px] px-2 py-0.5 rounded-full border transition-colors',
              isBound
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-white/10 text-bone/40 hover:text-bone/70',
            )}
          >
            {isBound ? '● ' : '○ '}
            {c.name}
          </button>
        );
      })}
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────

export function AgentsView() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const { success, error: toastError } = useToast();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agentList, channelList] = await Promise.all([
        invoke<Agent[]>('list_agents'),
        invoke<Channel[]>('list_channels').catch(() => [] as Channel[]),
      ]);
      setAgents(agentList);
      setChannels(channelList);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const create = useCallback(
    async (draft: AgentDraft) => {
      try {
        await invoke<Agent>('add_agent', {
          name: draft.name.trim(),
          model: draft.model.trim(),
          description: draft.description.trim() || null,
          systemPrompt: draft.system_prompt.trim() || null,
        });
        success(`Created agent ${draft.name}`);
        setCreating(false);
        await fetchAll();
      } catch (e) {
        toastError(String(e), 'Create failed');
      }
    },
    [fetchAll, success, toastError],
  );

  const saveEdit = useCallback(
    async (id: string, draft: AgentDraft) => {
      try {
        await invoke('set_agent_identity', {
          id,
          name: draft.name.trim(),
          description: draft.description.trim(),
          systemPrompt: draft.system_prompt.trim(),
          model: draft.model.trim(),
        });
        success('Agent updated');
        setEditingId(null);
        await fetchAll();
      } catch (e) {
        toastError(String(e), 'Update failed');
      }
    },
    [fetchAll, success, toastError],
  );

  const toggleEnabled = useCallback(
    async (agent: Agent) => {
      const next = !agent.enabled;
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, enabled: next } : a)));
      try {
        await invoke('set_agent_enabled', { id: agent.id, enabled: next });
      } catch (e) {
        setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, enabled: !next } : a)));
        toastError(String(e), 'Toggle failed');
      }
    },
    [toastError],
  );

  const remove = useCallback(
    async (agent: Agent) => {
      if (!window.confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) return;
      try {
        await invoke('delete_agent', { id: agent.id });
        success(`Deleted ${agent.name}`);
        await fetchAll();
      } catch (e) {
        toastError(String(e), 'Delete failed');
      }
    },
    [fetchAll, success, toastError],
  );

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="Agents"
        subtitle="Create, configure, and bind agents to channels"
        count={agents.length}
        action={
          <button
            type="button"
            onClick={() => {
              setCreating((c) => !c);
              setEditingId(null);
            }}
            className="px-3 py-1.5 text-xs rounded-lg bg-accent text-bone hover:bg-accent/80 transition-colors"
          >
            {creating ? 'Close' : '+ New agent'}
          </button>
        }
      />

      {creating && (
        <AgentEditor initial={EMPTY_DRAFT} onSave={create} onCancel={() => setCreating(false)} />
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <LoadingState message="Loading agents…" />
        ) : error ? (
          <ErrorState error={error} onRetry={fetchAll} />
        ) : agents.length === 0 ? (
          <EmptyState message="No agents yet. Create one to get started." />
        ) : (
          <ul className="space-y-2">
            {agents.map((a) =>
              editingId === a.id ? (
                <li key={a.id}>
                  <AgentEditor
                    initial={{
                      name: a.name,
                      model: a.model,
                      description: a.description,
                      system_prompt: a.system_prompt,
                    }}
                    onSave={(draft) => saveEdit(a.id, draft)}
                    onCancel={() => setEditingId(null)}
                  />
                </li>
              ) : (
                <li key={a.id}>
                  <GlassCard className="p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <StatusDot ok={a.enabled} warn={!a.enabled} />
                      <h3 className="text-sm font-medium text-bone truncate">{a.name}</h3>
                      <Pill variant="default">{a.model}</Pill>
                      {a.backend && a.backend !== 'jarvis' && (
                        <Pill variant="info">{a.backend}</Pill>
                      )}
                      <div className="ml-auto flex items-center gap-1 text-[11px]">
                        <button
                          type="button"
                          onClick={() => toggleEnabled(a)}
                          className={cn(
                            'px-2 py-0.5 rounded-md border transition-colors',
                            a.enabled
                              ? 'border-amber-500/30 text-amber-200 hover:bg-amber-500/10'
                              : 'border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10',
                          )}
                        >
                          {a.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(a.id);
                            setCreating(false);
                          }}
                          className="px-2 py-0.5 rounded-md border border-white/10 text-bone/60 hover:text-bone transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(a)}
                          className="px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {a.description && (
                      <p className="text-xs text-bone/60 line-clamp-2">{a.description}</p>
                    )}
                    <ChannelBindings agent={a} channels={channels} onChanged={fetchAll} />
                  </GlassCard>
                </li>
              ),
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

export default AgentsView;
