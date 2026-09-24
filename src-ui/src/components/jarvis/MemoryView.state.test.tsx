import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MemoryView from './MemoryView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const entry = (title: string) => ({
  id: title,
  title,
  content: `${title} content`,
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
});
const list = vi.fn();
const recall = vi.fn();
const recallEntry = (title: string) => ({ memory: entry(title), score: 0.9, matched_terms: [] });
function search(query: string, enter = false) {
  const input = screen.getByPlaceholderText('Recall by query…');
  fireEvent.change(input, { target: { value: query } });
  if (enter) fireEvent.keyDown(input, { key: 'Enter' });
  else fireEvent.click(screen.getByRole('button', { name: 'Search' }));
}

beforeEach(() => {
  list.mockReset().mockResolvedValue([entry('Recent memory')]);
  recall.mockReset();
  invokeMock.mockReset().mockImplementation((command: string, args?: { query: string }) => {
    if (command === 'list_recent_memories') return list();
    if (command === 'memory_recall_preview') return recall(args!.query);
    if (command === 'jarvis_get_tier_stats') return Promise.resolve({ hot: 1, warm: 0, cold: 0 });
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

describe('Memory recall request honesty', () => {
  it('shows persistent query-specific failure and retries the failed query, not the edited input', async () => {
    const first = deferred<unknown[]>();
    const retry = deferred<unknown[]>();
    recall.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    render(<MemoryView />);
    await screen.findByText('Recent memory');
    search('alpha');
    expect(screen.getByRole('status')).toHaveTextContent('Recalling memories');
    expect(screen.queryByText('Recent memory')).not.toBeInTheDocument();
    await act(async () => first.reject(new Error('offline')));
    expect(screen.getByRole('alert')).toHaveTextContent('Memory recall failed for "alpha"');
    expect(screen.queryByText('No memories match the current query.')).not.toBeInTheDocument();
    expect(screen.queryByText('Recent memory')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Recall by query…'), { target: { value: 'unsent draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(recall.mock.calls).toEqual([['alpha'], ['alpha']]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    await act(async () => retry.resolve([recallEntry('Recovered recall')]));
    expect(screen.getByText('Recovered recall')).toBeInTheDocument();
    expect(screen.getByText('Results for "alpha"')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each(['resolve', 'reject'] as const)('ignores a late initial list %s after recall succeeds', async (completion) => {
    const initial = deferred<unknown[]>();
    const request = deferred<unknown[]>();
    list.mockReturnValueOnce(initial.promise);
    recall.mockReturnValueOnce(request.promise);
    render(<MemoryView />);
    search('alpha');
    await act(async () => request.resolve([recallEntry('Recall hit')]));
    await act(async () => {
      if (completion === 'resolve') initial.resolve([entry('Old list')]);
      else initial.reject(new Error('old list failure'));
    });
    expect(screen.getByText('Recall hit')).toBeInTheDocument();
    expect(screen.queryByText('Old list')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['resolve', 'reject'] as const)('ignores an earlier recall %s while a newer recall is pending', async (completion) => {
    const first = deferred<unknown[]>();
    const second = deferred<unknown[]>();
    recall.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<MemoryView />);
    await screen.findByText('Recent memory');
    search('alpha');
    search('beta', true);
    await act(async () => {
      if (completion === 'resolve') first.resolve([recallEntry('Alpha result')]);
      else first.reject(new Error('old recall failure'));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Recalling memories');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Alpha result')).not.toBeInTheDocument();
    await act(async () => second.resolve([recallEntry('Beta result')]));
    expect(screen.getByText('Beta result')).toBeInTheDocument();
    expect(screen.getByText('Results for "beta"')).toBeInTheDocument();
  });

  it('ignores a late recall after a blank query switches back to the list', async () => {
    const request = deferred<unknown[]>();
    recall.mockReturnValueOnce(request.promise);
    render(<MemoryView />);
    await screen.findByText('Recent memory');
    search('alpha');
    search('   ');
    await screen.findByText('Recent memory');
    await act(async () => request.resolve([recallEntry('Old recall')]));
    expect(screen.getByText('Recent memory')).toBeInTheDocument();
    expect(screen.queryByText('Old recall')).not.toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('recovers from initial list failure through a successful recall', async () => {
    list.mockRejectedValueOnce(new Error('sqlite unavailable'));
    recall.mockResolvedValueOnce([recallEntry('Recall hit')]);
    render(<MemoryView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load memories');
    search('alpha');
    expect(await screen.findByText('Recall hit')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries an initial list failure using the list command', async () => {
    list.mockRejectedValueOnce(new Error('sqlite unavailable'));
    render(<MemoryView />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Recent memory');
    expect(list).toHaveBeenCalledTimes(2);
    expect(recall).not.toHaveBeenCalled();
  });

  it('shows empty only after successful empty recall and labels the submitted query', async () => {
    const request = deferred<unknown[]>();
    recall.mockReturnValueOnce(request.promise);
    render(<MemoryView />);
    await screen.findByText('Recent memory');
    search('empty');
    expect(screen.queryByText('No memories match the current query.')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Recalling memories');
    await act(async () => request.resolve([]));
    expect(screen.getByText('No memories match the current query.')).toBeInTheDocument();
    expect(screen.getByText('Results for "empty"')).toBeInTheDocument();
  });
});
