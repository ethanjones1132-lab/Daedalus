import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PluginsView from './PluginsView';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface FixturePlugin {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  description: string;
  source: string;
}

function fixture(overrides: Partial<FixturePlugin> = {}): FixturePlugin {
  return {
    id: 'plugin-alpha',
    name: 'Alpha plugin',
    version: '1.2.0',
    enabled: false,
    description: 'Synthetic description',
    source: 'synthetic',
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'get_plugins') return Promise.resolve([]);
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

async function renderWith(plugins: FixturePlugin[]) {
  invokeMock.mockImplementation((command: string) => {
    if (command === 'get_plugins') return Promise.resolve(plugins);
    throw new Error(`Unexpected command: ${command}`);
  });
  render(
    <ToastProvider>
      <PluginsView />
    </ToastProvider>,
  );
  await screen.findByText(plugins.length > 0 ? plugins[0].name : 'No plugins installed.');
}

function toggleCalls() {
  return invokeMock.mock.calls.filter(([c]) => c === 'enable_plugin' || c === 'disable_plugin');
}

describe('PluginsView toggle coordination', () => {
  it('invokes the native command exactly once across repeated clicks while pending and freezes the control', async () => {
    const pending = deferred<boolean>();
    await renderWith([fixture()]);
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_plugins') return Promise.resolve([fixture()]);
      if (command === 'enable_plugin') return pending.promise;
      throw new Error(`Unexpected command: ${command}`);
    });

    const button = screen.getByRole('button', { name: 'Enable Alpha plugin' });
    fireEvent.click(button);
    expect(toggleCalls()).toEqual([['enable_plugin', { id: 'plugin-alpha' }]]);
    expect(screen.getByText('0 enabled')).toBeInTheDocument();

    // Reuse the clicked element even when its accessible pending name changes.
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Enabling Alpha plugin' }));
    expect(toggleCalls()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Enabling Alpha plugin' })).toBeDisabled();

    // No premature success toast before the native command resolves.
    expect(screen.queryByText('Enabled Alpha plugin')).not.toBeInTheDocument();

    await act(async () => { pending.resolve(true); });
    expect(screen.getByText('Enabled Alpha plugin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable Alpha plugin' })).toBeEnabled();
  });

  it('shows a fixed-message alert with Retry after a rejected toggle and never renders native detail', async () => {
    const first = deferred<boolean>();
    const retry = deferred<boolean>();
    await renderWith([fixture()]);
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_plugins') return Promise.resolve([fixture()]);
      if (command === 'enable_plugin') return first.promise;
      throw new Error(`Unexpected command: ${command}`);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Enable Alpha plugin' }));
    await act(async () => { first.reject(new Error('boom: api_key=sk-leaked')); });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not enable the plugin.');
    expect(alert).toHaveTextContent('Retry');
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sk-leaked/)).not.toBeInTheDocument();
    expect(screen.queryByText('Toggle failed')).not.toBeInTheDocument();
    // No success toast describes an operation that failed.
    expect(screen.queryByText('Enabled Alpha plugin')).not.toBeInTheDocument();
    // The row still offers the unconfirmed action; nothing was optimistically published.
    expect(screen.getByRole('button', { name: 'Enable Alpha plugin' })).toBeEnabled();

    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_plugins') return Promise.resolve([fixture()]);
      if (command === 'enable_plugin') return retry.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(toggleCalls()).toHaveLength(2);
    expect(toggleCalls()[1]).toEqual(['enable_plugin', { id: 'plugin-alpha' }]);
    expect(screen.getByRole('button', { name: 'Enabling Alpha plugin' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Enabling Alpha plugin' }));
    expect(toggleCalls()).toHaveLength(2);

    await act(async () => { retry.resolve(true); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable Alpha plugin' })).toBeEnabled();
  });

  it('serializes opposite clicks on one plugin without publishing conflicting state', async () => {
    const enable = deferred<boolean>();
    await renderWith([fixture()]);
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_plugins') return Promise.resolve([fixture()]);
      if (command === 'enable_plugin') return enable.promise;
      if (command === 'disable_plugin') return Promise.reject(new Error('disable must not run while enable is pending'));
      throw new Error(`Unexpected command: ${command}`);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Enable Alpha plugin' }));
    // The pending control cannot flip direction mid-flight.
    fireEvent.click(screen.getByRole('button', { name: 'Enabling Alpha plugin' }));
    expect(toggleCalls()).toHaveLength(1);
    expect(toggleCalls()[0][0]).toBe('enable_plugin');

    await act(async () => { enable.resolve(true); });
    expect(screen.getByRole('button', { name: 'Disable Alpha plugin' })).toBeEnabled();

    // Now a disable is a fresh, independent write.
    const disable = deferred<boolean>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_plugins') return Promise.resolve([fixture({ enabled: true })]);
      if (command === 'disable_plugin') return disable.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Disable Alpha plugin' }));
    expect(toggleCalls()[1]).toEqual(['disable_plugin', { id: 'plugin-alpha' }]);
    await act(async () => { disable.resolve(true); });
    expect(screen.getByText('Disabled Alpha plugin')).toBeInTheDocument();
  });

  it('keeps independent plugins toggleable while another plugin mutation is pending', async () => {
    const { promise: alphaPromise, resolve: alphaResolve } = deferred<boolean>();
    const { promise: betaPromise, resolve: betaResolve } = deferred<boolean>();
    const beta = fixture({ id: 'plugin-beta', name: 'Beta plugin', enabled: true });
    await renderWith([fixture(), beta]);
    invokeMock.mockImplementation((command: string, args: { id: string }) => {
      if (command === 'enable_plugin' && args.id === 'plugin-alpha') return alphaPromise;
      if (command === 'disable_plugin' && args.id === 'plugin-beta') return betaPromise;
      throw new Error(`Unexpected command: ${command}`);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Enable Alpha plugin' }));
    expect(screen.getByRole('button', { name: 'Enabling Alpha plugin' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Disable Beta plugin' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Disable Beta plugin' }));
    expect(screen.getByRole('button', { name: 'Disabling Beta plugin' })).toBeDisabled();
    expect(toggleCalls()).toEqual([
      ['enable_plugin', { id: 'plugin-alpha' }],
      ['disable_plugin', { id: 'plugin-beta' }],
    ]);
    expect(screen.getByText('1 enabled')).toBeInTheDocument();
    expect(screen.queryByText('Enabled Alpha plugin')).not.toBeInTheDocument();
    expect(screen.queryByText('Disabled Beta plugin')).not.toBeInTheDocument();

    await act(async () => { alphaResolve(true); });
    expect(screen.getByText('Enabled Alpha plugin')).toBeInTheDocument();
    expect(screen.getByText('2 enabled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable Alpha plugin' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Disabling Beta plugin' })).toBeDisabled();
    expect(screen.queryByText('Disabled Beta plugin')).not.toBeInTheDocument();

    await act(async () => { betaResolve(true); });
    expect(screen.getByText('Disabled Beta plugin')).toBeInTheDocument();
    expect(screen.getByText('1 enabled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable Beta plugin' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Disable Alpha plugin' })).toBeEnabled();
    expect(toggleCalls()).toHaveLength(2);
  });

  it('reports list load failure with a fixed message instead of native error detail', async () => {
    invokeMock.mockImplementation(() => Promise.reject(new Error('boom: api_key=sk-leaked')));
    render(
      <ToastProvider>
        <PluginsView />
      </ToastProvider>,
    );
    expect(await screen.findByText('Could not load plugins.')).toBeInTheDocument();
    expect(screen.queryByText(/sk-leaked/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('retains confirmed enablement on rejected disable and keeps retry serialized', async () => {
    const first = deferred<boolean>();
    const retry = deferred<boolean>();
    await renderWith([fixture({ enabled: true })]);
    invokeMock.mockImplementation(() => first.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Disable Alpha plugin' }));
    expect(screen.getByText('1 enabled')).toBeInTheDocument();
    expect(screen.queryByText('Disabled Alpha plugin')).not.toBeInTheDocument();
    await act(async () => { first.reject(new Error('synthetic native detail')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not disable the plugin.');
    expect(screen.queryByText(/synthetic native detail/)).not.toBeInTheDocument();
    expect(screen.getByText('1 enabled')).toBeInTheDocument();
    invokeMock.mockImplementation(() => retry.promise);
    const retryButton = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retryButton);
    expect(retryButton).toBeDisabled();
    fireEvent.click(retryButton);
    fireEvent.click(screen.getByRole('button', { name: 'Disabling Alpha plugin' }));
    expect(toggleCalls()).toEqual([
      ['disable_plugin', { id: 'plugin-alpha' }],
      ['disable_plugin', { id: 'plugin-alpha' }],
    ]);
    await act(async () => { retry.resolve(true); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('0 enabled')).toBeInTheDocument();
    expect(screen.getByText('Disabled Alpha plugin')).toBeInTheDocument();
  });

  it('renders a successful empty list without mutation controls', async () => {
    await renderWith([]);
    expect(screen.getByText('No plugins installed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
  });
});
