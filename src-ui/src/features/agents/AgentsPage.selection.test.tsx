import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentsPage from './AgentsPage';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const agent = (id: string, name: string) => ({
  id, name, description: `${name} description`, model: 'test-model', backend: 'jarvis',
  system_prompt: `${name} prompt`, enabled: true, config: null, created_at: '', updated_at: '',
});
const hash = 'a'.repeat(64);
const discovery = [
  { id: 'coder', slug: 'coder', status: 'valid', source_hash: hash, source_path: '/agents/coder/soul.md' },
  { id: 'scribe', slug: 'scribe', status: 'invalid', source_path: '/agents/scribe/soul.md' },
];
const bindingsFor: Record<string, string[]> = { a1: ['c1'], b1: [] };
const calls = (name: string) => invokeMock.mock.calls.filter(([c]) => c === name);

beforeEach(() => {
  invokeMock.mockReset().mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === 'list_agents') return Promise.resolve([agent('a1', 'Atlas'), agent('b1', 'Beta')]);
    if (command === 'list_channels') return Promise.resolve([{ id: 'c1', name: 'Newsroom', type: 'discord', enabled: true }]);
    if (command === 'list_agent_channel_bindings') return Promise.resolve(bindingsFor[String(args?.agentId)] ?? []);
    if (command === 'list_agent_projections') return Promise.resolve([]);
    throw new Error(`Unexpected command: ${command}`);
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => discovery }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Agents master-detail', () => {
  it('opens the first Agent by default and reloads bindings for the Agent you select', async () => {
    render(<AgentsPage />);
    await screen.findByRole('heading', { name: 'Atlas' });
    expect(screen.getByRole('region', { name: 'Atlas detail' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Newsroom/ })).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.click(within(screen.getByRole('heading', { name: 'Beta' })).getByRole('button'));
    expect(screen.getByRole('region', { name: 'Beta detail' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Newsroom/ })).toHaveAttribute('aria-pressed', 'false'));
    expect(calls('list_agent_channel_bindings').map(([, a]) => a)).toEqual([{ agentId: 'a1' }, { agentId: 'b1' }]);
  });

  it('shows the lifecycle track of a selected Agent directory, failing at Validate when its soul.md is invalid', async () => {
    render(<AgentsPage />);
    const title = await screen.findByRole('heading', { name: 'scribe' });
    fireEvent.click(within(title).getByRole('button'));

    const detail = screen.getByRole('region', { name: 'scribe lifecycle' });
    const track = within(detail).getByRole('list', { name: 'Agent lifecycle for scribe' });
    const stations = within(track).getAllByRole('listitem');
    expect(stations).toHaveLength(4);
    expect(stations[1]).toHaveTextContent('Validate');
    expect(stations[1]).toHaveTextContent('failed');
    expect(stations[2]).toHaveTextContent('pending');
    expect(within(detail).getByText('/agents/scribe/soul.md')).toBeInTheDocument();
  });

  it('keeps Save disabled until both a name and a model are given', async () => {
    render(<AgentsPage />);
    await screen.findByRole('heading', { name: 'Atlas' });
    fireEvent.click(screen.getByRole('button', { name: '+ New agent' }));
    const dialog = screen.getByRole('dialog', { name: 'New Agent' });
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText('Name *'), { target: { value: 'Nova' } });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText('Model * (e.g. qwen2.5-coder:7b)'), { target: { value: 'm' } });
    expect(save).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls('add_agent')).toHaveLength(0);
  });
});
