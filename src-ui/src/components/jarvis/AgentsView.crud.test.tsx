import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
import AgentsView from './AgentsView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

type Agent = {
  id: string;
  name: string;
  description: string;
  model: string;
  backend: string;
  system_prompt: string;
  enabled: boolean;
  config: string | null;
  created_at: string;
  updated_at: string;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const alpha: Agent = {
  id: 'a1', name: 'Atlas', description: 'old description', model: 'old-model', backend: 'jarvis',
  system_prompt: 'old prompt', enabled: true, config: null, created_at: '', updated_at: '',
};
const beta: Agent = { ...alpha, id: 'b1', name: 'Beta' };
const created: Agent = {
  ...alpha,
  id: 'c1',
  name: 'Created',
  description: 'created description',
  model: 'created-model',
  system_prompt: 'created prompt',
};
const disabledAlpha: Agent = { ...alpha, enabled: false };
const updatedAlpha: Agent = {
  ...alpha,
  name: 'Atlas Updated',
  description: '',
  model: 'new-model',
  system_prompt: '',
};

const row = (name = 'Atlas') => within(screen.getByRole('heading', { name }).closest('li')!);
const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);

function renderView() {
  return render(<ToastProvider><AgentsView /></ToastProvider>);
}

async function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: '+ New agent' }));
}

