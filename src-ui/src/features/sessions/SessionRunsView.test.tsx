import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionRunsView from './SessionRunsView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const run = (over: Record<string, unknown> = {}) => ({
  session_id: 's-1',
  run_id: 'r1',
  outcome: 'success',
  selected_model: 'test-model',
  token_count: 10,
  tool_count: 2,
  ...over,
});

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(cleanup);

describe('SessionRunsView reads the recorded runs of one Session', () => {
  it('reads through the existing per-Session command and shows every durable run id', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_session_runs') {
        return [run(), run({ run_id: 'r0', outcome: 'partial' })];
      }
      return [];
    });
    render(<SessionRunsView sessionId="s-1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Reading recorded runs…');
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'get_session_runs',
      expect.objectContaining({ session_id: 's-1' }),
    ));
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('run r1');
    expect(items[0]).toHaveTextContent('10 tokens');
    expect(items[1]).toHaveTextContent('run r0');
  });

  it('reads a confirmed empty result as no runs recorded', async () => {
    invokeMock.mockImplementation(async () => []);
    render(<SessionRunsView sessionId="s-1" />);
    await waitFor(() => expect(screen.getByText('No runs recorded for this Session.')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('never shows a failed read as an empty run history', async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error('sqlite: /Users/operator/.openclaw/jarvis.db is locked');
    });
    render(<SessionRunsView sessionId="s-1" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not read the recorded runs for this Session.',
    ));
    expect(screen.queryByText('No runs recorded for this Session.')).not.toBeInTheDocument();
    // Native error detail never reaches the surface.
    expect(screen.getByRole('alert').textContent).not.toContain('jarvis.db');
  });

  it('treats an undecodable read as unavailable rather than as no runs', async () => {
    invokeMock.mockImplementation(async () => ({ rows: [] }));
    render(<SessionRunsView sessionId="s-1" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText('No runs recorded for this Session.')).not.toBeInTheDocument();
  });

  it('re-reads on a deliberate retry and recovers', async () => {
    let attempt = 0;
    invokeMock.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('locked');
      return [run({ run_id: 'r9' })];
    });
    render(<SessionRunsView sessionId="s-1" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Retry recorded runs' }));
    await waitFor(() => expect(screen.getByRole('listitem')).toHaveTextContent('run r9'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([command]) => command === 'get_session_runs')).toHaveLength(2);
  });
});
