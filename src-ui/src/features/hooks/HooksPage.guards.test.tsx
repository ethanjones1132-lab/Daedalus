import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../design';
import HooksPage from './HooksPage';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}


async function renderIdle(ui: React.ReactNode) {
  render(ui);
  await screen.findByRole('button', { name: /Register/ });
}

describe('register_hook refresh boundary', () => {
  const list = 'get_hooks';
  const create = 'register_hook';
  const field = 'Hook name';
  const button = 'Register';
  const success = 'Registered hook example';
  it('keeps creation unconfirmed when list refresh fails and retries only the list', async () => {
    const creation = deferred<unknown>();
    const refresh = deferred<unknown>();
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === list) return ++listCalls === 2 ? refresh.promise : Promise.resolve([]);
      if (command === create) return creation.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle(<ToastProvider><HooksPage /></ToastProvider>);
    const name = screen.getByPlaceholderText(field);
    fireEvent.change(name, { target: { value: 'example' } });
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(screen.queryByText(success)).not.toBeInTheDocument();
    await act(async () => { creation.resolve({ id: 'created' }); });
    expect(screen.queryByText(success)).not.toBeInTheDocument();
    expect(name).toHaveValue('example');
    expect(name).toBeDisabled();
    await act(async () => { refresh.reject(new Error('List refresh unavailable')); });
    expect(screen.queryByText(success)).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not (add|register) the/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('alert').map(node => node.textContent).join(' ')).toContain('the hook list could not be read back');
    expect(screen.queryByText('List refresh unavailable')).not.toBeInTheDocument();
    expect(name).toBeEnabled();
    fireEvent.change(name, { target: { value: 'next draft' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(invokeMock.mock.calls.filter(([c]) => c === create)).toHaveLength(1);
    expect(listCalls).toBe(3);
    expect(name).toHaveValue('next draft');
  });
});

describe('HooksPage creation guard', () => {
  it('invokes register_hook exactly once across click and Enter repetition while pending', async () => {
    const store: unknown[] = [];
    const first = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_hooks') return Promise.resolve([...store]);
      if (command === 'register_hook') return first.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle(<HooksPage />);

    fireEvent.change(screen.getByPlaceholderText('Hook name'), { target: { value: 'on-start' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    expect(invokeMock.mock.calls.filter(([c]) => c === 'register_hook')).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'register_hook')[0]).toEqual([
      'register_hook',
      { name: 'on-start', event: 'session.start', script: null },
    ]);
    // Pending feedback: frozen form and visible in-flight state.
    expect(screen.getByRole('button', { name: 'Registering…' })).toBeDisabled();
    expect(screen.getByPlaceholderText('Hook name')).toBeDisabled();
    expect(screen.getByPlaceholderText('Script / command (optional)')).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();

    // Enter must not bypass the pending guard.
    fireEvent.keyDown(screen.getByPlaceholderText('Script / command (optional)'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Registering…' }));
    expect(invokeMock.mock.calls.filter(([c]) => c === 'register_hook')).toHaveLength(1);

    await act(async () => { const created = { id: 'h1', name: 'on-start', event: 'session.start', script: '', enabled: true, created_at: '' }; store.push(created); first.resolve(created); });
    expect(screen.getByPlaceholderText('Hook name')).toHaveValue('');
    expect(screen.getByPlaceholderText('Hook name')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Register' })).toBeDisabled();
  });

  it('retains the draft after a rejected register with retryable feedback and no native error detail', async () => {
    const store: unknown[] = [];
    const first = deferred<unknown>();
    const retry = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_hooks') return Promise.resolve([...store]);
      if (command === 'register_hook') return first.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle(<HooksPage />);

    fireEvent.change(screen.getByPlaceholderText('Hook name'), { target: { value: 'on-start' } });
    fireEvent.change(screen.getByPlaceholderText('Script / command (optional)'), { target: { value: 'run.sh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    await act(async () => { first.reject(new Error('boom: api_key=sk-leaked')); });

    expect(screen.getByRole('alert')).toHaveTextContent('Could not register the hook');
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sk-leaked/)).not.toBeInTheDocument();
    // The draft survives the failure and the form is editable again.
    expect(screen.getByPlaceholderText('Hook name')).toHaveValue('on-start');
    expect(screen.getByPlaceholderText('Script / command (optional)')).toHaveValue('run.sh');
    expect(screen.getByPlaceholderText('Hook name')).toBeEnabled();

    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_hooks') return Promise.resolve([...store]);
      if (command === 'register_hook') return retry.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(invokeMock.mock.calls.filter(([c]) => c === 'register_hook')).toHaveLength(2);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'register_hook')[1]).toEqual([
      'register_hook',
      { name: 'on-start', event: 'session.start', script: 'run.sh' },
    ]);
    await act(async () => { const created = { id: 'h1', name: 'on-start', event: 'session.start', script: '', enabled: true, created_at: '' }; store.push(created); retry.resolve(created); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Hook name')).toHaveValue('');
  });
});

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

const cases: RemovalCase[] = [
  {
    title: 'HooksPage', View: HooksPage, list: 'get_hooks', remove: 'unregister_hook', action: 'Unregister',
    failure: /Could not unregister the hook/i, success: /Unregistered Alpha Hook/i,
    rows: [hookAlpha, { ...hookAlpha, id: 'hook-b', name: 'Beta Hook' }],
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
