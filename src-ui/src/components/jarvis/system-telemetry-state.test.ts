import { describe, expect, it } from 'vitest';
import {
  deriveSystemTelemetryView,
  initialSystemTelemetryState,
  parseHealthData,
  parseInferenceMetrics,
  projectServiceRequirements,
  reduceSystemTelemetryState,
  summarizeVerdict,
  type HealthData,
  type InferenceMetrics,
} from './system-telemetry-state';

const health: HealthData = {
  ollama: { running: true, model: 'test-model', url: 'http://127.0.0.1:11434' },
  bun_server: { running: true, url: 'http://127.0.0.1:19877' },
  bridge: { running: true, port: 19876 },
  claude_proxy: { running: true, port: 19878 },
  disk: { total: '100G', used: '40G', available: '60G', use_percent: '40%' },
  memory: { total_mb: 1000, available_mb: 580, used_mb: 420, used_percent: 42 },
  supervisor: { bun_give_up: false, proxy_give_up: false, ollama_give_up: false },
  timestamp: '2026-09-24T00:00:00Z',
};

const inference: InferenceMetrics = {
  window_size: 0,
  backends: [],
  generated_at: 1,
  recent_attempts: [],
  conductor_cache: null,
};

describe('system telemetry observation state', () => {
  it('distinguishes unknown, pending, unavailable, and successful empty resources', () => {
    const initial = initialSystemTelemetryState();
    expect(initial.health.status).toBe('unknown');
    expect(initial.inference.status).toBe('unknown');

    const pending = reduceSystemTelemetryState(initial, { type: 'pending', requestId: 1 });
    expect(pending.health.status).toBe('pending');
    expect(pending.inference.status).toBe('pending');

    const unavailable = reduceSystemTelemetryState(pending, { type: 'health-failure', requestId: 1 });
    expect(unavailable.health.status).toBe('unavailable');
    expect(unavailable.inference.status).toBe('pending');

    const retried = reduceSystemTelemetryState(unavailable, { type: 'pending', requestId: 2 });
    expect(retried.health.status).toBe('pending');
    expect(reduceSystemTelemetryState(retried, { type: 'health-success', requestId: 2, snapshot: health }).health.data).toEqual(health);
    expect(reduceSystemTelemetryState(retried, { type: 'inference-success', requestId: 2, snapshot: inference }).inference.status).toBe('ready');
  });

  it('retains a valid snapshot as stale through pending and failed refreshes', () => {
    const loaded = reduceSystemTelemetryState(
      reduceSystemTelemetryState(initialSystemTelemetryState(), { type: 'pending', requestId: 1 }),
      { type: 'health-success', requestId: 1, snapshot: health },
    );
    const pending = reduceSystemTelemetryState(loaded, { type: 'pending', requestId: 2 });
    expect(pending.health.status).toBe('pending');
    expect(pending.health.data).toEqual(health);
    const failed = reduceSystemTelemetryState(pending, { type: 'health-failure', requestId: 2 });
    expect(failed.health.status).toBe('stale');
    expect(failed.health.data).toEqual(health);
    expect(deriveSystemTelemetryView(failed, 'ollama').overall).toBe('stale');
  });

  it('ignores superseded resource completions without ending the latest request', () => {
    const latest = reduceSystemTelemetryState(initialSystemTelemetryState(), { type: 'pending', requestId: 2 });
    expect(reduceSystemTelemetryState(latest, { type: 'health-success', requestId: 1, snapshot: health })).toBe(latest);
    expect(reduceSystemTelemetryState(latest, { type: 'inference-failure', requestId: 1 })).toBe(latest);
    expect(reduceSystemTelemetryState(latest, { type: 'health-failure', requestId: 1 })).toBe(latest);
  });

  it('keeps resource-specific retry lifetimes independent', () => {
    const loaded = reduceSystemTelemetryState(
      reduceSystemTelemetryState(initialSystemTelemetryState(), { type: 'pending', requestId: 1 }),
      { type: 'health-success', requestId: 1, snapshot: health },
    );
    const bothReady = reduceSystemTelemetryState(loaded, { type: 'inference-success', requestId: 1, snapshot: inference });
    const inferenceFailed = reduceSystemTelemetryState(bothReady, { type: 'inference-failure', requestId: 2 });
    const healthRetrying = reduceSystemTelemetryState(inferenceFailed, { type: 'health-pending', requestId: 2 });
    expect(healthRetrying.health.status).toBe('pending');
    expect(healthRetrying.inference.status).toBe('stale');
    expect(healthRetrying.inference.error).toBe(true);
    expect(reduceSystemTelemetryState(healthRetrying, { type: 'health-success', requestId: 2, snapshot: health }).inference.status).toBe('stale');
  });

  it('rejects partial health and inference payloads instead of treating them as empty observations', () => {
    expect(parseHealthData({ ...health, bun_server: undefined })).toBeNull();
    expect(parseHealthData({ ...health, memory: { used_percent: '42%' } })).toBeNull();
    expect(parseInferenceMetrics({ ...inference, backends: [{ backend: 'ollama' }] })).toBeNull();
    expect(parseInferenceMetrics({ ...inference, recent_attempts: null })).toBeNull();
    expect(parseHealthData(health)).toEqual(health);
    expect(parseInferenceMetrics(inference)).toEqual(inference);
  });

  it('derives healthy, degraded, stopped, and optional unavailable states from valid observations', () => {
    const healthy = reduceSystemTelemetryState(
      reduceSystemTelemetryState(initialSystemTelemetryState(), { type: 'pending', requestId: 1 }),
      { type: 'health-success', requestId: 1, snapshot: health },
    );
    const withInference = reduceSystemTelemetryState(healthy, { type: 'inference-success', requestId: 1, snapshot: inference });
    expect(deriveSystemTelemetryView(withInference, 'ollama').overall).toBe('healthy');

    const degradedHealth = {
      ...health,
      ollama: { ...health.ollama, running: false },
      memory: { ...health.memory, used_percent: 85 },
      supervisor: { bun_give_up: false, proxy_give_up: true, ollama_give_up: false },
    };
    const degraded = reduceSystemTelemetryState(
      reduceSystemTelemetryState(initialSystemTelemetryState(), { type: 'pending', requestId: 3 }),
      { type: 'health-success', requestId: 3, snapshot: degradedHealth },
    );
    expect(deriveSystemTelemetryView(degraded, 'ollama').overall).toBe('degraded');

    const stopped = reduceSystemTelemetryState(
      reduceSystemTelemetryState(initialSystemTelemetryState(), { type: 'pending', requestId: 4 }),
      { type: 'health-success', requestId: 4, snapshot: { ...health, bun_server: { ...health.bun_server, running: false } } },
    );
    expect(deriveSystemTelemetryView(stopped, 'ollama').overall).toBe('stopped');

    const optionalUnavailable = reduceSystemTelemetryState(healthy, { type: 'inference-failure', requestId: 2 });
    expect(deriveSystemTelemetryView(optionalUnavailable, 'ollama').overall).toBe('degraded');
    expect(deriveSystemTelemetryView(optionalUnavailable, 'ollama').inference.status).toBe('unavailable');
  });
});

