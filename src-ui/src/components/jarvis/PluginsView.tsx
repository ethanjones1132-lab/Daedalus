import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  PageTransition,
  AnimatedGrid,
  GlassCard,
  StatusDot,
  Pill,
  SectionHeader,
  LoadingState,
  ErrorState,
  cn,
  useToast,
} from '../ui';

interface Plugin {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  status: string;
  author?: string;
  path?: string;
}

export default function PluginsView() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<Set<string>>(new Set());

  const fetchPlugins = useCallback(async () => {
    try {
      const r = await invoke<Plugin[]>('get_plugins');
      setPlugins(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPlugins(); }, [fetchPlugins]);

  const { success, error: toastError } = useToast();

  const handleToggle = async (plugin: Plugin) => {
    setToggling(prev => new Set(prev).add(plugin.id));
    const isEnabling = !plugin.enabled;
    try {
      if (plugin.enabled) {
        await invoke('disa
        success(`Plugin "${plugin.name}" disabled.`, 'Plugin Disabled');
      } else {
        await invoke('enable_plugin', { id: plugin.id });
        success(`Plugin "${plugin.name}" enabled.`, 'Plugin Enabled');
      }
      await fetchPlugins();
    } catch (e) {
      toastError(`Failed to ${isEnabling ? 'enable' : 'disable'} plugin: ${e}`, 'Plugin Error');
      console.error('Failed to toggle plugin:', e);
    } finally {
      setToggling(prev => { const n = new Set(prev); n.delete(plugin.id); return n; });
    }
  };

  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

  return (
    <PageTransition>
      <SectionHeader title="Plugins" count={plugins.length} />

      {plugins.length === 0 ? (
        <GlassCard className="text-center py-12">
          <motion.div
            className="text-4xl mb-4 opacity-20"