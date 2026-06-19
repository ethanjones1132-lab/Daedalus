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

interface Hook {
  id: string;
  name: string;
  event: string;
  enabled: boolean;
  description: string;
  created_at: string;
  updated_at: string;
}

export default function HooksView() {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newEvent, setNewEvent] = useState('');
  const [adding, setAdding] = useState(false);

  const fetchHooks = useCallback(async () => {
    try {
      const r = await invoke<Hook[]>('get_hooks');
      setHooks(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchHooks(); }, [fetchHooks]);

  const { success, error: toastError } = useToast();

  const handleRegister = async () => {
    if (!newName.trim() || !newEvent.trim()) return;
    setAdding(true);
    const addedName = newName.trim();
    try {

      success(`Hook "${addedName}" registered successfully.`, 'Hook Registered');
      setNewName('');
      setNewEvent('');
      await fetchHooks();
    } catch (e) {
      toastError(`Failed to register hook: ${e}`, 'Hook Error');
      console.error('Failed to register hook:', e);
    } finally {
      setAdding(false);
    }
  };

  const handleUnregister = async (id: string) => {
    try {
      await invoke('unregister_hook', { id });
      success('Hook unregistered successfully.', 'Hook Unregistered');
      await fetchHooks();
    } catch (e) {
      toastError(`Failed to unregister hook: ${e}`, 'Hook Error');
      console.error('Failed to unregister hook:', e);
    }
  };

  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

  return (
    <PageTransition>
      <SectionHeader title="Hooks" count={hooks.length} />

      <GlassCard className="mb-6">
        <h3 className="text-sm font-semibold text-bone mb-3">Register Hook</h3>
        <div className="flex gap-3 items-end">
          <div className="flex-1">