import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  PageTransition,
  AnimatedList,
  GlassCard,
  StatusDot,
  Pill,
  SectionHeader,
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
  latency_ms?: number;
  last_ping: string;
  capabilities: string[];
}

export default function NodesView() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [adding, setAdding] = useState(false);

  const fetchNodes = useCallback(async () => {
    try {
      const r = await invoke<Node[]>('get_nodes');
      setNodes(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchNodes(); }, [fetchNodes]);

  const { success, error: toastError } = useToast();

  const handleAdd = async () => {
    if (!newName.trim() || !newAddress.trim()) return;
    setAdding(true);
    const nodeName = newName.trim();
    try {
      await invoke('add_node', { name: nodeName, address: newAddress.trim() });
      success(`Node "${nodeName}" added successfully.`, 'Node Added');
      setNewName('');
      setNewAddress('');
      await fetchNodes();
    } catch (e) {
      toastError(`Failed to add node: ${e}`, 'Node Error');
      console.error('Failed to add node:', e);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await invoke('remove_node', { id });
      success('Node removed successfully.', 'Node Removed');
      await fetchNodes();
    } catch (e) {
      toastError(`Failed to remove node: ${e}`, 'Node Error');
      console.error('Failed to remove node:', e);
    }
  };

  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

  return (
    <PageTransition>
      <SectionHeader title="Nodes" count={nodes.length} />

      <GlassCard className="mb-6">
        <h3 className="text-sm font-semibold text-bone mb-3">Add Node</h3>
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="block text-xs font-mono text-bone-dim mb-1">Name</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}