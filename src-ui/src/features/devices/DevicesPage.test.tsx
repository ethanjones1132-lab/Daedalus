import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../design';
import DevicesPage from './DevicesPage';

// Ported from the legacy CreationGuard.test.tsx (DevicesView blocks) and
// RemovalGuard.test.tsx (DevicesView case).

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
    if (command === 'get_devices') return Promise.resolve([]);
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

async function renderIdle(ui: React.ReactNode) {
  render(ui);
  await screen.findByRole('button', { name: /Register|Add/ });
}

describe('add_device refresh boundary', () => {
  it('keeps creation successful when list refresh fails and retries only the list', async () => {
    const creation = deferred<unknown>();
    const refresh = deferred<unknown>();
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_devices') return ++listCalls === 2 ? refresh.promise : Promise.resolve([]);
      if (command === 'add_device') return creation.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle(<ToastProvider><DevicesPage /></ToastProvider>);
    const name = screen.getByPlaceholderText('Device name');
    fireEvent.change(name, { target: { value: 'example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.queryByText('Added device example')).not.toBeInTheDocument();
    await act(async () => { creation.resolve({ id: 'created' }); });
    expect(screen.getByText('Added device example')).toBeInTheDocument();
    expect(name).toHaveValue('');
    expect(name).toBeDisabled();
    await act(async () => { refresh.reject(new Error('List refresh unavailable')); });
    expect(screen.getByText('Added device example')).toBeInTheDocument();
    expect(screen.queryByText(/Could not (add|register) the/)).not.toBeInTheDocument();
    expect(screen.getByText('Error: List refresh unavailable')).toBeInTheDocument();
    expect(name).toBeEnabled();
    fireEvent.change(name, { target: { value: 'next draft' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_device')).toHaveLength(1);
    expect(listCalls).toBe(3);
    expect(name).toHaveValue('next draft');
  });
});

describe('DevicesPage creation guard', () => {
  it('invokes add_device exactly once across click and Enter repetition while pending', async () => {
    const first = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_devices') return Promise.resolve([]);
      if (command === 'add_device') return first.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle(<DevicesPage />);

    fireEvent.change(screen.getByPlaceholderText('Device name'), { target: { value: 'studio-mac' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_device')).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_device')[0]).toEqual([
      'add_device',
      { name: 'studio-mac', deviceType: 'desktop' },
    ]);
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
    expect(screen.getByPlaceholderText('Device name')).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();

    fireEvent.keyDown(screen.getByPlaceholderText('Device name'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Adding…' }));
    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_device')).toHaveLength(1);

    await act(async () => { first.resolve({ id: 'd1' }); });
    expect(screen.getByPlaceholderText('Device name')).toHaveValue('');
  });

  it('retains the draft after a rejected add with retryable feedback', async () => {
    const first = deferred<unknown>();
    const retry = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_devices') return Promise.resolve([]);
      if (command === 'add_device') return first.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle(<DevicesPage />);

    fireEvent.change(screen.getByPlaceholderText('Device name'), { target: { value: 'studio-mac' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await act(async () => { first.reject(new Error('boom: pairing failed')); });

    expect(screen.getByRole('alert')).toHaveTextContent('Could not add the device');
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Device name')).toHaveValue('studio-mac');

    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_devices') return Promise.resolve([]);
      if (command === 'add_device') return retry.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => { retry.resolve({ id: 'd1' }); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Device name')).toHaveValue('');
  });
});

type Row = { id: string; name: string; [key: string]: unknown };
const deviceAlpha: Row = { id: 'device-a', name: 'Alpha Device', device_type: 'desktop', status: 'online', last_seen: '' };
const rows: [Row, Row] = [deviceAlpha, { ...deviceAlpha, id: 'device-b', name: 'Beta Device' }];
const ACTION = 'Remove';

const row = (name: string) => within(screen.getByText(name).closest('li')!);
const writes = () => invokeMock.mock.calls.filter(([command]) => command === 'remove_device');

async function mount(list: Row[] = rows) {
  invokeMock.mockResolvedValueOnce(list);
  render(<ToastProvider><DevicesPage /></ToastProvider>);
  await screen.findByText(rows[0].name);
}

function openRemoval(name = rows[0].name) {
  fireEvent.click(row(name).getByRole('button', { name: ACTION }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: ACTION }));
  return dialog;
}

describe('DevicesPage removal coordination', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockRejectedValue(new Error('Unexpected native call'));
  });

  it('holds confirmation, blocks repeated confirmation, and keeps other ids usable', async () => {
    await mount();
    const write = deferred<boolean>();
    const read = deferred<Row[]>();
    invokeMock.mockReturnValueOnce(write.promise).mockReturnValueOnce(read.promise);

    const dialog = openRemoval();
    expect(writes()).toEqual([['remove_device', { id: rows[0].id }]]);
    expect(dialog).toHaveTextContent(/saving removal/i);
    expect(row(rows[0].name).getByRole('button', { name: ACTION })).toBeDisabled();
    expect(row(rows[0].name).getByRole('status')).toHaveTextContent(/saving removal/i);
    expect(row(rows[1].name).getByRole('button', { name: ACTION })).toBeEnabled();

    fireEvent.click(within(dialog).getAllByRole('button')[1]);
    expect(writes()).toHaveLength(1);

    await act(async () => { write.resolve(true); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/Removed Alpha Device/i)).toBeInTheDocument();
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
    expect(alert).toHaveTextContent(/Could not remove the device/i);
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
    expect(invokeMock.mock.calls.filter(([command]) => command === 'get_devices')).toHaveLength(3);
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
      ['remove_device', { id: rows[0].id }],
      ['remove_device', { id: rows[1].id }],
    ]);
  });
});

describe('DevicesPage honest status', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockRejectedValue(new Error('Unexpected native call'));
  });

  it('presents status and last-seen as recorded values, with a fallback when none was recorded', async () => {
    invokeMock.mockResolvedValueOnce([
      { id: 'd1', name: 'Studio Mac', device_type: 'desktop', status: 'online', last_seen: '' },
    ]);
    render(<ToastProvider><DevicesPage /></ToastProvider>);
    await screen.findByText('Studio Mac');
    const device = within(screen.getByText('Studio Mac').closest('li')!);
    expect(device.getByText('not recorded')).toBeInTheDocument();
    expect(screen.getByText(/not live signals/)).toBeInTheDocument();
  });
});
