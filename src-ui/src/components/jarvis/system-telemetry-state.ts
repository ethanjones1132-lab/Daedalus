export interface OllamaHealth {
  running: boolean;
  model: string | null;
  url: string;
}

export interface BunHealth {
  running: boolean;
  url: string;
}

export interface BridgeHealth {
  running: boolean;
  port: number;
}

export interface ClaudeProxyHealth {
  running: boolean;
  port: number;
}

export interface DiskHealth {
  total: string;
  used: string;
  available: string;
  use_percent: string;
}

export interface MemoryHealth {
  total_mb: number;
  available_mb: number;
  used_mb: number;
  used_percent: number;
}

export interface SupervisorStatus {
  bun_give_up: boolean;
  proxy_give_up: boolean;
  ollama_give_up: boolean;
}

export interface HealthData {
  ollama: OllamaHealth;
  bun_server: BunHealth;
  bridge: BridgeHealth;
  claude_proxy: ClaudeProxyHealth;
  disk: DiskHealth;
  memory: MemoryHealth;
  supervisor?: SupervisorStatus;
  timestamp: string;
}

export interface BackendStats {
  backend: string;
  requests: number;
  errors: number;
  error_rate: number;
  p50_ms: number;
  p95_ms: number;
  total_tokens_in: number;
  total_tokens_out: number;
  last_error?: string;
  last_model?: string;
}

export interface ConductorCacheSummary {
  window_size: number;
  cache_hit_rate: number;
  avg_prefix_recomputed: number;
  records: unknown[];
  generated_at: number;
}

export interface InferenceMetrics {
  window_size: number;
  backends: BackendStats[];
  generated_at: number;
  recent_attempts: unknown[];
  runtime?: {
    event_loop_delay_ms?: { p95?: number; p99?: number };
    event_loop_utilization?: number;
    rss_bytes?: number;
  };
  conductor_cache?: ConductorCacheSummary | null;
}

export type TelemetryResourceStatus = 'unknown' | 'pending' | 'ready' | 'unavailable' | 'stale';

export interface TelemetryResource<T> {
  data: T | null;
  status: TelemetryResourceStatus;
  error: boolean;
  requestId: number;
}

export interface SystemTelemetryState {
  health: TelemetryResource<HealthData>;
  inference: TelemetryResource<InferenceMetrics>;
}

