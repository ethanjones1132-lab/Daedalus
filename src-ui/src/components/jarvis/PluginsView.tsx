// ── PluginsView — installed plugins (get_plugins/enable_plugin/disable_plugin) ──

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
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

interface Plugin {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  description: string;
  source: string;
}

export default function PluginsView() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { success, error: toastError } = useToast();

  const fetchPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPlugins(await invoke<Plugin[]>('get_plugins'));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlugins();
  }, [fetchPlugins]);

  const toggle = useCallback(
    async (p: Plugin) => {
      const next = !p.enabled;
      setPlugins((prev) => prev.map((x) => (x.id === p.id ? { ...x, enabled: next } : x)));
      try {
        await invoke<boolean>(next ? 'enable_plugin' : 'disable_plugin', { id: p.id });
      } catch (e) {
        setPlugins((prev) => prev.map((x) => (x.id === p.id ? { ...x, enabled: !next } : x)));
        toastError(String(e), 'Toggle failed');
        return;
      }
      success(`${next ? 'Enabled' : 'Disabled'} ${p.name}`);
    },
    [success, toastError],
  );

  const enabledCount = plugins.filter((p) => p.enabled).length;

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="Plugins"
        subtitle="Installed extensions"
        count={plugins.length}
        action={<Pill variant={enabledCount > 0 ? 'success' : 'default'}>{enabledCount} enabled</Pill>}
      />

      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <LoadingState message="Loading plugins…" />
        ) : error ? (
          <ErrorState error={error} onRetry={fetchPlugins} />
        ) : plugins.length === 0 ? (
          <EmptyState message="No plugins installed." />
        ) : (
          <ul className="space-y-2">
            {plugins.map((p) => (
              <li key={p.id}>
                <GlassCard className="p-3">
                  <div className="flex items-center gap-2">
                    <StatusDot ok={p.enabled} warn={!p.enabled} />
                    <span className="text-sm font-medium text-bone truncate">{p.name}</span>
                    <Pill variant="default">v{p.version}</Pill>
                    <button
                      type="button"
                      onClick={() => toggle(p)}
                      className={cn(
                        'ml-auto text-[11px] px-2 py-0.5 rounded-md border transition-colors',
                        p.enabled
                          ? 'border-amber-500/30 text-amber-200 hover:bg-amber-500/10'
                          : 'border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10',
                      )}
                    >
                      {p.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                  {p.description && (
                    <p className="mt-1 text-xs text-bone/60 line-clamp-2">{p.description}</p>
                  )}
                  {p.source && (
                    <div className="mt-1 text-[10px] font-mono text-bone/30">{p.source}</div>
                  )}
                </GlassCard>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
