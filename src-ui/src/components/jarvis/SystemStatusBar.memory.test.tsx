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

const MEASURED_MEMORY = { total_mb: 16384, available_mb: 12288, used_mb: 4096, used_percent: 25 };
// Exactly what Native's `memory_health` returns when the probe cannot run.
const UNPROBED_MEMORY = { total_mb: 0, available_mb: 0, used_mb: 0, used_percent: 0 };

const baseHealth: HealthData = {
  ollama: { running: true, model: 'test-model', url: 'http://127.0.0.1:11434' },
  bun_server: { running: true, url: 'http://127.0.0.1:19877' },
  bridge: { running: true, port: 19876 },
  claude_proxy: { running: true, port: 19878 },
  disk: { total: '100G', used: '40G', available: '60G', use_percent: '40%' },
  memory: MEASURED_MEMORY,
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

const mount = async () => { await act(async () => { render(<SystemStatusBar activeBackend="ollama" />); }); };
const settleHealth = async (index: number, value: unknown = baseHealth) => {
  await act(async () => { healthRequests[index].resolve(value); });
  await act(async () => { inferenceRequests[index].resolve(new Response(JSON.stringify(emptyInference), { status: 200 })); });
};
const memoryChip = () => screen.getByText(/^MEM /);
const verdict = () => screen.getByRole('status', { name: 'System telemetry verdict' });

describe('SystemStatusBar memory reading', () => {
  it('keeps a real memory reading and its existing chip vocabulary', async () => {
    await mount();
    await settleHealth(0);
    expect(memoryChip()).toHaveTextContent('MEM 25%');
    expect(memoryChip()).not.toHaveTextContent('(stale)');
    expect(verdict()).toHaveTextContent('All services required by the active inference backend');
  });

  it('never shows a green MEM 0% chip for a record the probe never measured', async () => {
    await mount();
    await settleHealth(0, { ...baseHealth, memory: UNPROBED_MEMORY });
    // An unfixed surface read the zeroed sentinel as a real 0%, which the chip
    // classes coloured emerald — the reading that says nothing is wrong here.
    expect(screen.queryByText('MEM 0%')).not.toBeInTheDocument();
    expect(memoryChip()).toHaveTextContent('MEM —');
  });

  it('carries the unprobed basis in the chip’s accessible name', async () => {
    await mount();
    await settleHealth(0, { ...baseHealth, memory: UNPROBED_MEMORY });
    expect(memoryChip().getAttribute('aria-label')).toContain('The memory probe reported no total');
  });

  it('stops suppressing the memory pressure reason for an unmeasured record', async () => {
    // The reason already fired for a record the shared decoder could not read;
    // the zeroed sentinel slipped past it and certified a system whose memory
    // was never probed. The sibling disk row pushes its reason the same way.
    await mount();
    await settleHealth(0, { ...baseHealth, memory: UNPROBED_MEMORY });
    expect(verdict()).toHaveTextContent('Degraded');
    expect(verdict()).toHaveTextContent('memory use is high');
  });

  it('leaves a healthy reading free of the memory pressure reason', async () => {
    await mount();
    await settleHealth(0);
    expect(verdict()).not.toHaveTextContent('memory use is high');
  });

  it('keeps the pressure reason for a genuinely high reading at its existing threshold', async () => {
    await mount();
    await settleHealth(0, { ...baseHealth, memory: { ...MEASURED_MEMORY, used_percent: 85 } });
    expect(memoryChip()).toHaveTextContent('MEM 85%');
    expect(verdict()).toHaveTextContent('memory use is high');
  });

  it('reaches the honest reading again from a refresh', async () => {
    await mount();
    await settleHealth(0, { ...baseHealth, memory: UNPROBED_MEMORY });
    expect(memoryChip()).toHaveTextContent('MEM —');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh system telemetry' }));
    await act(async () => { inferenceRequests[1].resolve(new Response(JSON.stringify(emptyInference), { status: 200 })); });
    await settleHealth(1);
    expect(memoryChip()).toHaveTextContent('MEM 25%');
    expect(memoryChip().getAttribute('aria-label')).toBeNull();
  });
});
