import { useCallback, useEffect, useReducer, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { cn, Pill, StatusDot } from '../ui';
import {
  deriveSystemTelemetryView,
  initialSystemTelemetryState,
  reduceSystemTelemetryState,
  type HealthData,
} from './system-telemetry-state';

const BUN_URL = 'http://127.0.0.1:19877';

function serviceLabel(label: string, state: 'up' | 'down' | 'unknown', stale: boolean): string {
  const suffix = state === 'up' ? 'UP' : state === 'down' ? 'DOWN' : '?';
  return `${label} ${suffix}${stale ? ' (stale)' : ''}`;
}

function percentLabel(label: string, value: number | null, stale: boolean): string {
  return `${label} ${value === null ? '—' : `${value}%`}${stale && value !== null ? ' (stale)' : ''}`;
}

function inferenceLabel(view: ReturnType<typeof deriveSystemTelemetryView>): string {
  const suffix = view.inference.stale ? ' (stale)' : '';
  if (!view.inference.hasData) {
    if (view.inference.status === 'pending' || view.inference.status === 'unknown') return 'INF …';
    if (view.inference.status === 'stale') return 'INF STALE';
    return 'INF UNAVAILABLE';
  }
  if (!view.inference.hasAttempts) return `INF EMPTY${suffix}`;
  if (view.inference.errorRate !== null) return `ERR ${Math.round(view.inference.errorRate * 100)}%${suffix}`;
  return `INF OK${suffix}`;
}

export default function SystemStatusBar() {
  const [state, dispatch] = useReducer(reduceSystemTelemetryState, undefined, initialSystemTelemetryState);
  const healthRequestId = useRef(0);
  const inferenceRequestId = useRef(0);

  const fetchHealth = useCallback(async () => {
    const id = ++healthRequestId.current;
    dispatch({ type: 'health-pending', requestId: id });
    try {
      const snapshot = await invoke<HealthData>('get_system_health');
      dispatch({ type: 'health-success', requestId: id, snapshot });
    } catch {
      dispatch({ type: 'health-failure', requestId: id });
    }
  }, []);

  const fetchInference = useCallback(async () => {
    const id = ++inferenceRequestId.current;
    dispatch({ type: 'inference-pending', requestId: id });
    try {
      if (typeof globalThis.fetch !== 'function') throw new Error('Inference telemetry unavailable');
      const response = await globalThis.fetch(`${BUN_URL}/health/inference`);
      if (!response.ok) throw new Error('Inference telemetry unavailable');
      dispatch({ type: 'inference-success', requestId: id, snapshot: await response.json() });
    } catch {
      dispatch({ type: 'inference-failure', requestId: id });
    }
  }, []);

  const fetchTelemetry = useCallback(async () => {
    await Promise.all([fetchHealth(), fetchInference()]);
  }, [fetchHealth, fetchInference]);

  useEffect(() => {
    void fetchTelemetry();
    const interval = setInterval(() => { void fetchTelemetry(); }, 30_000);
    return () => clearInterval(interval);
  }, [fetchTelemetry]);

  const view = deriveSystemTelemetryView(state);
  const overallLabel = {
    pending: 'SYS PENDING',
    unavailable: 'SYS UNAVAILABLE',
    stale: 'SYS STALE',
    healthy: 'SYS HEALTHY',
    degraded: 'SYS DEGRADED',
    stopped: 'SYS STOPPED',
  }[view.overall];
  const healthStale = view.health.stale;
  const inferenceStale = view.inference.stale;
  const inferenceStatus = view.inference.status;
  const refreshing = state.health.error || state.inference.error || state.health.data !== null || state.inference.data !== null;

  return (
    <div className="border-b border-white/[0.03]">
      <div
        className={cn(
          'flex items-center gap-2 px-1 py-1.5',
          'text-[10px] font-mono'
        )}
        title="System telemetry"
      >
        <StatusDot
          ok={view.overall === 'healthy'}
          warn={view.overall !== 'healthy' && view.overall !== 'stopped'}
          variant={view.overall === 'stopped' ? 'error' : 'default'}
          size="sm"
        />
        <span className="text-bone/60">{overallLabel}</span>
        <span className={cn('px-1.5 py-0.5 rounded', view.health.services.bun === 'up' ? 'bg-emerald-500/15 text-emerald-300' : view.health.services.bun === 'down' ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300')}>
          {serviceLabel('BUN', view.health.services.bun, healthStale)}
        </span>
        <span className={cn('px-1.5 py-0.5 rounded', view.health.services.bridge === 'up' ? 'bg-emerald-500/15 text-emerald-300' : view.health.services.bridge === 'down' ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300')}>
          {serviceLabel('BRG', view.health.services.bridge, healthStale)}
        </span>
        <span className={cn('px-1.5 py-0.5 rounded', view.health.services.ollama === 'up' ? 'bg-emerald-500/15 text-emerald-300' : view.health.services.ollama === 'down' ? 'bg-amber-500/15 text-amber-300' : 'bg-amber-500/15 text-amber-300')}>
          {serviceLabel('OLL', view.health.services.ollama, healthStale)}
        </span>
        <span className={cn('px-1.5 py-0.5 rounded', view.health.services.proxy === 'up' ? 'bg-emerald-500/15 text-emerald-300' : view.health.services.proxy === 'down' ? 'bg-amber-500/15 text-amber-300' : 'bg-amber-500/15 text-amber-300')}>
          {serviceLabel('PRX', view.health.services.proxy, healthStale)}
        </span>
        <span className={cn('px-1.5 py-0.5 rounded', view.health.memoryPercent === null ? 'bg-amber-500/15 text-amber-300' : view.health.memoryPercent >= 90 ? 'bg-red-500/15 text-red-300' : view.health.memoryPercent >= 80 ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300')}>
          {percentLabel('MEM', view.health.memoryPercent, healthStale)}
        </span>
        <span className={cn('px-1.5 py-0.5 rounded', view.health.diskPercent === null ? 'bg-amber-500/15 text-amber-300' : view.health.diskPercent >= 90 ? 'bg-red-500/15 text-red-300' : view.health.diskPercent >= 80 ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300')}>
          {percentLabel('DSK', view.health.diskPercent, healthStale)}
        </span>
        <span className={cn('px-1.5 py-0.5 rounded', inferenceStatus === 'unavailable' || inferenceStale ? 'bg-amber-500/15 text-amber-300' : view.inference.errorRate !== null && view.inference.errorRate > 0.1 ? 'bg-red-500/15 text-red-300' : 'bg-emerald-500/15 text-emerald-300')}>
          {inferenceLabel(view)}
        </span>
        {view.inference.conductorHitRate !== null && (
          <span className={cn('px-1.5 py-0.5 rounded', view.inference.conductorHitRate >= 0.8 ? 'bg-emerald-500/15 text-emerald-300' : view.inference.conductorHitRate >= 0.5 ? 'bg-amber-500/15 text-amber-300' : 'bg-red-500/15 text-red-300')}>
            CND {Math.round(view.inference.conductorHitRate * 100)}%{inferenceStale ? ' (stale)' : ''}
          </span>
        )}
        {view.health.bunGiveUp && <Pill variant="error" className="text-[9px]">BUN GIVE-UP</Pill>}
        {view.health.proxyGiveUp && <Pill variant="error" className="text-[9px]">PRX GIVE-UP</Pill>}
        {view.health.ollamaGiveUp && <Pill variant="error" className="text-[9px]">OLL GIVE-UP</Pill>}
        {view.loading && (
          <span role="status" aria-label="System telemetry">
            {refreshing ? 'Refreshing system telemetry…' : 'Checking system telemetry…'}
          </span>
        )}
        <button
          type="button"
          aria-label="Refresh system telemetry"
          onClick={() => { void fetchTelemetry(); }}
          disabled={view.loading}
          className="ml-auto text-bone/40 hover:text-bone/70 disabled:opacity-40"
        >
          ↻
        </button>
      </div>
      {view.health.error && (
        <div role="alert" aria-label="System health observation" className="flex items-center gap-2 px-1 py-1 text-[10px] text-amber-200">
          <span>{healthStale ? 'Showing previously observed system health; it may be stale.' : 'System health is unavailable.'}</span>
          <button type="button" aria-label="Retry system health" onClick={() => { void fetchHealth(); }} disabled={view.loading} className="underline disabled:opacity-40">Retry</button>
        </div>
      )}
      {view.inference.error && (
        <div role="alert" aria-label="Inference telemetry observation" className="flex items-center gap-2 px-1 py-1 text-[10px] text-amber-200">
          <span>{inferenceStale ? 'Showing previously observed inference telemetry; it may be stale.' : 'Inference telemetry is unavailable.'}</span>
          <button type="button" aria-label="Retry inference telemetry" onClick={() => { void fetchInference(); }} disabled={view.loading} className="underline disabled:opacity-40">Retry</button>
        </div>
      )}
    </div>
  );
}
