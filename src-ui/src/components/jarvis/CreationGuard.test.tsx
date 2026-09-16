import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HooksView from './HooksView';
import NodesView from './NodesView';
import DevicesView from './DevicesView';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const LIST_COMMANDS = ['get_hooks', 'get_nodes', 'get_devices'] as const;

beforeEach(() => {
  invokeMock.mockReset().mockImplementation((command: string) => {
    if ((LIST_COMMANDS as readonly string[]).includes(command)) return Promise.resolve([]);
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

async function renderIdle(ui: React.ReactNode) {
  render(ui);
  await screen.findByRole('button', { name: /Register|Add/ });
}

describe.each([
  { View: HooksView, list: 'get_hooks', create: 'register_hook', field: 'Hook name', button: 'Register', success: 'Registered hook example' },
  { View: NodesView, list: 'get_nodes', create: 'add_node', field: 'Node name', button: 'Add', success: 'Added node example' },
  { View: DevicesView, list: 'get_devices', create: 'add_device', field: 'Device name', button: 'Add', success: 'Added device example' },
])('$create refresh boundary', ({ View, list, create, field, button, success }) => {
  it('keeps creation successful when list refresh fails and retries only the list', async () => {
    const creation = deferred<unknown>();
    const refresh = deferred<unknown>();
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === list) return ++listCalls === 2 ? refresh.promise : Promise.resolve([]);
      if (command === create) return creation.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle(<ToastProvider><View /></ToastProvider>);
    const name = screen.getByPlaceholderText(field);
    fireEvent.change(name, { target: { value: 'example' } });
    const address = screen.queryByPlaceholderText('Address (host:port)');
    if (address) fireEvent.change(address, { target: { value: 'localhost:7000' } });
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(screen.queryByText(success)).not.toBeInTheDocument();
    await act(async () => { creation.resolve({ id: 'created' }); });
    expect(screen.getByText(success)).toBeInTheDocument();
    expect(name).toHaveValue('');
    expect(name).toBeDisabled();
    await act(async () => { refresh.reject(new Error('List refresh unavailable')); });
    expect(screen.getByText(success)).toBeInTheDocument();
    expect(screen.queryByText(/Could not (add|register) the/)).not.toBeInTheDocument();
    expect(screen.getByText('Error: List refresh unavailable')).toBeInTheDocument();
    expect(name).toBeEnabled();
    fireEvent.change(name, { target: { value: 'next draft' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(invokeMock.mock.calls.filter(([c]) => c === create)).toHaveLength(1);
    expect(listCalls).toBe(3);
    expect(name).toHaveValue('next draft');
  });
});

describe('HooksView creation guard', () => {
  it('invokes register_hook exactly once across click and Enter repetition while pending', async () => {
    const first = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_hooks') return Promise.resolve([]);
      if (command === 'register_hook') return first.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle(<HooksView />);

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

    await act(async () => { first.resolve({ id: 'h1', name: 'on-start', event: 'session.start', script: '', enabled: true, created_at: '' }); });
    expect(screen.getByPlaceholderText('Hook name')).toHaveValue('');
    expect(screen.getByPlaceholderText('Hook name')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Register' })).toBeDisabled();
  });

  it('retains the draft after a rejected register with retryable feedback and no native error detail', async () => {
    const first = deferred<unknown>();
    const retry = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_hooks') return Promise.resolve([]);
      if (command === 'register_hook') return first.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle(<HooksView />);

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
      if (command === 'get_hooks') return Promise.resolve([]);
      if (command === 'register_hook') return retry.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(invokeMock.mock.calls.filter(([c]) => c === 'register_hook')).toHaveLength(2);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'register_hook')[1]).toEqual([
      'register_hook',
      { name: 'on-start', event: 'session.start', script: 'run.sh' },
    ]);
    await act(async () => { retry.resolve({ id: 'h1' }); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Hook name')).toHaveValue('');
  });
});

describe('NodesView creation guard', () => {
  it('invokes add_node exactly once across click and Enter repetition while pending', async () => {
    const first = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_nodes') return Promise.resolve([]);
      if (command === 'add_node') return first.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle(<NodesView />);

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
    await renderIdle(<NodesView />);

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

describe('DevicesView creation guard', () => {
  it('invokes add_device exactly once across click and Enter repetition while pending', async () => {
    const first = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_devices') return Promise.resolve([]);
      if (command === 'add_device') return first.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle(<DevicesView />);

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
    await renderIdle(<DevicesView />);

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
