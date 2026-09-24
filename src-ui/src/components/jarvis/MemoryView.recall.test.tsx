import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MemoryView from './MemoryView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const nativeMemory = (overrides: Record<string, unknown> = {}) => ({
  id: 'recall-memory',
  title: 'Native recall title',
  content: 'The full native recall content is available.',
  tags: '["native"]',
  category: 'project',
  created_at: '2026-09-20T10:00:00Z',
  updated_at: '2026-09-21T10:00:00Z',
  relevance_score: 0.37,
  agent_id: 'agent-1',
  source: 'operator',
  source_session_id: 'session-1',
  source_message_ids: '["message-1"]',
  confidence: 0.81,
  last_used_at: null,
  usage_count: 0,
  expires_at: null,
  review_after: null,
  status: 'active',
  supersedes_id: null,
  metadata: JSON.stringify({ tier: 'hot' }),
  tier: 'warm',
  drive_file_id: null,
  summary: '',
  archived_at: null,
  updated_at_ms: 123,
  ...overrides,
});

const recallResult = (memory: Record<string, unknown>) => ({
  memory,
  score: 0.92,
  matched_terms: ['native'],
});

function search(query: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Recall query' }), { target: { value: query } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
}

beforeEach(() => {
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'list_recent_memories') return Promise.resolve([]);
    if (command === 'jarvis_get_tier_stats') return Promise.resolve({ hot: 0, warm: 0, cold: 0 });
    if (command === 'memory_recall_preview') return Promise.resolve([]);
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(cleanup);

describe('Memory Native recall response', () => {
  it('renders the nested Native memory and opens its inspector', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_recent_memories') return Promise.resolve([]);
      if (command === 'jarvis_get_tier_stats') return Promise.resolve({ hot: 0, warm: 0, cold: 0 });
      if (command === 'memory_recall_preview') return Promise.resolve([recallResult(nativeMemory())]);
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryView />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Recall query' })).toBeInTheDocument());
    search('native');
    expect(await screen.findByText('Native recall title')).toBeInTheDocument();
    expect(screen.getByText('The full native recall content is available.')).toBeInTheDocument();

    const inspect = screen.getByRole('button', { name: 'Inspect memory: Native recall title' });
    expect(inspect).toHaveAttribute('aria-controls', expect.stringContaining('recall-memory'));
    await userEvent.setup().click(inspect);
    const details = screen.getByRole('region', { name: 'Memory details: Native recall title' });
    expect(details).toHaveAttribute('id', expect.stringContaining('recall-memory'));
    expect(within(details).getByText('recall-memory')).toBeInTheDocument();
    expect(within(details).getByText('warm')).toBeInTheDocument();
    expect(within(details).getByText('The full native recall content is available.')).toBeInTheDocument();
  });

  it('renders a missing tier as not supplied and does not include it in a concrete tier filter', async () => {
    const memory = nativeMemory({ tier: undefined, metadata: JSON.stringify({ tier: 'hot' }) });
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_recent_memories') return Promise.resolve([]);
      if (command === 'jarvis_get_tier_stats') return Promise.resolve({ hot: 1, warm: 0, cold: 0 });
      if (command === 'memory_recall_preview') return Promise.resolve([recallResult(memory)]);
      throw new Error(`Unexpected command: ${command}`);
    });

    const user = userEvent.setup();
    render(<MemoryView />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Recall query' })).toBeInTheDocument());
    search('native');
    await user.click(await screen.findByRole('button', { name: 'Inspect memory: Native recall title' }));
    const details = screen.getByRole('region', { name: 'Memory details: Native recall title' });
    expect(within(details).getByText('Tier').nextElementSibling).toHaveTextContent('Not supplied');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Memory tier' }), 'hot');
    expect(screen.queryByRole('region', { name: 'Memory details: Native recall title' })).not.toBeInTheDocument();
    expect(screen.getByText('No memories match the current query.')).toBeInTheDocument();
  });

  it('shows a fixed recall error for malformed Native envelopes', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_recent_memories') return Promise.resolve([]);
      if (command === 'jarvis_get_tier_stats') return Promise.resolve({ hot: 0, warm: 0, cold: 0 });
      if (command === 'memory_recall_preview') return Promise.resolve([{ memory: { title: 'missing fields' }, score: 1, matched_terms: [] }]);
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryView />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Recall query' })).toBeInTheDocument());
    search('native');

    expect(await screen.findByRole('alert')).toHaveTextContent('Memory recall failed for "native".');
    expect(screen.queryByText('No memories match the current query.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
