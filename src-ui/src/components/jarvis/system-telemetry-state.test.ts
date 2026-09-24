import { describe, expect, it } from 'vitest';
import {
  deriveSystemTelemetryView,
  initialSystemTelemetryState,
  parseHealthData,
  parseInferenceMetrics,
  reduceSystemTelemetryState,
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
    expect(deriveSystemTelemetryView(failed).overall).toBe('stale');
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
    expect(deriveSystemTelemetryView(withInference).overall).toBe('healthy');

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
    expect(deriveSystemTelemetryView(degraded).overall).toBe('degraded');

    const stopped = reduceSystemTelemetryState(
      reduceSystemTelemetryState(initialSystemTelemetryState(), { type: 'pending', requestId: 4 }),
      { type: 'health-success', requestId: 4, snapshot: { ...health, bun_server: { ...health.bun_server, running: false } } },
    );
    expect(deriveSystemTelemetryView(stopped).overall).toBe('stopped');

    const optionalUnavailable = reduceSystemTelemetryState(healthy, { type: 'inference-failure', requestId: 2 });
    expect(deriveSystemTelemetryView(optionalUnavailable).overall).toBe('degraded');
    expect(deriveSystemTelemetryView(optionalUnavailable).inference.status).toBe('unavailable');
  });
});