beforeEach(() => {
  invokeMock.mockReset();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Agent CRUD coordination', () => {
  it('keeps one create lifetime through editor dismissal and readback', async () => {
    const write = deferred<Agent>();
    const readback = deferred<Agent[]>();
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_agents') {
        listCalls += 1;
        return listCalls === 1 ? Promise.resolve([alpha, beta]) : readback.promise;
      }
      if (command === 'list_channels' || command === 'list_agent_channel_bindings' || command === 'list_agent_projections') return Promise.resolve([]);
      if (command === 'add_agent') return write.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    renderView();
    await screen.findByRole('heading', { name: 'Atlas' });
    await openEditor();
    fireEvent.change(screen.getByPlaceholderText('Name *'), { target: { value: '  Created  ' } });
    fireEvent.change(screen.getByPlaceholderText('Model * (e.g. qwen2.5-coder:7b)'), { target: { value: '  created-model  ' } });
    fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: '  created description  ' } });
    fireEvent.change(screen.getByPlaceholderText('System prompt'), { target: { value: '  created prompt  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(calls('add_agent')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeInTheDocument();
    expect(calls('add_agent')).toHaveLength(1);

    await act(async () => { write.resolve(created); });
    expect(screen.getByText(/Change saved\. Reconciling agents/)).toBeInTheDocument();
    await act(async () => { readback.resolve([alpha, beta, { ...created, name: 'Created' }]); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Created' })).toBeInTheDocument();
    expect(calls('add_agent')).toEqual([['add_agent', {
      name: 'Created', model: 'created-model', description: 'created description', systemPrompt: 'created prompt',
    }]]);
  });

  it('retains a rejected create draft and retries the same normalized write', async () => {
    const first = deferred<Agent>();
    const second = deferred<Agent>();
    let writesAttempt = 0;
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_agents') {
        listCalls += 1;
        return listCalls === 1 ? Promise.resolve([alpha, beta]) : Promise.resolve([alpha, beta, created]);
      }
      if (command === 'list_channels' || command === 'list_agent_channel_bindings' || command === 'list_agent_projections') return Promise.resolve([]);
      if (command === 'add_agent') {
        writesAttempt += 1;
        return writesAttempt === 1 ? first.promise : second.promise;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    renderView();
    await screen.findByRole('heading', { name: 'Atlas' });
    await openEditor();
    fireEvent.change(screen.getByPlaceholderText('Name *'), { target: { value: '  Created  ' } });
    fireEvent.change(screen.getByPlaceholderText('Model * (e.g. qwen2.5-coder:7b)'), { target: { value: '  created-model  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => { first.reject(new Error('private create detail')); });
    expect(screen.getByText(/Could not create the agent/)).toBeInTheDocument();
    expect(screen.queryByText(/private create detail/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Name *')).toHaveValue('  Created  ');
    expect(screen.getByPlaceholderText('Model * (e.g. qwen2.5-coder:7b)')).toHaveValue('  created-model  ');
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(calls('add_agent')).toHaveLength(2);
    expect(calls('add_agent')[0]).toEqual(calls('add_agent')[1]);
    await act(async () => { second.resolve(created); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument());
  });

  it('retains a rejected identity edit and repeats only its write payload', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    let editWrites = 0;
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_agents') {
        listCalls += 1;
        return Promise.resolve(listCalls === 1 ? [alpha, beta] : [updatedAlpha, beta]);
      }
      if (command === 'list_channels' || command === 'list_agent_channel_bindings' || command === 'list_agent_projections') return Promise.resolve([]);
      if (command === 'set_agent_identity') {
        editWrites += 1;
        return editWrites === 1 ? first.promise : second.promise;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    renderView();
    await screen.findByRole('heading', { name: 'Atlas' });
    fireEvent.click(row().getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByPlaceholderText('Name *'), { target: { value: 'Atlas Updated' } });
    fireEvent.change(screen.getByPlaceholderText('Model * (e.g. qwen2.5-coder:7b)'), { target: { value: 'new-model' } });
    fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('System prompt'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => { first.reject(new Error('private edit detail')); });
    expect(screen.getByText(/Could not update the agent/)).toBeInTheDocument();
    expect(screen.queryByText(/private edit detail/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Name *')).toHaveValue('Atlas Updated');
    expect(screen.getByPlaceholderText('Model * (e.g. qwen2.5-coder:7b)')).toHaveValue('new-model');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(calls('set_agent_identity')).toEqual([
      ['set_agent_identity', {
        id: 'a1', name: 'Atlas Updated', description: '', systemPrompt: '', model: 'new-model',
      }],
      ['set_agent_identity', {
        id: 'a1', name: 'Atlas Updated', description: '', systemPrompt: '', model: 'new-model',
      }],
    ]);
    await act(async () => { second.resolve(); });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Atlas Updated' })).toBeInTheDocument());
  });

  it('serializes repeated and opposite enablement requests until a confirming list', async () => {
    const write = deferred<void>();
    const readback = deferred<Agent[]>();
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_agents') {
        listCalls += 1;
        return listCalls === 1 ? Promise.resolve([alpha, beta]) : readback.promise;
      }
      if (command === 'list_channels' || command === 'list_agent_channel_bindings' || command === 'list_agent_projections') return Promise.resolve([]);
      if (command === 'set_agent_enabled') return write.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    renderView();
    await screen.findByRole('heading', { name: 'Atlas' });
    const disable = row().getByRole('button', { name: 'Disable' });
    fireEvent.click(disable);
    fireEvent.click(disable);
    expect(calls('set_agent_enabled')).toEqual([['set_agent_enabled', { id: 'a1', enabled: false }]]);
    expect(row().getByRole('button', { name: 'Disable' })).toBeDisabled();
    expect(row('Beta').getByRole('button', { name: 'Disable' })).toBeEnabled();
    await act(async () => { write.resolve(); });
    expect(row().getByRole('button', { name: 'Disable' })).toBeDisabled();
    await act(async () => { readback.resolve([disabledAlpha, beta]); });
    await waitFor(() => expect(row().getByRole('button', { name: 'Enable' })).toBeEnabled());
  });

  it('holds delete confirmation through persistence and fences competing row actions', async () => {
    const write = deferred<void>();
    const readback = deferred<Agent[]>();
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_agents') {
        listCalls += 1;
        return listCalls === 1 ? Promise.resolve([alpha, beta]) : readback.promise;
      }
      if (command === 'list_channels' || command === 'list_agent_channel_bindings' || command === 'list_agent_projections') return Promise.resolve([]);
      if (command === 'delete_agent') return write.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    renderView();
    await screen.findByRole('heading', { name: 'Atlas' });
    fireEvent.click(row().getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(calls('delete_agent')).toEqual([['delete_agent', { id: 'a1' }]]);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /Deleting/ })).toBeInTheDocument();
    fireEvent.click(row().getByRole('button', { name: 'Edit' }));
    fireEvent.click(row().getByRole('button', { name: 'Disable' }));
    expect(calls('set_agent_identity')).toHaveLength(0);
    expect(calls('set_agent_enabled')).toHaveLength(0);
    await act(async () => { write.resolve(); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Atlas' })).toBeInTheDocument();
    expect(row().getByRole('button', { name: 'Delete' })).toBeDisabled();
    await act(async () => { readback.resolve([beta]); });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Atlas' })).not.toBeInTheDocument());
  });

  it('ignores an obsolete pre-write list completion after a newer create confirmation', async () => {
    const oldRead = deferred<Agent[]>();
    const newRead = deferred<Agent[]>();
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_agents') {
        listCalls += 1;
        return listCalls === 1 ? oldRead.promise : newRead.promise;
      }
      if (command === 'list_channels' || command === 'list_agent_channel_bindings' || command === 'list_agent_projections') return Promise.resolve([]);
      if (command === 'add_agent') return Promise.resolve(created);
      throw new Error(`Unexpected command: ${command}`);
    });
    renderView();
    await waitFor(() => expect(listCalls).toBe(1));
    await openEditor();
    fireEvent.change(screen.getByPlaceholderText('Name *'), { target: { value: 'Created' } });
    fireEvent.change(screen.getByPlaceholderText('Model * (e.g. qwen2.5-coder:7b)'), { target: { value: 'created-model' } });
    fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: 'created description' } });
    fireEvent.change(screen.getByPlaceholderText('System prompt'), { target: { value: 'created prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(listCalls).toBe(2));
    await act(async () => { newRead.resolve([alpha, created]); });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Created' })).toBeInTheDocument());
    await act(async () => { oldRead.resolve([alpha]); });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Created' })).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('turns a failed confirmation read into a read-only retry for a settled toggle', async () => {
    const write = deferred<void>();
    const retryRead = deferred<Agent[]>();
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_agents') {
        listCalls += 1;
        if (listCalls === 1) return Promise.resolve([alpha, beta]);
        if (listCalls === 2) return Promise.reject(new Error('private readback detail'));
        return retryRead.promise;
      }
      if (command === 'list_channels' || command === 'list_agent_channel_bindings' || command === 'list_agent_projections') return Promise.resolve([]);
      if (command === 'set_agent_enabled') return write.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    renderView();
    await screen.findByRole('heading', { name: 'Atlas' });
    fireEvent.click(row().getByRole('button', { name: 'Disable' }));
    await act(async () => { write.resolve(); });
    const alert = row().getByRole('alert');
    expect(alert).toHaveTextContent(/saved.*retry reloads the list only/i);
    expect(alert).not.toHaveTextContent('private readback detail');
    expect(row().getByRole('button', { name: 'Disable' })).toBeDisabled();
    const retry = within(alert).getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(calls('set_agent_enabled')).toHaveLength(1);
    expect(calls('list_agents')).toHaveLength(3);
    await act(async () => { retryRead.resolve([disabledAlpha, beta]); });
    await waitFor(() => expect(row().getByRole('button', { name: 'Enable' })).toBeEnabled());
  });
});
