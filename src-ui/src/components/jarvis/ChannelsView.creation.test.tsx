import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
import ChannelsView from './ChannelsView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const channel = {
  id: 'created', name: 'Newsroom', type: 'discord', enabled: true, config: null,
  last_used: null, connected: false, created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z',
};
const fetchMock = vi.fn();
const creates = () => invokeMock.mock.calls.filter(([command]) => command === 'add_channel');
const nameInput = () => screen.getByPlaceholderText('Channel name *');
const urlInput = () => screen.getByPlaceholderText('Endpoint URL / token (optional)');

beforeEach(() => {
  invokeMock.mockReset().mockImplementation(async (command) => {
    if (command === 'list_channels') return [];
    throw new Error(`Unexpected command: ${command}`);
  });
  fetchMock.mockReset().mockImplementation(async () => new Response('{"receipts":[]}'));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openDraft() {
  render(<ToastProvider><ChannelsView /></ToastProvider>);
  await screen.findByText('No channels yet. Add one to get started.');
  fireEvent.click(screen.getByRole('button', { name: '+ New channel' }));
  fireEvent.change(nameInput(), { target: { value: '  Newsroom  ' } });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'discord' } });
  fireEvent.change(urlInput(), { target: { value: '  https://example.test/channel  ' } });
}

describe('Channel creation lifetime', () => {
  it('freezes fields and both dismissal paths while submitting once, then allows a fresh form', async () => {
    const request = deferred<typeof channel>();
    await openDraft();
    invokeMock.mockImplementation((command) => command === 'add_channel' ? request.promise : Promise.resolve([channel]));
    const add = screen.getByRole('button', { name: 'Add channel' });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(nameInput()).toBeDisabled();
    expect(urlInput()).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Adding channel');
    const user = userEvent.setup();
    await user.type(nameInput(), 'newer');
    await user.type(urlInput(), '/newer');
    await user.selectOptions(screen.getByRole('combobox'), 'slack');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(nameInput()).toHaveValue('  Newsroom  ');
    expect(urlInput()).toHaveValue('  https://example.test/channel  ');
    expect(screen.getByRole('combobox')).toHaveValue('discord');
    expect(screen.queryByText('Added channel Newsroom')).not.toBeInTheDocument();
    expect(creates()).toEqual([['add_channel', { name: 'Newsroom', channelType: 'discord', config: { url: 'https://example.test/channel' } }]]);
    await act(async () => { request.resolve(channel); });
    expect(screen.getByText('Added channel Newsroom')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Channel name *')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ New channel' }));
    expect(nameInput()).toHaveValue('');
    expect(urlInput()).toHaveValue('');
    expect(screen.getByRole('combobox')).toHaveValue('webhook');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retains the entire rejected draft with fixed inline recovery and guarded retry', async () => {
    const request = deferred<typeof channel>();
    await openDraft();
    invokeMock.mockReturnValueOnce(request.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    await act(async () => { request.reject(new Error('synthetic private native detail')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not add channel. Your draft has been kept.');
    expect(screen.queryByText(/synthetic private native detail/)).not.toBeInTheDocument();
    expect(nameInput()).toHaveValue('  Newsroom  ');
    expect(urlInput()).toHaveValue('  https://example.test/channel  ');
    expect(screen.getByRole('combobox')).toHaveValue('discord');
    expect(nameInput()).toBeEnabled();
    const retry = deferred<typeof channel>();
    invokeMock.mockReturnValueOnce(retry.promise);
    const button = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Adding…' }));
    expect(creates()).toHaveLength(2);
    expect(creates()[1]).toEqual(creates()[0]);
    await act(async () => { retry.resolve(channel); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Added channel Newsroom')).toBeInTheDocument();
  });

  it('distinguishes confirmed creation from failed readback and retries only the list', async () => {
    const request = deferred<typeof channel>();
    const readback = deferred<typeof channel[]>();
    await openDraft();
    invokeMock.mockReturnValueOnce(request.promise).mockReturnValueOnce(readback.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    await act(async () => { request.resolve(channel); });
    expect(screen.getByText('Added channel Newsroom')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Channel name *')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ New channel' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '+ New channel' }));
    expect(screen.queryByPlaceholderText('Channel name *')).not.toBeInTheDocument();
    await act(async () => { readback.reject(new Error('synthetic private readback detail')); });
    expect(screen.getByText('Channel was added, but the channel list could not be refreshed. Retry reloads the list only.')).toBeInTheDocument();
    expect(screen.queryByText(/synthetic private readback detail/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not add channel/)).not.toBeInTheDocument();
    invokeMock.mockResolvedValueOnce([channel]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.getByRole('heading', { name: 'Newsroom' })).toBeInTheDocument();
    expect(creates()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows cancellation before submission and keeps channel choices and blank URL semantics', async () => {
    await openDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: '+ New channel' }));
    expect(nameInput()).toHaveValue('');
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      'Webhook', 'Discord', 'Slack', 'Telegram', 'Signal', 'Email', 'HTTP Endpoint', 'WebSocket',
    ]);
    expect(screen.getByRole('button', { name: 'Add channel' })).toBeDisabled();
    fireEvent.change(nameInput(), { target: { value: '  Other  ' } });
    fireEvent.change(urlInput(), { target: { value: '  ' } });
    const request = deferred<typeof channel>();
    invokeMock.mockReturnValueOnce(request.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    expect(creates()).toEqual([['add_channel', { name: 'Other', channelType: 'webhook', config: {} }]]);
    await act(async () => { request.resolve({ ...channel, name: 'Other' }); });
    fireEvent.click(screen.getByRole('button', { name: '+ New channel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByPlaceholderText('Channel name *')).not.toBeInTheDocument();
  });
});
