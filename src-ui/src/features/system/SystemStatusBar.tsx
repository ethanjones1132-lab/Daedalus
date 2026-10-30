// ═══════════════════════════════════════════════════════════════
// ── SystemStatusBar — the instrument strip in the shell footer
// ═══════════════════════════════════════════════════════════════
//
// Compact mono chips separated by hairlines: verdict, BUN / BRG / OLL|GEM /
// PRX, MEM / DSK, INF, CND. Every chip carries a full-sentence aria-label so
// state never depends on colour. Takes no props: it reads the persisted
// `active_backend` itself (`jarvis_get_config`) so a service can be judged
// required or not, and polls visibility-aware (`usePolling`).

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RotateCw } from 'lucide-react';
import { Badge, cn, IconButton, Spinner, StatusDot, type Tone } from '../../design';
import { usePolling } from '../../hooks/usePolling';
import {
  deriveSystemTelemetryView,
  initialSystemTelemetryState,
  reduceSystemTelemetryState,
  summarizeVerdict,
  REQUIREMENT_WORDS,
  SERVICE_NAMES,
  type HealthData,
  type ServiceRequirement,
  type ServiceState,
  type SystemTelemetryOverall,
  type TelemetryServiceKey,
} from '../../domain/system-telemetry-state';

const BUN_URL = 'http://127.0.0.1:19877';
const POLL_MS = 30_000;

const CHIP_LABELS: Record<TelemetryServiceKey, string> = {
  bun: 'BUN',
  bridge: 'BRG',
  ollama: 'OLL',
  proxy: 'PRX',
};

const STATE_WORDS: Record<ServiceState, string> = {
  up: 'is up',
  down: 'is not running',
  unknown: 'state is unknown',
};

const REQUIREMENT_MARKS: Record<ServiceRequirement, string> = {
  required: '',
  not_required: ' · NR',
  disabled: ' · OFF',
  unknown: ' · REQ?',
};

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink-2',
  muted: 'text-ink-4',
  accent: 'text-accent',
  ok: 'text-ok',
  info: 'text-info',
  warn: 'text-warn',
  error: 'text-err',
};

// Severity is unchanged from the legacy bar: the always-required Bun server and
// bridge read as errors, the backend-dependent pair as warnings. A service
// outside the active backend's required set is deliberately muted, so colour
// keeps meaning "this matters for the backend you are running".
const DOWN_TONE: Record<TelemetryServiceKey, Tone> = {
  bun: 'error',
  bridge: 'error',
  ollama: 'warn',
  proxy: 'warn',
};

function serviceLabel(label: string, state: ServiceState, stale: boolean, requirement: ServiceRequirement): string {
  // OFF: the operator turned the bridge off. It is not down and not a fault.
  const suffix = state === 'up' ? 'UP' : state === 'down' ? (requirement === 'disabled' ? 'OFF' : 'DOWN') : '?';
  return `${label} ${suffix}${stale ? ' (stale)' : ''}`;
}

