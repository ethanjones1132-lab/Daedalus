import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SystemStatusBar from './SystemStatusBar';
import { STARTUP_GRACE_MS, type HealthData, type InferenceMetrics } from '../../domain/system-telemetry-state';

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

// A cold start: Native has answered with a fresh observation that says Bun is
// not listening yet. Inside the grace this is the ordinary startup, not a fault.
const bunDownHealth: HealthData = {
  ...baseHealth,
  bun_server: { ...baseHealth.bun_server, running: false },
};

const bunGiveUpHealth: HealthData = {
  ...bunDownHealth,
  supervisor: { bun_give_up: true, proxy_give_up: false, ollama_give_up: false },
};

let healthRequests: Deferred<unknown>[];
let inferenceRequests: Deferred<Response>[];
// The bar now reads the persisted Inference backend itself (`jarvis_get_config`)
// instead of taking it as a prop, so the backend each case wants is served here.
let configuredBackend: string | null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  healthRequests = [];
  inferenceRequests = [];
  configuredBackend = 'ollama';
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'jarvis_get_config') return Promise.resolve({ active_backend: configuredBackend });
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
  configuredBackend = activeBackend;
  let result!: ReturnType<typeof render>;
  await act(async () => { result = render(<SystemStatusBar />); });
  return result;
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
    // No snapshot means no disk reading either: never a 0 it does not have.
    expect(screen.getByText('DSK —')).toBeInTheDocument();
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
    const { rerender } = await mount();
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
    // Inside the cold-start grace the footer reads the same absence as the
    // banner above it: the Bun server is still coming up, not stopped.
    expect(screen.getByText('SYS STARTING')).toBeInTheDocument();
    expect(screen.queryByText('SYS STOPPED')).not.toBeInTheDocument();
    await advance(STARTUP_GRACE_MS);
    // The clock has reached the boundary; observing the rendered surface again
    // reads stopped without waiting for the next poll.
    await act(async () => { rerender(<SystemStatusBar />); });
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
    // The same in-grace absence reads as starting here too, before the older
    // inference read is retried; the boundary then reads stopped.
    expect(screen.getByText('SYS STARTING')).toBeInTheDocument();
    await advance(STARTUP_GRACE_MS);
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
    const { container } = render(<SystemStatusBar />);
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

describe('SystemStatusBar self-contained backend and polling', () => {
  it('reads the persisted Inference backend itself, so it needs no props', async () => {
    await mount('llama_cpp');
    const llamaHealth: HealthData = {
      ...baseHealth,
      ollama: { ...baseHealth.ollama, running: false },
      llama_cpp: { running: true, model: 'gemma-4', url: 'http://127.0.0.1:8080' },
    };
    await settleHealth(0, llamaHealth);
    await settleInference(0);
    expect(invokeMock).toHaveBeenCalledWith('jarvis_get_config');
    expect(screen.getByText('SYS HEALTHY')).toBeInTheDocument();
    expect(screen.getByText('LCP UP')).toHaveAccessibleName('llama.cpp server is up and required by the active inference backend.');
    expect(screen.queryByText(/OLL/)).not.toBeInTheDocument();
  });

  it('keeps the last confirmed backend when a config re-read fails', async () => {
    await mount('openrouter');
    await settleHealth(0, stockOpenRouterHealth);
    await settleInference(0);
    expect(screen.getByText('SYS HEALTHY')).toBeInTheDocument();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_get_config') return Promise.reject(new Error('config unavailable'));
      const request = deferred<unknown>();
      healthRequests.push(request);
      return request.promise;
    });
    fireEvent.click(refresh());
    await settleHealth(1, stockOpenRouterHealth);
    await settleInference(1);
    expect(screen.getByText('SYS HEALTHY')).toBeInTheDocument();
    expect(screen.getByText('OLL DOWN · NR')).toBeInTheDocument();
  });

  it('polls only while the document is visible, and re-reads at once when it becomes visible again', async () => {
    await mount();
    await settleHealth(0);
    await settleInference(0);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    await advance(90_000);
    expect(healthRequests).toHaveLength(1);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    expect(healthRequests).toHaveLength(2);
    await advance(30_000);
    expect(healthRequests).toHaveLength(3);
  });
});

