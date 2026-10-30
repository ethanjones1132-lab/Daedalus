import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { initialDiscoveryState, parseDiscoveryPayload, reduceDiscoveryState, type LifecycleAgent } from '../../domain/agent-discovery-state';
import { canActivateLifecycle, canDeactivateLifecycle, type AgentProjection } from '../../domain/agent-lifecycle-state';
import { useToast } from '../../design';
import { BUN_URL, type LifecycleMutationResponse, type LifecycleOperation } from './types';

/*
 * Agent lifecycle: discover (Bun GET /agents) -> validate -> project (native
 * Runtime projection) -> activate. Activation is a two-phase write; each phase
 * is confirmed by readback and a failed readback never repeats a native write.
 *   activate:   Bun POST /agents/:slug/activate -> native activate_agent_projection -> re-read both
 *   deactivate: native deactivate_agent_projection -> Bun POST .../deactivate -> re-read both
 */
export function useAgentLifecycle() {
  const [discovery, dispatchDiscovery] = useReducer(reduceDiscoveryState, initialDiscoveryState);
  const discoveryPending = useRef(false);
  const [projections, setProjections] = useState<AgentProjection[] | null>(null);
  const [projectionsLoading, setProjectionsLoading] = useState(true);
  const [projectionsError, setProjectionsError] = useState(false);
  const projectionsPending = useRef(false);
  const [operations, setOperations] = useState<Record<string, LifecycleOperation>>({});
  const operationsRef = useRef<Record<string, LifecycleOperation>>({});
  const toast = useToast();
  const successRef = useRef(toast.success);
  successRef.current = toast.success;

  const publishOperations = useCallback((next: Record<string, LifecycleOperation>) => {
    operationsRef.current = next;
    setOperations(next);
  }, []);

  const fetchLifecycle = useCallback(async (): Promise<LifecycleAgent[] | null> => {
    if (discoveryPending.current) return null;
    discoveryPending.current = true;
    dispatchDiscovery({ type: 'pending' });
    try {
      const res = await fetch(`${BUN_URL}/agents`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Both server shapes are accepted: the bare array (older surface) and
      // the object that also states what the Agents root is.
      const { agents, rootVerdict, rootResolvedPath } = parseDiscoveryPayload(await res.json());
      dispatchDiscovery({ type: 'success', agents, rootVerdict, rootResolvedPath });
      return agents;
    } catch {
      dispatchDiscovery({ type: 'failure' });
      return null;
    } finally {
      discoveryPending.current = false;
    }
  }, []);

  const fetchProjections = useCallback(async (): Promise<AgentProjection[] | null> => {
    if (projectionsPending.current) return null;
    projectionsPending.current = true;
    setProjectionsLoading(true);
    try {
      const data = await invoke<AgentProjection[]>('list_agent_projections');
      setProjections(data);
      setProjectionsError(false);
      return data;
    } catch {
      setProjectionsError(true);
      return null;
    } finally {
      projectionsPending.current = false;
      setProjectionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchLifecycle();
    void fetchProjections();
  }, [fetchLifecycle, fetchProjections]);

  const reconcileLifecycle = useCallback(async (
    slug: string,
    action: 'activate' | 'deactivate',
    expectedSourceHash?: string,
  ) => {
    const [currentDiscovery, currentProjections] = await Promise.all([fetchLifecycle(), fetchProjections()]);
    const discovered = currentDiscovery?.find((agent) => agent.slug === slug);
    const projection = currentProjections?.find((candidate) => candidate.slug === slug);
    const confirmed = action === 'activate'
      ? Boolean(
        discovered
        && discovered.status === 'valid'
        && discovered.source_hash === expectedSourceHash
        && projection?.active === true
        && projection.source_hash === expectedSourceHash,
      )
      : Boolean(projection && projection.active === false);
    if (!confirmed) {
      const next = { ...operationsRef.current };
      const operation = next[slug];
      if (operation) next[slug] = { ...operation, phase: 'read-failed' };
      publishOperations(next);
      return false;
    }
    const next = { ...operationsRef.current };
    delete next[slug];
    publishOperations(next);
    successRef.current(action === 'activate' ? `Activated ${slug}` : `Deactivated ${slug}`);
    return true;
  }, [fetchLifecycle, fetchProjections, publishOperations]);

  const activate = useCallback(async (agent: LifecycleAgent) => {
    const existing = operationsRef.current[agent.slug];
    if (existing && existing.phase !== 'write-failed') return;
    if (!canActivateLifecycle(agent, projections?.find((projection) => projection.slug === agent.slug))) return;
    const expectedSourceHash = agent.source_hash;
    if (!expectedSourceHash) return;
    publishOperations({
      ...operationsRef.current,
      [agent.slug]: { slug: agent.slug, action: 'activate', phase: 'writing', expectedSourceHash },
    });
    let nativeConfirmed = false;
    try {
      const response = await fetch(`${BUN_URL}/agents/${encodeURIComponent(agent.slug)}/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected_source_hash: expectedSourceHash }),
      });
      const payload = await response.json() as LifecycleMutationResponse;
      if (!response.ok || !payload.success || !payload.projection) throw new Error('activation rejected');
      const next = { ...operationsRef.current };
      next[agent.slug] = { slug: agent.slug, action: 'activate', phase: 'reconciling', expectedSourceHash };
      publishOperations(next);
      const nativeProjection = await invoke<AgentProjection>('activate_agent_projection', { projection: payload.projection });
      if (!nativeProjection?.active || nativeProjection.source_hash !== expectedSourceHash) throw new Error('native readback rejected');
      nativeConfirmed = true;
      await reconcileLifecycle(agent.slug, 'activate', expectedSourceHash);
    } catch {
      const next = { ...operationsRef.current };
      next[agent.slug] = {
        slug: agent.slug,
        action: 'activate',
        phase: nativeConfirmed ? 'read-failed' : 'write-failed',
        expectedSourceHash,
      };
      publishOperations(next);
    }
  }, [projections, publishOperations, reconcileLifecycle]);

  const deactivate = useCallback(async (agent: LifecycleAgent) => {
    const projection = projections?.find((candidate) => candidate.slug === agent.slug);
    const existing = operationsRef.current[agent.slug];
    if (existing && existing.phase !== 'write-failed') return;
    if (!canDeactivateLifecycle(agent, projection)) return;
    publishOperations({
      ...operationsRef.current,
      [agent.slug]: { slug: agent.slug, action: 'deactivate', phase: 'writing' },
    });
    let nativeConfirmed = false;
    try {
      const nativeProjection = await invoke<AgentProjection | null>('deactivate_agent_projection', { slug: agent.slug });
      if (!nativeProjection || nativeProjection.active) throw new Error('native deactivation rejected');
      nativeConfirmed = true;
      const next = { ...operationsRef.current };
      next[agent.slug] = { slug: agent.slug, action: 'deactivate', phase: 'reconciling' };
      publishOperations(next);
      const response = await fetch(`${BUN_URL}/agents/${encodeURIComponent(agent.slug)}/deactivate`, { method: 'POST' });
      const payload = await response.json() as LifecycleMutationResponse;
      if (!response.ok || !payload.success) throw new Error('boundary deactivation rejected');
      await reconcileLifecycle(agent.slug, 'deactivate');
    } catch {
      const next = { ...operationsRef.current };
      next[agent.slug] = {
        slug: agent.slug,
        action: 'deactivate',
        phase: nativeConfirmed ? 'read-failed' : 'write-failed',
      };
      publishOperations(next);
    }
  }, [projections, publishOperations, reconcileLifecycle]);

  const retry = useCallback((agent: LifecycleAgent) => {
    const operation = operationsRef.current[agent.slug];
    if (!operation) return;
    if (operation.phase === 'read-failed') {
      void reconcileLifecycle(agent.slug, operation.action, operation.expectedSourceHash);
      return;
    }
    if (operation.action === 'activate') void activate(agent);
    else void deactivate(agent);
  }, [activate, deactivate, reconcileLifecycle]);

  return {
    discovery,
    projections,
    projectionsLoading,
    projectionsError,
    operations,
    fetchLifecycle,
    fetchProjections,
    activate,
    deactivate,
    retry,
  };
}