function serviceAnnouncement(
  key: TelemetryServiceKey,
  state: ServiceState,
  stale: boolean,
  requirement: ServiceRequirement,
  backend: string,
): string {
  const name = key === 'ollama' && backend === 'llama_cpp' ? 'llama.cpp server' : SERVICE_NAMES[key];
  return `${name} ${STATE_WORDS[state]}${REQUIREMENT_WORDS[requirement]}.${stale ? ' This is a previously observed state.' : ''}`;
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

function percentTone(value: number | null): Tone {
  if (value === null) return 'warn';
  if (value >= 90) return 'error';
  if (value >= 80) return 'warn';
  return 'ok';
}

const OVERALL_LABEL: Record<SystemTelemetryOverall, string> = {
  pending: 'SYS PENDING',
  unavailable: 'SYS UNAVAILABLE',
  stale: 'SYS STALE',
  healthy: 'SYS HEALTHY',
  degraded: 'SYS DEGRADED',
  stopped: 'SYS STOPPED',
};

const OVERALL_TONE: Record<SystemTelemetryOverall, Tone> = {
  pending: 'muted',
  unavailable: 'warn',
  stale: 'warn',
  healthy: 'ok',
  degraded: 'warn',
  stopped: 'error',
};

/** One chip: dot + mono text, with its full sentence as the accessible name. */
function Chip({ tone, label, name }: { tone: Tone; label: string; name?: string }) {
  return (
    <span aria-label={name} className={cn('inline-flex h-full shrink-0 items-center gap-1.5 px-2.5', TONE_TEXT[tone])}>
      <StatusDot tone={tone} className="size-[5px]" />
      {label}
    </span>
  );
}

export default function SystemStatusBar() {
  const [state, dispatch] = useReducer(reduceSystemTelemetryState, undefined, initialSystemTelemetryState);
  const [activeBackend, setActiveBackend] = useState<string | null>(null);
  // The bridge requirement follows the operator's Enable Bridge setting. Only
  // an explicit false disables it; an unreadable config keeps the last value
  // rather than guessing.
  const [bridgeEnabled, setBridgeEnabled] = useState<boolean>(true);
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

  // The persisted Inference backend decides which services are required. A
  // failed read keeps the last confirmed backend; it never invents one.
  const fetchBackend = useCallback(async () => {
    try {
      const config = await invoke<{ active_backend?: unknown; bridge_enabled?: unknown } | null>('jarvis_get_config');
      const backend = config?.active_backend;
      setActiveBackend(typeof backend === 'string' ? backend : null);
      if (typeof config?.bridge_enabled === 'boolean') setBridgeEnabled(config.bridge_enabled);
    } catch {
      /* keep the last confirmed backend and bridge setting */
    }
  }, []);

  const fetchTelemetry = useCallback(async () => {
    await Promise.all([fetchHealth(), fetchInference(), fetchBackend()]);
  }, [fetchHealth, fetchInference, fetchBackend]);

  usePolling(fetchTelemetry, POLL_MS, [fetchTelemetry]);

  const view = deriveSystemTelemetryView(state, activeBackend, bridgeEnabled);
  const healthStale = view.health.stale;
  const inferenceStale = view.inference.stale;
  const inferenceStatus = view.inference.status;
  const refreshing = state.health.error || state.inference.error || state.health.data !== null || state.inference.data !== null;
  const verdict = summarizeVerdict(view);
  const llama = view.health.backend === 'llama_cpp';

  const serviceTone = (key: TelemetryServiceKey): Tone => {
    const serviceState = view.health.services[key];
    if (view.health.requirements[key] === 'not_required' || view.health.requirements[key] === 'disabled') return 'muted';
    if (serviceState === 'up') return 'ok';
    if (serviceState === 'down') return DOWN_TONE[key];
    return 'warn';
  };
  const inferenceTone: Tone =
    inferenceStatus === 'unavailable' || inferenceStale
      ? 'warn'
      : view.inference.errorRate !== null && view.inference.errorRate > 0.1
        ? 'error'
        : 'ok';
  const hit = view.inference.conductorHitRate;
  const retry = (reader: () => void) => () => {
    focusAfterRetry.current = true;
    reader();
  };

  return (
    <div
      title="System telemetry"
      className="flex h-full w-full min-w-0 items-stretch overflow-hidden font-mono text-[10.5px] tracking-[0.02em] divide-x divide-line"
    >
      <span className={cn('inline-flex h-full shrink-0 items-center gap-1.5 pr-2.5', TONE_TEXT[OVERALL_TONE[view.overall]])}>
        <StatusDot tone={OVERALL_TONE[view.overall]} live={view.overall === 'healthy'} />
        {OVERALL_LABEL[view.overall]}
      </span>

      {(Object.keys(CHIP_LABELS) as TelemetryServiceKey[]).map((key) => (
        <Chip
          key={key}
          tone={serviceTone(key)}
          name={serviceAnnouncement(key, view.health.services[key], healthStale, view.health.requirements[key], view.health.backend)}
          label={`${serviceLabel(key === 'ollama' && llama ? 'LCP' : CHIP_LABELS[key], view.health.services[key], healthStale, view.health.requirements[key])}${REQUIREMENT_MARKS[view.health.requirements[key]]}`}
        />
      ))}

      <Chip name={view.health.memoryReading?.basis ?? undefined} tone={percentTone(view.health.memoryPercent)} label={percentLabel('MEM', view.health.memoryPercent, healthStale)} />
      <Chip tone={percentTone(view.health.diskPercent)} label={percentLabel('DSK', view.health.diskPercent, healthStale)} />
      <Chip tone={inferenceTone} label={inferenceLabel(view)} />
      {hit !== null && (
        <Chip
          tone={hit >= 0.8 ? 'ok' : hit >= 0.5 ? 'warn' : 'error'}
          label={`CND ${Math.round(hit * 100)}%${inferenceStale ? ' (stale)' : ''}`}
        />
      )}

      {(view.health.bunGiveUp || view.health.proxyGiveUp || view.health.ollamaGiveUp) && (
        <span className="inline-flex h-full shrink-0 items-center gap-1 px-2.5">
          {view.health.bunGiveUp && <Badge tone="error" size="xs">BUN GIVE-UP</Badge>}
          {view.health.proxyGiveUp && <Badge tone="error" size="xs">PRX GIVE-UP</Badge>}
          {view.health.ollamaGiveUp && <Badge tone="error" size="xs">{llama ? 'LCP' : 'OLL'} GIVE-UP</Badge>}
        </span>
      )}

      {view.loading && (
        <span role="status" aria-label="System telemetry" className="inline-flex h-full shrink-0 items-center gap-1.5 px-2.5 text-ink-3">
          <Spinner size={10} />
          {refreshing ? 'Refreshing system telemetry…' : 'Checking system telemetry…'}
        </span>
      )}

      {view.health.error && (
        <span role="alert" aria-label="System health observation" className="inline-flex h-full shrink-0 items-center gap-2 px-2.5 text-warn">
          <span className="sr-only">{healthStale ? 'Showing previously observed system health; it may be stale.' : 'System health is unavailable.'}</span>
          <span aria-hidden="true" title={healthStale ? 'Showing previously observed system health; it may be stale.' : 'System health is unavailable.'}>
            {healthStale ? 'health read stale' : 'health unread'}
          </span>
          <button
            type="button"
            aria-label="Retry system health"
            onClick={retry(() => { void fetchHealth(); })}
            disabled={view.loading}
            className="shrink-0 underline underline-offset-2 hover:text-ink disabled:opacity-40"
          >
            Retry
          </button>
        </span>
      )}
      {view.inference.error && (
        <span role="alert" aria-label="Inference telemetry observation" className="inline-flex h-full shrink-0 items-center gap-2 px-2.5 text-warn">
          <span className="sr-only">{inferenceStale ? 'Showing previously observed inference telemetry; it may be stale.' : 'Inference telemetry is unavailable.'}</span>
          <span aria-hidden="true" title={inferenceStale ? 'Showing previously observed inference telemetry; it may be stale.' : 'Inference telemetry is unavailable.'}>
            {inferenceStale ? 'inference read stale' : 'inference unread'}
          </span>
          <button
            type="button"
            aria-label="Retry inference telemetry"
            onClick={retry(() => { void fetchInference(); })}
            disabled={view.loading}
            className="shrink-0 underline underline-offset-2 hover:text-ink disabled:opacity-40"
          >
            Retry
          </button>
        </span>
      )}

      {/* The verdict sentence always survives (focus hand-off target). */}
      <span className="flex h-full min-w-0 flex-1 items-center pl-2.5 pr-1">
        {view.health.status !== 'pending' && view.health.status !== 'unknown' && (
          <span
            ref={verdictRef}
            role="status"
            aria-label="System telemetry verdict"
            tabIndex={-1}
            title={verdict}
            className="block min-w-0 truncate text-ink-4 focus:outline-none focus-visible:outline-none"
          >
            {verdict}
          </span>
        )}
      </span>

      <span className="inline-flex h-full shrink-0 items-center pl-1.5">
        <IconButton
          size="xs"
          aria-label="Refresh system telemetry"
          title="Refresh system telemetry"
          onClick={() => { void fetchTelemetry(); }}
          disabled={view.loading}
        >
          <RotateCw aria-hidden="true" className="size-3" />
        </IconButton>
      </span>
    </div>
  );
}
