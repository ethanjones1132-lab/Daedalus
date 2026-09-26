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
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const alpha: Agent = {
  id: 'a1', name: 'Atlas', description: 'old description', model: 'old-model', backend: 'jarvis',
  system_prompt: 'old prompt', enabled: true, config: null, created_at: '', updated_at: '',
};
const beta: Agent = { ...alpha, id: 'b1', name: 'Beta', model: 'qwen2.5-coder:7b' };
const blank: Agent = { ...alpha, id: 'a3', name: 'Blank', model: '' };
const spaced: Agent = { ...alpha, id: 'a4', name: 'Spaced', model: '   ' };
const nulled: Agent = { ...alpha, id: 'a5', name: 'Nulled', model: null as unknown as string };
const disabledAlpha: Agent = { ...alpha, enabled: false };

const cardEl = (name: string) => screen.getByRole('heading', { name }).closest('li') as HTMLElement;
const card = (name: string) => within(cardEl(name));
const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);
const fetchMock = vi.fn();

function renderView() {
  return render(<ToastProvider><AgentsView /></ToastProvider>);
}

function mockReads(agents: Agent[], readback?: Agent[]) {
  let listCalls = 0;
  invokeMock.mockImplementation((command: string) => {
    if (command === 'list_agents') {
      listCalls += 1;
      if (listCalls === 1) return Promise.resolve(agents);
      return readback ? Promise.resolve(readback) : Promise.resolve(agents);
    }
    if (command === 'list_channels' || command === 'list_agent_channel_bindings' || command === 'list_agent_projections') return Promise.resolve([]);
    if (command === 'set_agent_enabled') return Promise.resolve();
    throw new Error(`Unexpected command: ${command}`);
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the two stores an Agent card is read against', () => {
  it('names the record and the routing pool above the cards, and reads no pool state of its own', async () => {
    mockReads([alpha, beta]);
    renderView();
    await screen.findByRole('heading', { name: 'Atlas' });
    expect(
      screen.getByText(
        "Enabled and the model on an Agent card are stored on that Agent record. Turn routing reads the orchestrator's Agent pool in Daedalus' configuration instead, so neither of them changes which model a turn uses.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.includes('/agents/pool'))).toEqual([]);
    // The one network read this surface makes is Agent lifecycle discovery, so
    // "no pool state of its own" is a property of the code, not of this fixture.
    expect(urls.every((url) => url === 'http://127.0.0.1:19877/agents')).toBe(true);
  });

  it('keeps a record card scoped when the server-side read fails, so no pool claim can appear or vanish', async () => {
    fetchMock.mockRejectedValue(new Error('server unreachable'));
    mockReads([alpha, beta]);
    renderView();
    await screen.findByRole('heading', { name: 'Atlas' });
    await waitFor(() => expect(screen.getByRole('alert', { name: 'Agent discovery' })).toBeInTheDocument());
    expect(
      screen.getByText(
        "Enabled and the model on an Agent card are stored on that Agent record. Turn routing reads the orchestrator's Agent pool in Daedalus' configuration instead, so neither of them changes which model a turn uses.",
      ),
    ).toBeInTheDocument();
    expect(card('Atlas').getByText('old-model')).toBeInTheDocument();
    expect(cardEl('Atlas').textContent).not.toMatch(/rout/i);
    expect(cardEl('Beta').textContent).not.toMatch(/rout/i);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.includes('/agents/pool'))).toEqual([]);
  });

  it('makes no routing claim on a card whose label looks like a routable model id', async () => {
    mockReads([alpha, beta]);
    renderView();
    await screen.findByRole('heading', { name: 'Beta' });
    expect(card('Beta').getByText('qwen2.5-coder:7b')).toBeInTheDocument();
    expect(card('Beta').getByText('qwen2.5-coder:7b').textContent).not.toMatch(/rout|pool|pin/i);
    expect(cardEl('Atlas').textContent).not.toMatch(/rout/i);
    expect(cardEl('Beta').textContent).not.toMatch(/rout/i);
  });

  it('describes the enable switch as a record write without renaming it', async () => {
    mockReads([alpha]);
    renderView();
    await screen.findByRole('heading', { name: 'Atlas' });
    const disable = card('Atlas').getByRole('button', { name: 'Disable' });
    expect(disable).toHaveAttribute('title', expect.stringContaining('Agent record'));
    expect(disable.getAttribute('title')).toContain('Agent pool');
    expect(disable).toBeEnabled();
    // One basis for both record fields on the card, so the model label and the
    // switch cannot drift into two different claims about routing.
    expect(card('Atlas').getByText('old-model').getAttribute('title')).toBe(disable.getAttribute('title'));
  });

  it('prints an honest label when the record carries no readable model', async () => {
    mockReads([blank, spaced, nulled]);
    renderView();
    await screen.findByRole('heading', { name: 'Blank' });
    expect(card('Blank').getByText('No model label')).toBeInTheDocument();
    expect(card('Spaced').getByText('No model label')).toBeInTheDocument();
    expect(card('Nulled').getByText('No model label')).toBeInTheDocument();
    expect(card('Blank').getByText('No model label').getAttribute('title')).toContain('Agent pool');
  });

  it('confirms a disabled record by naming the record, and keeps the card unclaimed', async () => {
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
    fireEvent.click(card('Atlas').getByRole('button', { name: 'Disable' }));
    expect(calls('set_agent_enabled')).toEqual([['set_agent_enabled', { id: 'a1', enabled: false }]]);
    await act(async () => { write.resolve(); });
    expect(screen.queryByText('Agent record disabled')).not.toBeInTheDocument();
    await act(async () => { readback.resolve([disabledAlpha, beta]); });
    await waitFor(() => expect(screen.getByText('Agent record disabled')).toBeInTheDocument());
    expect(screen.queryByText('Agent disabled')).not.toBeInTheDocument();
    expect(card('Atlas').getByRole('button', { name: 'Enable' })).toBeEnabled();
    expect(card('Atlas').getByText('old-model')).toBeInTheDocument();
  });

  it('confirms an enabled record the same way', async () => {
    mockReads([disabledAlpha], [alpha]);
    renderView();
    await screen.findByRole('heading', { name: 'Atlas' });
    fireEvent.click(card('Atlas').getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(screen.getByText('Agent record enabled')).toBeInTheDocument());
    expect(calls('set_agent_enabled')).toEqual([['set_agent_enabled', { id: 'a1', enabled: true }]]);
    expect(card('Atlas').getByRole('button', { name: 'Disable' })).toBeEnabled();
  });
});
