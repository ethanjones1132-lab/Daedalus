// ── GatewayView — gateway server status (get_gateway_status) ──

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useReducer, useRef } from 'react';
import {
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
} from '../ui';
import { usePolling } from '../../hooks/usePolling';
import { initialRegistryState, reduceRegistryState } from './action-registry-state';

interface GatewayStatus {
  running: boolean;
  port: number;
  active_connections: number;
  uptime_seconds: number;
  version: string;
  timestamp: string;
}

function formatUptime(seconds: number): string {
  if (seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function GatewayView() {
  const [{ snapshot: status, loading, error }, dispatch] = useReducer(
    reduceRegistryState<GatewayStatus>, initialRegistryState<GatewayStatus>(),
  );
  const requestId = useRef(0);

  const fetchStatus = useCallback(async () => {
    const id = ++requestId.current;
    dispatch({ type: 'pending', requestId: id });
    try {
      const snapshot = await invoke<GatewayStatus>('get_gateway_status');
      dispatch({ type: 'success', requestId: id, snapshot });
    } catch {
      dispatch({ type: 'failure', requestId: id });
    }
  }, []);

  usePolling(fetchStatus, 10000, [fetchStatus]);

  const metrics = status
    ? [
        { label: 'Port', value: String(status.port) },
        { label: 'Connections', value: String(status.active_connections) },
        { label: 'Uptime', value: formatUptime(status.uptime_seconds) },
        { label: 'Version', value: status.version },
      ]
    : [];

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="Gateway"
        subtitle="Local gateway server status"
        action={
          <button
            type="button"
            onClick={fetchStatus}
            disabled={loading}
            className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-bone/60 hover:text-bone transition-colors disabled:opacity-50"
          >
            Refresh
          </button>
        }
      />

      {loading && <div role="status" aria-label="Gateway observation" className="text-sm text-bone-dim">
        {status === null ? 'Checking gateway…' : 'Refreshing gateway status…'}
      </div>}
      {error && <div role="alert" className="text-sm text-bone-dim">
        <p>{status === null ? 'Could not load gateway status.' : 'Could not refresh gateway status. Showing previously observed gateway status; it may be stale.'}</p>
        <button type="button" onClick={fetchStatus} disabled={loading} className="btn-ghost text-xs mt-2 disabled:opacity-50">Retry</button>
      </div>}
      {status ? (
        <div className="space-y-3">
          <GlassCard className="p-4">
            <div className="flex items-center gap-2">
              <StatusDot ok={status.running} warn={!status.running} pulse={status.running} />
              <span className="text-sm font-medium text-bone">
                Gateway is {status.running ? 'running' : 'stopped'}
              </span>
              <Pill variant={status.running ? 'success' : 'error'}>
                {status.running ? 'online' : 'offline'}
              </Pill>
            </div>
          </GlassCard>

          <div className="grid grid-cols-2 gap-3">
            {metrics.map((m) => (
              <GlassCard key={m.label} className="p-3">
                <div className="text-lg font-semibold text-bone truncate">{m.value}</div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40">
                  {m.label}
                </div>
              </GlassCard>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
