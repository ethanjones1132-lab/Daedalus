import { vi } from 'vitest';
import type { HealthData } from '../../domain/system-telemetry-state';
import type { JarvisStatus } from '../../domain/types';
import type { DoctorReport } from './health-format';

/** Synthetic native fixtures shared by the Health page tests. */
export const status: JarvisStatus = {
  ollama_running: true,
  model_available: true,
  bun_server_running: true,
  bun_server_url: 'http://localhost:19877',
  claude_proxy_running: false,
  bridge_active: true,
  bridge_port: 19876,
  bun_available: true,
  active_backend: 'ollama',
  model: 'test-model',
  openrouter_key_set: false,
};

export const doctor: DoctorReport = {
  checks: [{ name: 'Synthetic check', status: 'ok', detail: 'Observed detail' }],
  summary: { total: 1, ok: 1, warn: 0, error: 0, overall: 'ok' },
  timestamp: 'synthetic',
};

export function healthFor(
  key: 'ollama' | 'bun' | 'proxy',
  running: boolean,
  timestamp = 'synthetic',
): HealthData {
  return {
    ollama: { running: key === 'ollama' ? running : true, model: 'local', url: 'http://ollama.test' },
    bun_server: { running: key === 'bun' ? running : true, url: 'http://bun.test' },
    bridge: { running: true, port: 19876 },
    claude_proxy: { running: key === 'proxy' ? running : true, port: 19878 },
    disk: { total: '100G', used: '20G', available: '80G', use_percent: '20%' },
    memory: { total_mb: 1000, available_mb: 700, used_mb: 300, used_percent: 30 },
    supervisor: { bun_give_up: false, proxy_give_up: false, ollama_give_up: false },
    timestamp,
  };
}

export const cleanBuild = {
  version: '0.6.0',
  git_sha: 'a1b2c3d4e5f6a7b8',
  git_short: 'a1b2c3d4e5',
  dirty: false,
  build_time: '2026-09-25T10:00:00Z',
  source_sha: 'a1b2c3d4e5f6a7b8',
  stale: false,
};

/** The Bun server is not reachable: every `GET /health*` read fails quietly. */
export function stubUnreachableBun() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 503 })));
}

export function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
