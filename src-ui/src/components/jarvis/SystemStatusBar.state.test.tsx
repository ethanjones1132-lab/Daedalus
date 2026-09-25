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
const failHealth = async (index: number) => { await act(async () => { healthRequests[index].reject(new Error('private native health detail')); }); };
const settleInference = async (index: number, value: unknown = emptyInference) => { await act(async () => { inferenceRequests[index].resolve(new Response(JSON.stringify(value), { status: 200 })); }); };
const failInference = async (index: number) => { await act(async () => { inferenceRequests[index].reject(new Error('private inference detail')); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const status = () => screen.getByRole('status', { name: 'System telemetry' });
const refresh = () => screen.getByRole('button', { name: 'Refresh system telemetry' });

describe('SystemStatusBar telemetry observation state', () => {
  it('shows an honest initial pending state without inferred stopped services or zero resources', async () => {
    await mount();
    expect(status()).toHaveTextContent('Checking system telemetry');
    expect(refresh()).toBeDisabled();
    expect(screen.getByText('SYS PENDING')).toBeInTheDocument();
    expect(screen.getByText('BUN ?')).toBeInTheDocument();
    expect(screen.getByText('MEM —')).toBeInTheDocument();
    expect(screen.getByText('INF …')).toBeInTheDocument();
  });

  it('recovers an initial native health failure without exposing detail or false service state', async () => {
    await mount();
    await failHealth(0);
    await settleInference(0);
    expect(screen.getByRole('alert', { name: 'System health observation' })).toHaveTextContent('System health is unavailable.');
    expect(screen.queryByText(/private native health detail/)).not.toBeInTheDocument();
    expect(screen.getByText('SYS UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByText('BUN ?')).toBeInTheDocument();
    expect(screen.queryByText('BUN DOWN')).not.toBeInTheDocument();
    expect(screen.getByText('MEM —')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry system health' });
    fireEvent.click(retry);
    const pendingRetry = screen.getByRole('button', { name: 'Retry system health' });
    fireEvent.click(pendingRetry);
    expect(pendingRetry).toBeDisabled();
    expect(healthRequests).toHaveLength(2);
    expect(inferenceRequests).toHaveLength(1);
    await settleHealth(1, baseHealth);
    expect(screen.queryByRole('alert', { name: 'System health observation' })).not.toBeInTheDocument();
  });

  it('keeps optional inference failures separate from valid native health', async () => {
    await mount();
    await settleHealth(0);
    await failInference(0);
    expect(screen.getByRole('alert', { name: 'Inference telemetry observation' })).toHaveTextContent('Inference telemetry is unavailable.');
    expect(screen.queryByText(/private inference detail/)).not.toBeInTheDocument();
    expect(screen.getByText('SYS DEGRADED')).toBeInTheDocument();
    expect(screen.getByText('BUN UP')).toBeInTheDocument();
    expect(screen.getByText('INF UNAVAILABLE')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry inference telemetry' }));
    expect(healthRequests).toHaveLength(1);
    expect(inferenceRequests).toHaveLength(2);
    await settleInference(1);
    expect(screen.queryByRole('alert', { name: 'Inference telemetry observation' })).not.toBeInTheDocument();
  });

  it('treats malformed native health as unavailable rather than a successful empty observation', async () => {
    await mount();
    await settleHealth(0, { ...baseHealth, bun_server: undefined });
    await settleInference(0);
    expect(screen.getByRole('alert', { name: 'System health observation' })).toHaveTextContent('System health is unavailable.');
    expect(screen.getByText('BUN ?')).toBeInTheDocument();
    expect(screen.queryByText('BUN DOWN')).not.toBeInTheDocument();
  });

  it('renders valid healthy, degraded, and stopped observations distinctly', async () => {
    await mount();
    await settleHealth(0);
    await settleInference(0);
    expect(screen.getByText('SYS HEALTHY')).toBeInTheDocument();
    expect(screen.getByText('BUN UP')).toBeInTheDocument();
    expect(screen.getByText('BRG UP')).toBeInTheDocument();
    // Under the ollama inference backend the claude_cli_proxy is not required.
    expect(screen.getByText('PRX UP · NR')).toBeInTheDocument();
    expect(screen.getByText('MEM 42%')).toBeInTheDocument();
    expect(screen.getByText('DSK 40%')).toBeInTheDocument();
    expect(screen.getByText('INF EMPTY')).toBeInTheDocument();

    fireEvent.click(refresh());
    await settleHealth(1, {
      ...baseHealth,
      ollama: { ...baseHealth.ollama, running: false },
      claude_proxy: { ...baseHealth.claude_proxy, running: false },
      memory: { ...baseHealth.memory, used_percent: 85 },
      supervisor: { bun_give_up: true, proxy_give_up: true, ollama_give_up: true },
    });
    await settleInference(1, {
      ...emptyInference,
      window_size: 4,
      backends: [{ backend: 'ollama', requests: 4, errors: 1, error_rate: 0.25, p50_ms: 1, p95_ms: 2, total_tokens_in: 0, total_tokens_out: 0 }],
    });
    expect(screen.getByText('SYS DEGRADED')).toBeInTheDocument();
    expect(screen.getByText('OLL DOWN')).toBeInTheDocument();
    // Under the ollama inference backend the claude_cli_proxy is not required,
    // so its own state is reported without pretending it is a fault.
    expect(screen.getByText('PRX DOWN · NR')).toBeInTheDocument();
    expect(screen.getByText('ERR 25%')).toBeInTheDocument();
    expect(screen.getByText('BUN GIVE-UP')).toBeInTheDocument();
    expect(screen.getByText('PRX GIVE-UP')).toBeInTheDocument();
    expect(screen.getByText('OLL GIVE-UP')).toBeInTheDocument();

    fireEvent.click(refresh());
    await settleHealth(2, { ...baseHealth, bun_server: { ...baseHealth.bun_server, running: false } });
    await settleInference(2);
    expect(screen.getByText('SYS STOPPED')).toBeInTheDocument();
    expect(screen.getByText('BUN DOWN')).toBeInTheDocument();
  });

  it('retains known values as explicitly stale after failed refresh and recovers through retry', async () => {
    await mount();
    await settleHealth(0);
    await settleInference(0);
    fireEvent.click(refresh());
    expect(status()).toHaveTextContent('Refreshing system telemetry');
    await failHealth(1);
    await failInference(1);
    expect(screen.getByRole('alert', { name: 'System health observation' })).toHaveTextContent('Showing previously observed system health; it may be stale.');
    expect(screen.getByRole('alert', { name: 'Inference telemetry observation' })).toHaveTextContent('Showing previously observed inference telemetry; it may be stale.');
    expect(screen.getByText('SYS STALE')).toBeInTheDocument();
    expect(screen.getByText('BUN UP (stale)')).toBeInTheDocument();
    expect(screen.getByText('MEM 42% (stale)')).toBeInTheDocument();
    expect(screen.getByText('INF EMPTY (stale)')).toBeInTheDocument();
    expect(screen.queryByText(/private .* detail/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry system health' }));
    expect(status()).toHaveTextContent('Refreshing system telemetry');
    expect(inferenceRequests).toHaveLength(2);
    await settleHealth(2, { ...baseHealth, bun_server: { ...baseHealth.bun_server, running: false } });
    expect(screen.queryByRole('alert', { name: 'System health observation' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert', { name: 'Inference telemetry observation' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry inference telemetry' }));
    await settleInference(2);
    expect(screen.getByText('SYS STOPPED')).toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: 'System health observation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: 'Inference telemetry observation' })).not.toBeInTheDocument();
  });

  it('ignores an older poll completion after a newer observation succeeds', async () => {
    await mount();
    await advance(30000);
    expect(healthRequests).toHaveLength(2);
    await settleHealth(1, { ...baseHealth, bun_server: { ...baseHealth.bun_server, running: false } });
    await settleInference(1);
    await settleHealth(0);
    await settleInference(0);
    expect(screen.getByText('SYS STOPPED')).toBeInTheDocument();
    expect(screen.getByText('BUN DOWN')).toBeInTheDocument();
    expect(screen.queryByText('BUN UP')).not.toBeInTheDocument();
  });
});

const verdict = () => screen.getByRole('status', { name: 'System telemetry verdict' });
const stockOpenRouterHealth: HealthData = {
  ...baseHealth,
  ollama: { ...baseHealth.ollama, running: false, model: null },
  claude_proxy: { ...baseHealth.claude_proxy, running: false },
};

describe('SystemStatusBar required-set presentation', () => {
  it('prints the required/not-required distinction as text and confirms health on a stock OpenRouter install', async () => {
    await mount('openrouter');
    await settleHealth(0, stockOpenRouterHealth);
    await settleInference(0);
    expect(screen.getByText('SYS HEALTHY')).toBeInTheDocument();
    expect(screen.getByText('OLL DOWN · NR')).toBeInTheDocument();
    expect(screen.getByText('PRX DOWN · NR')).toBeInTheDocument();
    expect(screen.getByText('BUN UP')).toBeInTheDocument();
    expect(verdict()).toHaveTextContent(
      'All services required by the active inference backend (openrouter) are running.',
    );
    expect(verdict()).toHaveTextContent('Not required by this backend: Ollama and claude_cli_proxy.');
  });

  it('still names a required service that is down and still degrades', async () => {
    await mount('claude_cli');
    await settleHealth(0, stockOpenRouterHealth);
    await settleInference(0);
    expect(screen.getByText('SYS DEGRADED')).toBeInTheDocument();
    expect(screen.getByText('PRX DOWN')).toBeInTheDocument();
    expect(screen.getByText('OLL DOWN · NR')).toBeInTheDocument();
    expect(verdict()).toHaveTextContent('Degraded: claude_cli_proxy is not running.');
  });

  it('degrades on Ollama under the ollama backend for the very same observation', async () => {
    await mount('ollama');
    await settleHealth(0, stockOpenRouterHealth);
    await settleInference(0);
    expect(screen.getByText('SYS DEGRADED')).toBeInTheDocument();
    expect(screen.getByText('OLL DOWN')).toBeInTheDocument();
    expect(screen.getByText('PRX DOWN · NR')).toBeInTheDocument();
    expect(verdict()).toHaveTextContent('Degraded: Ollama is not running.');
  });

  it('never claims health while the active inference backend is unconfirmed', async () => {
    await mount(null);
    await settleHealth(0, stockOpenRouterHealth);
    await settleInference(0);
    expect(screen.queryByText('SYS HEALTHY')).not.toBeInTheDocument();
    expect(screen.getByText('SYS DEGRADED')).toBeInTheDocument();
    expect(screen.getByText('OLL DOWN · REQ?')).toBeInTheDocument();
    expect(screen.getByText('PRX DOWN · REQ?')).toBeInTheDocument();
    expect(verdict()).toHaveTextContent('the active inference backend is not confirmed');
  });

  it('carries a non-colour accessible name for every service chip', async () => {
    await mount('openrouter');
    await settleHealth(0, stockOpenRouterHealth);
    await settleInference(0);
    expect(screen.getByText('BUN UP')).toHaveAccessibleName('Bun server is up and required by the active inference backend.');
    expect(screen.getByText('BRG UP')).toHaveAccessibleName('bridge is up and required by the active inference backend.');
    expect(screen.getByText('OLL DOWN · NR')).toHaveAccessibleName('Ollama is not running and not required by the active inference backend.');
    expect(screen.getByText('PRX DOWN · NR')).toHaveAccessibleName('claude_cli_proxy is not running and not required by the active inference backend.');
  });

  it('announces recovery, not only degradation', async () => {
    await mount('ollama');
    await settleHealth(0, stockOpenRouterHealth);
    await settleInference(0);
    expect(verdict()).toHaveTextContent('Degraded: Ollama is not running.');

    fireEvent.click(refresh());
    await settleHealth(1, baseHealth);
    await settleInference(1);
    expect(screen.getByText('SYS HEALTHY')).toBeInTheDocument();
    expect(verdict()).toHaveTextContent('All services required by the active inference backend (ollama) are running.');
  });

  it('keeps focus off the document body when a focused Retry disappears on recovery', async () => {
    const { container } = render(<SystemStatusBar activeBackend="ollama" />);
    await act(async () => {});
    await failHealth(0);
    await settleInference(0);
    const retry = screen.getByRole('button', { name: 'Retry system health' });
    retry.focus();
    expect(document.activeElement).toBe(retry);

    fireEvent.click(retry);
    await settleHealth(1, baseHealth);
    expect(screen.queryByRole('button', { name: 'Retry system health' })).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(container.contains(document.activeElement)).toBe(true);
  });
});
