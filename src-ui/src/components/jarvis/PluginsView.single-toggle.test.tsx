import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PluginsView from './PluginsView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
afterEach(cleanup);

describe('single plugin toggle confirmation', () => {
  it.each(['reject', 'false', 'true'] as const)('publishes only a true native result: %s', async (result) => {
    let resolve!: (value: boolean) => void;
    let reject!: (reason: Error) => void;
    const pending = new Promise<boolean>((res, rej) => { resolve = res; reject = rej; });
    invokeMock.mockReset().mockImplementation((command: string) => {
      if (command === 'get_plugins') return Promise.resolve([
        { id: 'alpha', name: 'Alpha', enabled: false, version: '1', description: '', source: '' },
      ]);
      if (command === 'enable_plugin') return pending;
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<PluginsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable Alpha' }));
    expect(screen.getByText('0 enabled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enabling Alpha' })).toBeDisabled();
    expect(invokeMock.mock.calls.filter(([command]) => command === 'enable_plugin')).toEqual([
      ['enable_plugin', { id: 'alpha' }],
    ]);
    await act(async () => {
      if (result === 'reject') reject(new Error('synthetic failure'));
      else resolve(result === 'true');
    });
    expect(screen.getByText(result === 'true' ? '1 enabled' : '0 enabled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: result === 'true' ? 'Disable Alpha' : 'Enable Alpha' })).toBeEnabled();
    if (result !== 'true') expect(screen.getByRole('alert')).toHaveTextContent('Could not enable the plugin.');
  });
});