export type SystemTelemetryAction =
  | { type: 'pending'; requestId: number }
  | { type: 'health-pending'; requestId: number }
  | { type: 'inference-pending'; requestId: number }
  | { type: 'health-success'; requestId: number; snapshot: unknown }
  | { type: 'health-failure'; requestId: number }
  | { type: 'inference-success'; requestId: number; snapshot: unknown }
  | { type: 'inference-failure'; requestId: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isValidPort(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

function isHealthData(value: unknown): value is HealthData {
  if (!isRecord(value)) return false;
  const { ollama, bun_server: bunServer, bridge, claude_proxy: claudeProxy, disk, memory } = value;
  if (!isRecord(ollama) || typeof ollama.running !== 'boolean' || (ollama.model !== null && typeof ollama.model !== 'string') || typeof ollama.url !== 'string') return false;
  if (!isRecord(bunServer) || typeof bunServer.running !== 'boolean' || typeof bunServer.url !== 'string') return false;
  if (!isRecord(bridge) || typeof bridge.running !== 'boolean' || !isValidPort(bridge.port)) return false;
  if (!isRecord(claudeProxy) || typeof claudeProxy.running !== 'boolean' || !isValidPort(claudeProxy.port)) return false;
  if (!isRecord(disk) || typeof disk.total !== 'string' || typeof disk.used !== 'string' || typeof disk.available !== 'string' || typeof disk.use_percent !== 'string') return false;
  if (!isRecord(memory) || !isNonNegativeNumber(memory.total_mb) || !isNonNegativeNumber(memory.available_mb) || !isNonNegativeNumber(memory.used_mb) || !isFiniteNumber(memory.used_percent)) return false;
  if (typeof value.timestamp !== 'string') return false;
  if (value.supervisor !== undefined) {
    if (!isRecord(value.supervisor) || typeof value.supervisor.bun_give_up !== 'boolean' || typeof value.supervisor.proxy_give_up !== 'boolean' || typeof value.supervisor.ollama_give_up !== 'boolean') return false;
  }
  return true;
}

function isBackendStats(value: unknown): value is BackendStats {
  if (!isRecord(value) || typeof value.backend !== 'string') return false;
  return isNonNegativeNumber(value.requests)
    && isNonNegativeNumber(value.errors)
    && isFiniteNumber(value.error_rate) && value.error_rate >= 0 && value.error_rate <= 1
    && isFiniteNumber(value.p50_ms) && value.p50_ms >= 0
    && isFiniteNumber(value.p95_ms) && value.p95_ms >= 0
    && isNonNegativeNumber(value.total_tokens_in)
    && isNonNegativeNumber(value.total_tokens_out);
}

function isInferenceMetrics(value: unknown): value is InferenceMetrics {
  if (!isRecord(value) || !isNonNegativeNumber(value.window_size) || !isFiniteNumber(value.generated_at) || !Array.isArray(value.backends) || !value.backends.every(isBackendStats) || !Array.isArray(value.recent_attempts)) return false;
  if (value.conductor_cache !== undefined && value.conductor_cache !== null) {
    if (!isRecord(value.conductor_cache) || !isNonNegativeNumber(value.conductor_cache.window_size) || !isFiniteNumber(value.conductor_cache.cache_hit_rate) || value.conductor_cache.cache_hit_rate < 0 || value.conductor_cache.cache_hit_rate > 1 || !isFiniteNumber(value.conductor_cache.avg_prefix_recomputed) || !Array.isArray(value.conductor_cache.records) || !isFiniteNumber(value.conductor_cache.generated_at)) return false;
  }
  return true;
}

export function parseHealthData(value: unknown): HealthData | null {
  return isHealthData(value) ? value : null;
}

export function parseInferenceMetrics(value: unknown): InferenceMetrics | null {
  return isInferenceMetrics(value) ? value : null;
}

export function initialSystemTelemetryState(): SystemTelemetryState {
  return {
    health: { data: null, status: 'unknown', error: false, requestId: 0 },
    inference: { data: null, status: 'unknown', error: false, requestId: 0 },
  };
}

function beginResource<T>(resource: TelemetryResource<T>, requestId: number): TelemetryResource<T> {
  return { ...resource, status: 'pending', requestId };
}

function failResource<T>(resource: TelemetryResource<T>, requestId: number): TelemetryResource<T> {
  return { ...resource, status: resource.data === null ? 'unavailable' : 'stale', error: true, requestId };
}

function readyResource<T>(requestId: number, data: T): TelemetryResource<T> {
  return { data, status: 'ready', error: false, requestId };
}

export function reduceSystemTelemetryState(state: SystemTelemetryState, action: SystemTelemetryAction): SystemTelemetryState {
  switch (action.type) {
    case 'pending':
      return {
        health: action.requestId < state.health.requestId ? state.health : beginResource(state.health, action.requestId),
        inference: action.requestId < state.inference.requestId ? state.inference : beginResource(state.inference, action.requestId),
      };
    case 'health-pending':
      return action.requestId < state.health.requestId ? state : { ...state, health: beginResource(state.health, action.requestId) };
    case 'inference-pending':
      return action.requestId < state.inference.requestId ? state : { ...state, inference: beginResource(state.inference, action.requestId) };
    case 'health-success': {
      if (action.requestId < state.health.requestId) return state;
      const snapshot = parseHealthData(action.snapshot);
      return { ...state, health: snapshot === null ? failResource(state.health, action.requestId) : readyResource(action.requestId, snapshot) };
    }
    case 'health-failure':
      return action.requestId < state.health.requestId ? state : { ...state, health: failResource(state.health, action.requestId) };
    case 'inference-success': {
      if (action.requestId < state.inference.requestId) return state;
      const snapshot = parseInferenceMetrics(action.snapshot);
      return { ...state, inference: snapshot === null ? failResource(state.inference, action.requestId) : readyResource(action.requestId, snapshot) };
    }
    case 'inference-failure':
      return action.requestId < state.inference.requestId ? state : { ...state, inference: failResource(state.inference, action.requestId) };
  }
}

export type SystemTelemetryOverall = 'pending' | 'unavailable' | 'stale' | 'healthy' | 'degraded' | 'stopped';
export type ServiceState = 'up' | 'down' | 'unknown';
export type TelemetryServiceKey = 'bun' | 'bridge' | 'ollama' | 'proxy';
export type ServiceRequirement = 'required' | 'not_required' | 'unknown';
export type InferenceBackend = 'ollama' | 'openrouter' | 'claude_cli';
export type OverallReason =
  | 'backend_unconfirmed'
  | 'bun_down'
  | 'bridge_down'
  | 'ollama_down'
  | 'proxy_down'
  | 'bun_give_up'
  | 'proxy_give_up'
  | 'ollama_give_up'
  | 'memory_pressure'
  | 'disk_pressure'
  | 'inference_error_rate'
  | 'inference_unavailable';

export interface ServiceRequirementProjection {
  backend: InferenceBackend | 'unknown';
  requirements: Record<TelemetryServiceKey, ServiceRequirement>;
}

const ALWAYS_REQUIRED: Record<TelemetryServiceKey, ServiceRequirement> = {
  bun: 'required',
  bridge: 'required',
  ollama: 'unknown',
  proxy: 'unknown',
};

function normalizeBackend(value: unknown): InferenceBackend | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'ollama' || normalized === 'openrouter' || normalized === 'claude_cli' ? normalized : null;
}

/**
 * Which services the confirmed active inference backend actually needs.
 *
 * `ollama` and `claude_cli_proxy` are the two services that only one
 * inference backend depends on, so a service that is simply not running is
 * only a fault when the active backend requires it. The Bun server and the
 * bridge carry every inference turn, so they are required unconditionally.
 * An unrecognised or absent `active_backend` yields `unknown` for the
 * backend-dependent pair: the required set is not guessed, and an
 * unconfirmed required set can never certify the system as healthy.
 */
export function projectServiceRequirements(activeBackend: unknown): ServiceRequirementProjection {
  const backend = normalizeBackend(activeBackend);
  if (backend === null) return { backend: 'unknown', requirements: { ...ALWAYS_REQUIRED } };
  return {
    backend,
    requirements: {
      ...ALWAYS_REQUIRED,
      ollama: backend === 'ollama' ? 'required' : 'not_required',
      proxy: backend === 'claude_cli' ? 'required' : 'not_required',
    },
  };
}

export interface SystemTelemetryView {
  overall: SystemTelemetryOverall;
  overallReasons: OverallReason[];
  loading: boolean;
  health: {
    status: TelemetryResourceStatus;
    stale: boolean;
    error: boolean;
    backend: InferenceBackend | 'unknown';
    backendUnconfirmed: boolean;
    requirements: Record<TelemetryServiceKey, ServiceRequirement>;
    services: {
      bun: ServiceState;
      bridge: ServiceState;
      ollama: ServiceState;
      proxy: ServiceState;
    };
    memoryPercent: number | null;
    diskPercent: number | null;
    bunGiveUp: boolean;
    proxyGiveUp: boolean;
    ollamaGiveUp: boolean;
  };
  inference: {
    status: TelemetryResourceStatus;
    stale: boolean;
    error: boolean;
    hasData: boolean;
    hasAttempts: boolean;
    errorRate: number | null;
    conductorHitRate: number | null;
  };
}

export function parsePercent(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace('%', '').trim()) : NaN;
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100 ? numeric : null;
}

