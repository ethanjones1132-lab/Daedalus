import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DevicesView from './DevicesView';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

type Device = { id: string; name: string; device_type: string; status: string; last_seen: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function device(overrides: Partial<Device> = {}): Device {
  return {
    id: 'device-a',
    name: 'Studio Mac',
    device_type: 'desktop',
    status: 'online',
    last_seen: new Date(Date.now() - 3 * HOUR).toISOString(),
    ...overrides,
  };
}

async function mount(rows: Device[], firstRowName = 'Studio Mac') {
  invokeMock.mockResolvedValueOnce(rows);
  render(<ToastProvider><DevicesView /></ToastProvider>);
  await screen.findByText(firstRowName);
}

const row = (name = 'Studio Mac') => screen.getByText(name).closest('li') as HTMLElement;
const presence = (name = 'Studio Mac') => within(row(name)).getByTestId('device-presence');

beforeEach(() => {
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'get_devices') return Promise.resolve([]);
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

describe('a device paired moments ago is not an online device', () => {
  it('reports the stored status and says no check-in was recorded', async () => {
    await mount([device({ last_seen: new Date(Date.now() - 4_000).toISOString() })]);

    expect(within(row()).getByText('online')).toBeInTheDocument();
    expect(presence()).toHaveTextContent('Not checked in');
    expect(presence()).toHaveTextContent(
      'Stamped 4s ago, and Daedalus only writes that field when a device is paired, so no check-in is recorded.',
    );
  });

  it('never animates a liveness dot for a never-observed record', async () => {
    await mount([device({ last_seen: new Date(Date.now() - 4_000).toISOString() })]);
    expect(row().querySelector('.animate-pulse')).toBeNull();
  });

  it('carries the claim and its basis as the row accessible name, so colour is decoration', async () => {
    await mount([device({ last_seen: new Date(Date.now() - 4_000).toISOString() })]);
    expect(row()).toHaveAttribute('aria-label', expect.stringContaining('Not checked in'));
    expect(row()).toHaveAttribute('aria-label', expect.stringContaining('no check-in is recorded'));
  });
});

describe('a device whose record carries a real check-in still reads as online', () => {
  it('reports the check-in with the age that qualifies it', async () => {
    await mount([device()]);
    expect(presence()).toHaveTextContent('Checked in');
    expect(presence()).toHaveTextContent('Last stamped 3h ago.');
    expect(presence()).toHaveTextContent('Daedalus does not probe devices');
  });

  it('shows the stored timestamp alongside the claim', async () => {
    await mount([device()]);
    const stamp = within(row()).getByTestId('device-stamp');
    expect(stamp).toHaveTextContent('stamped');
    expect(stamp).toHaveTextContent('3h ago');
    expect(stamp).toHaveTextContent(String(new Date(device().last_seen).getFullYear()));
  });

  it('keeps the stored status pill reading as recorded', async () => {
    await mount([device()]);
    expect(within(row()).getByText('online')).toBeInTheDocument();
  });
});

describe('a stamp Daedalus cannot read never reads as a check-in', () => {
  it.each(['', '   ', 'yesterday', 'never'])('reports %p as not verified', async (last_seen) => {
    await mount([device({ last_seen })]);
    expect(presence()).toHaveTextContent('Not verified');
    expect(presence()).toHaveTextContent('a last-seen value Daedalus cannot read');
    expect(within(row()).queryByTestId('device-stamp')).toBeNull();
  });

  it('does not print the unparsable stored value back as a time', async () => {
    await mount([device({ last_seen: 'yesterday' })]);
    expect(within(row()).queryByText(/yesterday/)).toBeNull();
  });
});

describe('a stored status other than online is reported as recorded', () => {
  it('reports a stored offline without claiming a check-in', async () => {
    await mount([device({ status: 'offline' })]);
    expect(presence()).toHaveTextContent('Offline');
    expect(presence()).toHaveTextContent('Stored status "offline"; last stamped 3h ago.');
    expect(within(row()).queryByText('Checked in')).toBeNull();
  });

  it('reads a stored unknown the way the Nodes surface does', async () => {
    await mount([device({ status: 'unknown', last_seen: new Date(Date.now() - 4_000).toISOString() })]);
    expect(presence()).toHaveTextContent('Unknown');
    expect(presence()).toHaveTextContent('no check-in has been recorded');
  });

  it('reports a status Daedalus does not define and makes no liveness claim', async () => {
    await mount([device({ status: 'semi-online' })]);
    expect(within(row()).getByText('semi-online')).toBeInTheDocument();
    expect(presence()).toHaveTextContent('Unrecognised');
    expect(presence()).toHaveTextContent('is not a status Daedalus defines');
    expect(within(row()).queryByText('Checked in')).toBeNull();
  });

  it('refuses a record with no readable status at all', async () => {
    invokeMock.mockReset().mockImplementation((command: string) => {
      if (command === 'get_devices') return Promise.resolve([{ ...device(), status: undefined }]);
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<ToastProvider><DevicesView /></ToastProvider>);
    await screen.findByText('Studio Mac');
    expect(presence()).toHaveTextContent('Not verified');
    expect(presence()).toHaveTextContent('no readable status');
  });
});

describe('one projection decides every row on the surface', () => {
  it('separates a paired device from a checked-in device in the same list', async () => {
    await mount([
      device({ id: 'device-a', name: 'Paired Phone', last_seen: new Date(Date.now() - 2_000).toISOString() }),
      device({ id: 'device-b', name: 'Checked Laptop' }),
    ], 'Paired Phone');
    expect(within(row('Paired Phone')).getByTestId('device-presence')).toHaveTextContent('Not checked in');
    expect(within(row('Checked Laptop')).getByTestId('device-presence')).toHaveTextContent('Checked in');
  });

  it('keeps the existing empty, remove, and section-header vocabulary', async () => {
    await mount([device()]);
    expect(screen.getByRole('heading', { name: /Devices/ })).toBeInTheDocument();
    expect(within(row()).getByRole('button', { name: 'Remove' })).toBeEnabled();
  });
});
