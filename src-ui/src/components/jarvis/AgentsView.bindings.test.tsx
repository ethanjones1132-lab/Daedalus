import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentsView from './AgentsView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const agent = {
  id: 'a1', name: 'Atlas', description: '', model: 'test-model', backend: 'jarvis',
  system_prompt: '', enabled: true, config: null, created_at: '', updated_at: '',
};
const channels = [{ id: 'c1', name: 'Newsroom', type: 'discord', enabled: true }];
let readBindings: () => Promise<string[]>;
let readChannels: () => Promise<typeof channels>;
let mutate: () => Promise<unknown>;
const calls = (command: string) => invokeMock.mock.calls.filter(([c]) => c === command);
const binding = () => screen.getByRole('button', { name: /Newsroom/ });
beforeEach(() => {
  readBindings = () => Promise.resolve([]);
  readChannels = () => Promise.resolve(channels);
  mutate = () => Promise.resolve(null);
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'list_agents') return Promise.resolve([agent]);
    if (command === 'list_channels') return readChannels();
    if (command === 'list_agent_channel_bindings') return readBindings();
    if (command === 'list_agent_projections') return Promise.resolve([]);
    if (command === 'bind_agent_channel' || command === 'unbind_agent_channel') return mutate();
    throw new Error(`Unexpected command: ${command}`);
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Agent channel resources', () => {
  it('does not label unknown bindings unbound or allow mutation while pending or failed; retries to true empty', async () => {
    const request = deferred<string[]>();
    readBindings = () => request.promise;
    render(<AgentsView />);
    await screen.findByText('Atlas');
    expect(screen.getByRole('status', { name: 'Channel bindings for Atlas' })).toHaveTextContent('Loading');
    expect(binding()).toBeDisabled();
    expect(binding()).not.toHaveAttribute('aria-pressed');
    expect(binding()).not.toHaveTextContent('○');
    fireEvent.click(binding());
    expect(calls('bind_agent_channel')).toHaveLength(0);
    await act(async () => { request.reject(new Error('private native detail')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Channel bindings are unavailable');
    expect(binding()).toBeDisabled();
    expect(screen.queryByText(/private native detail/)).not.toBeInTheDocument();
    const retry = deferred<string[]>();
    readBindings = () => retry.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Retry bindings for Atlas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry bindings for Atlas' }));
    expect(calls('list_agent_channel_bindings')).toHaveLength(2);
    await act(async () => { retry.resolve([]); });
    expect(binding()).toBeEnabled();
    expect(binding()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(calls('list_agent_channel_bindings')[0]).toEqual(['list_agent_channel_bindings', { agentId: 'a1' }]);
  });

  it('keeps native Agent rows available while channel metadata is pending, failed, and retrying', async () => {
    const request = deferred<typeof channels>();
    readChannels = () => request.promise;
    render(<AgentsView />);
    await screen.findByText('Atlas');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(screen.getByRole('status', { name: 'Agent channels' })).toHaveTextContent('Loading channels');
    expect(screen.queryByText('No channels available.')).not.toBeInTheDocument();
    await act(async () => { request.reject(new Error('private channel detail')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Channels are unavailable');
    expect(screen.getByText('Atlas')).toBeInTheDocument();
    expect(screen.queryByText(/private channel detail/)).not.toBeInTheDocument();
    readChannels = () => Promise.resolve(channels);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry channels' })); });
    expect(binding()).toBeEnabled();
    expect(calls('list_agents')).toHaveLength(1);
    expect(calls('list_channels')).toHaveLength(2);
  });

  it('reports zero channels only after a successful empty channel list', async () => {
    readChannels = () => Promise.resolve([]);
    render(<AgentsView />);
    expect(await screen.findByText('No channels available.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('serializes a bind through its reconciliation and then derives unbind from the retrieved snapshot', async () => {
    render(<AgentsView />);
    await screen.findByText('Atlas');
    const write = deferred<unknown>();
    const reconcile = deferred<string[]>();
    await waitFor(() => expect(binding()).toBeEnabled());
    mutate = () => write.promise;
    readBindings = () => reconcile.promise;
    fireEvent.click(binding());
    fireEvent.click(binding());
    expect(calls('bind_agent_channel')).toEqual([['bind_agent_channel', { agentId: 'a1', channelId: 'c1' }]]);
    expect(binding()).toBeDisabled();
    expect(binding()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('status', { name: 'Channel bindings for Atlas' })).toHaveTextContent('Updating');
    await act(async () => { write.resolve(null); });
    expect(binding()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh bindings for Atlas' }));
    expect(calls('list_agent_channel_bindings')).toHaveLength(2);
    await act(async () => { reconcile.resolve(['c1']); });
    expect(binding()).toBeEnabled();
    expect(binding()).toHaveAttribute('aria-pressed', 'true');
    mutate = () => Promise.resolve(null);
    readBindings = () => Promise.resolve([]);
    await act(async () => { fireEvent.click(binding()); });
    expect(calls('unbind_agent_channel')).toEqual([['unbind_agent_channel', { agentId: 'a1', channelId: 'c1' }]]);
    expect(binding()).toHaveAttribute('aria-pressed', 'false');
    expect(calls('list_agents')).toHaveLength(1);
  });

  it.each(['refresh', 'reconciliation'])('retains known bindings as stale after failed %s and recovers with read-only retry', async (kind) => {
    readBindings = () => Promise.resolve(['c1']);
    render(<AgentsView />);
    await screen.findByText('Atlas');
    await waitFor(() => expect(binding()).toBeEnabled());
    expect(binding()).toHaveAttribute('aria-pressed', 'true');
    readBindings = () => Promise.reject(new Error('private refresh detail'));
    await act(async () => {
      fireEvent.click(kind === 'refresh' ? screen.getByRole('button', { name: 'Refresh bindings for Atlas' }) : binding());
    });
    expect(screen.getByRole('alert')).toHaveTextContent('previously loaded bindings; they may be stale');
    expect(binding()).toHaveAttribute('aria-pressed', 'true');
    expect(binding()).toBeDisabled();
    expect(screen.queryByText(/Could not change/)).not.toBeInTheDocument();
    readBindings = () => Promise.resolve([]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry bindings for Atlas' })); });
    expect(binding()).toHaveAttribute('aria-pressed', 'false');
    expect(binding()).toBeEnabled();
    expect(calls('unbind_agent_channel')).toHaveLength(kind === 'refresh' ? 0 : 1);
  });

  it('surfaces a failed mutation without changing the known snapshot and reloads before another attempt', async () => {
    render(<AgentsView />);
    await screen.findByText('Atlas');
    mutate = () => Promise.reject(new Error('private mutation detail'));
    await waitFor(() => expect(binding()).toBeEnabled());
    await act(async () => { fireEvent.click(binding()); });
    expect(calls('bind_agent_channel')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not change channel binding');
    expect(binding()).toHaveAttribute('aria-pressed', 'false');
    expect(binding()).toBeDisabled();
    expect(screen.queryByText(/private mutation detail/)).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry bindings for Atlas' })); });
    expect(binding()).toBeEnabled();
    expect(calls('bind_agent_channel')).toHaveLength(1);
  });

  it('retains channel metadata with stale feedback and disables mutations after its refresh fails', async () => {
    render(<AgentsView />);
    await screen.findByText('Atlas');
    readChannels = () => Promise.reject(new Error('channel refresh failed'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh channels' })).toBeEnabled());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh channels' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('previously loaded channels; they may be stale');
    expect(binding()).toBeDisabled();
    expect(screen.getByText('Atlas')).toBeInTheDocument();
    readChannels = () => Promise.resolve(channels);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry channels' })); });
    expect(binding()).toBeEnabled();
  });
});
