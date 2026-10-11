import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApprovalsPage from './ApprovalsPage';
import { ToastProvider } from '../../design';
import type { ApprovalRow } from '../../domain/approval-queue-state';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const alpha: ApprovalRow = {
  id: 'a', request_type: 'tool', description: 'Alpha request', agent_id: 'forge',
  created_at: '', status: 'pending', tool_name: 'shell.exec', tool_args: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => invokeMock.mockReset());
afterEach(cleanup);

describe('Approvals page', () => {
  it('names the legacy store, and keeps a confirmed decision in this visit\'s history', async () => {
    let queue: ApprovalRow[] = [alpha];
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_approvals') return queue;
      queue = [];
      return true;
    });
    render(<ToastProvider><ApprovalsPage /></ToastProvider>);
    await screen.findByText(alpha.description);

    expect(screen.getByText(/legacy approval store/i)).toBeInTheDocument();
    expect(screen.getByText(/Session turn/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Decided this visit' })).not.toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reject' })); });

    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();
    const history = screen.getByRole('region', { name: 'Decided this visit' });
    expect(within(history).getByText('Rejected')).toBeInTheDocument();
    expect(within(history).getByText('shell.exec')).toBeInTheDocument();
    expect(within(history).getByText('agent forge')).toBeInTheDocument();
  });

  it('does not show a zero count before the first read has answered', async () => {
    const first = deferred<ApprovalRow[]>();
    invokeMock.mockImplementation(() => first.promise);
    render(<ToastProvider><ApprovalsPage /></ToastProvider>);
    expect(screen.getByText('—')).toBeInTheDocument();
    await act(async () => { first.resolve([]); });
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });
});
