// ── NodesView — compute nodes (get_nodes/add_node/remove_node) ──

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { reconcileRemovals, removalLocked, type RemovalOperation } from './removal-state';
import {
  cn,
  ConfirmModal,
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
  LoadingState,
  ErrorState,
  EmptyState,
  useToast,
} from '../ui';

interface Node {
  id: string;
  name: string;
  address: string;
  status: string;
  latency_ms: number | null;
  last_ping: string;
  capabilities: string[];
}

export default function NodesView() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Node | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [operations, setOperations] = useState<Record<string, RemovalOperation<Node>>>({});
  const createPending = useRef(false);
  const operationsRef = useRef(operations);
  const requestId = useRef(0);
  const reading = useRef(false);
  const { success } = useToast();
  const publishOperations = useCallback((next: Record<string, RemovalOperation<Node>>) => {
    operationsRef.current = next;
    setOperations(next);
  }, []);

  const fetchNodes = useCallback(async (opts?: { removalRead?: boolean }) => {
    const request = ++requestId.current;
    reading.current = true;
    setLoading(true);
    setError(null);
    try {
      const snapshot = await invoke<Node[]>('get_nodes');
      if (request !== requestId.current) return;
      const result = reconcileRemovals(snapshot, operationsRef.current, request);
      publishOperations(result.operations);
      setNodes(result.rows);
      setLoaded(true);
    } catch (e) {
      if (request !== requestId.current) return;
      const next = { ...operationsRef.current };
      let removalFailure = false;
      for (const [id, operation] of Object.entries(next)) {
        if (operation.phase === 'reconciling' || operation.phase === 'read-failed') {
          next[id] = { ...operation, phase: 'read-failed' };
          removalFailure = true;
        }
      }
      publishOperations(next);
      if (!opts?.removalRead || !removalFailure) setError(String(e));
    } finally {
      if (request === requestId.current) {
        reading.current = false;
        setLoading(false);
      }
    }
  }, [publishOperations]);

  const retryRead = useCallback(() => {
    if (reading.current) return;
    void fetchNodes();
  }, [fetchNodes]);

  useEffect(() => {
    fetchNodes();
  }, [fetchNodes]);

  const add = useCallback(async () => {
    if (createPending.current || !name.trim() || !address.trim()) return;
    createPending.current = true;
    setCreating(true);
    setCreateError(false);
    try {
      await invoke<Node>('add_node', { name: name.trim(), address: address.trim() });
      success(`Added node ${name}`);
      setName('');
      setAddress('');
      await fetchNodes();
    } catch {
      setCreateError(true);
    } finally {
      createPending.current = false;
      setCreating(false);
    }
  }, [name, address, fetchNodes, success]);

  const remove = useCallback((n: Node) => {
    if (!removalLocked(operationsRef.current[n.id])) setPendingDelete(n);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || removalLocked(operationsRef.current[pendingDelete.id])) return;
    const n = nodes.find(row => row.id === pendingDelete.id);
    if (!n) {
      setPendingDelete(null);
      return;
    }
    const operation: RemovalOperation<Node> = {
      row: n,
      phase: 'writing',
      after: requestId.current,
    };
    publishOperations({ ...operationsRef.current, [n.id]: operation });
    try {
      const removed = await invoke<boolean>('remove_node', { id: n.id });
      if (removed !== true) throw new Error('Removal not confirmed');
      success(`Removed ${n.name}`);
      publishOperations({
        ...operationsRef.current,
        [n.id]: { ...operation, phase: 'reconciling', after: requestId.current },
      });
      setPendingDelete(current => current?.id === n.id ? null : current);
      await fetchNodes({ removalRead: true });
    } catch {
      publishOperations({
        ...operationsRef.current,
        [n.id]: { ...operation, phase: 'write-failed', after: requestId.current },
      });
      setPendingDelete(current => current?.id === n.id ? null : current);
    }
  }, [fetchNodes, nodes, pendingDelete, publishOperations, success]);

  const inputCls =
    'px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50';

  const statusVariant = (s: string) => {
    const v = s.toLowerCase();
    if (v === 'online' || v === 'connected' || v === 'ok') return 'success' as const;
    if (v === 'unknown') return 'warn' as const;
    return 'default' as const;
  };
  const deleteOperation = pendingDelete ? operations[pendingDelete.id] : undefined;
  const deleting = deleteOperation?.phase === 'writing';

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <ConfirmModal
        open={pendingDelete !== null}
        message={`Remove node "${pendingDelete?.name}"?`}
        detail={deleting ? 'Saving removal. Repeated confirmation will not submit another write.' : undefined}
        confirmLabel={deleting ? 'Removing…' : 'Remove'}
        danger
        onConfirm={confirmDelete}
        onCancel={() => { if (!deleting) setPendingDelete(null); }}
      />
      <SectionHeader title="Nodes" subtitle="Distributed compute nodes" count={nodes.length} />

      {createError && (
        <div role="alert" className="text-sm text-red-200">
          Could not add the node. Your draft was kept.{' '}
          <button type="button" onClick={add} disabled={creating || !name.trim() || !address.trim()} className="underline disabled:opacity-40">Retry</button>
        </div>
      )}

      <div className="flex gap-2">
        <input
          className={cn(inputCls, 'flex-1')}
          placeholder="Node name"
          disabled={creating}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={cn(inputCls, 'flex-1')}
          placeholder="Address (host:port)"
          disabled={creating}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button
          type="button"
          onClick={add}
          disabled={creating || !name.trim() || !address.trim()}
          className="px-4 py-2 text-sm rounded-lg bg-accent text-bone hover:bg-accent/80 disabled:opacity-40 transition-colors"
        >
          {creating ? 'Adding…' : 'Add'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {!loaded && loading ? (
          <LoadingState message="Loading nodes…" />
        ) : !loaded && error ? (
          <ErrorState error={error} onRetry={retryRead} />
        ) : !loaded ? null : (
          <>
            {error && (
              <div role="alert" className="text-sm text-red-200">
                <span>{error}</span> Previously loaded nodes may be stale.{' '}
                <button type="button" onClick={retryRead} disabled={loading} className="underline disabled:opacity-40">Retry</button>
              </div>
            )}
            {loading && <div role="status" className="text-xs text-bone/60">Refreshing nodes…</div>}
            {nodes.length === 0 ? (
              !error && !loading && <EmptyState message="No nodes registered yet." />
            ) : (
              <ul className="space-y-2">
                {nodes.map((n) => {
                  const variant = statusVariant(n.status);
                  const operation = operations[n.id];
                  const locked = removalLocked(operation);
                  return (
                    <li key={n.id}>
                      <GlassCard className="p-3">
                        <div className="flex items-center gap-2">
                          <StatusDot ok={variant === 'success'} warn={variant === 'warn'} />
                          <span className="text-sm font-medium text-bone truncate">{n.name}</span>
                          <Pill variant={variant}>{n.status}</Pill>
                          {n.latency_ms != null && (
                            <span className="text-[10px] font-mono text-bone/40">{n.latency_ms}ms</span>
                          )}
                          <button
                            type="button"
                            onClick={() => remove(n)}
                            disabled={locked}
                            className="ml-auto text-[11px] px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Remove
                          </button>
                        </div>
                        {operation?.phase === 'writing' && <div role="status" className="mt-1.5 text-xs text-bone/60">Saving removal…</div>}
                        {operation?.phase === 'reconciling' && <div role="status" className="mt-1.5 text-xs text-bone/60">Removal saved. Reconciling nodes…</div>}
                        {operation?.phase === 'write-failed' && (
                          <div role="alert" className="mt-1.5 text-xs text-red-200">
                            Could not remove the node. Confirmed state was kept.{' '}
                            <button type="button" onClick={() => remove(n)} className="underline">Retry</button>
                          </div>
                        )}
                        {operation?.phase === 'read-failed' && (
                          <div role="alert" className="mt-1.5 text-xs text-red-200">
                            Removal was saved, but the node list could not be reconciled. Showing previous state. Retry reloads the list only.{' '}
                            <button type="button" onClick={retryRead} disabled={loading} className="underline disabled:opacity-40">Retry</button>
                          </div>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-mono text-bone/30">
                          <span>{n.address}</span>
                          {n.capabilities.map((c) => (
                            <span key={c} className="rounded-full bg-white/5 border border-white/10 px-1.5 py-0.5 text-bone/50">
                              {c}
                            </span>
                          ))}
                        </div>
                      </GlassCard>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
