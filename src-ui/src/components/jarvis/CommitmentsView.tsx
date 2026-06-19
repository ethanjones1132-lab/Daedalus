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
  useToast,
} from '../ui';

interface Commitment {
  id: string;
  text: string;
  status: string;
      due?: string;
  created_at: string;
  completed_at?: string;
  agent_id?: string;
}

export default function CommitmentsView() {
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
      const [newText, setNewText] = useState('');
  const [newDue, setNewDue] = useState('');
  const [adding, setAdding] = useState(false);

  const fetchCommitments = useCallback(async () => {
    try {
      const r = await invoke<Commitment[]>('get_commitments');
      setCommitments(r);
      setError(null);
    } catch (e) {
          setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCommitments(); }, [fetchCommitments]);

  const { success, error: toastError } = useToast();

      const handleAdd = async () => {
    if (!newText.trim()) return;
    setAdding(true);
    const textVal = newText.trim();
    try {
      await invoke('add_commitment', {
        text: textVal,
        due: newDue.trim() || null,
      });
      success(`Commitment "${textVal}" added.`, 'Commitment Added');
          setNewText('');
      setNewDue('');
      await fetchCommitments();
    } catch (e) {
      toastError(`Failed to add commitment: ${e}`, 'Commitment Error');
    } finally {
      setAdding(false);
    }
  };

      const handleComplete = async (id: string) => {
    try {
      await invoke('complete_commitment', { id });
      success('Commitment marked as completed.', 'Commitment Completed');
      await fetchCommitments();
    } catch (e) {
      toastError(`Failed to complete commitment: ${e}`, 'Commitment Error');
    }
  };

      const handleDelete = async (id: string) => {
    try {
      await invoke('delete_commitment', { id });
      success('Commitment deleted.', 'Commitment Deleted');
      await fetchCommitments();
    } catch (e) {
      toastError(`Failed to delete commitment: ${e}`, 'Commitment Error');
    }
  };

      const statusVariant = (s: string) => {
    switch (s) {
      case 'pending': return 'warning';
      case 'completed': return 'success';
      case 'expired': return 'error';
      default: return 'default';
    }
  };

  if (loading) return <LoadingState />;
     if (error) return <ErrorState error={error} />;

  return (
    <PageTransition>
      <SectionHeader title="Commitments" count={commitments.length} />

      <GlassCard className="mb-6">
        <h3 className="text-sm font-semibold text-bone mb-3">Add Commitment</h3>
        <div className="flex gap-3 items-end">
          <div className="flex-[2]">
               <label className="block text-xs font-mono text-bone-dim mb-1">Text</label>
            <input
              type="text"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              placeholder="Follow up on deployment..."
              className="w-full px-3 py-1.5 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
            />
          </div>
          <div className="flex-1">
               <label className="block text-xs font-mono text-bone-dim mb-1">Due (optional)</label>
... 77 lines not shown ...