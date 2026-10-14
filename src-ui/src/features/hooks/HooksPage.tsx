import { decideCreateReadback, createFailureSentence, type CreateFailure } from '../../domain/create-readback';
// Hooks — event hooks (get_hooks / register_hook / unregister_hook).
//
// Behaviour is ported unchanged from the legacy HooksView: guarded register
// (one write in flight, draft kept on failure, no native error detail), a
// confirm-gated unregister whose lifetime is tracked by removal-state, and a
// fenced list read (request id) so an older read can never resurrect a row.

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Anchor, Plus, RotateCw, Trash2 } from 'lucide-react';
import {
  AlertLine,
  Badge,
  Button,
  Chip,
  ConfirmModal,
  EmptyState,
  Input,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  RowList,
  Select,
  Skeleton,
  StatusDot,
  StatusLine,
  formatIsoAge,
  useToast,
} from '../../design';
import { reconcileRemovals, removalLocked, type RemovalOperation } from '../../domain/removal-state';

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

export default function HooksPage() {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [event, setEvent] = useState(HOOK_EVENTS[0]);
  const [script, setScript] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Hook | null>(null);
  const [creating, setCreating] = useState(false);
  const [createFailure, setCreateFailure] = useState<CreateFailure | null>(null);
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
      if (request !== requestId.current) return null;
      const result = reconcileRemovals(snapshot, operationsRef.current, request);
      publishOperations(result.operations);
      setHooks(result.rows);
      setLoaded(true);
      return snapshot;
    } catch {
      if (request !== requestId.current) return null;
      const next = { ...operationsRef.current };
      let removalFailure = false;
      for (const [id, operation] of Object.entries(next)) {
        if (operation.phase === 'reconciling' || operation.phase === 'read-failed') {
          next[id] = { ...operation, phase: 'read-failed' };
          removalFailure = true;
        }
      }
      publishOperations(next);
      if (!opts?.removalRead || !removalFailure) setError('Could not read hooks. Retry the read.');
      return null;
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
    void fetchHooks();
  }, [fetchHooks]);

  const register = useCallback(async () => {
    if (createPending.current || !name.trim()) return;
    createPending.current = true;
    setCreating(true);
    setCreateFailure(null);
    try {
      const returned = await invoke<Hook>('register_hook', {
        name: name.trim(),
        event,
        script: script.trim() || null,
      });
      const verdict = decideCreateReadback<Hook>(returned, await fetchHooks());
      if (verdict.status !== 'confirmed') { setCreateFailure(verdict.status); return; }
      success(`Registered hook ${verdict.row.name}`);
      setName('');
      setScript('');
    } catch {
      setCreateFailure('write-failed');
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
    const h = hooks.find((row) => row.id === pendingDelete.id);
    if (!h) {
      setPendingDelete(null);
      return;
    }
    const operation: RemovalOperation<Hook> = { row: h, phase: 'writing', after: requestId.current };
    publishOperations({ ...operationsRef.current, [h.id]: operation });
    try {
      const removed = await invoke<boolean>('unregister_hook', { id: h.id });
      if (removed !== true) throw new Error('Removal not confirmed');
      success(`Unregistered ${h.name}`);
      publishOperations({
        ...operationsRef.current,
        [h.id]: { ...operation, phase: 'reconciling', after: requestId.current },
      });
      setPendingDelete((current) => (current?.id === h.id ? null : current));
      await fetchHooks({ removalRead: true });
    } catch {
      publishOperations({
        ...operationsRef.current,
        [h.id]: { ...operation, phase: 'write-failed', after: requestId.current },
      });
      setPendingDelete((current) => (current?.id === h.id ? null : current));
    }
  }, [fetchHooks, hooks, pendingDelete, publishOperations, success]);

  const deleteOperation = pendingDelete ? operations[pendingDelete.id] : undefined;
  const deleting = deleteOperation?.phase === 'writing';
  const canRegister = !creating && name.trim().length > 0;

  return (
    <Page>
      <ConfirmModal
        open={pendingDelete !== null}
        message={`Unregister hook "${pendingDelete?.name}"?`}
        detail={deleting ? 'Saving removal. Repeated confirmation will not submit another write.' : undefined}
        confirmLabel={deleting ? 'Unregistering…' : 'Unregister'}
        danger
        onConfirm={confirmDelete}
        onCancel={() => {
          if (!deleting) setPendingDelete(null);
        }}
      />

      <PageHeader
        eyebrow="Automate"
        title="Hooks"
        description="Event hooks run a handler whenever something happens in the Tool runtime: a Session starts, a tool is about to run, a cron job fires."
        actions={
          <Button variant="ghost" icon={<RotateCw />} onClick={retryRead} disabled={loading} aria-label="Refresh hooks">
            Refresh
          </Button>
        }
      />

      <Panel className="mb-6" aria-label="Register a hook">
        <PanelHeader
          title="Register a hook"
          description="Bind a handler to one event. The handler is optional — a hook without one only records that the event fired."
        />
        {createFailure && (
          <AlertLine
            className="mb-3"
            onRetry={createFailure === 'write-failed' ? () => void register() : undefined}
            retryDisabled={creating || !name.trim()}
          >
            {createFailureSentence('hook', createFailure)}
          </AlertLine>
        )}
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_200px]">
          <Input
            placeholder="Hook name"
            aria-label="Hook name"
            disabled={creating}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Select aria-label="Hook event" disabled={creating} value={event} onChange={(e) => setEvent(e.target.value)} className="font-mono text-[12px]">
            {HOOK_EVENTS.map((ev) => (
              <option key={ev} value={ev}>
                {ev}
              </option>
            ))}
          </Select>
        </div>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Input
            mono
            className="flex-1"
            placeholder="Script / command (optional)"
            aria-label="Hook handler"
            disabled={creating}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void register()}
          />
          <Button
            variant="primary"
            size="md"
            icon={<Plus />}
            busy={creating}
            onClick={() => void register()}
            disabled={!canRegister}
          >
            {creating ? 'Registering…' : 'Register'}
          </Button>
        </div>
      </Panel>

      <Panel flush>
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Anchor aria-hidden="true" className="size-3.5 text-ink-3" />
            <h2 className="text-[13px] font-semibold text-ink">Registered hooks</h2>
            {loaded && <span className="font-mono text-[11px] text-ink-3 tabular">{hooks.length}</span>}
          </div>
          {loaded && loading && (
            <StatusLine label="Hooks refresh" className="text-[11.5px]">
              Refreshing hooks…
            </StatusLine>
          )}
        </div>

        {!loaded && loading ? (
          <div className="space-y-3 p-4">
            <StatusLine>Loading hooks…</StatusLine>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !loaded && error ? (
          <div className="p-4">
            <AlertLine onRetry={retryRead} retryDisabled={loading}>
              <span>{error}</span>
            </AlertLine>
          </div>
        ) : !loaded ? null : (
          <>
            {error && (
              <div className="p-3">
                <AlertLine onRetry={retryRead} retryDisabled={loading}>
                  <span>{error}</span> Previously loaded hooks may be stale.
                </AlertLine>
              </div>
            )}
            {hooks.length === 0 ? (
              !error &&
              !loading && (
                <EmptyState
                  icon={<Anchor />}
                  title="No hooks registered yet."
                  description="Register one above to run a handler on Session, tool, or cron events."
                />
              )
            ) : (
              <RowList>
                {hooks.map((h) => (
                  <HookRow
                    key={h.id}
                    hook={h}
                    operation={operations[h.id]}
                    loading={loading}
                    onUnregister={unregister}
                    onRetryRead={retryRead}
                  />
                ))}
              </RowList>
            )}
          </>
        )}
      </Panel>
    </Page>
  );
}