describe('SystemStatusBar cold-start inference presentation', () => {
  const inferenceWaiting = () => screen.queryByRole('status', { name: 'Inference telemetry observation' });
  const inferenceAlert = () => screen.queryByRole('alert', { name: 'Inference telemetry observation' });

  it('regression: presents the initial failed inference read as waiting for Bun inside the grace', async () => {
    await mount();
    await settleHealth(0, bunDownHealth);
    await failInference(0);
    expect(inferenceWaiting()).toHaveTextContent('Inference telemetry is waiting for the Bun server to start.');
    expect(inferenceAlert()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry inference telemetry' })).not.toBeInTheDocument();
    expect(screen.getByText('INF WAITING')).toBeInTheDocument();
    expect(screen.queryByText('INF UNAVAILABLE')).not.toBeInTheDocument();
    // Waiting is not a reading: no fabricated empty payload and no zero.
    expect(screen.queryByText('INF EMPTY')).not.toBeInTheDocument();
    expect(screen.getByText('SYS STARTING')).toBeInTheDocument();
    expect(screen.queryByText(/private inference detail/)).not.toBeInTheDocument();
    // The verdict is part of the presentation too: waiting is not a fault.
    expect(verdict()).toHaveTextContent('Starting');
    expect(verdict()).not.toHaveTextContent('inference telemetry is unavailable');
  });

  it('keeps a successful inference read that recovers before the grace boundary', async () => {
    await mount();
    await settleHealth(0, bunDownHealth);
    await settleInference(0);
    expect(screen.queryByRole('status', { name: 'Inference telemetry observation' })).not.toBeInTheDocument();
    expect(screen.getByText('INF EMPTY')).toBeInTheDocument();
    await advance(STARTUP_GRACE_MS);
    expect(screen.queryByRole('alert', { name: 'Inference telemetry observation' })).not.toBeInTheDocument();
    expect(screen.getByText('INF EMPTY')).toBeInTheDocument();
  });

  it('restores the unavailable alert and Retry exactly at the grace boundary without a rerender', async () => {
    await mount();
    await settleHealth(0, bunDownHealth);
    await failInference(0);
    await advance(STARTUP_GRACE_MS - 1);
    expect(screen.getByText('INF WAITING')).toBeInTheDocument();
    // Strictly below the threshold is the only window that reads as waiting;
    // the boundary update arrives from the mount clock with no new response and
    // no explicit rerender.
    await advance(1);
    expect(screen.queryByText('INF WAITING')).not.toBeInTheDocument();
    expect(screen.getByText('INF UNAVAILABLE')).toBeInTheDocument();
    expect(inferenceAlert()).toHaveTextContent('Inference telemetry is unavailable.');
    expect(screen.getByRole('button', { name: 'Retry inference telemetry' })).toBeInTheDocument();
    expect(screen.getByText('SYS STOPPED')).toBeInTheDocument();
    expect(verdict()).toHaveTextContent('Stopped');
    expect(verdict()).toHaveTextContent('inference telemetry is unavailable');
  });

  it('keeps the failure honest when Bun auto-restart has given up inside the grace', async () => {
    await mount();
    await settleHealth(0, bunGiveUpHealth);
    await failInference(0);
    expect(inferenceWaiting()).not.toBeInTheDocument();
    expect(inferenceAlert()).toHaveTextContent('Inference telemetry is unavailable.');
    expect(screen.getByText('INF UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByText('SYS STOPPED')).toBeInTheDocument();
    expect(screen.getByText('BUN GIVE-UP')).toBeInTheDocument();
  });

  it('keeps an inference failure immediate once Bun is already running', async () => {
    await mount();
    await settleHealth(0);
    await failInference(0);
    expect(inferenceWaiting()).not.toBeInTheDocument();
    expect(inferenceAlert()).toHaveTextContent('Inference telemetry is unavailable.');
    expect(screen.getByText('INF UNAVAILABLE')).toBeInTheDocument();
  });

  it('keeps the failure immediate when no valid health observation has arrived', async () => {
    await mount();
    await failInference(0);
    expect(inferenceWaiting()).not.toBeInTheDocument();
    expect(inferenceAlert()).toHaveTextContent('Inference telemetry is unavailable.');
    expect(screen.getByText('INF UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByText('SYS PENDING')).toBeInTheDocument();
  });

  it('never hides a previously successful inference reading behind startup copy', async () => {
    await mount();
    await settleHealth(0, bunDownHealth);
    await settleInference(0);
    fireEvent.click(refresh());
    // Fresh health still says Bun is down inside the grace, but the inference
    // read already succeeded once, so its failure stays a stale observation.
    await settleHealth(1, bunDownHealth);
    await failInference(1);
    expect(screen.queryByText('INF WAITING')).not.toBeInTheDocument();
    expect(screen.getByText('INF EMPTY (stale)')).toBeInTheDocument();
    expect(inferenceAlert()).toHaveTextContent('Showing previously observed inference telemetry; it may be stale.');
    expect(screen.getByRole('button', { name: 'Retry inference telemetry' })).toBeInTheDocument();
    expect(screen.getByText('SYS STARTING')).toBeInTheDocument();
  });

  it('treats stale native health as no evidence that Bun is still starting', async () => {
    await mount();
    await settleHealth(0, bunDownHealth);
    await settleInference(0);
    fireEvent.click(refresh());
    await failHealth(1);
    await failInference(1);
    expect(screen.queryByText('INF WAITING')).not.toBeInTheDocument();
    expect(inferenceAlert()).toHaveTextContent('Showing previously observed inference telemetry; it may be stale.');
    expect(screen.getByRole('alert', { name: 'System health observation' })).toHaveTextContent('Showing previously observed system health; it may be stale.');
    expect(screen.getByText('SYS STALE')).toBeInTheDocument();
  });

  it('clears the grace boundary timer on unmount', async () => {
    const { unmount } = await mount();
    await settleHealth(0, bunDownHealth);
    await failInference(0);
    expect(screen.getByText('INF WAITING')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => { unmount(); });
    expect(vi.getTimerCount()).toBe(0);
  });
});
