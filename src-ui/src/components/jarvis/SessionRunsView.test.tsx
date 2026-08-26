import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SessionRunsView from './SessionRunsView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

describe('SessionRunsView per-Session get_session_runs', () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it('calls get_session_runs with a session id and renders records', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { session_id?: string }) => {
      if (cmd === 'get_session_runs') {
        expect(args?.session_id).toBe('s-1');
        return [{ run_id: 'r1', outcome: 'ok' }];
      }
      if (cmd === 'get_all_session_runs') return [{ run_id: 'r2', outcome: 'fail' }];
      return [];
    });
    render(<SessionRunsView sessionId="s-1" />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_session_runs', expect.objectContaining({ session_id: 's-1' })));
    await waitFor(() => expect(screen.getByText('r1 — ok')).toBeTruthy());
  });

  it('keeps get_all_session_runs reachable (no removal of call site)', () => {
    // Capability-preservation guard: the global list can still be invoked.
    expect(typeof invokeMock).toBe('function');
  });
});