const loaded = (snapshot: HealthData) => reduceSystemTelemetryState(
  reduceSystemTelemetryState(initialSystemTelemetryState(), { type: 'pending', requestId: 1 }),
  { type: 'health-success', requestId: 1, snapshot },
);

const readyWith = (snapshot: HealthData) => reduceSystemTelemetryState(
  loaded(snapshot),
  { type: 'inference-success', requestId: 1, snapshot: inference },
);

const healthyReady = () => readyWith(health);

// A stock OpenRouter install: Bun server and bridge up, Ollama and the
// claude_cli_proxy both not running, nothing over budget.
const stockReadyHealth: HealthData = {
  ...health,
  ollama: { ...health.ollama, running: false, model: null },
  claude_proxy: { ...health.claude_proxy, running: false },
};

const stockReady = () => readyWith(stockReadyHealth);

describe('inference-backend service requirements', () => {
  it('binds the backend-dependent services to the confirmed active inference backend', () => {
    expect(projectServiceRequirements('ollama')).toEqual({
      backend: 'ollama',
      requirements: { bun: 'required', bridge: 'required', ollama: 'required', proxy: 'not_required' },
    });
    expect(projectServiceRequirements('openrouter')).toEqual({
      backend: 'openrouter',
      requirements: { bun: 'required', bridge: 'required', ollama: 'not_required', proxy: 'not_required' },
    });
    expect(projectServiceRequirements('claude_cli')).toEqual({
      backend: 'claude_cli',
      requirements: { bun: 'required', bridge: 'required', ollama: 'not_required', proxy: 'required' },
    });
  });

  it('fails an unknown, absent, or unrecognised active backend to unknown rather than to a required set', () => {
    const unknown = { backend: 'unknown', requirements: { bun: 'required', bridge: 'required', ollama: 'unknown', proxy: 'unknown' } };
    for (const value of [null, undefined, '', '   ', 'gemini', 'claude-cli', 42, {}, ['ollama'], true]) {
      expect(projectServiceRequirements(value)).toEqual(unknown);
    }
  });

  it('normalises surrounding case and whitespace from the persisted backend id', () => {
    expect(projectServiceRequirements(' OpenRouter ')).toEqual(projectServiceRequirements('openrouter'));
    expect(projectServiceRequirements('CLAUDE_CLI')).toEqual(projectServiceRequirements('claude_cli'));
  });
});

