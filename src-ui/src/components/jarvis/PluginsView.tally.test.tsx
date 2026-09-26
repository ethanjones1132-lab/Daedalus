import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PluginsView from './PluginsView';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

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

const alpha = fixture();
const beta = fixture({ id: 'plugin-beta', name: 'Beta plugin', enabled: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function readCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'get_plugins');
}

function header() {
  return screen.getByRole('heading', { level: 2 });
}

// The count is rendered inside the heading with no separating space ("Plugins(2)"),
// so the printed count is read off the heading text rather than off a name match.
function headerCount(): number | null {
  const match = /^Plugins\((\d+)\)$/.exec(header().textContent ?? '');
  return match === null ? null : Number(match[1]);
}

function enabledPill() {
  return screen.queryByText(/^\d+ enabled$/);
}

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(cleanup);

describe('PluginsView header tally', () => {
  it('states no count while the first read is in flight', () => {
    const pending = deferred<FixturePlugin[]>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_plugins') return pending.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    render(
      <ToastProvider>
        <PluginsView />
      </ToastProvider>,
    );

    expect(screen.getByText('Loading plugins…')).toBeInTheDocument();
    expect(header()).toHaveTextContent('Plugins');
    expect(headerCount()).toBeNull();
    expect(enabledPill()).not.toBeInTheDocument();
  });

  it('states no count after a rejected first read, beside the fixed error and its Retry', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_plugins') return Promise.reject(new Error('boom: api_key=sk-leaked'));
      throw new Error(`Unexpected command: ${command}`);
    });
    render(
      <ToastProvider>
        <PluginsView />
      </ToastProvider>,
    );

    expect(await screen.findByText('Could not load plugins.')).toBeInTheDocument();
    expect(headerCount()).toBeNull();
    expect(enabledPill()).not.toBeInTheDocument();
    expect(screen.queryByText(/sk-leaked/)).not.toBeInTheDocument();
  });

  it('states no count after a repeated failed read, and each Retry re-reads the same command', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_plugins') return Promise.reject(new Error('synthetic native detail'));
      throw new Error(`Unexpected command: ${command}`);
    });
    render(
      <ToastProvider>
        <PluginsView />
      </ToastProvider>,
    );

    await screen.findByText('Could not load plugins.');
    for (const attempt of [2, 3]) {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await act(async () => {});
      expect(readCalls()).toHaveLength(attempt);
      expect(headerCount()).toBeNull();
      expect(enabledPill()).not.toBeInTheDocument();
    }
    expect(screen.getByText('Could not load plugins.')).toBeInTheDocument();
  });

  it('keeps a confirmed empty read reading as a genuine zero', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_plugins') return Promise.resolve([]);
      throw new Error(`Unexpected command: ${command}`);
    });
    render(
      <ToastProvider>
        <PluginsView />
      </ToastProvider>,
    );

    expect(await screen.findByText('No plugins installed.')).toBeInTheDocument();
    expect(headerCount()).toBe(0);
    expect(enabledPill()).toHaveTextContent('0 enabled');
  });

  it('states the real counts once a read confirms a list', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_plugins') return Promise.resolve([alpha, beta]);
      throw new Error(`Unexpected command: ${command}`);
    });
    render(
      <ToastProvider>
        <PluginsView />
      </ToastProvider>,
    );

    expect(await screen.findByText('Alpha plugin')).toBeInTheDocument();
    expect(headerCount()).toBe(2);
    expect(enabledPill()).toHaveTextContent('1 enabled');
  });

  it('recovers the confirmed counts on the read a Retry actually completes', async () => {
    const retry = deferred<FixturePlugin[]>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_plugins') return Promise.reject(new Error('synthetic native detail'));
      throw new Error(`Unexpected command: ${command}`);
    });
    render(
      <ToastProvider>
        <PluginsView />
      </ToastProvider>,
    );
    await screen.findByText('Could not load plugins.');

    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_plugins') return retry.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(headerCount()).toBeNull();

    await act(async () => { retry.resolve([alpha, beta]); });
    expect(headerCount()).toBe(2);
    expect(enabledPill()).toHaveTextContent('1 enabled');
    expect(screen.queryByText('Could not load plugins.')).not.toBeInTheDocument();
  });

  it('keeps a confirmed count beside a rejected toggle, whose state is the last confirmed one', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_plugins') return Promise.resolve([alpha, beta]);
      if (command === 'enable_plugin') return Promise.reject(new Error('synthetic native detail'));
      throw new Error(`Unexpected command: ${command}`);
    });
    render(
      <ToastProvider>
        <PluginsView />
      </ToastProvider>,
    );
    expect(await screen.findByText('Alpha plugin')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Enable Alpha plugin' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not enable the plugin.');
    expect(headerCount()).toBe(2);
    expect(enabledPill()).toHaveTextContent('1 enabled');
  });
});
