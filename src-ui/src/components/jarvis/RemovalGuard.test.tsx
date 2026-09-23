import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
import DevicesView from './DevicesView';
import HooksView from './HooksView';
import NodesView from './NodesView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Row = { id: string; name: string; [key: string]: unknown };

type RemovalCase = {
  title: string;
  View: ComponentType;
  list: string;
  remove: string;
  action: string;
  failure: RegExp;
  success: RegExp;
  rows: [Row, Row];
};

const hookAlpha: Row = {
  id: 'hook-a', name: 'Alpha Hook', event: 'session.start', script: '', enabled: true, created_at: '',
};
const nodeAlpha: Row = {
  id: 'node-a', name: 'Alpha Node', address: 'alpha:7000', status: 'online', latency_ms: 1,
  last_ping: '', capabilities: [],
};
const deviceAlpha: Row = {
  id: 'device-a', name: 'Alpha Device', device_type: 'desktop', status: 'online', last_seen: '',
};

const cases: RemovalCase[] = [
  {
    title: 'HooksView', View: HooksView, list: 'get_hooks', remove: 'unregister_hook', action: 'Unregister',
    failure: /Could not unregister the hook/i, success: /Unregistered Alpha Hook/i,
    rows: [hookAlpha, { ...hookAlpha, id: 'hook-b', name: 'Beta Hook' }],
  },
  {
    title: 'NodesView', View: NodesView, list: 'get_nodes', remove: 'remove_node', action: 'Remove',
    failure: /Could not remove the node/i, success: /Removed Alpha Node/i,
    rows: [nodeAlpha, { ...nodeAlpha, id: 'node-b', name: 'Beta Node' }],
  },
  {
    title: 'DevicesView', View: DevicesView, list: 'get_devices', remove: 'remove_device', action: 'Remove',
    failure: /Could not remove the device/i, success: /Removed Alpha Device/i,
    rows: [deviceAlpha, { ...deviceAlpha, id: 'device-b', name: 'Beta Device' }],
  },
];

const row = (name: string) => within(screen.getByText(name).closest('li')!);
const writes = (config: RemovalCase) => invokeMock.mock.calls.filter(([command]) => command === config.remove);

async function mount(config: RemovalCase, rows: Row[] = config.rows) {
  invokeMock.mockResolvedValueOnce(rows);
  render(<ToastProvider><config.View /></ToastProvider>);
  await screen.findByText(config.rows[0].name);
}

function openRemoval(config: RemovalCase, name = config.rows[0].name) {
  fireEvent.click(row(name).getByRole('button', { name: config.action }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: config.action }));
  return dialog;
}

beforeEach(() => {
  invokeMock.mockReset().mockRejectedValue(new Error('Unexpected native call'));
});
afterEach(cleanup);

