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

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-26T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const stored = {
  id: 'a', name: 'Newsroom', type: 'discord', enabled: true,
  config: { channel_id: '123', connected: true, last_connected: ago(2 * DAY) },
  connected: false, last_used: null,
  created_at: '2026-09-16T00:00:00Z', updated_at: ago(2 * DAY),
};
const loggedOut = { ...stored, config: { channel_id: '123', connected: false, last_connected: ago(2 * DAY) } };
const unreadable = { ...stored, id: 'c', name: 'Unreadable', config: null };
const drifted = { ...stored, id: 'd', name: 'Drifted', config: { channel_id: '123', connected: 'sk-legacy-token' } };
const receipt = {
  message_id: 'm1', channel: 'discord', status: 'delivered' as const, retry_count: 0,
  correlation_id: 'c1', finished_at: '2026-09-16T00:00:00Z',
};
const receiptResponse = () => new Response(JSON.stringify({ receipts: [] }));
const delivered = () => new Response(JSON.stringify({ ok: true, receipt }));
const rejected = () => new Response(JSON.stringify({ ok: false, error: 'discord_secret_unavailable' }), { status: 503 });
const fetchMock = vi.fn();

function row(name = 'Newsroom') {
  return screen.getByRole('heading', { name }).closest('li')!;
}
function claim(name = 'Newsroom') {
  return row(name).querySelector('[data-testid="channel-liveness"]') as HTMLElement | null;
}
function animated(name = 'Newsroom') {
  return row(name).querySelectorAll('.animate-pulse');
}
function sendCalls() {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/channels/discord/send'));
}

async function mount(rows: unknown[]) {
  invokeMock.mockResolvedValueOnce(rows);
  render(<ChannelsView />);
  await screen.findAllByRole('heading');
  await screen.findByText('No delivery receipts yet.');
}