describe('required-set aware system telemetry', () => {
  it('reads a service the active backend does not need as not required instead of degraded', () => {
    const view = deriveSystemTelemetryView(stockReady(), 'openrouter');
    expect(view.health.backend).toBe('openrouter');
    expect(view.health.requirements.ollama).toBe('not_required');
    expect(view.health.requirements.proxy).toBe('not_required');
    // The measurement is still reported — only the degradation is withdrawn.
    expect(view.health.services.ollama).toBe('down');
    expect(view.health.services.proxy).toBe('down');
    expect(view.overall).toBe('healthy');
    expect(view.overallReasons).toEqual([]);
  });

  it('still names a required service that is actually down and still degrades', () => {
    const claudeCli = deriveSystemTelemetryView(stockReady(), 'claude_cli');
    expect(claudeCli.health.requirements.proxy).toBe('required');
    expect(claudeCli.health.services.proxy).toBe('down');
    expect(claudeCli.overall).toBe('degraded');
    expect(claudeCli.overallReasons).toEqual(['proxy_down']);

    const ollamaBackend = deriveSystemTelemetryView(stockReady(), 'ollama');
    expect(ollamaBackend.health.requirements.ollama).toBe('required');
    expect(ollamaBackend.health.services.ollama).toBe('down');
    expect(ollamaBackend.overall).toBe('degraded');
    expect(ollamaBackend.overallReasons).toEqual(['ollama_down']);
  });

  it('never reads healthy while the active inference backend is unconfirmed', () => {
    for (const value of [null, undefined, 'gemini']) {
      const view = deriveSystemTelemetryView(stockReady(), value);
      expect(view.health.backend).toBe('unknown');
      expect(view.health.backendUnconfirmed).toBe(true);
      expect(view.health.requirements.ollama).toBe('unknown');
      expect(view.health.requirements.proxy).toBe('unknown');
      expect(view.overall).toBe('degraded');
      expect(view.overallReasons).toEqual(['backend_unconfirmed']);
    }
    const pending = deriveSystemTelemetryView(initialSystemTelemetryState(), null);
    expect(pending.health.backendUnconfirmed).toBe(true);
    expect(pending.overall).toBe('pending');
  });

  it('reaches confirmed healthy only when every required service is confirmed up', () => {
    const allUp = deriveSystemTelemetryView(healthyReady(), 'ollama');
    expect(allUp.overall).toBe('healthy');
    expect(allUp.health.backendUnconfirmed).toBe(false);
    expect(allUp.overallReasons).toEqual([]);

    // One observation, two confirmed backends: the very same snapshot is healthy
    // for the backend that does not need Ollama and degraded for the one that does.
    const stock = stockReady();
    const underOpenRouter = deriveSystemTelemetryView(stock, 'openrouter');
    const underOllama = deriveSystemTelemetryView(stock, 'ollama');
    expect(underOpenRouter.health.services.ollama).toBe(underOllama.health.services.ollama);
    expect(underOpenRouter.overall).toBe('healthy');
    expect(underOllama.overall).toBe('degraded');
  });

  it('keeps the always-required Bun server and bridge, and the supervisor give-up hints, authoritative', () => {
    const openRouter = deriveSystemTelemetryView(stockReady(), 'openrouter');
    expect(openRouter.health.requirements.bun).toBe('required');
    expect(openRouter.health.requirements.bridge).toBe('required');

    const stopped = deriveSystemTelemetryView(
      readyWith({ ...stockReadyHealth, bun_server: { ...health.bun_server, running: false } }),
      'openrouter',
    );
    expect(stopped.overall).toBe('stopped');
    expect(stopped.overallReasons).toEqual(['bun_down']);

    const bridgeDown = deriveSystemTelemetryView(
      readyWith({ ...stockReadyHealth, bridge: { ...health.bridge, running: false } }),
      'openrouter',
    );
    expect(bridgeDown.overall).toBe('stopped');
    expect(bridgeDown.overallReasons).toEqual(['bridge_down']);

    const givenUp = deriveSystemTelemetryView(
      readyWith({ ...stockReadyHealth, supervisor: { bun_give_up: false, proxy_give_up: true, ollama_give_up: true } }),
      'openrouter',
    );
    // A give-up hint still surfaces even for a service this backend does not need.
    expect(givenUp.overall).toBe('degraded');
    expect(givenUp.overallReasons).toEqual(expect.arrayContaining(['proxy_give_up', 'ollama_give_up']));
  });

  it('orders required-set reasons ahead of resource reasons and never repeats one', () => {
    const busy = deriveSystemTelemetryView(
      readyWith({
        ...health,
        ollama: { ...health.ollama, running: false },
        memory: { ...health.memory, used_percent: 91 },
        disk: { ...health.disk, use_percent: '95%' },
      }),
      'ollama',
    );
    expect(busy.overall).toBe('degraded');
    expect(busy.overallReasons).toEqual([
      'ollama_down',
      'memory_pressure',
      'disk_pressure',
    ]);
    expect(new Set(busy.overallReasons).size).toBe(busy.overallReasons.length);

    const inferenceOnly = deriveSystemTelemetryView(
      reduceSystemTelemetryState(stockReady(), { type: 'inference-failure', requestId: 2 }),
      'openrouter',
    );
    expect(inferenceOnly.overall).toBe('degraded');
    expect(inferenceOnly.overallReasons).toEqual(['inference_unavailable']);
  });
});