function serviceState(data: HealthData | null, key: 'bun_server' | 'bridge' | 'ollama' | 'claude_proxy'): ServiceState {
  if (!data) return 'unknown';
  return data[key].running ? 'up' : 'down';
}

function isStale(status: TelemetryResourceStatus, hasData: boolean): boolean {
  return hasData && (status === 'pending' || status === 'stale');
}

const SERVICE_REASON: Record<TelemetryServiceKey, OverallReason> = {
  bun: 'bun_down',
  bridge: 'bridge_down',
  ollama: 'ollama_down',
  proxy: 'proxy_down',
};

export function deriveSystemTelemetryView(state: SystemTelemetryState, activeBackend: unknown): SystemTelemetryView {
  const healthData = state.health.data;
  const healthStale = isStale(state.health.status, healthData !== null);
  const inferenceData = state.inference.data;
  const inferenceStale = isStale(state.inference.status, inferenceData !== null);
  const healthStatus = state.health.status;
  const memoryPercent = healthData ? parsePercent(healthData.memory.used_percent) : null;
  const diskPercent = healthData ? parsePercent(healthData.disk.use_percent) : null;
  const services = {
    bun: serviceState(healthData, 'bun_server'),
    bridge: serviceState(healthData, 'bridge'),
    ollama: serviceState(healthData, 'ollama'),
    proxy: serviceState(healthData, 'claude_proxy'),
  };
  const { backend, requirements } = projectServiceRequirements(activeBackend);
  const backendUnconfirmed = requirements.ollama === 'unknown' || requirements.proxy === 'unknown';
  const errorRates = inferenceData?.backends.map((entry) => entry.error_rate) ?? [];
  const errorRate = inferenceData && inferenceData.window_size > 0 && errorRates.length > 0
    ? Math.max(...errorRates)
    : null;
  const hasInferenceError = errorRate !== null && errorRate > 0.1;
  const inferenceUnavailable = state.inference.status === 'unavailable' || state.inference.status === 'stale' || state.inference.status === 'pending' || state.inference.status === 'unknown';
  // `inferenceUnavailable` also covers a read that is merely still in flight, so
  // the attributable reason is narrower: an unreadable resource, not a pending one.
  const inferenceReadFailed = state.inference.status === 'unavailable' || state.inference.status === 'stale';

  // A service that is not running is a fault only when the confirmed active
  // inference backend needs it. An unconfirmed required set is itself a reason
  // not to certify health, so the projection can never read `healthy` while the
  // backend is unknown — but it also never claims an unprobed service is up.
  const reasons: OverallReason[] = [];
  if (healthData !== null) {
    for (const key of ['bun', 'bridge', 'ollama', 'proxy'] as const) {
      if (services[key] === 'down' && requirements[key] === 'required') reasons.push(SERVICE_REASON[key]);
    }
    if (backendUnconfirmed) reasons.push('backend_unconfirmed');
    if (healthData.supervisor?.bun_give_up ?? false) reasons.push('bun_give_up');
    if (healthData.supervisor?.proxy_give_up ?? false) reasons.push('proxy_give_up');
    if (healthData.supervisor?.ollama_give_up ?? false) reasons.push('ollama_give_up');
    if (memoryPercent === null || memoryPercent >= 80) reasons.push('memory_pressure');
    if (diskPercent === null || diskPercent >= 80) reasons.push('disk_pressure');
    if (hasInferenceError) reasons.push('inference_error_rate');
  }
  if (inferenceReadFailed) reasons.push('inference_unavailable');

  let overall: SystemTelemetryOverall;
  if (healthData === null) {
    overall = healthStatus === 'unavailable' ? 'unavailable' : 'pending';
  } else if (healthStale) {
    overall = 'stale';
  } else if (services.bun === 'down' || services.bridge === 'down') {
    overall = 'stopped';
  } else if (inferenceUnavailable || reasons.length > 0) {
    overall = 'degraded';
  } else {
    overall = 'healthy';
  }
  return {
    overall,
    overallReasons: reasons,
    loading: state.health.status === 'pending' || state.inference.status === 'pending',
    health: {
      status: healthStatus,
      stale: healthStale,
      error: state.health.error,
      backend,
      backendUnconfirmed,
      requirements,
      services,
      memoryPercent,
      diskPercent,
      bunGiveUp: healthData?.supervisor?.bun_give_up ?? false,
      proxyGiveUp: healthData?.supervisor?.proxy_give_up ?? false,
      ollamaGiveUp: healthData?.supervisor?.ollama_give_up ?? false,
    },
    inference: {
      status: state.inference.status,
      stale: inferenceStale,
      error: state.inference.error,
      hasData: inferenceData !== null,
      hasAttempts: inferenceData !== null && inferenceData.window_size > 0,
      errorRate,
      conductorHitRate: inferenceData?.conductor_cache?.cache_hit_rate ?? null,
    },
  };
}

