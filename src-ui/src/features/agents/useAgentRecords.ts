import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  reconcileAgents,
  type Agent,
  type AgentExpectation,
  type AgentOperation,
  type AgentOperationAction,
  type AgentOperationPhase,
} from '../../domain/agent-operation-state';
import { useToast } from '../../design';
import type { AgentDraft } from './types';

/*
 * Native Agent rows (SQLite): list, create, edit, enable/disable, delete.
 *
 * Every write is fenced by an operation record that stays in place until a
 * later list read *confirms* the expected state (reconcileAgents). Reads carry
 * a request id so an obsolete pre-write list can never overwrite a newer one.
 */

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

export function useAgentRecords() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const agentsRef = useRef<Agent[]>([]);
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
        if (operation.action === 'edit') successRef.current('Agent record updated');
        if (operation.action === 'enable') successRef.current('Agent record enabled');
        if (operation.action === 'disable') successRef.current('Agent record disabled');
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
    void fetchAgents();
  }, [fetchAgents]);

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

  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  const openCreate = useCallback(() => {
    if (createPending.current) return;
    setCreating(true);
    publishCreatePhase(null);
    setEditing(null);
  }, [publishCreatePhase, setEditing]);

  const cancelCreate = useCallback(() => {
    if (createPending.current) return;
    setCreating(false);
    publishCreatePhase(null);
  }, [publishCreatePhase]);

  const beginEdit = useCallback((id: string) => {
    if (creating || createPending.current || operationsRef.current[id]) return;
    setEditing(id);
  }, [creating, setEditing]);

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

  const createLocked = createPhase !== null && createPhase !== 'write-failed';

  return {
    agents,
    loaded,
    loading,
    listError,
    operations,
    creating,
    createPhase,
    createLocked,
    editingId,
    pendingDelete,
    refresh: fetchAgents,
    reading,
    retryRead,
    create,
    saveEdit,
    toggleEnabled,
    retryMutation,
    remove,
    confirmDelete,
    cancelDelete,
    openCreate,
    cancelCreate,
    beginEdit,
    cancelEdit,
  };
}