describe('verdict summary', () => {
  it('confirms the required set and names what the backend does not need', () => {
    expect(summarizeVerdict(deriveSystemTelemetryView(stockReady(), 'openrouter'))).toBe(
      'All services required by the active inference backend (openrouter) are running. Not required by this backend: Ollama and claude_cli_proxy.',
    );
    expect(summarizeVerdict(deriveSystemTelemetryView(healthyReady(), 'ollama'))).toBe(
      'All services required by the active inference backend (ollama) are running. Not required by this backend: claude_cli_proxy.',
    );
    expect(summarizeVerdict(deriveSystemTelemetryView(healthyReady(), 'claude_cli'))).toBe(
      'All services required by the active inference backend (claude_cli) are running. Not required by this backend: Ollama.',
    );
  });

  it('names the required service that is down behind a degraded verdict', () => {
    expect(summarizeVerdict(deriveSystemTelemetryView(stockReady(), 'claude_cli'))).toBe(
      'Degraded: claude_cli_proxy is not running.',
    );
    expect(summarizeVerdict(deriveSystemTelemetryView(stockReady(), 'ollama'))).toBe(
      'Degraded: Ollama is not running.',
    );
  });

  it('states an unconfirmed required set instead of implying a service is at fault', () => {
    expect(summarizeVerdict(deriveSystemTelemetryView(stockReady(), null))).toBe(
      'Degraded: the active inference backend is not confirmed.',
    );
  });

  it('falls back to the bare verdict label when no reason is attributable', () => {
    const pending = deriveSystemTelemetryView(initialSystemTelemetryState(), 'ollama');
    expect(summarizeVerdict(pending)).toBe('Checking system telemetry');
    const stale = deriveSystemTelemetryView(
      reduceSystemTelemetryState(healthyReady(), { type: 'health-pending', requestId: 9 }),
      'ollama',
    );
    expect(stale.overall).toBe('stale');
    expect(stale.overallReasons).toEqual([]);
    expect(summarizeVerdict(stale)).toBe('System health may be stale');
  });

  it('never reports an in-flight inference read as an unavailable one', () => {
    const inflight = deriveSystemTelemetryView(healthyReady(), 'ollama');
    expect(inflight.overall).toBe('healthy');
    const pendingInference = deriveSystemTelemetryView(
      reduceSystemTelemetryState(loaded(health), { type: 'pending', requestId: 3 }),
      'ollama',
    );
    expect(pendingInference.overallReasons).toEqual([]);
  });
});
