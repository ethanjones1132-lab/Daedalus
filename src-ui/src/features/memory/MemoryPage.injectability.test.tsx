import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MemoryPage from './MemoryPage';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const entry = (id: string, title: string) => ({
  id,
  title,
  content: `${title} content`,
  tags: '[]',
  category: 'note',
  created_at: '2026-10-30T00:00:00Z',
  updated_at: '2026-10-30T00:00:00Z',
  relevance_score: 0,
  agent_id: 'jarvis',
  source: 'manual',
  source_session_id: null,
  source_message_ids: '[]',
  confidence: 0.9,
  last_used_at: null,
  usage_count: 0,
  expires_at: null,
  review_after: null,
  status: 'active',
  supersedes_id: null,
  metadata: null,
  tier: 'hot',
  summary: '',
  archived_at: null,
  updated_at_ms: 0,
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'list_recent_memories') return [entry('a', 'Alpha'), entry('b', 'Bravo')];
    if (command === 'jarvis_get_tier_stats') return { hot: 2, warm: 0, cold: 0 };
    if (command === 'jarvis_list_sessions') return [{ id: 'ses-1', name: 'Project One' }];
    if (command === 'memory_injectability') {
      return [
        { id: 'a', admitted: true, stale: false, reason: null },
        { id: 'b', admitted: false, stale: false, reason: 'out_of_scope' },
      ];
    }
    return [];
  });
});
afterEach(cleanup);

describe('Memory Overview injectability', () => {
  it('labels the Overview as stored memories, not recall, before any scope is chosen', async () => {
    render(<MemoryPage />);
    await screen.findByText('Alpha');
    expect(screen.getByText('All stored memories — not necessarily what will be recalled.')).toBeInTheDocument();
    // No verdict is claimed without a chosen Session scope.
    expect(screen.queryByRole('status', { name: /Injectability/ })).not.toBeInTheDocument();
  });

  it('shows the exact per-row verdict for the chosen Session scope', async () => {
    render(<MemoryPage />);
    await screen.findByText('Alpha');
    fireEvent.change(screen.getByRole('combobox', { name: 'Recall scope Session' }), {
      target: { value: 'ses-1' },
    });

    expect(await screen.findByRole('status', { name: 'Injectability: recallable here' })).toBeInTheDocument();
    expect(await screen.findByRole('status', { name: 'Injectability: filtered: other scope' })).toBeInTheDocument();
    const call = invokeMock.mock.calls.find(([command]) => command === 'memory_injectability');
    expect(call?.[1]).toEqual({
      request: { session_id: 'ses-1', ids: ['a', 'b'], include_user_scope: false },
    });
    // The raw native reason code never reaches the surface.
    expect(screen.queryByText(/out_of_scope/)).not.toBeInTheDocument();
  });

  it('uses the operator-chosen user-scope inclusion for the verdicts', async () => {
    render(<MemoryPage />);
    await screen.findByText('Alpha');
    fireEvent.change(screen.getByRole('combobox', { name: 'Recall scope Session' }), {
      target: { value: 'ses-1' },
    });
    await screen.findByRole('status', { name: 'Injectability: recallable here' });

    invokeMock.mockClear();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include user-scope memories' }));

    await waitFor(() => {
      const call = invokeMock.mock.calls.find(([command]) => command === 'memory_injectability');
      expect(call?.[1]).toEqual({
        request: { session_id: 'ses-1', ids: ['a', 'b'], include_user_scope: true },
      });
    });
    expect(screen.getByText(/User-scope memories are included/)).toBeInTheDocument();
  });

  it('claims no verdict when the projection is unreadable', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_recent_memories') return [entry('a', 'Alpha')];
      if (command === 'jarvis_get_tier_stats') return { hot: 1, warm: 0, cold: 0 };
      if (command === 'jarvis_list_sessions') return [{ id: 'ses-1', name: 'Project One' }];
      if (command === 'memory_injectability') return { not: 'an array' };
      return [];
    });
    render(<MemoryPage />);
    await screen.findByText('Alpha');
    fireEvent.change(screen.getByRole('combobox', { name: 'Recall scope Session' }), {
      target: { value: 'ses-1' },
    });
    await waitFor(() =>
      expect(screen.getByText(/Injectability is unavailable for this Session/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('status', { name: /Injectability:/ })).not.toBeInTheDocument();
  });
});
