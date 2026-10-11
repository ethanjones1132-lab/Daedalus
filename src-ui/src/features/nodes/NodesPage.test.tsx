import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../design';
import NodesPage from './NodesPage';

// Ported from the legacy CreationGuard.test.tsx (NodesView blocks) and
// RemovalGuard.test.tsx (NodesView case).

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'get_nodes') return Promise.resolve([]);
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

async function renderIdle(ui: React.ReactNode) {
  render(ui);
  await screen.findByRole('button', { name: /Register|Add/ });
}

describe('add_node refresh boundary', () => {
  it('keeps creation successful when list refresh fails and retries only the list', async () => {
    const creation = deferred<unknown>();
    const refresh = deferred<unknown>();
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_nodes') return ++listCalls === 2 ? refresh.promise : Promise.resolve([]);
      if (command === 'add_node') return creation.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle(<ToastProvider><NodesPage /></ToastProvider>);
    const name = screen.getByPlaceholderText('Node name');
    fireEvent.change(name, { target: { value: 'example' } });
    fireEvent.change(screen.getByPlaceholderText('Address (host:port)'), { target: { value: 'localhost:7000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.queryByText('Added node example')).not.toBeInTheDocument();
    await act(async () => { creation.resolve({ id: 'created' }); });
    expect(screen.getByText('Added node example')).toBeInTheDocument();
    expect(name).toHaveValue('');
    expect(name).toBeDisabled();
    await act(async () => { refresh.reject(new Error('List refresh unavailable')); });
    expect(screen.getByText('Added node example')).toBeInTheDocument();
    expect(screen.queryByText(/Could not (add|register) the/)).not.toBeInTheDocument();
    expect(screen.getByText('Error: List refresh unavailable')).toBeInTheDocument();
    expect(name).toBeEnabled();
    fireEvent.change(name, { target: { value: 'next draft' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_node')).toHaveLength(1);
    expect(listCalls).toBe(3);
    expect(name).toHaveValue('next draft');
  });
});

describe('NodesPage creation guard', () => {
  it('invokes add_node exactly once across click and Enter repetition while pending', async () => {
    const first = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_nodes') return Promise.resolve([]);
      if (command === 'add_node') return first.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle(<NodesPage />);

    fireEvent.change(screen.getByPlaceholderText('Node name'), { target: { value: 'edge-1' } });
    fireEvent.change(screen.getByPlaceholderText('Address (host:port)'), { target: { value: '10.0.0.5:7000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_node')).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_node')[0]).toEqual([
      'add_node',
      { name: 'edge-1', address: '10.0.0.5:7000' },
    ]);
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
    expect(screen.getByPlaceholderText('Node name')).toBeDisabled();
    expect(screen.getByPlaceholderText('Address (host:port)')).toBeDisabled();

    fireEvent.keyDown(screen.getByPlaceholderText('Address (host:port)'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Adding…' }));
    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_node')).toHaveLength(1);

    await act(async () => { first.resolve({ id: 'n1' }); });
    expect(screen.getByPlaceholderText('Node name')).toHaveValue('');
    expect(screen.getByPlaceholderText('Address (host:port)')).toHaveValue('');
  });

  it('retains the draft after a rejected add with retryable feedback', async () => {
    const first = deferred<unknown>();
    const retry = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_nodes') return Promise.resolve([]);
      if (command === 'add_node') return first.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle(<NodesPage />);

    fireEvent.change(screen.getByPlaceholderText('Node name'), { target: { value: 'edge-1' } });
    fireEvent.change(screen.getByPlaceholderText('Address (host:port)'), { target: { value: '10.0.0.5:7000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await act(async () => { first.reject(new Error('boom: connection refused')); });

    expect(screen.getByRole('alert')).toHaveTextContent('Could not add the node');
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Node name')).toHaveValue('edge-1');
    expect(screen.getByPlaceholderText('Address (host:port)')).toHaveValue('10.0.0.5:7000');

    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_nodes') return Promise.resolve([]);
      if (command === 'add_node') return retry.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => { retry.resolve({ id: 'n1' }); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Node name')).toHaveValue('');
  });
});

type Row = { id: string; name: string; [key: string]: unknown };
const nodeAlpha: Row = { id: 'node-a', name: 'Alpha Node', address: 'alpha:7000', status: 'online', latency_ms: 1, last_ping: '', capabilities: [] };
const rows: [Row, Row] = [nodeAlpha, { ...nodeAlpha, id: 'node-b', name: 'Beta Node' }];
const ACTION = 'Remove';

const row = (name: string) => within(screen.getByText(name).closest('li')!);
const writes = () => invokeMock.mock.calls.filter(([command]) => command === 'remove_node');

async function mount(list: Row[] = rows) {
  invokeMock.mockResolvedValueOnce(list);
  render(<ToastProvider><NodesPage /></ToastProvider>);
  await screen.findByText(rows[0].name);
}

function openRemoval(name = rows[0].name) {
  fireEvent.click(row(name).getByRole('button', { name: ACTION }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: ACTION }));
  return dialog;
}

describe('NodesPage removal coordination', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockRejectedValue(new Error('Unexpected native call'));
  });

  it('holds confirmation, blocks repeated confirmation, and keeps other ids usable', async () => {
    await mount();
    const write = deferred<boolean>();
    const read = deferred<Row[]>();
    invokeMock.mockReturnValueOnce(write.promise).mockReturnValueOnce(read.promise);

    const dialog = openRemoval();
    expect(writes()).toEqual([['remove_node', { id: rows[0].id }]]);
    expect(dialog).toHaveTextContent(/saving removal/i);
    expect(row(rows[0].name).getByRole('button', { name: ACTION })).toBeDisabled();
    expect(row(rows[0].name).getByRole('status')).toHaveTextContent(/saving removal/i);
    expect(row(rows[1].name).getByRole('button', { name: ACTION })).toBeEnabled();

    fireEvent.click(within(dialog).getAllByRole('button')[1]);
    expect(writes()).toHaveLength(1);

    await act(async () => { write.resolve(true); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/Removed Alpha Node/i)).toBeInTheDocument();
    expect(row(rows[0].name).getByRole('button', { name: ACTION })).toBeDisabled();
    expect(row(rows[0].name).getByRole('status')).toHaveTextContent(/reconciling/i);

    await act(async () => { read.resolve([rows[1]]); });
    expect(screen.queryByText(rows[0].name)).not.toBeInTheDocument();
    expect(writes()).toHaveLength(1);
  });

  it.each(['false', 'rejected'] as const)('retains the row after a %s write and requires confirmation to retry', async (settlement) => {
    await mount();
    const write = deferred<boolean>();
    invokeMock.mockReturnValueOnce(write.promise);
    openRemoval();
    await act(async () => {
      if (settlement === 'false') write.resolve(false);
      else write.reject(new Error('synthetic private native detail'));
    });

    expect(screen.getByText(rows[0].name)).toBeInTheDocument();
    const alert = row(rows[0].name).getByRole('alert');
    expect(alert).toHaveTextContent(/Could not remove the node/i);
    expect(alert).toHaveTextContent(/confirmed state was kept/i);
    expect(screen.queryByText(/synthetic private native detail/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unexpected native call/i)).not.toBeInTheDocument();
    expect(row(rows[0].name).getByRole('button', { name: ACTION })).toBeEnabled();

    const retryWrite = deferred<boolean>();
    const retryRead = deferred<Row[]>();
    invokeMock.mockReturnValueOnce(retryWrite.promise).mockReturnValueOnce(retryRead.promise);
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: ACTION }));
    fireEvent.click(within(dialog).getAllByRole('button')[1]);
    expect(writes()).toHaveLength(2);
    expect(row(rows[0].name).getByRole('status')).toHaveTextContent(/saving removal/i);

    await act(async () => { retryWrite.resolve(true); });
    await act(async () => { retryRead.resolve([rows[1]]); });
    expect(screen.queryByText(rows[0].name)).not.toBeInTheDocument();
    expect(writes()).toHaveLength(2);
  });

  it('retains an explicitly stale row after readback failure and retries only the list', async () => {
    await mount();
    const write = deferred<boolean>();
    const read = deferred<Row[]>();
    invokeMock.mockReturnValueOnce(write.promise).mockReturnValueOnce(read.promise);
    openRemoval();

    await act(async () => { write.resolve(true); });
    expect(row(rows[0].name).getByRole('status')).toHaveTextContent(/reconciling/i);
    await act(async () => { read.reject(new Error('synthetic private readback detail')); });

    expect(screen.getByText(rows[0].name)).toBeInTheDocument();
    const alert = row(rows[0].name).getByRole('alert');
    expect(alert).toHaveTextContent(/saved.*retry reloads the list only/i);
    expect(screen.queryByText(/synthetic private readback detail/i)).not.toBeInTheDocument();
    expect(row(rows[0].name).getByRole('button', { name: ACTION })).toBeDisabled();

    const retryRead = deferred<Row[]>();
    invokeMock.mockReturnValueOnce(retryRead.promise);
    const retry = within(alert).getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(invokeMock.mock.calls.filter(([command]) => command === 'get_nodes')).toHaveLength(3);
    expect(writes()).toHaveLength(1);

    await act(async () => { retryRead.resolve([]); });
    expect(screen.queryByText(rows[0].name)).not.toBeInTheDocument();
    expect(writes()).toHaveLength(1);
  });

  it('keeps independent removals usable and ignores an obsolete list completion', async () => {
    await mount();
    const firstWrite = deferred<boolean>();
    const firstRead = deferred<Row[]>();
    invokeMock.mockReturnValueOnce(firstWrite.promise).mockReturnValueOnce(firstRead.promise);
    openRemoval(rows[0].name);
    await act(async () => { firstWrite.resolve(true); });

    const secondWrite = deferred<boolean>();
    const secondRead = deferred<Row[]>();
    invokeMock.mockReturnValueOnce(secondWrite.promise).mockReturnValueOnce(secondRead.promise);
    expect(row(rows[1].name).getByRole('button', { name: ACTION })).toBeEnabled();
    openRemoval(rows[1].name);

    await act(async () => { secondWrite.resolve(true); });
    await act(async () => { secondRead.resolve([]); });
    expect(screen.queryByText(rows[0].name)).not.toBeInTheDocument();
    expect(screen.queryByText(rows[1].name)).not.toBeInTheDocument();

    await act(async () => { firstRead.resolve(rows); });
    expect(screen.queryByText(rows[0].name)).not.toBeInTheDocument();
    expect(screen.queryByText(rows[1].name)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(writes()).toEqual([
      ['remove_node', { id: rows[0].id }],
      ['remove_node', { id: rows[1].id }],
    ]);
  });
});

describe('NodesPage honest status', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockRejectedValue(new Error('Unexpected native call'));
  });

  it('renders unprobed nodes as not pinged / not measured rather than as numbers', async () => {
    invokeMock.mockResolvedValueOnce([
      { id: 'n-u', name: 'Unprobed', address: 'a:1', status: 'unknown', latency_ms: null, last_ping: '', capabilities: [] },
      { id: 'n-o', name: 'Probed', address: 'b:2', status: 'online', latency_ms: 12, last_ping: '', capabilities: ['gpu'] },
    ]);
    render(<ToastProvider><NodesPage /></ToastProvider>);
    await screen.findByText('Unprobed');
    const unprobed = within(screen.getByText('Unprobed').closest('li')!);
    expect(unprobed.getByText('not pinged')).toBeInTheDocument();
    expect(unprobed.getByText('not measured')).toBeInTheDocument();
    expect(unprobed.queryByText(/ms$/)).not.toBeInTheDocument();
    const probed = within(screen.getByText('Probed').closest('li')!);
    expect(probed.getByText('12ms')).toBeInTheDocument();
    expect(probed.getByText('gpu')).toBeInTheDocument();
  });
});
