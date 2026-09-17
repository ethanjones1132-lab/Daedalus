import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import HealthBanner from './HealthBanner';
import type { JarvisStatus } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const healthy: JarvisStatus = {
  ollama_running: false, model_available: false, bun_server_running: true,
  bun_server_url: 'http://127.0.0.1:19877', claude_proxy_running: false,
  bridge_active: true, bridge_port: 19879, bun_available: true,
  active_backend: 'openrouter', model: 'observed-model', openrouter_key_set: true,
};
function deferred() {
  let resolve!: (value: JarvisStatus) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<JarvisStatus>((res, rej) => { resolve = res; reject = rej; });
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
const mount = async () => { await act(async () => { render(<HealthBanner />); }); };
const settle = async (index: number, status = healthy) => {
  await act(async () => { requests[index].resolve(status); });
};
const fail = async (index: number) => {
  await act(async () => { requests[index].reject(new Error('synthetic private native detail')); });
};
const advance = async (ms = 15000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const feedback = () => screen.getByRole('status', { name: 'Health observation' });

describe('HealthBanner observation state', () => {
  it('shows initial pending and recovers initial failure with read-only Retry', async () => {
    await mount();
    expect(feedback()).toHaveTextContent('Checking health');
    await fail(0);
    expect(screen.getByRole('alert')).toHaveTextContent('Health observation is unavailable.');
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    expect(screen.queryByText(/synthetic private/)).not.toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(feedback()).toHaveTextContent('Checking health');
    expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
    expect(requests).toHaveLength(2);
    await settle(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls).toEqual([['jarvis_check_status'], ['jarvis_check_status']]);
  });

  it('retains explicitly stale details through failure and pending retry, then self-hides on health', async () => {
    await mount();
    await settle(0, { ...healthy, openrouter_key_set: false });
    expect(screen.getByText('Offline')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /details/ }));
    expect(screen.getByText('(observed-model)')).toBeInTheDocument();
    await advance();
    await fail(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Showing previously observed health details; they may be stale.');
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    expect(screen.getByText('(observed-model)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(feedback()).toHaveTextContent('Refreshing health');
    expect(screen.getByRole('alert')).toHaveTextContent('may be stale');
    await settle(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each(['success', 'failure'])('ignores obsolete %s while a newer request is pending', async (outcome) => {
    await mount();
    await advance();
    if (outcome === 'success') await settle(0);
    else await fail(0);
    expect(feedback()).toHaveTextContent('Checking health');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await fail(1);
    expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
  });

  it('does not let an old healthy response hide a newer failure', async () => {
    await mount();
    await advance();
    await fail(1);
    await settle(0);
    expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();
  });

  it.each(['success', 'failure'])('ignores old poll %s after a newer visibility observation and preserves cadence', async (outcome) => {
    await mount();
    await settle(0);
    await advance(14999);
    expect(requests).toHaveLength(1);
    await advance(1);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    await advance(30000);
    expect(requests).toHaveLength(2);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    expect(requests).toHaveLength(3);
    await settle(2, { ...healthy, openrouter_key_set: false });
    if (outcome === 'success') await settle(1);
    else await fail(1);
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    cleanup();
    await advance();
    expect(requests).toHaveLength(3);
  });
});
