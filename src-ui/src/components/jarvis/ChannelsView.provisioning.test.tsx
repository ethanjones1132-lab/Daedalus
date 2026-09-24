import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChannelsView from './ChannelsView';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const channel = {
  id: 'ch-1', name: 'Newsroom', type: 'discord', enabled: true,
  config: { channel_id: '123' }, connected: false, last_used: null,
  created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:00:00Z',
};
const connected = { ...channel, config: { channel_id: '123', connected: true } };
const receipt = {
  message_id: 'message-1', channel: 'discord', status: 'delivered' as const,
  retry_count: 0, correlation_id: 'verification-1', finished_at: '2026-09-24T00:00:01Z',
};
const receiptResponse = () => new Response(JSON.stringify({ receipts: [] }));
const deliveredResponse = () => new Response(JSON.stringify({ ok: true, receipt }));
const fetchMock = vi.fn();

beforeEach(() => {
  invokeMock.mockReset().mockImplementation(async (command) => {
    if (command === 'list_channels') return [];
    throw new Error(`unexpected native command: ${command}`);
  });
  fetchMock.mockReset().mockImplementation(async (input) => {
    if (String(input).endsWith('/channels/discord/receipts')) return receiptResponse();
    return deliveredResponse();
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function channelRow(name = 'Newsroom') {
  return within(screen.getByRole('heading', { name }).closest('li')!);
}

async function renderForm() {
  render(<ToastProvider><ChannelsView /></ToastProvider>);
  await screen.findByText('No channels yet. Add one to get started.');
  fireEvent.click(screen.getByRole('button', { name: '+ New channel' }));
  fireEvent.change(screen.getByPlaceholderText('Channel name *'), { target: { value: 'Newsroom' } });
  fireEvent.change(screen.getByPlaceholderText('Discord channel ID *'), { target: { value: '123' } });
}

describe('Discord channel provisioning', () => {
  it('exposes only the executable adapter and persists a destination without a secret', async () => {
    await renderForm();
    expect(screen.getByRole('combobox')).toHaveValue('discord');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Discord']);
    expect(screen.queryByPlaceholderText(/token|endpoint/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add channel' })).toBeEnabled();
    invokeMock.mockResolvedValueOnce(channel);
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    await act(async () => {});
    expect(invokeMock).toHaveBeenCalledWith('add_channel', {
      name: 'Newsroom', channelType: 'discord', config: { channel_id: '123' },
    });
    expect(JSON.stringify(invokeMock.mock.calls)).not.toMatch(/token|secret/i);
  });

  it('waits for a delivered receipt before persisting the connected flag', async () => {
    invokeMock.mockResolvedValueOnce([channel]);
    render(<ToastProvider><ChannelsView /></ToastProvider>);
    await screen.findByRole('heading', { name: 'Newsroom' });
    await screen.findByText('No delivery receipts yet.');
    const send = deferred<Response>();
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith('/channels/discord/receipts')) return Promise.resolve(receiptResponse());
      return send.promise;
    });
    invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce([connected]);
    const row = channelRow();
    fireEvent.click(row.getByRole('button', { name: 'Verify & connect' }));
    expect(row.getByRole('button', { name: 'Verifying…' })).toBeDisabled();
    const [, init] = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/channels/discord/send'))!;
    expect(JSON.parse(String(init?.body))).toEqual({
      channel_id: '123', text: 'Jarvis Discord connection check',
    });
    expect(JSON.stringify(init)).not.toMatch(/token|secret/i);
    expect(invokeMock).not.toHaveBeenCalledWith('login_channel', expect.anything());
    await act(async () => { send.resolve(deliveredResponse()); });
    await screen.findByText('1 connected');
    expect(invokeMock).toHaveBeenCalledWith('login_channel', { id: 'ch-1' });
    expect(screen.getByText('delivery verified')).toBeInTheDocument();
  });

  it.each([
    ['missing secret', new Response(JSON.stringify({ ok: false, error: 'discord_secret_unavailable' }), { status: 503 })],
    ['failed delivery', new Response(JSON.stringify({ ok: false, receipt: { ...receipt, status: 'failed', error_code: 'discord_http_401' } }), { status: 502 })],
    ['malformed response', new Response(JSON.stringify({ ok: true }))],
  ])('does not claim a connection after %s', async (_label, response) => {
    invokeMock.mockResolvedValueOnce([channel]);
    render(<ToastProvider><ChannelsView /></ToastProvider>);
    await screen.findByRole('heading', { name: 'Newsroom' });
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith('/channels/discord/receipts')) return Promise.resolve(receiptResponse());
      return Promise.resolve(response);
    });
    fireEvent.click(channelRow().getByRole('button', { name: 'Verify & connect' }));
    await act(async () => {});
    expect(invokeMock).not.toHaveBeenCalledWith('login_channel', expect.anything());
    expect(channelRow().getByRole('alert')).toHaveTextContent('Delivery could not be verified. The channel was not connected.');
    expect(channelRow().getByRole('button', { name: 'Verify & connect' })).toBeEnabled();
  });

  it('does not offer verification for an unsupported legacy adapter', async () => {
    const legacy = { ...channel, type: 'webhook', config: { connected: false } };
    invokeMock.mockResolvedValueOnce([legacy]);
    render(<ToastProvider><ChannelsView /></ToastProvider>);
    await screen.findByRole('heading', { name: 'Newsroom' });
    const row = channelRow();
    expect(row.getByText('unsupported adapter')).toBeInTheDocument();
    expect(row.queryByRole('button', { name: 'Verify & connect' })).not.toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Remove' })).toBeEnabled();
  });
});
