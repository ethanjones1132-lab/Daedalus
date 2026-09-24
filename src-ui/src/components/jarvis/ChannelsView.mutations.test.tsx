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

const alpha = {
  id: 'a', name: 'Alpha', type: 'discord', enabled: true,
  config: { channel_id: '123', connected: false }, connected: false, last_used: null,
  created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z',
};
const beta = { ...alpha, id: 'b', name: 'Beta' };
const connected = (row = alpha) => ({ ...row, config: { ...row.config, connected: true } });
const receipt = {
  message_id: 'm1', channel: 'discord', status: 'delivered' as const, retry_count: 0,
  correlation_id: 'c1', finished_at: '2026-09-16T00:00:00Z',
};
const response = (receipts: unknown[] = []) => new Response(JSON.stringify({ receipts }));
const sendResponse = () => new Response(JSON.stringify({ ok: true, receipt }));
const row = (name = 'Alpha') => within(screen.getByRole('heading', { name }).closest('li')!);
const writes = () => invokeMock.mock.calls.filter(([cmd]) => ['login_channel', 'logout_channel', 'remove_channel'].includes(cmd));
const connectButton = (name = 'Alpha') => row(name).getByRole('button', { name: 'Verify & connect' });

async function mount(rows = [alpha, beta]) {
  invokeMock.mockResolvedValueOnce(rows);
  render(<ChannelsView />);
  await screen.findByRole('heading', { name: 'Alpha' });
  await screen.findByText('No delivery receipts yet.');
}
function confirmRemoval() {
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
}

