import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MemoryView from './MemoryView';
import {
  TIER_STATS_GROUP_LABEL,
  TIER_STATS_PENDING,
  TIER_STATS_REJECTED,
  TIER_STATS_RETRY_LABEL,
  TIER_STATS_UNREADABLE,
} from './memory-tier-stats';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const entry = {
  id: 'm1',
  title: 'Recent memory',
  content: 'Recent memory content',
  tags: '[]',
  category: 'note',
  created_at: '2026-09-15T00:00:00Z',
  updated_at: '2026-09-16T00:00:00Z',
  relevance_score: 0.5,
  agent_id: 'agent-1',
  source: 'operator',
  source_session_id: 'session-1',
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
  drive_file_id: null,
  summary: '',
  archived_at: null,
  updated_at_ms: 1,
};

const list = vi.fn();
const stats = vi.fn();
const tierGroup = () => screen.queryByRole('group', { name: TIER_STATS_GROUP_LABEL });
const tierCommands = () => invokeMock.mock.calls.filter(([command]) => command === 'jarvis_get_tier_stats').length;

beforeEach(() => {
  list.mockReset().mockResolvedValue([entry]);
  stats.mockReset().mockResolvedValue({ hot: 3, warm: 2, cold: 1 });
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'list_recent_memories') return list();
    if (command === 'memory_recall_preview') return Promise.resolve([]);
    if (command === 'jarvis_get_tier_stats') return stats();
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

describe('Memory tier tally is a tracked read of its own', () => {
  it('announces a pending tier read instead of dropping the tally', async () => {
    const pending = deferred<unknown>();
    stats.mockReturnValueOnce(pending.promise);
    render(<MemoryView />);
    await screen.findByText('Recent memory');

    expect(screen.getByRole('status')).toHaveTextContent(TIER_STATS_PENDING);
    expect(tierGroup()).not.toBeInTheDocument();

    await act(async () => pending.resolve({ hot: 3, warm: 2, cold: 1 }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(tierGroup()).toHaveTextContent('hot 3');
  });

  it('announces a failed first tier read with a fixed message and a deliberate Retry', async () => {
    stats.mockRejectedValueOnce(new Error('command not found: jarvis_get_tier_stats'));
    render(<MemoryView />);
    await screen.findByText('Recent memory');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(TIER_STATS_REJECTED);
    expect(within(alert).getByRole('button', { name: TIER_STATS_RETRY_LABEL })).toBeInTheDocument();
    expect(tierGroup()).not.toBeInTheDocument();
  });

  it('never prints native error detail on the failed tier read', async () => {
    stats.mockRejectedValueOnce(new Error('command jarvis_get_tier_stats not found in registry (lib.rs:1524)'));
    render(<MemoryView />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('not found in registry');
    expect(alert.textContent).not.toContain('lib.rs');
  });

  it('a Retry re-reads only the tier command and then confirms the real counts', async () => {
    stats.mockRejectedValueOnce(new Error('locked database'));
    render(<MemoryView />);
    const alert = await screen.findByRole('alert');
    const listCallsBefore = invokeMock.mock.calls.filter(([c]) => c === 'list_recent_memories').length;

    fireEvent.click(within(alert).getByRole('button', { name: TIER_STATS_RETRY_LABEL }));
    await act(async () => {});

    expect(tierCommands()).toBe(2);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'list_recent_memories').length).toBe(listCallsBefore);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const group = tierGroup()!;
    expect(group).toHaveTextContent('hot 3');
    expect(group).toHaveTextContent('warm 2');
    expect(group).toHaveTextContent('cold 1');
  });

  it('a failed re-read keeps the confirmed counts and marks them stale', async () => {
    stats.mockResolvedValueOnce({ hot: 3, warm: 2, cold: 1 });
    render(<MemoryView />);
    await screen.findByRole('group', { name: TIER_STATS_GROUP_LABEL });

    const retry = deferred<unknown>();
    stats.mockReturnValueOnce(retry.promise).mockRejectedValueOnce(new Error('locked database'));
    // A blank search re-runs the list read, which re-reads the tiers beside it.
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Recent memory');
    await act(async () => retry.reject(new Error('locked database')));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('may be stale');
    expect(tierGroup()).toHaveTextContent('hot 3');
  });

  it('a superseded tier read cannot replace the newest confirmed counts', async () => {
    const first = deferred<unknown>();
    stats.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ hot: 5, warm: 5, cold: 5 });
    render(<MemoryView />);
    await screen.findByText('Recent memory');

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('group', { name: TIER_STATS_GROUP_LABEL });
    expect(tierGroup()).toHaveTextContent('hot 5');

    await act(async () => first.resolve({ hot: 9, warm: 9, cold: 9 }));
    expect(tierGroup()).toHaveTextContent('hot 5');
    expect(tierGroup()).not.toHaveTextContent('9');
  });

  it('prints a tier the record did not return as not supplied rather than 0', async () => {
    stats.mockResolvedValueOnce({ hot: 4, warm: 2 });
    render(<MemoryView />);
    const group = await screen.findByRole('group', { name: TIER_STATS_GROUP_LABEL });
    expect(group).toHaveTextContent('hot 4');
    expect(group).toHaveTextContent('warm 2');
    expect(group).toHaveTextContent('cold not supplied');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('announces a record it cannot read instead of printing any count from it', async () => {
    stats.mockResolvedValueOnce({ hot: 4, warm: 2, cold: 'many' });
    render(<MemoryView />);
    const group = await screen.findByRole('group', { name: TIER_STATS_GROUP_LABEL });
    expect(group).toHaveTextContent('hot 4');
    expect(group).toHaveTextContent('cold unreadable');
    expect(group).not.toHaveTextContent('many');
  });

  it('announces a payload that is not a record at all', async () => {
    stats.mockResolvedValueOnce([3, 2, 1]);
    render(<MemoryView />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(TIER_STATS_UNREADABLE);
    expect(alert).not.toHaveTextContent('TIER_STATS_UNREADABLE');
  });

  it('the list still loads when the tier read is still in flight', async () => {
    const pending = deferred<unknown>();
    stats.mockReturnValueOnce(pending.promise);
    render(<MemoryView />);
    expect(await screen.findByText('Recent memory')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