describe.each(cases)('$title removal coordination', (config) => {
  it('holds confirmation, blocks repeated confirmation, and keeps other ids usable', async () => {
    await mount(config);
    const write = deferred<boolean>();
    const read = deferred<Row[]>();
    invokeMock.mockReturnValueOnce(write.promise).mockReturnValueOnce(read.promise);

    const dialog = openRemoval(config);
    expect(writes(config)).toEqual([[config.remove, { id: config.rows[0].id }]]);
    expect(dialog).toHaveTextContent(/saving removal/i);
    expect(row(config.rows[0].name).getByRole('button', { name: config.action })).toBeDisabled();
    expect(row(config.rows[0].name).getByRole('status')).toHaveTextContent(/saving removal/i);
    expect(row(config.rows[1].name).getByRole('button', { name: config.action })).toBeEnabled();

    fireEvent.click(within(dialog).getAllByRole('button')[1]);
    expect(writes(config)).toHaveLength(1);

    await act(async () => { write.resolve(true); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(config.success)).toBeInTheDocument();
    expect(row(config.rows[0].name).getByRole('button', { name: config.action })).toBeDisabled();
    expect(row(config.rows[0].name).getByRole('status')).toHaveTextContent(/reconciling/i);

    await act(async () => { read.resolve([config.rows[1]]); });
    expect(screen.queryByText(config.rows[0].name)).not.toBeInTheDocument();
    expect(writes(config)).toHaveLength(1);
  });

  it.each(['false', 'rejected'] as const)('retains the row after a %s write and requires confirmation to retry', async (settlement) => {
    await mount(config);
    const write = deferred<boolean>();
    invokeMock.mockReturnValueOnce(write.promise);
    openRemoval(config);
    await act(async () => {
      if (settlement === 'false') write.resolve(false);
      else write.reject(new Error('synthetic private native detail'));
    });

    expect(screen.getByText(config.rows[0].name)).toBeInTheDocument();
    const alert = row(config.rows[0].name).getByRole('alert');
    expect(alert).toHaveTextContent(config.failure);
    expect(alert).toHaveTextContent(/confirmed state was kept/i);
    expect(screen.queryByText(/synthetic private native detail/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unexpected native call/i)).not.toBeInTheDocument();
    expect(row(config.rows[0].name).getByRole('button', { name: config.action })).toBeEnabled();

    const retryWrite = deferred<boolean>();
    const retryRead = deferred<Row[]>();
    invokeMock.mockReturnValueOnce(retryWrite.promise).mockReturnValueOnce(retryRead.promise);
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: config.action }));
    fireEvent.click(within(dialog).getAllByRole('button')[1]);
    expect(writes(config)).toHaveLength(2);
    expect(row(config.rows[0].name).getByRole('status')).toHaveTextContent(/saving removal/i);

    await act(async () => { retryWrite.resolve(true); });
    await act(async () => { retryRead.resolve([config.rows[1]]); });
    expect(screen.queryByText(config.rows[0].name)).not.toBeInTheDocument();
    expect(writes(config)).toHaveLength(2);
  });

  it('retains an explicitly stale row after readback failure and retries only the list', async () => {
    await mount(config);
    const write = deferred<boolean>();
    const read = deferred<Row[]>();
    invokeMock.mockReturnValueOnce(write.promise).mockReturnValueOnce(read.promise);
    openRemoval(config);

    await act(async () => { write.resolve(true); });
    expect(row(config.rows[0].name).getByRole('status')).toHaveTextContent(/reconciling/i);
    await act(async () => { read.reject(new Error('synthetic private readback detail')); });

    expect(screen.getByText(config.rows[0].name)).toBeInTheDocument();
    const alert = row(config.rows[0].name).getByRole('alert');
    expect(alert).toHaveTextContent(/saved.*retry reloads the list only/i);
    expect(screen.queryByText(/synthetic private readback detail/i)).not.toBeInTheDocument();
    expect(row(config.rows[0].name).getByRole('button', { name: config.action })).toBeDisabled();

    const retryRead = deferred<Row[]>();
    invokeMock.mockReturnValueOnce(retryRead.promise);
    const retry = within(alert).getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(invokeMock.mock.calls.filter(([command]) => command === config.list)).toHaveLength(3);
    expect(writes(config)).toHaveLength(1);

    await act(async () => { retryRead.resolve([]); });
    expect(screen.queryByText(config.rows[0].name)).not.toBeInTheDocument();
    expect(writes(config)).toHaveLength(1);
  });

  it('keeps independent removals usable and ignores an obsolete list completion', async () => {
    await mount(config);
    const firstWrite = deferred<boolean>();
    const firstRead = deferred<Row[]>();
    invokeMock.mockReturnValueOnce(firstWrite.promise).mockReturnValueOnce(firstRead.promise);
    openRemoval(config, config.rows[0].name);
    await act(async () => { firstWrite.resolve(true); });

    const secondWrite = deferred<boolean>();
    const secondRead = deferred<Row[]>();
    invokeMock.mockReturnValueOnce(secondWrite.promise).mockReturnValueOnce(secondRead.promise);
    expect(row(config.rows[1].name).getByRole('button', { name: config.action })).toBeEnabled();
    openRemoval(config, config.rows[1].name);

    await act(async () => { secondWrite.resolve(true); });
    await act(async () => { secondRead.resolve([]); });
    expect(screen.queryByText(config.rows[0].name)).not.toBeInTheDocument();
    expect(screen.queryByText(config.rows[1].name)).not.toBeInTheDocument();

    await act(async () => { firstRead.resolve(config.rows); });
    expect(screen.queryByText(config.rows[0].name)).not.toBeInTheDocument();
    expect(screen.queryByText(config.rows[1].name)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(writes(config)).toEqual([
      [config.remove, { id: config.rows[0].id }],
      [config.remove, { id: config.rows[1].id }],
    ]);
  });
});

it('does not let an older creation readback resurrect a removed hook', async () => {
  const config = cases[0];
  const created: Row = { ...hookAlpha, id: 'hook-created', name: 'Created Hook' };
  await mount(config, [hookAlpha]);
  const creationRead = deferred<Row[]>();
  invokeMock.mockResolvedValueOnce(created).mockReturnValueOnce(creationRead.promise);
  fireEvent.change(screen.getByPlaceholderText('Hook name'), { target: { value: created.name } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Register' })); });
  expect(invokeMock.mock.calls.filter(([command]) => command === 'get_hooks')).toHaveLength(2);

  invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce([created]);
  openRemoval(config);
  await act(async () => {});
  expect(screen.queryByText(hookAlpha.name)).not.toBeInTheDocument();
  expect(screen.getByText(created.name)).toBeInTheDocument();

  await act(async () => { creationRead.resolve([hookAlpha, created]); });
  expect(screen.queryByText(hookAlpha.name)).not.toBeInTheDocument();
  expect(screen.getByText(created.name)).toBeInTheDocument();
  expect(writes(config)).toEqual([[config.remove, { id: hookAlpha.id }]]);
});