beforeEach(() => {
  invokeMock.mockReset().mockRejectedValue(new Error('Unexpected native call'));
  vi.stubGlobal('fetch', vi.fn().mockImplementation((input) => {
    if (String(input).endsWith('/channels/discord/receipts')) return Promise.resolve(response());
    return Promise.resolve(sendResponse());
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Channel row mutation coordination', () => {
  it('guards verification and an already-open removal confirmation through readback', async () => {
    await mount();
    const write = deferred<boolean>();
    const read = deferred<typeof alpha[]>();
    fireEvent.click(row().getByRole('button', { name: 'Remove' }));
    invokeMock.mockReturnValueOnce(write.promise).mockReturnValueOnce(read.promise);
    const verify = row().getByRole('button', { name: 'Verify & connect' });
    fireEvent.click(verify);
    fireEvent.click(verify);
    confirmRemoval();
    await act(async () => {});
    expect(writes()).toEqual([['login_channel', { id: 'a' }]]);
    expect(row().getByRole('button', { name: 'Verifying…' })).toBeDisabled();
    expect(row().getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(screen.getByText('0 connected')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await act(async () => { write.resolve(true); });
    expect(row().getByRole('button', { name: 'Verify & connect' })).toBeDisabled();
    await act(async () => { read.resolve([connected(), beta]); });
    expect(row().getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(screen.getByText('1 connected')).toBeInTheDocument();
  });

  it.each(['login_channel', 'logout_channel', 'remove_channel'])('treats false and rejected %s writes as fixed recoverable failures', async (command) => {
    await mount([command === 'logout_channel' ? connected() : alpha]);
    invokeMock.mockResolvedValueOnce(false);
    if (command === 'remove_channel') {
      fireEvent.click(row().getByRole('button', { name: 'Remove' }));
      confirmRemoval();
    } else {
      fireEvent.click(row().getByRole('button', { name: command === 'login_channel' ? 'Verify & connect' : 'Disconnect' }));
    }
    await act(async () => {});
    expect(row().getByRole('alert')).toHaveTextContent(/could not.*confirmed state was kept/i);
    expect(row().queryByText(/synthetic private/)).not.toBeInTheDocument();
    const retry = deferred<boolean>();
    invokeMock.mockReturnValueOnce(retry.promise);
    fireEvent.click(row().getByRole('button', { name: 'Retry' }));
    if (command === 'remove_channel') confirmRemoval();
    await act(async () => { retry.reject(new Error('synthetic private native detail')); });
    expect(row().getByRole('alert')).toHaveTextContent(/could not/i);
    expect(row().queryByText(/synthetic private/)).not.toBeInTheDocument();
    expect(writes()).toEqual([[command, { id: 'a' }], [command, { id: 'a' }]]);
    expect(row().getByRole('button', { name: command === 'logout_channel' ? 'Disconnect' : 'Verify & connect' })).toBeEnabled();
  });

  it('holds removal confirmation until write settlement and retries failed readback without rewriting', async () => {
    await mount();
    const write = deferred<boolean>();
    const read = deferred<typeof alpha[]>();
    invokeMock.mockReturnValueOnce(write.promise).mockReturnValueOnce(read.promise);
    fireEvent.click(row().getByRole('button', { name: 'Remove' }));
    confirmRemoval();
    expect(screen.getByRole('dialog')).toHaveTextContent(/removing/i);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /removing/i }));
    expect(row().getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(writes()).toEqual([['remove_channel', { id: 'a' }]]);
    await act(async () => { write.resolve(true); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(row().getByRole('button', { name: 'Remove' })).toBeDisabled();
    await act(async () => { read.reject(new Error('synthetic private read detail')); });
    expect(row().getByRole('alert')).toHaveTextContent(/saved.*retry reloads the list only/i);
    expect(row().queryByText(/synthetic private/)).not.toBeInTheDocument();
    const retry = deferred<typeof alpha[]>();
    invokeMock.mockReturnValueOnce(retry.promise);
    const button = row().getByRole('button', { name: 'Retry' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    await act(async () => { retry.resolve([beta]); });
    expect(screen.queryByRole('heading', { name: 'Alpha' })).not.toBeInTheDocument();
    expect(writes()).toHaveLength(1);
  });

  it('keeps independent writes usable and ignores an obsolete read resolve', async () => {
    await mount();
    const oldRead = deferred<typeof alpha[]>();
    const newRead = deferred<typeof alpha[]>();
    invokeMock.mockResolvedValueOnce(true).mockReturnValueOnce(oldRead.promise);
    fireEvent.click(connectButton());
    await act(async () => {});
    expect(row('Beta').getByRole('button', { name: 'Remove' })).toBeEnabled();
    invokeMock.mockResolvedValueOnce(true).mockReturnValueOnce(newRead.promise);
    fireEvent.click(row('Beta').getByRole('button', { name: 'Remove' }));
    confirmRemoval();
    await act(async () => {});
    await act(async () => { newRead.resolve([connected()]); });
    expect(row().getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Beta' })).not.toBeInTheDocument();
    await act(async () => { oldRead.resolve([alpha, beta]); });
    expect(row().getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Beta' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('protects a pending row from creation readback and rejects a contradictory post-write snapshot', async () => {
    await mount();
    const write = deferred<boolean>();
    invokeMock.mockReturnValueOnce(write.promise);
    fireEvent.click(connectButton());
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '+ New channel' }));
    fireEvent.change(screen.getByPlaceholderText('Channel name *'), { target: { value: 'Gamma' } });
    fireEvent.change(screen.getByPlaceholderText('Discord channel ID *'), { target: { value: '456' } });
    const gamma = { ...alpha, id: 'g', name: 'Gamma', config: { channel_id: '456' } };
    invokeMock.mockResolvedValueOnce(gamma).mockResolvedValueOnce([connected(), beta, gamma]).mockResolvedValueOnce([alpha, beta, gamma]);
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    await screen.findByRole('heading', { name: 'Gamma' });
    expect(row().getByRole('button', { name: 'Verifying…' })).toBeDisabled();
    await act(async () => { write.resolve(true); });
    expect(row().getByRole('alert')).toHaveTextContent(/saved.*retry reloads the list only/i);
    invokeMock.mockResolvedValueOnce([connected(), beta, gamma]);
    await act(async () => { fireEvent.click(row().getByRole('button', { name: 'Retry' })); });
    expect(row().getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(writes()).toHaveLength(1);
  });
});
