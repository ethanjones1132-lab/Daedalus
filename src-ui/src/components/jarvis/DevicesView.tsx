// ── DevicesView — paired devices (get_devices/add_device/remove_device) ──

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

interface Device {
  id: string;
  name: string;
  device_type: string;
  status: string;
  last_seen: string;
}

const DEVICE_TYPES = ['desktop', 'laptop', 'phone', 'tablet', 'server', 'iot'];

function formatWhen(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

export default function DevicesView() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState(DEVICE_TYPES[0]);
  const [pendingDelete, setPendingDelete] = useState<Device | null>(null);
  const { success, error: toastError } = useToast();

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDevices(await invoke<Device[]>('get_devices'));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const add = useCallback(async () => {
    if (!name.trim()) return;
    try {
      await invoke<Device>('add_device', { name: name.trim(), deviceType: type });
      success(`Added device ${name}`);
      setName('');
      await fetchDevices();
    } catch (e) {
      toastError(String(e), 'Add failed');
    }
  }, [name, type, fetchDevices, success, toastError]);

  const remove = useCallback((d: Device) => { setPendingDelete(d); }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const d = pendingDelete;
    setPendingDelete(null);
    try {
      await invoke<boolean>('remove_device', { id: d.id });
      success(`Removed ${d.name}`);
      await fetchDevices();
    } catch (e) {
      toastError(String(e), 'Remove failed');
    }
  }, [pendingDelete, fetchDevices, success, toastError]);

  const inputCls =
    'px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50';

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <ConfirmModal
        open={pendingDelete !== null}
        message={`Remove device "${pendingDelete?.name}"?`}
        confirmLabel="Remove"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
      <SectionHeader title="Devices" subtitle="Paired devices and their status" count={devices.length} />

      <div className="flex gap-2">
        <input
          className={cn(inputCls, 'flex-1')}
          placeholder="Device name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
          {DEVICE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={add}
          disabled={!name.trim()}
          className="px-4 py-2 text-sm rounded-lg bg-accent text-bone hover:bg-accent/80 disabled:opacity-40 transition-colors"
        >
          Add
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <LoadingState message="Loading devices…" />
        ) : error ? (
          <ErrorState error={error} onRetry={fetchDevices} />
        ) : devices.length === 0 ? (
          <EmptyState message="No devices paired yet." />
        ) : (
          <ul className="space-y-2">
            {devices.map((d) => {
              const online = d.status.toLowerCase() === 'online';
              return (
                <li key={d.id}>
                  <GlassCard className="p-3">
                    <div className="flex items-center gap-2">
                      <StatusDot ok={online} warn={!online} pulse={online} />
                      <span className="text-sm font-medium text-bone truncate">{d.name}</span>
                      <Pill variant="default">{d.device_type}</Pill>
                      <Pill variant={online ? 'success' : 'default'}>{d.status}</Pill>
                      <button
                        type="button"
                        onClick={() => remove(d)}
                        className="ml-auto text-[11px] px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="mt-1 text-[10px] font-mono text-bone/30">
                      last seen {formatWhen(d.last_seen)}
                    </div>
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
