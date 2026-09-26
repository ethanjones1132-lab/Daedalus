import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import GatewayView from './GatewayView';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const FIXED = Date.parse('2026-09-26T12:00:00Z');

const observation = {
  running: true,
  port: 19876,
  active_connections: 0,
  uptime_seconds: 0,
  version: '1.4.2',
  timestamp: new Date(FIXED - 4000).toISOString(),
};

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let request: ReturnType<typeof deferred>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED);
  request = deferred();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(() => request.promise);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const mount = async () => {
  await act(async () => {
    render(<GatewayView />);
  });
};

const settle = async (value: unknown) => {
  await act(async () => {
    request.resolve(value);
  });
};

const fail = async () => {
  await act(async () => {
    request.reject(new Error('synthetic private native detail'));
  });
};

const tile = (label: string): HTMLElement => {
  const element = screen.getByText(label).parentElement;
  if (!element) throw new Error(`no tile for ${label}`);
  return element;
};

describe('gateway claim delivery', () => {
  it('renders a confirmed probe as running with the port it checked and the age of the reading', async () => {
    await mount();
    await settle({ ...observation });

    expect(screen.getByText('Gateway is running')).toBeInTheDocument();
    expect(screen.getByText('online')).toBeInTheDocument();
    expect(screen.getByText('A listener answered on port 19876, 4s ago.')).toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls).toEqual([['get_gateway_status']]);
  });

  it('renders a probe that found nothing as stopped, still with its basis', async () => {
    await mount();
    await settle({ ...observation, running: false });

    expect(screen.getByText('Gateway is stopped')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.getByText('Nothing was listening on port 19876, 4s ago.')).toBeInTheDocument();
  });

  it('does not animate a reading that is four seconds old as live', async () => {
    await mount();
    await settle({ ...observation });

    expect(document.querySelector('.animate-pulse')).toBeNull();
  });

  it('makes no liveness claim from a running state Daedalus cannot read', async () => {
    await mount();
    await settle({ ...observation, running: 'listening' });

    expect(screen.getByText('Gateway state not readable')).toBeInTheDocument();
    expect(screen.getByText('not readable')).toBeInTheDocument();
    expect(screen.queryByText(/Gateway is/)).not.toBeInTheDocument();
    expect(screen.getByText('The gateway read returned no running state Daedalus can read, so no liveness claim is made.')).toBeInTheDocument();
  });

  it('survives a read that returns something other than a status record', async () => {
    await mount();
    await settle('native private detail');

    expect(screen.getByText('Gateway state not readable')).toBeInTheDocument();
    expect(screen.getByText('The gateway read returned something that is not a gateway status, so no liveness claim is made.')).toBeInTheDocument();
    expect(within(tile('Port')).getByText('Not readable')).toBeInTheDocument();
    expect(within(tile('Version')).getByText('Not readable')).toBeInTheDocument();
    expect(screen.getAllByText('Not measured')).toHaveLength(2);
  });
});

describe('gateway metric honesty', () => {
  it('keeps the four tiles, their labels, and their order', async () => {
    await mount();
    await settle({ ...observation });

    const labels = screen.getAllByText(/^(Port|Connections|Uptime|Version)$/).map((el) => el.textContent);
    expect(labels).toEqual(['Port', 'Connections', 'Uptime', 'Version']);
  });

  it('prints no connection count, even the zero the record carries', async () => {
    await mount();
    await settle({ ...observation });

    const connections = tile('Connections');
    expect(within(connections).getByText('Not measured')).toBeInTheDocument();
    expect(within(connections).queryByText('0')).not.toBeInTheDocument();
    expect(within(connections).getByText('This build reports a fixed zero here instead of counting connections to this port.')).toBeInTheDocument();
  });

  it('prints no uptime, even a real-looking one the record carries', async () => {
    await mount();
    await settle({ ...observation, uptime_seconds: 3661, active_connections: 3 });

    const uptime = tile('Uptime');
    expect(within(uptime).getByText('Not measured')).toBeInTheDocument();
    expect(within(uptime).queryByText('1h 1m')).not.toBeInTheDocument();
    expect(within(uptime).queryByText('3661')).not.toBeInTheDocument();
    expect(within(uptime).getByText('This build reports a fixed zero here instead of tracking how long the port has been open.')).toBeInTheDocument();

    const connections = tile('Connections');
    expect(within(connections).getByText('Not measured')).toBeInTheDocument();
    expect(within(connections).queryByText('3')).not.toBeInTheDocument();
  });

  it('names the port as the one Daedalus checks, not a detected one', async () => {
    await mount();
    await settle({ ...observation });

    const port = tile('Port');
    expect(within(port).getByText('19876')).toBeInTheDocument();
    expect(within(port).getByText('The port Daedalus checks, not one it detects.')).toBeInTheDocument();
  });

  it('still reports the build version the record carries', async () => {
    await mount();
    await settle({ ...observation });

    const version = tile('Version');
    expect(within(version).getByText('1.4.2')).toBeInTheDocument();
    expect(within(version).getByText('The version of this Daedalus build, not a reading from the port.')).toBeInTheDocument();
  });

  it('reads a port Daedalus cannot use as not readable rather than printing it', async () => {
    await mount();
    await settle({ ...observation, port: '19876' });

    const port = tile('Port');
    expect(within(port).getByText('Not readable')).toBeInTheDocument();
    expect(within(port).getByText('The status record carries no port Daedalus can read.')).toBeInTheDocument();
    expect(screen.getByText('A listener answered on the port Daedalus checks, 4s ago.')).toBeInTheDocument();
  });
});

describe('gateway read states are unchanged', () => {
  it('shows the pending read before any observation and no tiles', async () => {
    await mount();

    expect(screen.getByRole('status', { name: 'Gateway observation' })).toHaveTextContent('Checking gateway');
    expect(screen.queryByText('Not measured')).not.toBeInTheDocument();
    expect(screen.queryByText('19876')).not.toBeInTheDocument();
  });

  it('still announces a failed read and offers a retry', async () => {
    await mount();
    await fail();

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load gateway status.');
    expect(screen.queryByText(/synthetic private native detail/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(screen.queryByText('Not measured')).not.toBeInTheDocument();
  });
});
