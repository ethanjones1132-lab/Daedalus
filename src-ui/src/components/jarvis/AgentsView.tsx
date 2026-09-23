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
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { initialBindingState, reduceBindingState } from './agent-binding-state';
import { initialDiscoveryState, reduceDiscoveryState, type LifecycleAgent } from './agent-discovery-state';
import {
  agentOperationLocked,
  reconcileAgents,
  type Agent,
  type AgentExpectation,
  type AgentOperation,
  type AgentOperationAction,
  type AgentOperationPhase,
} from './agent-operation-state';
import {
  cn,
  ConfirmModal,
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
  LoadingState,
  EmptyState,
  useToast,
} from '../ui';

// ── Types ──────────────────────────────────────────────────────

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

function expectedFromDraft(draft: AgentDraft, enabled: boolean): AgentExpectation {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    model: draft.model.trim(),
    system_prompt: draft.system_prompt.trim(),
    enabled,
  };
}

function expectedFromAgent(agent: Agent): AgentExpectation {
  return {
    name: agent.name,
    description: agent.description,
    model: agent.model,
    system_prompt: agent.system_prompt,
    enabled: agent.enabled,
  };
}

// ── Helpers ────────────────────────────────────────────────────

// ── Editor (create + edit) ─────────────────────────────────────