function HookRow({
  hook,
  operation,
  loading,
  onUnregister,
  onRetryRead,
}: {
  hook: Hook;
  operation: RemovalOperation<Hook> | undefined;
  loading: boolean;
  onUnregister: (hook: Hook) => void;
  onRetryRead: () => void;
}) {
  const locked = removalLocked(operation);
  return (
    <li className="group px-4 py-3">
      <div className="flex items-center gap-3">
        <StatusDot tone={hook.enabled ? 'ok' : 'warn'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="truncate text-[13px] font-medium text-ink">{hook.name}</span>
            <Chip className="text-accent-hot">{hook.event}</Chip>
            <Badge tone={hook.enabled ? 'ok' : 'warn'}>{hook.enabled ? 'enabled' : 'disabled'}</Badge>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-[12px] text-ink-3">
            {hook.script ? (
              <code className="min-w-0 truncate rounded-[5px] border border-line bg-sunken px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2">
                {hook.script}
              </code>
            ) : (
              <span>No handler. Records the event only.</span>
            )}
            {hook.created_at && <span className="shrink-0 font-mono text-[11px] text-ink-4">registered {formatIsoAge(hook.created_at).replace(' 0h', '')}</span>}
          </div>
        </div>
        <Button
          variant="danger"
          size="xs"
          icon={<Trash2 />}
          onClick={() => onUnregister(hook)}
          disabled={locked}
        >
          Unregister
        </Button>
      </div>
      {operation?.phase === 'writing' && (
        <StatusLine className="mt-2" busy>
          Saving removal…
        </StatusLine>
      )}
      {operation?.phase === 'reconciling' && (
        <StatusLine className="mt-2" busy>
          Removal saved. Reconciling hooks…
        </StatusLine>
      )}
      {operation?.phase === 'write-failed' && (
        <AlertLine className="mt-2" onRetry={() => onUnregister(hook)}>
          Could not unregister the hook. Confirmed state was kept.
        </AlertLine>
      )}
      {operation?.phase === 'read-failed' && (
        <AlertLine className="mt-2" onRetry={onRetryRead} retryDisabled={loading}>
          Removal was saved, but the hook list could not be reconciled. Showing previous state. Retry reloads the list only.
        </AlertLine>
      )}
    </li>
  );
}
