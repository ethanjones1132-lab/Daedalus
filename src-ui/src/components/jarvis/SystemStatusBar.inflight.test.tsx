import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SystemStatusBar from './SystemStatusBar';
import type { HealthData, InferenceMetrics } from './system-telemetry-state';

const { invokeMock, fetchMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), fetchMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const baseHealth: HealthData = {
  ollama: { running: true, model: 'test-model', url: 'http://127.0.0.1:11434' },
  bun_server: { running: true, url: 'http://127.0.0.1:19877' },
  bridge: { running: true, port: 19876 },
  claude_proxy: { running: true, port: 19878 },
  disk: { total: '100G', used: '40G', available: '60G', use_percent: '40%' },
  memory: { total_mb: 1000, available_mb: 580, used_mb: 420, used_percent: 42 },
  supervisor: { bun_give_up: false, proxy_give_up: false, ollama_give_up: false },
  timestamp: '2026-09-24T00:00:00Z',
};

const emptyInference: InferenceMetrics = {
  window_size: 0,
  backends: [],
  generated_at: 1,
  recent_attempts: [],
  conductor_cache: null,
};

let healthRequests: Deferred<unknown>[];
let inferenceRequests: Deferred<Response>[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  healthRequests = [];
  inferenceRequests = [];
  invokeMock.mockReset().mockImplementation(() => {
    const request = deferred<unknown>();
    healthRequests.push(request);
    return request.promise;
  });
  fetchMock.mockReset().mockImplementation(() => {
    const request = deferred<Response>();
    inferenceRequests.push(request);
    return request.promise;
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const mount = async (activeBackend: string | null = 'ollama') => {
  await act(async () => { render(<SystemStatusBar activeBackend={activeBackend} />); });
};
const settleHealth = async (index: number, value: unknown = baseHealth) => { await act(async () => { healthRequests[index].resolve(value); }); };
const settleInference = async (index: number, value: unknown = emptyInference) => { await act(async () => { inferenceRequests[index].resolve(new Response(JSON.stringify(value), { status: 200 })); }); };
const failInference = async (index: number) => { await act(async () => { inferenceRequests[index].reject(new Error('private inference detail')); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const status = () => screen.getByRole('status', { name: 'System telemetry' });
const verdict = () => screen.getByRole('status', { name: 'System telemetry verdict' });
const refresh = () => screen.getByRole('button', { name: 'Refresh system telemetry' });

// The health read is a native `invoke` and the inference read an HTTP fetch to
// the Bun server, issued together. Whenever the native read answers first, the
// shell's most authoritative line is describing half an observation.
describe('SystemStatusBar with the inference read still outstanding', () => {
  it('reads as still checking rather than as a confirmed degraded system', async () => {
    await mount();
    await settleHealth(0);
    expect(healthRequests).toHaveLength(1);
    expect(inferenceRequests).toHaveLength(1);

    expect(screen.queryByText('SYS DEGRADED')).not.toBeInTheDocument();
    expect(screen.getByText('SYS PENDING')).toBeInTheDocument();
    expect(verdict()).toHaveTextContent('Checking system telemetry');
    // The request in flight is announced as such, by the pending status the bar
    // already renders beside the verdict.
    expect(status()).toHaveTextContent('Refreshing system telemetry');
    // Nothing failed, so there is no alert and nothing to retry.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(refresh()).toBeDisabled();
  });

  it('does not paint a reading that has not arrived as a confirmed one', async () => {
    await mount();
    await settleHealth(0);
    const chip = screen.getByText('INF …');
    expect(chip.className).not.toContain('emerald');
    expect(chip.className).not.toContain('amber');
    expect(screen.getByText('BUN UP')).toBeInTheDocument();
  });

  it('confirms health as soon as the outstanding read answers', async () => {
    await mount();
    await settleHealth(0);
    await settleInference(0);
    expect(screen.getByText('SYS HEALTHY')).toBeInTheDocument();
    expect(verdict()).toHaveTextContent('All services required by the active inference backend (ollama) are running.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not flash a fault on every 30s refresh that lands between the two reads', async () => {
    await mount();
    await settleHealth(0);
    await settleInference(0);
    expect(screen.getByText('SYS HEALTHY')).toBeInTheDocument();

    await advance(30000);
    await settleHealth(1);
    expect(screen.getByText('SYS PENDING')).toBeInTheDocument();
    expect(screen.queryByText('SYS DEGRADED')).not.toBeInTheDocument();
    expect(screen.getByText('INF EMPTY (stale)')).toBeInTheDocument();

    await settleInference(1);
    expect(screen.getByText('SYS HEALTHY')).toBeInTheDocument();
  });

  it('still names a confirmed fault, and still offers its own retry, once the read comes back failed', async () => {
    await mount();
    await settleHealth(0);
    expect(screen.getByText('SYS PENDING')).toBeInTheDocument();
    await failInference(0);
    expect(screen.getByRole('alert', { name: 'Inference telemetry observation' })).toHaveTextContent('Inference telemetry is unavailable.');
    expect(screen.getByText('SYS DEGRADED')).toBeInTheDocument();
    expect(verdict()).toHaveTextContent('Degraded: inference telemetry is unavailable.');
    expect(screen.getByText('INF UNAVAILABLE')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry inference telemetry' }));
    expect(inferenceRequests).toHaveLength(2);
    expect(screen.getByText('SYS PENDING')).toBeInTheDocument();
    await settleInference(1);
    expect(screen.getByText('SYS HEALTHY')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('still names the health fault that a real observation confirmed', async () => {
    await mount('claude_cli');
    await settleHealth(0, { ...baseHealth, claude_proxy: { ...baseHealth.claude_proxy, running: false } });
    expect(screen.getByText('SYS DEGRADED')).toBeInTheDocument();
    expect(verdict()).toHaveTextContent('Degraded: claude_cli_proxy is not running.');
    await settleInference(0);
    expect(screen.getByText('SYS DEGRADED')).toBeInTheDocument();
    expect(verdict()).toHaveTextContent('Degraded: claude_cli_proxy is not running.');
  });
});