function AgentEditor({
  initial,
  onSave,
  onCancel,
  locked = false,
  phase = null,
  failureMessage = 'Agent change failed. Your draft was kept.',
  onRetryRead,
}: {
  initial: AgentDraft;
  onSave: (draft: AgentDraft) => Promise<void>;
  onCancel: () => void;
  locked?: boolean;
  phase?: AgentOperationPhase | null;
  failureMessage?: string;
  onRetryRead?: () => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(initial);
  const [saving, setSaving] = useState(false);
  const busy = locked || saving;

  const field = (key: keyof AgentDraft, value: string) => {
    if (!busy) setDraft((d) => ({ ...d, [key]: value }));
  };

  const submit = async () => {
    if (busy || !draft.name.trim() || !draft.model.trim()) return;
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    'w-full px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50';
  const invalid = !draft.name.trim() || !draft.model.trim();

  return (
    <GlassCard className="p-4 space-y-3">
      <fieldset disabled={busy} className="space-y-3 border-0 p-0 m-0 min-w-0">
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
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-bone/60 hover:text-bone transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || invalid}
            className="px-3 py-1.5 text-xs rounded-lg bg-accent text-bone hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </fieldset>
      {phase === 'writing' && <p role="status">Saving agent…</p>}
      {phase === 'reconciling' && <p role="status">Change saved. Reconciling agents…</p>}
      {phase === 'write-failed' && (
        <div role="alert" className="text-xs text-red-200">
          {failureMessage}{' '}
          <button type="button" className="underline" onClick={submit} disabled={saving || invalid}>Retry</button>
        </div>
      )}
      {phase === 'read-failed' && (
        <div role="alert" className="text-xs text-red-200">
          Change saved, but the agent list could not be reconciled. Showing previous state. Retry reloads the list only.{' '}
          <button type="button" className="underline disabled:opacity-40" disabled={saving} onClick={onRetryRead}>Retry</button>
        </div>
      )}
    </GlassCard>
  );
}

// ── Channel binding picker ─────────────────────────────────────

function ChannelBindings({
  agent,
  channels,
  channelsReady,
  locked = false,
}: {
  agent: Agent;
  channels: Channel[];
  channelsReady: boolean;
  locked?: boolean;
}) {
  const [state, dispatch] = useReducer(reduceBindingState, initialBindingState);
  // One Agent snapshot is returned by the native read, so serialize its writes
  // and reads together. Other Agents' pickers remain independent.
  const pending = useRef(false);

  const readBindings = useCallback(async () => {
    try {
      const ids = await invoke<string[]>('list_agent_channel_bindings', { agentId: agent.id });
      dispatch({ type: 'success', ids });
    } catch {
      dispatch({ type: 'failure', error: 'read' });
    }
  }, [agent.id]);

  const refreshBindings = useCallback(async () => {
    if (locked || pending.current) return;
    pending.current = true;
    dispatch({ type: 'pending', phase: 'loading' });
    try {
      await readBindings();
    } finally {
      pending.current = false;
    }
  }, [readBindings]);

  useEffect(() => {
    void refreshBindings();
  }, [refreshBindings]);

  const toggle = async (channel: Channel) => {
    if (locked || pending.current || !channelsReady || state.phase !== 'ready' || state.bound === null) return;
    pending.current = true;
    dispatch({ type: 'pending', phase: 'updating' });
    try {
      await invoke(state.bound.includes(channel.id) ? 'unbind_agent_channel' : 'bind_agent_channel', {
        agentId: agent.id,
        channelId: channel.id,
      });
      // This read catches its own error: a failed reconciliation is not a
      // failed write, and Retry must never blindly repeat a settled mutation.
      await readBindings();
    } catch {
      dispatch({ type: 'failure', error: 'write' });
    } finally {
      pending.current = false;
    }
  };

  const busy = locked || state.phase === 'loading' || state.phase === 'updating';
  return (
    <div className="space-y-1.5 mt-2 text-[11px] text-bone/60">
      {busy && (
        <p role="status" aria-label={`Channel bindings for ${agent.name}`}>
          {state.phase === 'updating' ? 'Updating channel bindings…' : 'Loading channel bindings…'}
        </p>
      )}
      {state.error && (
        <p role="alert">
          {state.error === 'write' ? 'Could not change channel binding. Reload bindings before trying again. ' : 'Channel bindings are unavailable. '}
          {state.bound !== null && 'Showing previously loaded bindings; they may be stale.'}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void refreshBindings()}
        aria-label={`${state.error ? 'Retry' : 'Refresh'} bindings for ${agent.name}`}
        className="px-2 py-0.5 rounded-md border border-white/10 disabled:opacity-40"
      >
        {state.error ? 'Retry bindings' : 'Refresh bindings'}
      </button>
      <div className="flex flex-wrap gap-1.5">
        {channels.map((c) => {
          const isBound = state.bound?.includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              disabled={locked || !channelsReady || state.phase !== 'ready'}
              aria-pressed={isBound}
              onClick={() => void toggle(c)}
              className={cn(
                'text-[11px] px-2 py-0.5 rounded-full border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                isBound
                  ? 'border-accent/40 bg-accent/10 text-accent'
                  : 'border-white/10 text-bone/40 hover:text-bone/70',
              )}
            >
              {isBound === undefined ? '? ' : isBound ? '● ' : '○ '}
              {c.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────

export function AgentsView() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const agentsRef = useRef<Agent[]>([]);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [channelsError, setChannelsError] = useState(false);
  const channelsPending = useRef(false);
  const [discovery, dispatchDiscovery] = useReducer(reduceDiscoveryState, initialDiscoveryState);
  const discoveryPending = useRef(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createPhase, setCreatePhase] = useState<AgentOperationPhase | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingIdRef = useRef<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [operations, setOperations] = useState<Record<string, AgentOperation>>({});
  const operationsRef = useRef<Record<string, AgentOperation>>({});
  const requestId = useRef(0);
  const reading = useRef(false);
  const createPending = useRef(false);
  const createOperationId = useRef<string | null>(null);
  const createName = useRef('');
  const toast = useToast();
  const successRef = useRef(toast.success);
  successRef.current = toast.success;

  const publishOperations = useCallback((next: Record<string, AgentOperation>) => {
    operationsRef.current = next;
    setOperations(next);
  }, []);

  const publishCreatePhase = useCallback((phase: AgentOperationPhase | null) => {
    createPending.current = phase !== null && phase !== 'write-failed';
    setCreatePhase(phase);
  }, []);

  const setEditing = useCallback((id: string | null) => {
    editingIdRef.current = id;
    setEditingId(id);
  }, []);

  const completeCreate = useCallback((id: string) => {
    if (createOperationId.current !== id) return;
    const name = createName.current;
    createOperationId.current = null;
    createName.current = '';
    publishCreatePhase(null);
    setCreating(false);
    successRef.current(`Created agent ${name}`);
  }, [publishCreatePhase]);

  const fetchLifecycle = useCallback(async () => {
    if (discoveryPending.current) return;
    discoveryPending.current = true;
    dispatchDiscovery({ type: 'pending' });
    try {
      const res = await fetch('http://127.0.0.1:19877/agents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as LifecycleAgent[];
      dispatchDiscovery({ type: 'success', agents: data });
    } catch {
      dispatchDiscovery({ type: 'failure' });
    } finally {
      discoveryPending.current = false;
    }
  }, []);

  const fetchChannels = useCallback(async () => {
    if (channelsPending.current) return;
    channelsPending.current = true;
    setChannelsLoading(true);
    try {
      setChannels(await invoke<Channel[]>('list_channels'));
      setChannelsError(false);
    } catch {
      setChannelsError(true);
    } finally {
      channelsPending.current = false;
      setChannelsLoading(false);
    }
  }, []);

  const fetchAgents = useCallback(async () => {
    const request = ++requestId.current;
    reading.current = true;
    setLoading(true);
    try {
      const snapshot = await invoke<Agent[]>('list_agents');
      if (request !== requestId.current) return;
      const result = reconcileAgents(snapshot, operationsRef.current, request);
      const previous = operationsRef.current;
      publishOperations(result.operations);
      agentsRef.current = result.rows;
      setAgents(result.rows);
      setLoaded(true);
      setListError(null);
      for (const id of result.confirmed) {
        const operation = previous[id];
        if (!operation) continue;
        if (operation.action === 'edit') successRef.current('Agent updated');
        if (operation.action === 'enable') successRef.current('Agent enabled');
        if (operation.action === 'disable') successRef.current('Agent disabled');
        if (operation.action === 'delete' && operation.row) successRef.current(`Deleted ${operation.row.name}`);
        if (operation.action === 'edit' && editingIdRef.current === id) setEditing(null);
      }
      const createId = createOperationId.current;
      if (createId && result.confirmed.includes(createId)) completeCreate(createId);
    } catch {
      if (request !== requestId.current) return;
      const next = { ...operationsRef.current };
      let rowFailure = false;
      for (const [id, operation] of Object.entries(next)) {
        if (operation.phase === 'reconciling' || operation.phase === 'read-failed') {
          next[id] = { ...operation, phase: 'read-failed' };
          rowFailure = true;
        }
      }
      publishOperations(next);
      const createId = createOperationId.current;
      if (createId && next[createId]?.phase === 'read-failed') publishCreatePhase('read-failed');
      if (!rowFailure) setListError('Agents are unavailable. Retry reloads the list only.');
    } finally {
      if (request === requestId.current) {
        reading.current = false;
        setLoading(false);
      }
    }
  }, [completeCreate, publishCreatePhase, publishOperations, setEditing]);

  const retryRead = useCallback(() => {
    if (reading.current) return;
    const next = { ...operationsRef.current };
    for (const [id, operation] of Object.entries(next)) {
      if (operation.phase === 'read-failed') next[id] = { ...operation, phase: 'reconciling', after: requestId.current };
    }
    publishOperations(next);
    const createId = createOperationId.current;
    if (createId && next[createId]?.phase === 'reconciling') publishCreatePhase('reconciling');
    void fetchAgents();
  }, [fetchAgents, publishCreatePhase, publishOperations]);

  useEffect(() => {
    void fetchChannels();
    void fetchLifecycle();
    void fetchAgents();
  }, [fetchAgents, fetchChannels, fetchLifecycle]);

  const invalidateAgentReads = useCallback(() => {
    requestId.current += 1;
    reading.current = false;
  }, []);

  const startOperation = useCallback((
    agent: Agent,
    action: Exclude<AgentOperationAction, 'create'>,
    draft?: AgentDraft,
  ): AgentOperation | null => {
    const existing = operationsRef.current[agent.id];
    if (existing && (existing.phase !== 'write-failed' || existing.action !== action)) return null;
    invalidateAgentReads();
    const expected = action === 'edit' && draft
      ? expectedFromDraft(draft, agent.enabled)
      : action === 'enable' || action === 'disable'
        ? { ...expectedFromAgent(agent), enabled: action === 'enable' }
        : expectedFromAgent(agent);
    const operation: AgentOperation = {
      id: agent.id,
      row: agent,
      action,
      phase: 'writing',
      after: requestId.current,
      expected,
    };
    publishOperations({ ...operationsRef.current, [agent.id]: operation });
    return operation;
  }, [invalidateAgentReads, publishOperations]);

  const mutate = useCallback(async (
    agent: Agent,
    action: Exclude<AgentOperationAction, 'create'>,
    draft?: AgentDraft,
  ) => {
    const operation = startOperation(agent, action, draft);
    if (!operation) return;
    try {
      if (action === 'edit') {
        await invoke('set_agent_identity', {
          id: agent.id,
          name: operation.expected.name,
          description: operation.expected.description,
          systemPrompt: operation.expected.system_prompt,
          model: operation.expected.model,
        });
      } else if (action === 'enable' || action === 'disable') {
        await invoke('set_agent_enabled', { id: agent.id, enabled: operation.expected.enabled });
      } else {
        await invoke('delete_agent', { id: agent.id });
      }
      const reconciling = { ...operation, phase: 'reconciling' as const, after: requestId.current };
      publishOperations({ ...operationsRef.current, [agent.id]: reconciling });
      if (action === 'delete') setPendingDelete((current) => current === agent.id ? null : current);
      await fetchAgents();
    } catch {
      const failed = { ...operation, phase: 'write-failed' as const, after: requestId.current };
      publishOperations({ ...operationsRef.current, [agent.id]: failed });
      if (action === 'delete') setPendingDelete((current) => current === agent.id ? null : current);
      setLoading(false);
    }
  }, [fetchAgents, publishOperations, startOperation]);

  const create = useCallback(async (draft: AgentDraft) => {
    if (createPending.current) return;
    const expected = expectedFromDraft(draft, true);
    invalidateAgentReads();
    publishCreatePhase('writing');
    createName.current = expected.name;
    try {
      const created = await invoke<Agent>('add_agent', {
        name: expected.name,
        model: expected.model,
        description: expected.description || null,
        systemPrompt: expected.system_prompt || null,
      });
      if (!created?.id) throw new Error('Create did not return an Agent');
      const operation: AgentOperation = {
        id: created.id,
        row: null,
        action: 'create',
        phase: 'reconciling',
        after: requestId.current,
        expected,
      };
      createOperationId.current = created.id;
      publishOperations({ ...operationsRef.current, [created.id]: operation });
      publishCreatePhase('reconciling');
      await fetchAgents();
    } catch {
      publishCreatePhase('write-failed');
      setLoading(false);
    }
  }, [fetchAgents, invalidateAgentReads, publishCreatePhase, publishOperations]);

  const saveEdit = useCallback(async (id: string, draft: AgentDraft) => {
    const agent = agentsRef.current.find((candidate) => candidate.id === id);
    if (!agent) return;
    await mutate(agent, 'edit', draft);
  }, [mutate]);

  const toggleEnabled = useCallback((agent: Agent) => {
    void mutate(agent, agent.enabled ? 'disable' : 'enable');
  }, [mutate]);

  const retryMutation = useCallback((agent: Agent, action: Exclude<AgentOperationAction, 'create'>) => {
    if (action === 'delete') {
      setPendingDelete(agent.id);
      return;
    }
    void mutate(agent, action);
  }, [mutate]);

  const remove = useCallback((agent: Agent) => {
    const operation = operationsRef.current[agent.id];
    if (operation && operation.action !== 'delete') return;
    setPendingDelete(agent.id);
  }, []);

  const confirmDelete = useCallback(() => {
    if (!pendingDelete) return;
    const agent = agentsRef.current.find((candidate) => candidate.id === pendingDelete);
    if (!agent) {
      setPendingDelete(null);
      return;
    }
    void mutate(agent, 'delete');
  }, [mutate, pendingDelete]);

  const toggleCreating = useCallback(() => {
    if (createPending.current) return;
    if (creating) {
      setCreating(false);
      publishCreatePhase(null);
      return;
    }
    setCreating(true);
    publishCreatePhase(null);
    setEditing(null);
  }, [creating, publishCreatePhase, setEditing]);

  const cancelCreate = useCallback(() => {
    if (createPending.current) return;
    setCreating(false);
    publishCreatePhase(null);
  }, [publishCreatePhase]);

  const beginEdit = useCallback((id: string) => {
    if (creating || createPending.current || operationsRef.current[id]) return;
    setEditing(id);
  }, [createPending, creating, setEditing]);

  const cancelEdit = useCallback(() => {
    const operation = editingIdRef.current ? operationsRef.current[editingIdRef.current] : undefined;
    if (operation && operation.phase !== 'write-failed') return;
    if (operation) {
      const next = { ...operationsRef.current };
      delete next[editingIdRef.current as string];
      publishOperations(next);
    }
    setEditing(null);
  }, [publishOperations, setEditing]);

  const deleteAgent = pendingDelete ? agentsRef.current.find((candidate) => candidate.id === pendingDelete) : undefined;
  const deleteOperation = pendingDelete ? operations[pendingDelete] : undefined;
  const deleting = deleteOperation?.action === 'delete' && deleteOperation.phase === 'writing';

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <ConfirmModal
        open={pendingDelete !== null && deleteAgent !== undefined}
        message={`Delete agent "${deleteAgent?.name ?? ''}"?`}
        detail={deleting ? 'Saving deletion. Repeated confirmation will not submit another write.' : deleteOperation && agentOperationLocked(deleteOperation) ? 'Another change is pending. Removal is unavailable until reconciliation.' : 'This cannot be undone.'}
        confirmLabel={deleting ? 'Deleting…' : 'Delete'}
        danger
        onConfirm={confirmDelete}
        onCancel={() => { if (!deleting) setPendingDelete(null); }}
      />
      <SectionHeader
        title="Agents"
        subtitle="Create, configure, and bind agents to channels"
        count={agents.length}
        action={
          <button
            type="button"
            onClick={toggleCreating}
            disabled={createPending.current}
            className="px-3 py-1.5 text-xs rounded-lg bg-accent text-bone hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {creating ? 'Close' : '+ New agent'}
          </button>
        }
      />

      {creating && (
        <AgentEditor
          initial={EMPTY_DRAFT}
          onSave={create}
          onCancel={cancelCreate}
          locked={createPending.current}
          phase={createPhase}
          failureMessage="Could not create the agent. Your draft was kept."
          onRetryRead={retryRead}
        />
      )}

      <GlassCard className="p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-bone/80">Lifecycle agents (disk scan)</h3>
          <button
            type="button"
            onClick={() => void fetchLifecycle()}
            disabled={discovery.loading}
            className="text-[11px] px-2 py-0.5 rounded-md border border-white/10 text-bone/60 hover:text-bone transition-colors disabled:opacity-40"
          >
            {discovery.error ? 'Retry discovery' : 'Refresh discovery'}
          </button>
        </div>
        {discovery.loading && (
          <p role="status" aria-label="Agent discovery" className="text-xs text-bone/60">
            {discovery.agents === null ? 'Loading agent discovery…' : 'Refreshing agent discovery… Showing previous results.'}
          </p>
        )}
        {discovery.error && (
          <p role="alert" className="text-xs text-red-300">
            Agent discovery is unavailable. {discovery.agents !== null && 'Showing previously discovered agents; they may be stale.'}
          </p>
        )}
        {!discovery.loading && !discovery.error && discovery.agents?.length === 0 && (
          <p className="text-xs text-bone/40">No agents discovered in agents root.</p>
        )}
        {discovery.agents !== null && discovery.agents.length > 0 && (
          <ul className="space-y-1">
            {discovery.agents.map((a) => (
              <li key={a.id} className="flex items-center justify-between text-xs">
                <span className="text-bone truncate">{a.slug}</span>
                <Pill variant={a.status === 'valid' ? 'success' : a.status === 'invalid' ? 'error' : 'default'}>
                  {a.status}
                </Pill>
              </li>
            ))}
          </ul>
        )}
      </GlassCard>

      <div className="text-xs text-bone/60 space-y-1">
        {channelsLoading && <p role="status" aria-label="Agent channels">Loading channels…</p>}
        {channelsError && (
          <p role="alert">
            Channels are unavailable. {channels !== null && 'Showing previously loaded channels; they may be stale.'}
          </p>
        )}
        {!channelsLoading && !channelsError && channels?.length === 0 && <p>No channels available.</p>}
        <button
          type="button"
          disabled={channelsLoading}
          onClick={() => void fetchChannels()}
          className="px-2 py-0.5 rounded-md border border-white/10 disabled:opacity-40"
        >
          {channelsError ? 'Retry channels' : 'Refresh channels'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {listError && (
          <div role="alert" className="text-sm text-red-200">
            {listError} {loaded && 'Previously loaded agents may be stale.'}{' '}
            <button type="button" onClick={retryRead} disabled={loading} className="underline disabled:opacity-40">Retry</button>
          </div>
        )}
        {loaded && loading && <p role="status" className="text-xs text-bone/60">Refreshing agents…</p>}
        {!loaded && !listError ? (
          <LoadingState message="Loading agents…" />
        ) : loaded && agents.length === 0 && !listError ? (
          <EmptyState message="No agents yet. Create one to get started." />
        ) : loaded ? (
          <ul className="space-y-2">
            {agents.map((a) => {
              const operation = operations[a.id];
              const rowLocked = operation !== undefined;
              if (editingId === a.id) {
                return (
                  <li key={a.id}>
                    <AgentEditor
                      initial={{
                        name: a.name,
                        model: a.model,
                        description: a.description,
                        system_prompt: a.system_prompt,
                      }}
                      onSave={(draft) => saveEdit(a.id, draft)}
                      onCancel={cancelEdit}
                      locked={agentOperationLocked(operation)}
                      phase={operation?.phase ?? null}
                      failureMessage="Could not update the agent. Your draft was kept."
                      onRetryRead={retryRead}
                    />
                  </li>
                );
              }
              return (
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
                          disabled={rowLocked}
                          className={cn(
                            'px-2 py-0.5 rounded-md border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                            a.enabled
                              ? 'border-amber-500/30 text-amber-200 hover:bg-amber-500/10'
                              : 'border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10',
                          )}
                        >
                          {a.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() => beginEdit(a.id)}
                          disabled={rowLocked}
                          className="px-2 py-0.5 rounded-md border border-white/10 text-bone/60 hover:text-bone transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(a)}
                          disabled={rowLocked}
                          className="px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {a.description && (
                      <p className="text-xs text-bone/60 line-clamp-2">{a.description}</p>
                    )}
                    {operation && operation.action !== 'edit' && operation.phase === 'writing' && (
                      <p role="status" className="text-xs text-bone/60">Saving agent change…</p>
                    )}
                    {operation && operation.action !== 'edit' && operation.phase === 'reconciling' && (
                      <p role="status" className="text-xs text-bone/60">Change saved. Reconciling agents…</p>
                    )}
                    {operation && operation.action !== 'edit' && operation.phase === 'write-failed' && (
                      <div role="alert" className="text-xs text-red-200">
                        Agent change failed. Confirmed state was kept.{' '}
                        <button type="button" className="underline" onClick={() => retryMutation(a, operation.action as Exclude<AgentOperationAction, 'create'>)}>Retry</button>
                      </div>
                    )}
                    {operation && operation.action !== 'edit' && operation.phase === 'read-failed' && (
                      <div role="alert" className="text-xs text-red-200">
                        Change saved, but the agent list could not be reconciled. Showing previous state. Retry reloads the list only.{' '}
                        <button type="button" className="underline disabled:opacity-40" disabled={loading} onClick={retryRead}>Retry</button>
                      </div>
                    )}
                    <ChannelBindings
                      agent={a}
                      channels={channels ?? []}
                      channelsReady={!channelsLoading && !channelsError && channels !== null}
                      locked={rowLocked}
                    />
                  </GlassCard>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export default AgentsView;
