import { useCallback, useEffect, useReducer, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { cn, Pill, StatusDot } from '../ui';
import {
  deriveSystemTelemetryView,
  initialSystemTelemetryState,
  reduceSystemTelemetryState,
  summarizeVerdict,
  type HealthData,
  type ServiceRequirement,
  type ServiceState,
  type TelemetryServiceKey,
  REQUIREMENT_WORDS,
  SERVICE_NAMES,
} from './system-telemetry-state';

const BUN_URL = 'http://127.0.0.1:19877';

const CHIP_LABELS: Record<TelemetryServiceKey, string> = {
  bun: 'BUN',
  bridge: 'BRG',
  ollama: 'OLL',
  proxy: 'PRX',
};

// Severity is unchanged from before: the always-required Bun server and bridge
// read red, the backend-dependent pair read amber. A service outside the active
// backend's required set is deliberately neutral, so colour keeps meaning
// "this matters for the backend you are running".
const DOWN_CHIP_CLASS: Record<TelemetryServiceKey, string> = {
  bun: 'bg-red-500/15 text-red-300',
  bridge: 'bg-red-500/15 text-red-300',
  ollama: 'bg-amber-500/15 text-amber-300',
  proxy: 'bg-amber-500/15 text-amber-300',
};

const STATE_WORDS: Record<ServiceState, string> = {
  up: 'is up',
  down: 'is not running',
  unknown: 'state is unknown',
};

const REQUIREMENT_MARKS: Record<ServiceRequirement, string> = {
  required: '',
  not_required: ' · NR',
  unknown: ' · REQ?',
};

function serviceLabel(label: string, state: ServiceState, stale: boolean): string {
  const suffix = state === 'up' ? 'UP' : state === 'down' ? 'DOWN' : '?';
  return `${label} ${suffix}${stale ? ' (stale)' : ''}`;
}

function serviceAnnouncement(key: TelemetryServiceKey, state: ServiceState, stale: boolean, requirement: ServiceRequirement): string {
  return `${SERVICE_NAMES[key]} ${STATE_WORDS[state]}${REQUIREMENT_WORDS[requirement]}.${stale ? ' This is a previously observed state.' : ''}`;
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

interface SystemStatusBarProps {
  /** The persisted `active_backend`, so a service can be judged required or not. */
  activeBackend?: string | null;
}

export default function SystemStatusBar({ activeBackend = null }: SystemStatusBarProps) {
  const [state, dispatch] = useReducer(reduceSystemTelemetryState, undefined, initialSystemTelemetryState);
  const healthRequestId = useRef(0);
  const inferenceRequestId = useRef(0);
  const verdictRef = useRef<HTMLSpanElement | null>(null);
  // A focused Retry disappears the moment its read recovers. Without this the
  // browser strands focus on the document body, so recovery is tracked and the
  // verdict region — which always survives — takes the focus instead. The flag
  // is held until the alert is actually gone and the region is mounted, so
  // focus never jumps away from a Retry that is still on screen.
  const focusAfterRetry = useRef(false);
  const healthError = state.health.error;
  const inferenceError = state.inference.error;

  useEffect(() => {
    if (!focusAfterRetry.current || healthError || inferenceError) return;
    const node = verdictRef.current;
    if (!node) return;
    focusAfterRetry.current = false;
    node.focus();
  });

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

  const view = deriveSystemTelemetryView(state, activeBackend);
  const healthStale = view.health.stale;
  const inferenceStale = view.inference.stale;
  const inferenceStatus = view.inference.status;
  const refreshing = state.health.error || state.inference.error || state.health.data !== null || state.inference.data !== null;
  const verdict = summarizeVerdict(view);
  const chipClass = (key: TelemetryServiceKey) => {
    const serviceState = view.health.services[key];
    const requirement = view.health.requirements[key];
    if (requirement === 'not_required') return 'bg-white/[0.05] text-bone/50';
    if (serviceState === 'up') return 'bg-emerald-500/15 text-emerald-300';
    if (serviceState === 'down') return DOWN_CHIP_CLASS[key];
    return 'bg-amber-500/15 text-amber-300';
  };
  const retry = (reader: () => void) => () => {
    focusAfterRetry.current = true;
    reader();
  };

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
        <span className="text-bone/60">{overallLabel(view.overall)}</span>
        {(Object.keys(CHIP_LABELS) as TelemetryServiceKey[]).map(key => (
          <span key={key} className={cn('px-1.5 py-0.5 rounded', chipClass(key))} aria-label={serviceAnnouncement(key, view.health.services[key], healthStale, view.health.requirements[key])}>
            {serviceLabel(CHIP_LABELS[key], view.health.services[key], healthStale)}{REQUIREMENT_MARKS[view.health.requirements[key]]}
          </span>
        ))}
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
      {view.health.status !== 'pending' && view.health.status !== 'unknown' && (
        <span
          ref={verdictRef}
          role="status"
          aria-label="System telemetry verdict"
          tabIndex={-1}
          className="block px-1 py-1 text-[10px] text-bone/50 focus:outline-none focus-visible:outline-none"
        >
          {verdict}
        </span>
      )}
      {view.health.error && (
        <div role="alert" aria-label="System health observation" className="flex items-center gap-2 px-1 py-1 text-[10px] text-amber-200">
          <span>{healthStale ? 'Showing previously observed system health; it may be stale.' : 'System health is unavailable.'}</span>
          <button type="button" aria-label="Retry system health" onClick={retry(() => { void fetchHealth(); })} disabled={view.loading} className="underline disabled:opacity-40">Retry</button>
        </div>
      )}
      {view.inference.error && (
        <div role="alert" aria-label="Inference telemetry observation" className="flex items-center gap-2 px-1 py-1 text-[10px] text-amber-200">
          <span>{inferenceStale ? 'Showing previously observed inference telemetry; it may be stale.' : 'Inference telemetry is unavailable.'}</span>
          <button type="button" aria-label="Retry inference telemetry" onClick={retry(() => { void fetchInference(); })} disabled={view.loading} className="underline disabled:opacity-40">Retry</button>
        </div>
      )}
    </div>
  );
}

function overallLabel(overall: ReturnType<typeof deriveSystemTelemetryView>['overall']): string {
  return {
    pending: 'SYS PENDING',
    unavailable: 'SYS UNAVAILABLE',
    stale: 'SYS STALE',
    healthy: 'SYS HEALTHY',
    degraded: 'SYS DEGRADED',
    stopped: 'SYS STOPPED',
  }[overall];
}
