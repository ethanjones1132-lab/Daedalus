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
import { projectGatewayStatus, type GatewayStatusRecord } from './gateway-metrics';

export default function GatewayView() {
  const [{ snapshot: status, loading, error }, dispatch] = useReducer(
    reduceRegistryState<GatewayStatusRecord>, initialRegistryState<GatewayStatusRecord>(),
  );
  const requestId = useRef(0);

  const fetchStatus = useCallback(async () => {
    const id = ++requestId.current;
    dispatch({ type: 'pending', requestId: id });
    try {
      const snapshot = await invoke<GatewayStatusRecord>('get_gateway_status');
      dispatch({ type: 'success', requestId: id, snapshot });
    } catch {
      dispatch({ type: 'failure', requestId: id });
    }
  }, []);

  usePolling(fetchStatus, 10000, [fetchStatus]);

  const view = status ? projectGatewayStatus(status) : null;

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
      {view ? (
        <div className="space-y-3">
          <GlassCard className="p-4">
            <div className="flex items-center gap-2">
              <StatusDot ok={view.ok} warn={view.warn} />
              <span className="text-sm font-medium text-bone">
                {view.claimLabel}
              </span>
              <Pill variant={view.tone}>
                {view.pill}
              </Pill>
            </div>
            <p className="mt-2 text-[11px] text-bone-faint">{view.basis}</p>
          </GlassCard>

          <div className="grid grid-cols-2 gap-3">
            {view.metrics.map((m) => (
              <GlassCard key={m.key} className="p-3">
                <div className="text-lg font-semibold text-bone truncate">{m.value}</div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40">
                  {m.label}
                </div>
                <p className="mt-1 text-[10px] text-bone-faint">{m.basis}</p>
              </GlassCard>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
