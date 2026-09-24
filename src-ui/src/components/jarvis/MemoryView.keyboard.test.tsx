import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MemoryView from './MemoryView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const firstMemory = {
  id: 'memory-first',
  title: 'First memory',
  content: 'The complete first memory content remains available for inspection.',
  tags: JSON.stringify(['one', 'two', 'three', 'four']),
  category: 'project',
  created_at: '2026-09-20T10:00:00Z',
  updated_at: '2026-09-21T10:00:00Z',
  relevance_score: 0.8,
  agent_id: 'agent-1',
  source: 'operator',
  source_session_id: 'session-1',
  source_message_ids: JSON.stringify(['message-1', 'message-2']),
  confidence: 0.91,
  last_used_at: '2026-09-22T10:00:00Z',
  usage_count: 4,
  expires_at: '2026-10-21T10:00:00Z',
  review_after: '2026-09-28T10:00:00Z',
  status: 'active',
  supersedes_id: 'memory-old',
  metadata: JSON.stringify({ tier: 'hot', private_note: 'do not render' }),
  tier: 'hot',
};

const secondMemory = {
  ...firstMemory,
  id: 'memory-second',
  title: 'Second memory',
  content: 'The complete second memory content is different.',
};

const minimalMemory = {
  id: 'memory-minimal',
  title: 'Minimal memory',
  content: 'Full content without optional provenance.',
  tags: '[]',
  category: 'note',
  created_at: '2026-09-20T10:00:00Z',
  updated_at: '2026-09-21T10:00:00Z',
  relevance_score: 0,
  agent_id: '',
  source: '',
  source_session_id: null,
  source_message_ids: '[]',
  confidence: 0,
  last_used_at: null,
  usage_count: 0,
  expires_at: null,
  review_after: null,
  status: 'active',
  supersedes_id: null,
  metadata: null,
};

beforeEach(() => {
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'list_recent_memories') return Promise.resolve([firstMemory, secondMemory]);
    if (command === 'memory_recall_preview') return Promise.resolve([]);
    if (command === 'jarvis_get_tier_stats') return Promise.resolve({ hot: 2, warm: 0, cold: 0 });
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(cleanup);

async function mount() {
  const view = render(<MemoryView />);
  await screen.findByRole('button', { name: 'Inspect memory: First memory' });
  return view;
}

function inspectButton(title: string) {
  return screen.getByRole('button', { name: `Inspect memory: ${title}` });
}

function detailsFor(title: string) {
  return screen.getByRole('region', { name: `Memory details: ${title}` });
}

describe('Memory keyboard inspection', () => {
  it.each(['{Enter}', ' '])('opens the full inspector with %s', async (key) => {
    const user = userEvent.setup();
    await mount();

    const button = inspectButton('First memory');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls');
    expect(document.getElementById(button.getAttribute('aria-controls')!)).toBeNull();

    button.focus();
    await user.keyboard(key);

    expect(button).toHaveAttribute('aria-expanded', 'true');
    const details = detailsFor('First memory');
    expect(within(details).getByText(firstMemory.content)).toBeInTheDocument();
    expect(within(details).getByText('operator')).toBeInTheDocument();
    expect(within(details).getByText('session-1')).toBeInTheDocument();
    expect(within(details).getByText('message-1, message-2')).toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('switches the inspected entry without retaining the previous content', async () => {
    const user = userEvent.setup();
    await mount();

    const first = inspectButton('First memory');
    await user.click(first);
    expect(within(detailsFor('First memory')).getByText(firstMemory.content)).toBeInTheDocument();

    const second = inspectButton('Second memory');
    await user.click(second);

    expect(second).toHaveAttribute('aria-expanded', 'true');
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(detailsFor('Second memory')).toHaveTextContent(secondMemory.content);
    expect(within(detailsFor('Second memory')).queryByText(firstMemory.content)).not.toBeInTheDocument();
  });

  it('closes the inspector and restores focus to its opener', async () => {
    const user = userEvent.setup();
    await mount();

    const button = inspectButton('First memory');
    await user.click(button);
    const close = screen.getByRole('button', { name: 'Close' });
    await user.click(close);

    await waitFor(() => expect(inspectButton('First memory')).toHaveFocus());
    expect(inspectButton('First memory')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Memory details: First memory' })).not.toBeInTheDocument();
  });

  it('renders missing optional provenance without inventing values or reading a backing file', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_recent_memories') return Promise.resolve([minimalMemory]);
      if (command === 'memory_recall_preview') return Promise.resolve([]);
      if (command === 'jarvis_get_tier_stats') return Promise.resolve({ hot: 1, warm: 0, cold: 0 });
      throw new Error(`Unexpected command: ${command}`);
    });
    const user = userEvent.setup();
    render(<MemoryView />);
    await screen.findByRole('button', { name: 'Inspect memory: Minimal memory' });

    await user.click(inspectButton('Minimal memory'));
    const details = detailsFor('Minimal memory');
    expect(within(details).getByText(minimalMemory.content)).toBeInTheDocument();
    expect(within(details).getAllByText('Not supplied').length).toBeGreaterThan(0);
    expect(details).not.toHaveTextContent('undefined');
    expect(details).not.toHaveTextContent('null');
    expect(details).not.toHaveTextContent('private_note');
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'list_recent_memories',
      'jarvis_get_tier_stats',
    ]);
  });

  it('does not retain a selected inspector when a submitted query removes its entry', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(inspectButton('First memory'));
    expect(detailsFor('First memory')).toBeInTheDocument();

    const query = screen.getByRole('textbox', { name: 'Recall query' });
    await user.clear(query);
    await user.type(query, 'missing');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Memory details: First memory' })).not.toBeInTheDocument());
    expect(screen.queryByText(firstMemory.content)).not.toBeInTheDocument();
    expect(screen.getByText('Results for "missing"')).toBeInTheDocument();
    expect(screen.getByText('No memories match the current query.')).toBeInTheDocument();
  });

  it('preserves the existing recall and list commands without fetching memory content', async () => {
    await mount();
    await userEvent.setup().click(inspectButton('First memory'));

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'list_recent_memories',
      'jarvis_get_tier_stats',
    ]);
  });
});