export const SERVICE_NAMES: Record<TelemetryServiceKey, string> = {
  bun: 'Bun server',
  bridge: 'bridge',
  ollama: 'Ollama',
  proxy: 'claude_cli_proxy',
};

const REASON_PHRASES: Record<OverallReason, string> = {
  backend_unconfirmed: 'the active inference backend is not confirmed',
  bun_down: 'Bun server is not running',
  bridge_down: 'the bridge is not running',
  ollama_down: 'Ollama is not running',
  proxy_down: 'claude_cli_proxy is not running',
  bun_give_up: 'Bun server auto-restart is paused',
  proxy_give_up: 'claude_cli_proxy auto-restart is paused',
  ollama_give_up: 'Ollama auto-restart is paused',
  memory_pressure: 'memory use is high',
  disk_pressure: 'disk use is high',
  inference_error_rate: 'the inference error rate is high',
  inference_unavailable: 'inference telemetry is unavailable',
};

const VERDICT_LABELS: Record<SystemTelemetryOverall, string> = {
  pending: 'Checking system telemetry',
  unavailable: 'System health is unavailable',
  stale: 'System health may be stale',
  healthy: 'All required services are running',
  degraded: 'Degraded',
  stopped: 'Stopped',
};

function listNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
export { listNames };

/**
 * The one requirement vocabulary both mounted health surfaces print, so a
 * service the active backend does not need can never read as a fault on one
 * surface and as a fault on the other.
 */
export const REQUIREMENT_WORDS: Record<ServiceRequirement, string> = {
  required: ' and required by the active inference backend',
  not_required: ' and not required by the active inference backend',
  unknown: ' and whether it is required is unknown because the active inference backend is not confirmed',
};

/**
 * One sentence naming what the current verdict is and why, so degradation and
 * recovery are both announced as text rather than only implied by colour.
 */
export function summarizeVerdict(view: SystemTelemetryView): string {
  if (view.overall === 'healthy') {
    const unused = (['bun', 'bridge', 'ollama', 'proxy'] as const)
      .filter((key) => view.health.requirements[key] === 'not_required');
    const suffix = unused.length > 0
      ? ` Not required by this backend: ${listNames(unused.map((key) => SERVICE_NAMES[key]))}.`
      : '';
    return `All services required by the active inference backend (${view.health.backend}) are running.${suffix}`;
  }
  if (view.overallReasons.length === 0) return VERDICT_LABELS[view.overall];
  return `${VERDICT_LABELS[view.overall]}: ${listNames(view.overallReasons.map((reason) => REASON_PHRASES[reason]))}.`;
}
