import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MemoryPage from './MemoryPage';
import { dateBucket } from './memory-format';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const entry = (title: string, updated: string, over: Record<string, unknown> = {}) => ({
  id: title, title, content: `${title} content`, tags: '["x"]', category: 'note',
  created_at: updated, updated_at: updated, relevance_score: 0.5, agent_id: 'a', source: 's',
  source_session_id: null, source_message_ids: '[]', confidence: 0.9, last_used_at: null,
  usage_count: 0, expires_at: null, review_after: null, status: 'active', supersedes_id: null,
  metadata: null, tier: 'hot', ...over,
});

const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();

beforeEach(() => {
  invokeMock.mockReset().mockImplementation(async (cmd: string, args?: { query?: string }) => {
    if (cmd === 'list_recent_memories') return [entry('Alpha', iso(0)), entry('Bravo', iso(0)), entry('Charlie', iso(40))];
    if (cmd === 'jarvis_get_tier_stats') return { hot: 3, warm: 0, cold: 0 };
    if (cmd === 'memory_recall_preview') {
      return [
        { memory: entry('Delta', iso(1)), score: 0.9, matched_terms: [args?.query ?? ''] },
        { memory: entry('Echo', iso(2)), score: 0.4, matched_terms: [] },
      ];
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
});
afterEach(cleanup);

describe('Memory list', () => {
  it('buckets recent memories by when they were last updated', () => {
    const at = new Date('2026-10-11T15:00:00').getTime();
    expect(dateBucket(new Date('2026-10-11T08:00:00').toISOString(), at)).toBe('Today');
    expect(dateBucket(new Date('2026-10-10T20:00:00').toISOString(), at)).toBe('Yesterday');
    expect(dateBucket(new Date('2026-10-06T12:00:00').toISOString(), at)).toBe('This week');
    expect(dateBucket(new Date('2026-09-20T12:00:00').toISOString(), at)).toBe('Earlier this month');
    expect(dateBucket('2026-01-01T00:00:00Z', at)).toBe('Older');
    expect(dateBucket('not a date', at)).toBe('Older');
  });

  it('groups the recent list under day headings and keeps results flat for a recall', async () => {
    render(<MemoryPage />);
    await screen.findByRole('button', { name: 'Inspect memory: Alpha' });
    expect(screen.getByRole('region', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Older' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Recall query' }), { target: { value: 'delta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('button', { name: 'Inspect memory: Delta' });
    expect(screen.queryByRole('region', { name: 'Today' })).not.toBeInTheDocument();
  });

  it('shows a relevance meter and matched terms for recall hits', async () => {
    render(<MemoryPage />);
    await screen.findByRole('button', { name: 'Inspect memory: Alpha' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Recall query' }), { target: { value: 'delta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const row = (await screen.findByRole('button', { name: 'Inspect memory: Delta' })).closest('li')!;
    expect(within(row).getByRole('meter', { name: 'Relevance 90%' })).toBeInTheDocument();
    expect(within(row).getByText('delta')).toBeInTheDocument();
    const second = screen.getByRole('button', { name: 'Inspect memory: Echo' }).closest('li')!;
    expect(within(second).getByRole('meter', { name: 'Relevance 40%' })).toBeInTheDocument();
  });

  it('moves between inspection buttons with the arrow keys without selecting', async () => {
    const user = userEvent.setup();
    render(<MemoryPage />);
    const alpha = await screen.findByRole('button', { name: 'Inspect memory: Alpha' });
    const bravo = screen.getByRole('button', { name: 'Inspect memory: Bravo' });
    alpha.focus();
    await user.keyboard('{ArrowDown}');
    expect(bravo).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(alpha).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(alpha).toHaveFocus();
    expect(alpha).toHaveAttribute('aria-pressed', 'false');
  });
});
