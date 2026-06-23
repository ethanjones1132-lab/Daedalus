// ── NodesView — compute nodes (get_nodes/add_node/remove_node) ──

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
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
  const { success, error: toastError } = useToast();

  const fetchNodes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNodes(await invoke<Node[]>('get_nodes'));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNodes();
  }, [fetchNodes]);

  const add = useCallback(async () => {
    if (!name.trim() || !address.trim()) return;
    try {
      await invoke<Node>('add_node', { name: name.trim(), address: address.trim() });
      success(`Added node ${name}`);
      setName('');
      setAddress('');
      await fetchNodes();
    } catch (e) {
      toastError(String(e), 'Add failed');
    }
  }, [name, address, fetchNodes, success, toastError]);

  const remove = useCallback((n: Node) => { setPendingDelete(n); }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const n = pendingDelete;
    setPendingDelete(null);
    try {
      await invoke<boolean>('remove_node', { id: n.id });
      success(`Removed ${n.name}`);
      await fetchNodes();
    } catch (e) {
      toastError(String(e), 'Remove failed');
    }
  }, [pendingDelete, fetchNodes, success, toastError]);

  const inputCls =
    'px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50';

  const statusVariant = (s: string) => {
    const v = s.toLowerCase();
    if (v === 'online' || v === 'connected' || v === 'ok') return 'success' as const;
    if (v === 'unknown') return 'warn' as const;
    return 'default' as const;
  };

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <ConfirmModal
        open={pendingDelete !== null}
        message={`Remove node "${pendingDelete?.name}"?`}
        confirmLabel="Remove"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
      <SectionHeader title="Nodes" subtitle="Distributed compute nodes" count={nodes.length} />

      <div className="flex gap-2">
        <input
          className={cn(inputCls, 'flex-1')}
          placeholder="Node name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={cn(inputCls, 'flex-1')}
          placeholder="Address (host:port)"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button
          type="button"
          onClick={add}
          disabled={!name.trim() || !address.trim()}
          className="px-4 py-2 text-sm rounded-lg bg-accent text-bone hover:bg-accent/80 disabled:opacity-40 transition-colors"
        >
          Add
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <LoadingState message="Loading nodes…" />
        ) : error ? (
          <ErrorState error={error} onRetry={fetchNodes} />
        ) : nodes.length === 0 ? (
          <EmptyState message="No nodes registered yet." />
        ) : (
          <ul className="space-y-2">
            {nodes.map((n) => {
              const variant = statusVariant(n.status);
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
                        className="ml-auto text-[11px] px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors"
                      >
                        Remove
                      </button>
                    </div>
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
      </div>
    </div>
  );
}
