// ── HooksView — event hooks (get_hooks/register_hook/unregister_hook) ──

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

interface Hook {
  id: string;
  name: string;
  event: string;
  script: string;
  enabled: boolean;
  created_at: string;
}

const HOOK_EVENTS = [
  'session.start',
  'session.end',
  'message.sent',
  'message.received',
  'tool.before',
  'tool.after',
  'cron.run',
  'agent.activated',
];

export default function HooksView() {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [event, setEvent] = useState(HOOK_EVENTS[0]);
  const [script, setScript] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Hook | null>(null);
  const { success, error: toastError } = useToast();

  const fetchHooks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHooks(await invoke<Hook[]>('get_hooks'));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHooks();
  }, [fetchHooks]);

  const register = useCallback(async () => {
    if (!name.trim()) return;
    try {
      await invoke<Hook>('register_hook', {
        name: name.trim(),
        event,
        script: script.trim() || null,
      });
      success(`Registered hook ${name}`);
      setName('');
      setScript('');
      await fetchHooks();
    } catch (e) {
      toastError(String(e), 'Register failed');
    }
  }, [name, event, script, fetchHooks, success, toastError]);

  const unregister = useCallback((h: Hook) => { setPendingDelete(h); }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const h = pendingDelete;
    setPendingDelete(null);
    try {
      await invoke<boolean>('unregister_hook', { id: h.id });
      success(`Unregistered ${h.name}`);
      await fetchHooks();
    } catch (e) {
      toastError(String(e), 'Unregister failed');
    }
  }, [pendingDelete, fetchHooks, success, toastError]);

  const inputCls =
    'px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50';

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <ConfirmModal
        open={pendingDelete !== null}
        message={`Unregister hook "${pendingDelete?.name}"?`}
        confirmLabel="Unregister"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
      <SectionHeader title="Hooks" subtitle="Event-driven automation hooks" count={hooks.length} />

      <GlassCard className="p-3 space-y-2">
        <div className="flex gap-2">
          <input
            className={cn(inputCls, 'flex-1')}
            placeholder="Hook name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select className={inputCls} value={event} onChange={(e) => setEvent(e.target.value)}>
            {HOOK_EVENTS.map((ev) => (
              <option key={ev} value={ev}>
                {ev}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <input
            className={cn(inputCls, 'flex-1 font-mono text-xs')}
            placeholder="Script / command (optional)"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && register()}
          />
          <button
            type="button"
            onClick={register}
            disabled={!name.trim()}
            className="px-4 py-2 text-sm rounded-lg bg-accent text-bone hover:bg-accent/80 disabled:opacity-40 transition-colors"
          >
            Register
          </button>
        </div>
      </GlassCard>

      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <LoadingState message="Loading hooks…" />
        ) : error ? (
          <ErrorState error={error} onRetry={fetchHooks} />
        ) : hooks.length === 0 ? (
          <EmptyState message="No hooks registered yet." />
        ) : (
          <ul className="space-y-2">
            {hooks.map((h) => (
              <li key={h.id}>
                <GlassCard className="p-3">
                  <div className="flex items-center gap-2">
                    <StatusDot ok={h.enabled} warn={!h.enabled} />
                    <span className="text-sm font-medium text-bone truncate">{h.name}</span>
                    <Pill variant="info">{h.event}</Pill>
                    <button
                      type="button"
                      onClick={() => unregister(h)}
                      className="ml-auto text-[11px] px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors"
                    >
                      Unregister
                    </button>
                  </div>
                  {h.script && (
                    <pre className="mt-1.5 text-[10px] font-mono text-bone/50 bg-black/20 rounded-md px-2 py-1 overflow-x-auto">
                      {h.script}
                    </pre>
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
