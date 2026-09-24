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
const discovered = [{ id: 'coder', slug: 'coder', status: 'valid' }];
const response = (rows = discovered) => ({ ok: true, json: async () => rows }) as Response;
const fetchMock = vi.fn();
const emptyMessage = 'No agents discovered in agents root.';
let readAgents: () => Promise<typeof agent[]>;
const refresh = () => screen.getByRole('button', { name: 'Refresh discovery' });
const retry = () => screen.getByRole('button', { name: 'Retry discovery' });
beforeEach(() => {
  readAgents = () => Promise.resolve([agent]);
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'list_agents') return readAgents();
    if (command === 'list_channels' || command === 'list_agent_channel_bindings' || command === 'list_agent_projections') return Promise.resolve([]);
    throw new Error(`Unexpected command: ${command}`);
  });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Agent lifecycle discovery', () => {
  it('keeps native Agent rows usable while discovery is pending and reports empty only after success', async () => {
    const request = deferred<Response>();
    fetchMock.mockReturnValue(request.promise);
    render(<AgentsView />);
    await screen.findByText('Atlas');
    expect(screen.getByRole('status', { name: 'Agent discovery' })).toHaveTextContent('Loading');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(screen.queryByText(emptyMessage)).not.toBeInTheDocument();
    expect(refresh()).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:19877/agents');
    await act(async () => { request.resolve(response([])); });
    expect(screen.getByText(emptyMessage)).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Agent discovery' })).not.toBeInTheDocument();
    expect(refresh()).toBeEnabled();
  });

  it('starts discovery without waiting for the native list', async () => {
    const native = deferred<typeof agent[]>();
    readAgents = () => native.promise;
    fetchMock.mockResolvedValue(response());
    render(<AgentsView />);
    expect(await screen.findByText('coder')).toBeInTheDocument();
    expect(screen.queryByText('Atlas')).not.toBeInTheDocument();
    await act(async () => { native.resolve([agent]); });
    expect(screen.getByText('Atlas')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'http', 'json'])('exposes a fixed retryable error after %s failure and retries discovery only', async (kind) => {
    if (kind === 'network') fetchMock.mockRejectedValue(new Error('private discovery detail'));
    if (kind === 'http') fetchMock.mockResolvedValue({ ok: false, status: 503 });
    if (kind === 'json') fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new Error('private discovery detail'); } });
    render(<AgentsView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent discovery is unavailable.');
    expect(screen.queryByText(emptyMessage)).not.toBeInTheDocument();
    expect(screen.queryByText(/private discovery detail/)).not.toBeInTheDocument();
    expect(screen.getByText('Atlas')).toBeInTheDocument();
    const nativeCalls = invokeMock.mock.calls.length;
    const request = deferred<Response>();
    fetchMock.mockReturnValue(request.promise);
    fireEvent.click(retry());
    fireEvent.click(retry());
    expect(retry()).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
    expect(screen.getByRole('status', { name: 'Agent discovery' })).toBeInTheDocument();
    await act(async () => { request.resolve(response()); });
    expect(screen.getByText('coder')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(invokeMock.mock.calls).toHaveLength(nativeCalls);
  });

  it('retains discovered rows as stale through failed refresh and pending retry until successful replacement', async () => {
    fetchMock.mockResolvedValue(response());
    render(<AgentsView />);
    await screen.findByText('coder');
    const request = deferred<Response>();
    fetchMock.mockReturnValue(request.promise);
    fireEvent.click(refresh());
    expect(screen.getByText('coder')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Agent discovery' })).toHaveTextContent('Refreshing');
    await act(async () => { request.reject(new Error('private refresh detail')); });
    expect(screen.getByText('coder')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('previously discovered agents; they may be stale');
    const next = deferred<Response>();
    fetchMock.mockReturnValue(next.promise);
    fireEvent.click(retry());
    expect(screen.getByRole('alert')).toHaveTextContent('stale');
    expect(screen.queryByText(emptyMessage)).not.toBeInTheDocument();
    await act(async () => { next.resolve(response([])); });
    expect(screen.queryByText('coder')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(emptyMessage)).toBeInTheDocument();
  });

  it('guards concurrent discovery entry points so no older request can overwrite a newer snapshot', async () => {
    readAgents = () => Promise.reject(new Error('native list unavailable'));
    const first = deferred<Response>();
    fetchMock.mockReturnValue(first.promise);
    render(<AgentsView />);
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Agents are unavailable.');
    readAgents = () => Promise.resolve([agent]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Atlas');
    fireEvent.click(refresh());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(response()); });
    expect(screen.getByText('coder')).toBeInTheDocument();
    const second = deferred<Response>();
    fetchMock.mockReturnValue(second.promise);
    fireEvent.click(refresh());
    fireEvent.click(refresh());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve(response([{ id: 'writer', slug: 'writer', status: 'invalid' }])); });
    await waitFor(() => expect(refresh()).toBeEnabled());
    expect(screen.getByText('writer')).toBeInTheDocument();
    expect(screen.getByText('invalid')).toBeInTheDocument();
    expect(screen.queryByText('coder')).not.toBeInTheDocument();
  });
});