beforeEach(() => {
  invokeMock.mockReset().mockRejectedValue(new Error('Unexpected native call'));
  fetchMock.mockReset().mockImplementation(async (input) => (
    String(input).endsWith('/channels/discord/receipts') ? receiptResponse() : delivered()
  ));
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a channel row reports the basis for its connection claim', () => {
  it('will not present a stored login flag as a live connection', async () => {
    await mount([stored]);
    expect(claim()).toHaveTextContent('Stored as connected');
    expect(claim()).toHaveTextContent('The stored login flag was last set 2d ago. Daedalus only checks a channel when you ask it to.');
    expect(animated()).toHaveLength(0);
    expect(within(row()).queryByText('connected')).not.toBeInTheDocument();
    expect(within(row()).getByRole('button', { name: 'Disconnect' })).toBeEnabled();
  });

  it('reads a confirmed delivery probe as connected, so the positive path is reachable', async () => {
    await mount([loggedOut]);
    fetchMock.mockImplementation(async (input) => (
      String(input).endsWith('/channels/discord/receipts') ? receiptResponse() : delivered()
    ));
    invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce([stored]);
    fireEvent.click(within(row()).getByRole('button', { name: 'Verify & connect' }));
    await act(async () => {});
    await act(async () => {});
    expect(claim()).toHaveTextContent('Connected');
    expect(claim()).toHaveTextContent('A probe confirmed a message reached this channel, so the claim rests on that check.');
    expect(within(row()).getByText('connected')).toBeInTheDocument();
    expect(within(row()).getByText('delivery verified')).toBeInTheDocument();
    expect(animated()).toHaveLength(0);
  });

  it('claims nothing while the probe is still in flight', async () => {
    await mount([loggedOut]);
    const send = deferred<Response>();
    fetchMock.mockImplementation((input) => (
      String(input).endsWith('/channels/discord/receipts') ? Promise.resolve(receiptResponse()) : send.promise
    ));
    fireEvent.click(within(row()).getByRole('button', { name: 'Verify & connect' }));
    expect(claim()).toHaveTextContent('Probing');
    expect(claim()).toHaveTextContent('A probe is in flight, so no connection is claimed until it settles.');
    expect(animated()).toHaveLength(0);
    await act(async () => { send.resolve(delivered()); });
    invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce([stored]);
    await act(async () => {});
    expect(claim()).toHaveTextContent('Connected');
  });

  it('keeps the last confirmation visible and marked stale when a later probe fails', async () => {
    await mount([loggedOut]);
    // The first probe confirms delivery but the Native write is rejected, so the row
    // keeps its confirmation. The retry's probe then fails outright.
    invokeMock.mockResolvedValueOnce(false);
    fireEvent.click(within(row()).getByRole('button', { name: 'Verify & connect' }));
    await act(async () => {});
    expect(claim()).toHaveTextContent('Connected');
    expect(claim()).not.toHaveTextContent('may be stale');
    expect(within(row()).getByRole('alert')).toHaveTextContent(/could not.*confirmed state was kept/i);
    fetchMock.mockImplementation((input) => (
      String(input).endsWith('/channels/discord/receipts') ? receiptResponse() : rejected()
    ));
    fireEvent.click(within(row()).getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(claim()).toHaveTextContent('Connected');
    expect(claim()).toHaveTextContent('An earlier probe confirmed a message reached this channel, but the latest probe did not, so this may be stale.');
    expect(within(row()).getByRole('alert')).toHaveTextContent('Delivery could not be verified. The channel was not connected.');
    expect(within(row()).getByText('delivery verified')).toBeInTheDocument();
    expect(animated()).toHaveLength(0);
  });

  it('names the claims it can make so none of them is the same as a stored flag', async () => {
    await mount([loggedOut, { ...stored, id: 'b', name: 'Operations' }, unreadable, drifted]);
    expect(claim('Newsroom')).toHaveTextContent('Not connected');
    expect(claim('Newsroom')).toHaveTextContent('No stored login flag is set for this channel; the last recorded login was 2d ago.');
    expect(claim('Operations')).toHaveTextContent('Stored as connected');
    expect(claim('Operations')).toHaveTextContent('The stored login flag was last set 2d ago.');
    for (const name of ['Newsroom', 'Operations', 'Unreadable', 'Drifted']) {
      expect(claim(name)).not.toHaveTextContent('Connected. A probe');
      expect(animated(name)).toHaveLength(0);
      const label = claim(name)!.firstElementChild!.textContent!;
      const basis = claim(name)!.lastElementChild!.textContent!;
      expect(row(name).getAttribute('aria-label')).toBe(`${label}. ${basis}`);
    }
  });

  it('claims nothing for a flag it cannot read and keeps the store value off the surface', async () => {
    await mount([unreadable, drifted]);
    expect(claim('Unreadable')).toHaveTextContent('Flag not readable');
    expect(claim('Unreadable')).toHaveTextContent('The stored record carries no login flag Daedalus can read, so no connection is claimed.');
    expect(claim('Drifted')).toHaveTextContent('Flag not readable');
    expect(within(row('Drifted')).queryByText(/sk-legacy-token/)).not.toBeInTheDocument();
    expect(within(row('Drifted')).queryByText('connected')).not.toBeInTheDocument();
    expect(animated('Unreadable')).toHaveLength(0);
    expect(animated('Drifted')).toHaveLength(0);
  });

  it('states what the header connected tally counts', async () => {
    await mount([stored]);
    expect(screen.getByText('1 connected')).toBeInTheDocument();
    expect(screen.getByText(/counts stored login flags/i)).toBeInTheDocument();
  });

  it('keeps the stored flag and its login time out of a store the operator never set', async () => {
    await mount([{ ...stored, config: { channel_id: '123', connected: true, last_connected: 'yesterday' } }]);
    expect(claim()).toHaveTextContent('Stored as connected');
    expect(claim()).toHaveTextContent('The stored login flag is set with no login time Daedalus can read. Daedalus only checks a channel when you ask it to.');
    expect(within(row()).queryByText(/yesterday/)).not.toBeInTheDocument();
  });
});

describe('a channel probe is still a real probe', () => {
  it('still requires a delivered receipt and still reports the request it makes', async () => {
    await mount([loggedOut]);
    fetchMock.mockImplementation((input) => (
      String(input).endsWith('/channels/discord/receipts') ? receiptResponse() : rejected()
    ));
    fireEvent.click(within(row()).getByRole('button', { name: 'Verify & connect' }));
    await act(async () => {});
    expect(sendCalls()).toHaveLength(1);
    const [, init] = sendCalls()[0];
    expect(JSON.parse(String(init?.body))).toEqual({ channel_id: '123', text: 'Jarvis Discord connection check' });
    expect(JSON.stringify(init)).not.toMatch(/token|secret/i);
    expect(invokeMock).not.toHaveBeenCalledWith('login_channel', expect.anything());
    expect(claim()).toHaveTextContent('Not connected');
  });
});
