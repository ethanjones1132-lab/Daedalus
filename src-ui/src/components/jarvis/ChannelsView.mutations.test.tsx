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
  id: 'a', name: 'Alpha', type: 'webhook', enabled: true, config: { connected: false },
  connected: false, last_used: null, created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z',
};
const beta = { ...alpha, id: 'b', name: 'Beta' };
const connected = (row = alpha) => ({ ...row, config: { connected: true } });
const row = (name = 'Alpha') => within(screen.getByRole('heading', { name }).closest('li')!);
const writes = () => invokeMock.mock.calls.filter(([cmd]) => ['login_channel', 'logout_channel', 'remove_channel'].includes(cmd));
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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"receipts":[]}')));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Channel row mutation coordination', () => {
  it('guards repeated connection and already-open removal confirmation through readback', async () => {
    await mount();
    const write = deferred<boolean>();
    const read = deferred<typeof alpha[]>();
    invokeMock.mockReturnValueOnce(write.promise).mockReturnValueOnce(read.promise);
    fireEvent.click(row().getByRole('button', { name: 'Remove' }));
    const connect = row().getByRole('button', { name: 'Connect' });
    fireEvent.click(connect);
    fireEvent.click(connect);
    confirmRemoval();
    expect(writes()).toEqual([['login_channel', { id: 'a' }]]);
    expect(connect).toBeDisabled();
    expect(row().getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(row().getByRole('status')).toHaveTextContent(/saving/i);
    expect(screen.getByText('0 connected')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await act(async () => { write.resolve(true); });
    expect(row().getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(screen.getByText('0 connected')).toBeInTheDocument();
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
    } else fireEvent.click(row().getByRole('button', { name: command === 'login_channel' ? 'Connect' : 'Disconnect' }));
    await act(async () => {});
    expect(row().getByRole('alert')).toHaveTextContent(/could not.*confirmed state was kept/i);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    const retry = deferred<boolean>();
    invokeMock.mockReturnValueOnce(retry.promise);
    fireEvent.click(row().getByRole('button', { name: 'Retry' }));
    if (command === 'remove_channel') confirmRemoval();
    await act(async () => { retry.reject(new Error('synthetic private native detail')); });
    expect(row().getByRole('alert')).toHaveTextContent(/could not/i);
    expect(screen.queryByText(/synthetic private/)).not.toBeInTheDocument();
    expect(writes()).toEqual([[command, { id: 'a' }], [command, { id: 'a' }]]);
    expect(row().getByRole('button', { name: command === 'logout_channel' ? 'Disconnect' : 'Connect' })).toBeEnabled();
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
    fireEvent.click(row().getByRole('button', { name: 'Connect' }));
    expect(writes()).toEqual([['remove_channel', { id: 'a' }]]);
    await act(async () => { write.resolve(true); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(row().getByRole('button', { name: 'Remove' })).toBeDisabled();
    await act(async () => { read.reject(new Error('synthetic private read detail')); });
    expect(row().getByRole('alert')).toHaveTextContent(/saved.*retry reloads the list only/i);
    expect(screen.queryByText(/synthetic private/)).not.toBeInTheDocument();
    const retry = deferred<typeof alpha[]>();
    invokeMock.mockReturnValueOnce(retry.promise);
    const button = row().getByRole('button', { name: 'Retry' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(invokeMock).toHaveBeenCalledTimes(4);
    await act(async () => { retry.resolve([beta]); });
    expect(screen.queryByRole('heading', { name: 'Alpha' })).not.toBeInTheDocument();
    expect(writes()).toHaveLength(1);
  });

  it.each(['resolve', 'reject'] as const)('keeps independent writes usable and ignores an obsolete read %s', async (settlement) => {
    await mount();
    const oldRead = deferred<typeof alpha[]>();
    const newRead = deferred<typeof alpha[]>();
    invokeMock.mockResolvedValueOnce(true).mockReturnValueOnce(oldRead.promise);
    fireEvent.click(row().getByRole('button', { name: 'Connect' }));
    await act(async () => {});
    expect(row('Beta').getByRole('button', { name: 'Remove' })).toBeEnabled();
    invokeMock.mockResolvedValueOnce(true).mockReturnValueOnce(newRead.promise);
    fireEvent.click(row('Beta').getByRole('button', { name: 'Remove' }));
    confirmRemoval();
    await act(async () => {});
    await act(async () => { newRead.resolve([connected()]); });
    expect(row().getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Beta' })).not.toBeInTheDocument();
    await act(async () => {
      if (settlement === 'resolve') oldRead.resolve([alpha, beta]);
      else oldRead.reject(new Error('obsolete failure'));
    });
    expect(row().getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Beta' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('protects a pending row from creation readback and rejects contradictory post-write snapshots', async () => {
    await mount();
    const write = deferred<boolean>();
    invokeMock.mockReturnValueOnce(write.promise);
    fireEvent.click(row().getByRole('button', { name: 'Connect' }));
    fireEvent.click(screen.getByRole('button', { name: '+ New channel' }));
    fireEvent.change(screen.getByPlaceholderText('Channel name *'), { target: { value: 'Gamma' } });
    const gamma = { ...alpha, id: 'g', name: 'Gamma' };
    invokeMock.mockResolvedValueOnce(gamma).mockResolvedValueOnce([connected(), beta, gamma]);
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    await screen.findByRole('heading', { name: 'Gamma' });
    expect(row().getByRole('button', { name: 'Connect' })).toBeDisabled();
    invokeMock.mockResolvedValueOnce([alpha, beta, gamma]);
    await act(async () => { write.resolve(true); });
    expect(row().getByRole('alert')).toHaveTextContent(/saved.*retry reloads the list only/i);
    expect(row().getByRole('button', { name: 'Connect' })).toBeDisabled();
    invokeMock.mockResolvedValueOnce([connected(), beta, gamma]);
    fireEvent.click(row().getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(row().getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(writes()).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
