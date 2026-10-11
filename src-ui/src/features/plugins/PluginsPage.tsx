import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Puzzle, RefreshCw } from 'lucide-react';
import {
  AlertLine,
  Badge,
  Button,
  Chip,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  Skeleton,
  StatusLine,
  Switch,
  cn,
  useToast,
} from '../../design';
import { confirmPluginEnablement } from '../../domain/plugin-state';

/*
 * Plugins — installed extensions (get_plugins / enable_plugin / disable_plugin).
 *
 * The toggle is confirmed, not optimistic: the card shows the last confirmed
 * state until the native command returns the literal `true`. A synchronous
 * per-plugin gate (ref) allows one in-flight write per plugin from any entry
 * point; other plugins stay independent.
 */

interface Plugin {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  description: string;
  source: string;
}

const LOAD_ERROR = 'Could not load plugins.';

export default function PluginsPage() {
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
  // Opposite-direction clicks on the same card wait for the confirmed result.
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
          const rest = { ...prev };
          delete rest[p.id];
          return rest;
        });
      }
    },
    [success],
  );

  const enabledCount = plugins.filter((p) => p.enabled).length;

  return (
    <Page>
      <PageHeader
        eyebrow="Connect"
        title="Plugins"
        description="Installed extensions. Enabling one is confirmed by the Native surface before the switch moves."
        actions={
          <>
            {!loading && !error && (
              <Badge tone={enabledCount > 0 ? 'ok' : 'muted'}>{enabledCount} enabled</Badge>
            )}
            <Button variant="ghost" icon={<RefreshCw />} onClick={fetchPlugins} disabled={loading} aria-label="Refresh plugins">
              Refresh
            </Button>
          </>
        }
      />

      {loading ? (
        <div className="space-y-4">
          <StatusLine>Loading plugins…</StatusLine>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Panel key={i} className="space-y-3">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </Panel>
            ))}
          </div>
        </div>
      ) : error ? (
        <AlertLine onRetry={fetchPlugins}>{LOAD_ERROR}</AlertLine>
      ) : plugins.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Puzzle />}
            title="No plugins installed."
            description="Plugins that Jarvis discovers will appear here with a switch to enable or disable them."
          />
        </Panel>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {plugins.map((p) => {
            const pending = togglePending[p.id] === true;
            const hasError = toggleError[p.id] === true;
            const actionLabel = `${p.enabled ? 'Disable' : 'Enable'} ${p.name}`;
            return (
              <li key={p.id} className="flex">
                <Panel as="div" className={cn('flex w-full flex-col gap-3 transition-colors', p.enabled && 'border-accent-line/60')}>
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex size-9 shrink-0 items-center justify-center rounded-[8px] border',
                        p.enabled ? 'border-accent-line bg-accent-wash text-accent-hot' : 'border-line-strong bg-sunken text-ink-3',
                      )}
                    >
                      <Puzzle className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-[14px] font-medium text-ink">{p.name}</h3>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Chip>v{p.version}</Chip>
                        <Badge tone={pending ? 'accent' : p.enabled ? 'ok' : 'muted'} dot>
                          {pending ? (p.enabled ? 'disabling' : 'enabling') : p.enabled ? 'enabled' : 'disabled'}
                        </Badge>
                      </div>
                    </div>
                    <Switch
                      pressed
                      checked={p.enabled}
                      aria-label={pending ? `${p.enabled ? 'Disabling' : 'Enabling'} ${p.name}` : actionLabel}
                      title={actionLabel}
                      onClick={() => toggle(p)}
                      disabled={pending}
                    />
                  </div>
                  {p.description && <p className="line-clamp-3 text-[12.5px] leading-relaxed text-ink-2">{p.description}</p>}
                  {hasError && (
                    <AlertLine onRetry={() => toggle(p)} retryDisabled={pending}>
                      {p.enabled
                        ? 'Could not disable the plugin. Showing last confirmed state: enabled. '
                        : 'Could not enable the plugin. Showing last confirmed state: disabled. '}
                    </AlertLine>
                  )}
                  {p.source && (
                    <p className="mt-auto truncate border-t border-line pt-2.5 font-mono text-[11px] text-ink-3" title={p.source}>
                      {p.source}
                    </p>
                  )}
                </Panel>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
