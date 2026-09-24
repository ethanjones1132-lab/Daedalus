import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  id: 'ch_2', name: 'Newsroom', type: 'discord', enabled: true, config: { channel_id: '123' },
  last_used: null, connected: false, created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z',
};
const secondChannel = { ...channel, id: 'ch_3', name: 'Operations' };
const receipt = {
  message_id: 'm1', channel: 'discord', status: 'delivered', retry_count: 0,
  correlation_id: 'c1', finished_at: '2026-09-16T00:00:00Z',
};
const response = (receipts: unknown[] = [receipt]) => new Response(JSON.stringify({ receipts }));
const fetchMock = vi.fn();
beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue([channel]);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function usableRow() {
  expect(screen.getByText('Newsroom')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Verify & connect' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
}

describe('Channel receipt telemetry', () => {
  it('makes native rows usable while optional telemetry is pending', async () => {
    const request = deferred<Response>();
    fetchMock.mockReturnValue(request.promise);
    render(<ChannelsView />);
    await screen.findByText('Newsroom');
    usableRow();
    expect(screen.getByRole('status')).toHaveTextContent('Loading delivery telemetry');
    expect(screen.getByRole('button', { name: 'Refresh delivery telemetry' })).toBeDisabled();
    expect(screen.queryByRole('region', { name: 'Discord adapter delivery receipts' })).not.toBeInTheDocument();
    await act(async () => { request.resolve(response()); });
    const ledger = screen.getByRole('region', { name: 'Discord adapter delivery receipts' });
    expect(within(ledger).getByText('status: delivered')).toBeInTheDocument();
    expect(within(ledger).getByText('retry_count: 0')).toBeInTheDocument();
    expect(within(ledger).getByText('message_id: m1')).toBeInTheDocument();
    expect(within(ledger).getByText('correlation_id: c1')).toBeInTheDocument();
    expect(within(ledger).getByText('finished_at: 2026-09-16T00:00:00Z')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:19877/channels/discord/receipts');
  });

  it.each(['network', 'http', 'json', 'shape', 'missing fetch'])('isolates %s failure and retries telemetry only with duplicate protection', async (failure) => {
    const request = deferred<Response>();
    fetchMock.mockReturnValueOnce(request.promise);
    if (failure === 'missing fetch') vi.stubGlobal('fetch', undefined);
    render(<ChannelsView />);
    await act(async () => {
      if (failure === 'network') request.reject(new Error('private detail'));
      else if (failure === 'http') request.resolve(new Response('private detail', { status: 503 }));
      else if (failure === 'json') request.resolve(new Response('private detail'));
      else if (failure === 'shape') request.resolve(new Response('{"receipts":null}'));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Delivery telemetry is unavailable');
    usableRow();
    expect(screen.queryByText(/private detail/)).not.toBeInTheDocument();
    const retry = deferred<Response>();
    fetchMock.mockReset().mockReturnValue(retry.promise);
    vi.stubGlobal('fetch', fetchMock);

    fireEvent.click(screen.getByRole('button', { name: 'Retry delivery telemetry' }));
    expect(screen.getByRole('button', { name: 'Refresh delivery telemetry' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh delivery telemetry' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls).toEqual([['list_channels']]);
    await act(async () => { retry.resolve(response()); });
    expect(within(screen.getByRole('region', { name: 'Discord adapter delivery receipts' })).getByText('status: delivered')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('labels retained receipts stale during refresh and failure, clearing them on successful empty retry', async () => {
    fetchMock.mockResolvedValueOnce(response());
    render(<ChannelsView />);
    const ledger = await screen.findByRole('region', { name: 'Discord adapter delivery receipts' });
    expect(within(ledger).getByText('status: delivered')).toBeInTheDocument();
    const refresh = deferred<Response>();
    fetchMock.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh delivery telemetry' }));
    expect(within(ledger).getByText('status: delivered (stale)')).toBeInTheDocument();
    usableRow();
    await act(async () => { refresh.reject(new Error('private detail')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Delivery telemetry is stale');
    expect(within(ledger).getByText('status: delivered (stale)')).toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(response([]));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry delivery telemetry' })); });
    expect(screen.queryByRole('region', { name: 'Discord adapter delivery receipts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('No delivery receipts yet.')).toBeInTheDocument();
    expect(invokeMock.mock.calls).toEqual([['list_channels']]);
  });

  it('keeps adapter-wide receipts detached from every Discord row', async () => {
    invokeMock.mockResolvedValueOnce([channel, secondChannel]);
    fetchMock.mockResolvedValueOnce(response());
    render(<ChannelsView />);
    const ledger = await screen.findByRole('region', { name: 'Discord adapter delivery receipts' });
    const rows = [screen.getByText('Newsroom').closest('li')!, screen.getByText('Operations').closest('li')!];
    expect(within(ledger).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getAllByText('status: delivered')).toHaveLength(1);
    for (const row of rows) {
      expect(within(row).queryByText(/status:|message_id:|correlation_id:|delivery/)).not.toBeInTheDocument();
    }
  });

  it('renders multiple newest-first receipts with status, retries, identity, finish time, and stored error code', async () => {
    const failed = {
      ...receipt,
      message_id: '',
      correlation_id: 'c2',
      status: 'failed' as const,
      retry_count: 2,
      error_code: 'discord_http_500',
      finished_at: '2026-09-16T00:00:02Z',
    };
    const delivered = { ...receipt, correlation_id: 'c1' };
    fetchMock.mockResolvedValueOnce(response([failed, delivered]));
    render(<ChannelsView />);
    const ledger = await screen.findByRole('region', { name: 'Discord adapter delivery receipts' });
    const entries = within(ledger).getAllByRole('listitem');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent('status: failed');
    expect(entries[0]).toHaveTextContent('retry_count: 2');
    expect(entries[0]).toHaveTextContent('message_id: Not supplied');
    expect(entries[0]).toHaveTextContent('correlation_id: c2');
    expect(entries[0]).toHaveTextContent('finished_at: 2026-09-16T00:00:02Z');
    expect(entries[0]).toHaveTextContent('error_code: discord_http_500');
    expect(entries[1]).toHaveTextContent('status: delivered');
    expect(entries[1]).toHaveTextContent('message_id: m1');
    expect(entries[1]).toHaveTextContent('correlation_id: c1');
  });

  it('uses fixed missing-value fallbacks without exposing response details', async () => {
    fetchMock.mockResolvedValueOnce(response([{
      ...receipt,
      message_id: '',
      correlation_id: '',
      finished_at: '',
      status: 'failed',
      error_code: undefined,
    }]));
    render(<ChannelsView />);
    const ledger = await screen.findByRole('region', { name: 'Discord adapter delivery receipts' });
    expect(within(ledger).getByText('message_id: Not supplied')).toBeInTheDocument();
    expect(within(ledger).getByText('correlation_id: Not supplied')).toBeInTheDocument();
    expect(within(ledger).getByText('finished_at: Not supplied')).toBeInTheDocument();
    expect(within(ledger).getByText('error_code: Not supplied')).toBeInTheDocument();
    expect(screen.queryByText(/private detail|response body|authorization|bearer/i)).not.toBeInTheDocument();
  });

  it('keeps native loading and retry separate even when telemetry succeeds first', async () => {
    const list = deferred<typeof channel[]>();
    invokeMock.mockReturnValueOnce(list.promise);
    fetchMock.mockResolvedValueOnce(response([]));
    render(<ChannelsView />);
    await screen.findByText('No delivery receipts yet.');
    expect(screen.getByText('Loading channels…')).toBeInTheDocument();
    expect(screen.queryByText('No channels yet. Add one to get started.')).not.toBeInTheDocument();
    await act(async () => { list.reject(new Error('native list failed')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh channels. Retry reloads the list only.');
    expect(screen.queryByText(/native list failed/)).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    usableRow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls).toEqual([['list_channels'], ['list_channels']]);
  });
});
