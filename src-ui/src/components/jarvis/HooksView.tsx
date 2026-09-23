// ── HooksView — event hooks (get_hooks/register_hook/unregister_hook) ──

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
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [operations, setOperations] = useState<Record<string, RemovalOperation<Hook>>>({});
  const createPending = useRef(false);
  const operationsRef = useRef(operations);
  const requestId = useRef(0);
  const reading = useRef(false);
  const { success } = useToast();
  const publishOperations = useCallback((next: Record<string, RemovalOperation<Hook>>) => {
    operationsRef.current = next;
    setOperations(next);
  }, []);

  const fetchHooks = useCallback(async (opts?: { removalRead?: boolean }) => {
    const request = ++requestId.current;
    reading.current = true;
    setLoading(true);
    setError(null);
    try {
      const snapshot = await invoke<Hook[]>('get_hooks');
      if (request !== requestId.current) return;
      const result = reconcileRemovals(snapshot, operationsRef.current, request);
      publishOperations(result.operations);
      setHooks(result.rows);
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
    void fetchHooks();
  }, [fetchHooks]);

  useEffect(() => {
    fetchHooks();
  }, [fetchHooks]);

  const register = useCallback(async () => {
    if (createPending.current || !name.trim()) return;
    createPending.current = true;
    setCreating(true);
    setCreateError(false);
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
    } catch {
      setCreateError(true);
    } finally {
      createPending.current = false;
      setCreating(false);
    }
  }, [name, event, script, fetchHooks, success]);

  const unregister = useCallback((h: Hook) => {
    if (!removalLocked(operationsRef.current[h.id])) setPendingDelete(h);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || removalLocked(operationsRef.current[pendingDelete.id])) return;
    const h = hooks.find(row => row.id === pendingDelete.id);
    if (!h) {
      setPendingDelete(null);
      return;
    }
    const operation: RemovalOperation<Hook> = {
      row: h,
      phase: 'writing',
      after: requestId.current,
    };
    publishOperations({ ...operationsRef.current, [h.id]: operation });
    try {
      const removed = await invoke<boolean>('unregister_hook', { id: h.id });
      if (removed !== true) throw new Error('Removal not confirmed');
      success(`Unregistered ${h.name}`);
      publishOperations({
        ...operationsRef.current,
        [h.id]: { ...operation, phase: 'reconciling', after: requestId.current },
      });
      setPendingDelete(current => current?.id === h.id ? null : current);
      await fetchHooks({ removalRead: true });
    } catch {
      publishOperations({
        ...operationsRef.current,
        [h.id]: { ...operation, phase: 'write-failed', after: requestId.current },
      });
      setPendingDelete(current => current?.id === h.id ? null : current);
    }
  }, [fetchHooks, hooks, pendingDelete, publishOperations, success]);

  const inputCls =
    'px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50';
  const deleteOperation = pendingDelete ? operations[pendingDelete.id] : undefined;
  const deleting = deleteOperation?.phase === 'writing';

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <ConfirmModal
        open={pendingDelete !== null}
        message={`Unregister hook "${pendingDelete?.name}"?`}
        detail={deleting ? 'Saving removal. Repeated confirmation will not submit another write.' : undefined}
        confirmLabel={deleting ? 'Unregistering…' : 'Unregister'}
        danger
        onConfirm={confirmDelete}
        onCancel={() => { if (!deleting) setPendingDelete(null); }}
      />
      <SectionHeader title="Hooks" subtitle="Event-driven automation hooks" count={hooks.length} />

      <GlassCard className="p-3 space-y-2">
        {createError && (
          <div role="alert" className="text-sm text-red-200">
            Could not register the hook. Your draft was kept.{' '}
            <button type="button" onClick={register} disabled={creating || !name.trim()} className="underline disabled:opacity-40">Retry</button>
          </div>
        )}
        <div className="flex gap-2">
          <input
            className={cn(inputCls, 'flex-1')}
            placeholder="Hook name"
            disabled={creating}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select disabled={creating} className={inputCls} value={event} onChange={(e) => setEvent(e.target.value)}>
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
            disabled={creating}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && register()}
          />
          <button
            type="button"
            onClick={register}
            disabled={creating || !name.trim()}
            className="px-4 py-2 text-sm rounded-lg bg-accent text-bone hover:bg-accent/80 disabled:opacity-40 transition-colors"
          >
            {creating ? 'Registering…' : 'Register'}
          </button>
        </div>
      </GlassCard>

      <div className="flex-1 overflow-y-auto min-h-0">
        {!loaded && loading ? (
          <LoadingState message="Loading hooks…" />
        ) : !loaded && error ? (
          <ErrorState error={error} onRetry={retryRead} />
        ) : !loaded ? null : (
          <>
            {error && (
              <div role="alert" className="text-sm text-red-200">
                <span>{error}</span> Previously loaded hooks may be stale.{' '}
                <button type="button" onClick={retryRead} disabled={loading} className="underline disabled:opacity-40">Retry</button>
              </div>
            )}
            {loading && <div role="status" className="text-xs text-bone/60">Refreshing hooks…</div>}
            {hooks.length === 0 ? (
              !error && !loading && <EmptyState message="No hooks registered yet." />
            ) : (
              <ul className="space-y-2">
                {hooks.map((h) => {
                  const operation = operations[h.id];
                  const locked = removalLocked(operation);
                  return (
                    <li key={h.id}>
                      <GlassCard className="p-3">
                        <div className="flex items-center gap-2">
                          <StatusDot ok={h.enabled} warn={!h.enabled} />
                          <span className="text-sm font-medium text-bone truncate">{h.name}</span>
                          <Pill variant="info">{h.event}</Pill>
                          <button
                            type="button"
                            onClick={() => unregister(h)}
                            disabled={locked}
                            className="ml-auto text-[11px] px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Unregister
                          </button>
                        </div>
                        {operation?.phase === 'writing' && <div role="status" className="mt-1.5 text-xs text-bone/60">Saving removal…</div>}
                        {operation?.phase === 'reconciling' && <div role="status" className="mt-1.5 text-xs text-bone/60">Removal saved. Reconciling hooks…</div>}
                        {operation?.phase === 'write-failed' && (
                          <div role="alert" className="mt-1.5 text-xs text-red-200">
                            Could not unregister the hook. Confirmed state was kept.{' '}
                            <button type="button" onClick={() => unregister(h)} className="underline">Retry</button>
                          </div>
                        )}
                        {operation?.phase === 'read-failed' && (
                          <div role="alert" className="mt-1.5 text-xs text-red-200">
                            Removal was saved, but the hook list could not be reconciled. Showing previous state. Retry reloads the list only.{' '}
                            <button type="button" onClick={retryRead} disabled={loading} className="underline disabled:opacity-40">Retry</button>
                          </div>
                        )}
                        {h.script && (
                          <pre className="mt-1.5 text-[10px] font-mono text-bone/50 bg-black/20 rounded-md px-2 py-1 overflow-x-auto">
                            {h.script}
                          </pre>
                        )}
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
