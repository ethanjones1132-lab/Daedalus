import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import GatewayView from './GatewayView';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const observation = {
  running: true, port: 19878, active_connections: 3, uptime_seconds: 3661,
  version: 'observed-version', timestamp: '2026-09-16T10:00:00Z',
};
function deferred() {
  let resolve!: (value: typeof observation) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<typeof observation>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
let requests: ReturnType<typeof deferred>[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  requests = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(() => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const mount = async () => { await act(async () => { render(<GatewayView />); }); };
const settle = async (index: number, running = true) => {
  await act(async () => { requests[index].resolve({ ...observation, running }); });
};
const fail = async (index: number) => {
  await act(async () => { requests[index].reject(new Error('synthetic private native detail')); });
};
const advance = async (ms = 10000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const feedback = () => screen.getByRole('status', { name: 'Gateway observation' });
const refresh = () => screen.getByRole('button', { name: 'Refresh' });

describe('Gateway observation recovery', () => {
  it('distinguishes initial pending from an observed running or stopped result', async () => {
    await mount();
    expect(feedback()).toHaveTextContent('Checking gateway');
    expect(refresh()).toBeDisabled();
    fireEvent.click(refresh());
    expect(requests).toHaveLength(1);
    expect(screen.queryByText(/Gateway is/)).not.toBeInTheDocument();
    await settle(0, false);
    expect(screen.getByText('Gateway is stopped')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.getByText('1h 1m')).toBeInTheDocument();
    expect(screen.getByText('19878')).toBeInTheDocument();
    expect(screen.getByText('observed-version')).toBeInTheDocument();
    expect(refresh()).toBeEnabled();
    expect(screen.queryByRole('status', { name: 'Gateway observation' })).not.toBeInTheDocument();
  });

  it('recovers immediately from initial failure without inferring gateway state', async () => {
    await mount();
    await fail(0);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load gateway status.');
    expect(screen.queryByText(/synthetic private native detail/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Gateway is/)).not.toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    fireEvent.click(refresh());
    expect(retry).toBeDisabled();
    expect(refresh()).toBeDisabled();
    expect(feedback()).toHaveTextContent('Checking gateway');
    expect(requests).toHaveLength(2);
    await settle(1);
    expect(screen.getByText('Gateway is running')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([true, false])('retains the last observation (%s) with stale feedback through failed refresh and retry', async (running) => {
    await mount();
    await settle(0, running);
    fireEvent.click(refresh());
    expect(feedback()).toHaveTextContent('Refreshing gateway status');
    await fail(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Showing previously observed gateway status; it may be stale.');
    expect(screen.getByText(`Gateway is ${running ? 'running' : 'stopped'}`)).toBeInTheDocument();
    expect(screen.getByText('observed-version')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('alert')).toHaveTextContent('may be stale');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    await settle(2, !running);
    expect(screen.getByText(`Gateway is ${running ? 'stopped' : 'running'}`)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['success', 'failure'])('ignores obsolete manual %s after the newer poll observes stopped', async (outcome) => {
    await mount();
    await settle(0);
    fireEvent.click(refresh());
    await advance();
    expect(requests).toHaveLength(3);
    await settle(2, false);
    if (outcome === 'success') await settle(1);
    else await fail(1);
    expect(screen.getByText('Gateway is stopped')).toBeInTheDocument();
    expect(screen.queryByText('Gateway is running')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(refresh()).toBeEnabled();
  });

  it.each(['success', 'failure'])('does not end the latest loading state on obsolete %s', async (outcome) => {
    await mount();
    await advance();
    if (outcome === 'success') await settle(0);
    else await fail(0);
    expect(feedback()).toHaveTextContent('Checking gateway');
    expect(refresh()).toBeDisabled();
    expect(screen.queryByText(/Gateway is/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await settle(1, false);
    expect(screen.getByText('Gateway is stopped')).toBeInTheDocument();
  });

  it('orders visibility refresh with polling and preserves the ten-second cadence and command arguments', async () => {
    await mount();
    await settle(0);
    await advance(9999);
    expect(requests).toHaveLength(1);
    await advance(1);
    expect(requests).toHaveLength(2);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    await advance(20000);
    expect(requests).toHaveLength(2);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    expect(requests).toHaveLength(3);
    await settle(2, false);
    await settle(1);
    expect(screen.getByText('Gateway is stopped')).toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls).toEqual(Array.from({ length: 3 }, () => ['get_gateway_status']));
    cleanup();
    await advance();
    expect(requests).toHaveLength(3);
  });
});
