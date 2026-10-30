import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../design';
import { NavigationProvider } from './navigation';
import { SIGNAL_POLL_INTERVAL_MS, useAppSignals } from './useAppSignals';

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

const alert = (over: Record<string, unknown> = {}) => ({
  id: 'a1', kind: 'drift', severity: 'high', title: 'Registry drift', message: 'Two actions drifted.',
  created_at: '2026-10-11T00:00:00Z', ...over,
});

function mount() {
  return render(
    <ToastProvider>
      <NavigationProvider initial="sessions">
        <Probe />
      </NavigationProvider>
    </ToastProvider>,
  );
}

/** The banner view is derived in the Shell; here the probe exposes the projection. */
function Probe() {
  const { alertChannelView } = useAppSignals();
  return <div data-testid="delivery-view">{alertChannelView.status}</div>;
}

const view = () => screen.getByTestId('delivery-view');

beforeEach(() => {
  listenMock.mockReset().mockRejectedValue(new Error('event channel refused'));
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'get_action_registry_alerts') return Promise.resolve([]);
    if (command === 'list_pending_missed_jobs') return Promise.resolve([]);
    return Promise.reject(new Error('unexpected command'));
  });
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('alert delivery with poll fallback', () => {
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it('delivers through reads and stays quiet while every subscription is refused', async () => {
    vi.useFakeTimers();
    let bootDone = false;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_action_registry_alerts') return Promise.resolve(bootDone ? [alert()] : []);
      if (command === 'list_pending_missed_jobs') return Promise.resolve([]);
      return Promise.reject(new Error('unexpected command'));
    });
    mount();
    await advance(0);
    // Boot read delivered; refused subscriptions are a potential path, never
    // claimed as unreachable.
    expect(view()).toHaveTextContent('quiet');
    expect(screen.queryByText(/cannot reach you/)).not.toBeInTheDocument();

    // The next poll carries a new alert and delivers it with no event channel.
    bootDone = true;
    await advance(SIGNAL_POLL_INTERVAL_MS);
    expect(screen.getByText('Two actions drifted.')).toBeInTheDocument();
    expect(screen.getByText('Registry drift')).toBeInTheDocument();
    expect(view()).toHaveTextContent('quiet');
    // ...and de-duplication: the same alert is not re-announced by later polls.
    const callCount = invokeMock.mock.calls.filter(([command]) => command === 'get_action_registry_alerts').length;
    await advance(SIGNAL_POLL_INTERVAL_MS * 3);
    const laterCount = invokeMock.mock.calls.filter(([command]) => command === 'get_action_registry_alerts').length;
    expect(laterCount).toBeGreaterThan(callCount);
    expect(screen.getAllByText('Two actions drifted.')).toHaveLength(1);
  });

  it('announces no delivery path only after both paths of a subject have failed', async () => {
    listenMock.mockRejectedValue(new Error('event channel refused'));
    invokeMock.mockRejectedValue(new Error('private read refusal'));
    mount();
    await act(async () => {});
    expect(view()).toHaveTextContent('unavailable');
  });

  it('stays quiet while reads fail but events are merely subscribed — an unknown is not a claim', async () => {
    listenMock.mockImplementation(async () => () => {});
    invokeMock.mockRejectedValue(new Error('private read refusal'));
    mount();
    await act(async () => {});
    expect(view()).toHaveTextContent('quiet');
  });
});
