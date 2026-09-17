// ── PluginsView — installed plugins (get_plugins/enable_plugin/disable_plugin) ──

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { confirmPluginEnablement } from './plugin-state';
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

const LOAD_ERROR = 'Could not load plugins.';

export default function PluginsView() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglePending, setTogglePending] = useState<Record<string, boolean>>({});
  const [toggleError, setToggleError] = useState<Record<string, boolean>>({});
  const togglePendingRef = useRef<Record<string, boolean>>({});
  const { success } = useToast();

  const fetchPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPlugins(await invoke<Plugin[]>('get_plugins'));
    } catch {
      setError(LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlugins();
  }, [fetchPlugins]);

  // Synchronous per-plugin gate: one in-flight write per plugin, any entry point.
  // Opposite-direction clicks on the same row wait for the confirmed result.
  const toggle = useCallback(
    async (p: Plugin) => {
      if (togglePendingRef.current[p.id] === true) return;
      togglePendingRef.current[p.id] = true;
      setTogglePending((prev) => ({ ...prev, [p.id]: true }));
      const next = !p.enabled;
      try {
        const confirmed = await invoke<boolean>(next ? 'enable_plugin' : 'disable_plugin', { id: p.id });
        if (confirmed !== true) throw new Error('Plugin update was not confirmed');
        setPlugins((prev) => confirmPluginEnablement(prev, p.id, next));
        setToggleError((prev) => ({ ...prev, [p.id]: false }));
        success(`${next ? 'Enabled' : 'Disabled'} ${p.name}`);
      } catch {
        // State stays at the last confirmed value; a fixed-message alert offers Retry.
        setToggleError((prev) => ({ ...prev, [p.id]: true }));
      } finally {
        delete togglePendingRef.current[p.id];
        setTogglePending((prev) => {
          const next = { ...prev };
          delete next[p.id];
          return next;
        });
      }
    },
    [success],
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
          <ErrorState error={LOAD_ERROR} onRetry={fetchPlugins} />
        ) : plugins.length === 0 ? (
          <EmptyState message="No plugins installed." />
        ) : (
          <ul className="space-y-2">
            {plugins.map((p) => {
              const pending = togglePending[p.id] === true;
              const hasError = toggleError[p.id] === true;
              const actionLabel = `${p.enabled ? 'Disable' : 'Enable'} ${p.name}`;
              return (
                <li key={p.id}>
                  <GlassCard className="p-3">
                    <div className="flex items-center gap-2">
                      <StatusDot ok={p.enabled} warn={!p.enabled} />
                      <span className="text-sm font-medium text-bone truncate">{p.name}</span>
                      <Pill variant="default">v{p.version}</Pill>
                      <button
                        type="button"
                        aria-label={pending ? `${p.enabled ? 'Disabling' : 'Enabling'} ${p.name}` : actionLabel}
                        onClick={() => toggle(p)}
                        disabled={pending}
                        className={cn(
                          'ml-auto text-[11px] px-2 py-0.5 rounded-md border transition-colors disabled:opacity-40',
                          p.enabled
                            ? 'border-amber-500/30 text-amber-200 hover:bg-amber-500/10'
                            : 'border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10',
                        )}
                      >
                        {pending ? (p.enabled ? 'Disabling…' : 'Enabling…') : p.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                    {hasError && (
                      <div role="alert" className="mt-1 text-xs text-red-200">
                        {p.enabled
                          ? 'Could not disable the plugin. Showing last confirmed state: enabled. '
                          : 'Could not enable the plugin. Showing last confirmed state: disabled. '}
                        <button
                          type="button"
                          onClick={() => toggle(p)}
                          disabled={pending}
                          className="underline disabled:opacity-40"
                        >
                          Retry
                        </button>
                      </div>
                    )}
                    {p.description && (
                      <p className="mt-1 text-xs text-bone/60 line-clamp-2">{p.description}</p>
                    )}
                    {p.source && (
                      <div className="mt-1 text-[10px] font-mono text-bone/30">{p.source}</div>
                    )}
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
