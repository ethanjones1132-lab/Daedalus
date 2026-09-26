// ── DevicesView — paired devices (get_devices/add_device/remove_device) ──

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { projectDevicePresence } from './device-presence';
import RecordIdBadge from './RecordIdBadge';
import { createFailureSentence, decideCreateReadback, type CreateFailure } from './create-readback';
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

interface Device {
  id: string;
  name: string;
  device_type: string;
  status: string;
  last_seen: string;
}

const DEVICE_TYPES = ['desktop', 'laptop', 'phone', 'tablet', 'server', 'iot'];

function formatStamp(at: number): string {
  return new Date(at).toLocaleString();
}

export default function DevicesView() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState(DEVICE_TYPES[0]);
  const [pendingDelete, setPendingDelete] = useState<Device | null>(null);
  const [creating, setCreating] = useState(false);
  const [createFailure, setCreateFailure] = useState<CreateFailure | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [operations, setOperations] = useState<Record<string, RemovalOperation<Device>>>({});
  const createPending = useRef(false);
  const operationsRef = useRef(operations);
  const requestId = useRef(0);
  const reading = useRef(false);
  const { success } = useToast();
  const publishOperations = useCallback((next: Record<string, RemovalOperation<Device>>) => {
    operationsRef.current = next;
    setOperations(next);
  }, []);

  // Returns the confirmed store contents, or null when this read observed
  // nothing (it failed, or a newer read superseded it). Callers that must
  // confirm a write treat null as "not observed", never as "not stored".
  const fetchDevices = useCallback(async (opts?: { removalRead?: boolean }): Promise<Device[] | null> => {
    const request = ++requestId.current;
    reading.current = true;
    setLoading(true);
    setError(null);
    try {
      const snapshot = await invoke<Device[]>('get_devices');
      if (request !== requestId.current) return null;
      const result = reconcileRemovals(snapshot, operationsRef.current, request);
      publishOperations(result.operations);
      setDevices(result.rows);
      setLoaded(true);
      return snapshot;
    } catch (e) {
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
      if (!opts?.removalRead || !removalFailure) setError(String(e));
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
    void fetchDevices();
  }, [fetchDevices]);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const add = useCallback(async () => {
    if (createPending.current || !name.trim()) return;
    createPending.current = true;
    setCreating(true);
    setCreateFailure(null);
    try {
      const returned = await invoke<Device>('add_device', { name: name.trim(), deviceType: type });
      // The write's own return value is not a confirmation. Only a later read
      // that contains the record under the id Native assigned can confirm it.
      const verdict = decideCreateReadback<Device>(returned, await fetchDevices());
      if (verdict.status !== 'confirmed') {
        setCreateFailure(verdict.status);
        return;
      }
      success(`Added device ${verdict.row.name}`);
      setName('');
    } catch {
      setCreateFailure('write-failed');
    } finally {
      createPending.current = false;
      setCreating(false);
    }
  }, [name, type, fetchDevices, success]);

  const remove = useCallback((d: Device) => {
    if (!removalLocked(operationsRef.current[d.id])) setPendingDelete(d);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || removalLocked(operationsRef.current[pendingDelete.id])) return;
    const d = devices.find(row => row.id === pendingDelete.id);
    if (!d) {
      setPendingDelete(null);
      return;
    }
    const operation: RemovalOperation<Device> = {
      row: d,
      phase: 'writing',
      after: requestId.current,
    };
    publishOperations({ ...operationsRef.current, [d.id]: operation });
    try {
      const removed = await invoke<boolean>('remove_device', { id: d.id });
      if (removed !== true) throw new Error('Removal not confirmed');
      success(`Removed ${d.name}`);
      publishOperations({
        ...operationsRef.current,
        [d.id]: { ...operation, phase: 'reconciling', after: requestId.current },
      });
      setPendingDelete(current => current?.id === d.id ? null : current);
      await fetchDevices({ removalRead: true });
    } catch {
      publishOperations({
        ...operationsRef.current,
        [d.id]: { ...operation, phase: 'write-failed', after: requestId.current },
      });
      setPendingDelete(current => current?.id === d.id ? null : current);
    }
  }, [devices, fetchDevices, pendingDelete, publishOperations, success]);

  const inputCls =
    'px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50';
  const deleteOperation = pendingDelete ? operations[pendingDelete.id] : undefined;
  const deleting = deleteOperation?.phase === 'writing';

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <ConfirmModal
        open={pendingDelete !== null}
        message={`Remove device "${pendingDelete?.name}"?`}
        detail={deleting ? 'Saving removal. Repeated confirmation will not submit another write.' : undefined}
        confirmLabel={deleting ? 'Removing…' : 'Remove'}
        danger
        onConfirm={confirmDelete}
        onCancel={() => { if (!deleting) setPendingDelete(null); }}
      />
      <SectionHeader title="Devices" subtitle="Paired devices and their status" count={devices.length} />

      {createFailure && (
        <div role="alert" className="text-sm text-red-200">
          {createFailureSentence('device', createFailure)}{' '}
          <button
            type="button"
            aria-label="Retry adding the device"
            onClick={add}
            disabled={creating || !name.trim()}
            className="underline disabled:opacity-40"
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex gap-2">
        <input
          className={cn(inputCls, 'flex-1')}
          placeholder="Device name"
          disabled={creating}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <select disabled={creating} className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
          {DEVICE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={add}
          disabled={creating || !name.trim()}
          className="px-4 py-2 text-sm rounded-lg bg-accent text-bone hover:bg-accent/80 disabled:opacity-40 transition-colors"
        >
          {creating ? 'Adding…' : 'Add'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {!loaded && loading ? (
          <LoadingState message="Loading devices…" />
        ) : !loaded && error ? (
          <ErrorState error={error} onRetry={retryRead} />
        ) : !loaded ? null : (
          <>
            {error && (
              <div role="alert" className="text-sm text-red-200">
                <span>{error}</span> Previously loaded devices may be stale.{' '}
                <button type="button" onClick={retryRead} disabled={loading} className="underline disabled:opacity-40">Retry</button>
              </div>
            )}
            {loading && <div role="status" className="text-xs text-bone/60">Refreshing devices…</div>}
            {devices.length === 0 ? (
              !error && !loading && <EmptyState message="No devices paired yet." />
            ) : (
              <ul className="space-y-2">
                {devices.map((d) => {
                  const presence = projectDevicePresence(d);
                  const operation = operations[d.id];
                  const locked = removalLocked(operation);
                  return (
                    <li key={d.id} aria-label={presence.announcement}>
                      <GlassCard className="p-3">
                        <div className="flex items-center gap-2">
                          <StatusDot ok={presence.tone === 'success'} warn={presence.tone === 'warn'} />
                          <span className="text-sm font-medium text-bone truncate">{d.name}</span>
                          <Pill variant="default">{d.device_type}</Pill>
                          <Pill variant={presence.tone}>{presence.recorded}</Pill>
                          <button
                            type="button"
                            onClick={() => remove(d)}
                            disabled={locked}
                            className="ml-auto text-[11px] px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Remove
                          </button>
                        </div>
                        {operation?.phase === 'writing' && <div role="status" className="mt-1.5 text-xs text-bone/60">Saving removal…</div>}
                        {operation?.phase === 'reconciling' && <div role="status" className="mt-1.5 text-xs text-bone/60">Removal saved. Reconciling devices…</div>}
                        {operation?.phase === 'write-failed' && (
                          <div role="alert" className="mt-1.5 text-xs text-red-200">
                            Could not remove the device. Confirmed state was kept.{' '}
                            <button type="button" onClick={() => remove(d)} className="underline">Retry</button>
                          </div>
                        )}
                        {operation?.phase === 'read-failed' && (
                          <div role="alert" className="mt-1.5 text-xs text-red-200">
                            Removal was saved, but the device list could not be reconciled. Showing previous state. Retry reloads the list only.{' '}
                            <button type="button" onClick={retryRead} disabled={loading} className="underline disabled:opacity-40">Retry</button>
                          </div>
                        )}
                        <div
                          data-testid="device-presence"
                          className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[10px] font-mono text-bone/40"
                        >
                          <span className="text-bone/60">{presence.claimLabel}</span>
                          <span>{presence.basis}</span>
                        </div>
                        {presence.lastSeenAt !== null && (
                          <div data-testid="device-stamp" className="mt-0.5 text-[10px] font-mono text-bone/30">
                            stamped {formatStamp(presence.lastSeenAt)} · {presence.lastSeenAge} ago
                          </div>
                        )}
                        <RecordIdBadge id={d.id} label="device" />
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
