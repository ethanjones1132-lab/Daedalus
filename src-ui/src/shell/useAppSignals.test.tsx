import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../design';
import { NavigationProvider, useNavigation } from './navigation';
import { useAppSignals } from './useAppSignals';

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

type Handler = (event: { payload: unknown }) => void;

const alert = (over: Record<string, unknown> = {}) => ({
  id: 'a1', kind: 'drift', severity: 'high', title: 'Registry drift', message: 'Two actions drifted.',
  created_at: '2026-10-11T00:00:00Z', ...over,
});

let handlers: Map<string, Handler>;
let unlisten: ReturnType<typeof vi.fn>;

function Probe() {
  useAppSignals();
  const { route } = useNavigation();
  return <div data-testid="route">{route}</div>;
}

function mount() {
  return render(
    <ToastProvider>
      <NavigationProvider initial="sessions">
        <Probe />
      </NavigationProvider>
    </ToastProvider>,
  );
}

const emit = (name: string, payload: unknown) => act(async () => { handlers.get(name)?.({ payload }); });

beforeEach(() => {
  handlers = new Map();
  unlisten = vi.fn();
  listenMock.mockReset().mockImplementation((name: string, handler: Handler) => {
    handlers.set(name, handler);
    return Promise.resolve(unlisten);
  });
  invokeMock.mockReset().mockImplementation((command: string) =>
    command === 'get_action_registry_alerts' ? Promise.resolve([]) : Promise.reject(new Error('unexpected')));
});
afterEach(cleanup);

describe('useAppSignals', () => {
  it('toasts a high-severity registry alert as an error and navigates to Actions from its action', async () => {
    mount();
    await waitFor(() => expect(handlers.has('action-registry://alerts')).toBe(true));
    await emit('action-registry://alerts', [alert({ id: 'low', severity: 'low', title: 'Minor' }), alert()]);
    const toast = await screen.findByText('Two actions drifted.');
    expect(toast.closest('[role=alert]')).toHaveTextContent('Registry drift');
    fireEvent.click(screen.getByRole('button', { name: 'Open Actions' }));
    expect(screen.getByTestId('route')).toHaveTextContent('actions');
  });

  it('toasts a non-high alert as a warning', async () => {
    mount();
    await waitFor(() => expect(handlers.has('action-registry://alerts')).toBe(true));
    await emit('action-registry://alerts', [alert({ severity: 'medium', message: 'Heads up.' })]);
    expect((await screen.findByText('Heads up.')).closest('[role=alert]')).not.toBeNull();
  });

  it('surfaces an alert already present at startup and ignores malformed payloads', async () => {
    invokeMock.mockImplementation(() => Promise.resolve([alert({ message: 'Present at boot.' })]));
    mount();
    expect(await screen.findByText('Present at boot.')).toBeInTheDocument();
    await emit('action-registry://alerts', [{ id: 1 }]);
    expect(screen.queryByText('Invalid Action Registry alert')).not.toBeInTheDocument();
  });

  it('warns about missed cron jobs and navigates to Cron; an empty payload stays silent', async () => {
    mount();
    await waitFor(() => expect(handlers.has('cron://missed-jobs')).toBe(true));
    await emit('cron://missed-jobs', []);
    expect(screen.queryByText('Missed Cron Jobs Detected')).not.toBeInTheDocument();
    await emit('cron://missed-jobs', [{ id: 'a' }, { id: 'b' }]);
    expect(await screen.findByText('Missed Cron Jobs Detected')).toBeInTheDocument();
    expect(screen.getByText('You have 2 missed cron jobs pending review in the Cron tab.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Cron View' }));
    expect(screen.getByTestId('route')).toHaveTextContent('cron');
  });

  it('uses the singular form for one missed job', async () => {
    mount();
    await waitFor(() => expect(handlers.has('cron://missed-jobs')).toBe(true));
    await emit('cron://missed-jobs', [{ id: 'a' }]);
    expect(await screen.findByText('You have 1 missed cron job pending review in the Cron tab.')).toBeInTheDocument();
  });

  it('releases both listeners on unmount, including one that resolved after teardown', async () => {
    const view = mount();
    await waitFor(() => expect(listenMock).toHaveBeenCalledTimes(2));
    await act(async () => {});
    view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(2);

    // Race: unmount before the async listen() resolves.
    unlisten.mockClear();
    let resolveLate!: (fn: () => void) => void;
    listenMock.mockReset().mockImplementation(() => new Promise<() => void>((res) => { resolveLate = res; }));
    mount().unmount();
    await act(async () => { resolveLate(unlisten); });
    expect(unlisten).toHaveBeenCalled();
  });
});
