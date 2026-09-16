import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApprovalsView from './ApprovalsView';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const alpha = { id: 'a', request_type: 'tool', description: 'Alpha request', agent_id: 'agent', created_at: '', status: 'pending', tool_name: null, tool_args: null };
const beta = { ...alpha, id: 'b', description: 'Beta request' };
function row(description = alpha.description) {
  return within(screen.getByText(description).closest('li')!);
}
const decisions = () => invokeMock.mock.calls.filter(([command]) => command !== 'get_approvals');
async function mount() {
  render(<ToastProvider><ApprovalsView /></ToastProvider>);
  await screen.findByText(alpha.description);
}
beforeEach(() => { invokeMock.mockReset(); });
afterEach(cleanup);

describe('Approval decision coordination', () => {
  it('keeps a pending row visible through refresh and serializes both buttons by id while other rows remain independent', async () => {
    const decision = deferred<boolean>();
    const refresh = deferred<typeof alpha[]>();
    invokeMock.mockImplementation((command: string) => command === 'get_approvals' ? Promise.resolve([alpha, beta]) : decision.promise);
    await mount();
    fireEvent.click(row().getByRole('button', { name: 'Approve' }));
    expect(row().getByRole('status')).toHaveTextContent('Approving');
    expect(row().getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(row().getByRole('button', { name: 'Reject' })).toBeDisabled();
    expect(screen.queryByText('Approved request')).not.toBeInTheDocument();
    invokeMock.mockImplementation((command: string) => command === 'get_approvals' ? refresh.promise : decision.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(row().getByRole('status')).toHaveTextContent('Approving');
    await act(async () => { refresh.resolve([alpha, beta]); });
    fireEvent.click(row().getByRole('button', { name: 'Reject' }));
    fireEvent.click(row().getByRole('button', { name: 'Approve' }));
    expect(decisions()).toEqual([['approve_request', { id: 'a' }]]);
    fireEvent.click(row(beta.description).getByRole('button', { name: 'Reject' }));
    expect(decisions()).toEqual([['approve_request', { id: 'a' }], ['reject_request', { id: 'b' }]]);
    await act(async () => { decision.resolve(true); });
    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();
    expect(screen.queryByText(beta.description)).not.toBeInTheDocument();
    expect(screen.getByText('Approved request')).toBeInTheDocument();
    expect(screen.getByText('Rejected request')).toBeInTheDocument();
  });

  it('ignores older refresh results and errors without resurrecting settled requests', async () => {
    const older = deferred<typeof alpha[]>();
    const newer = deferred<typeof alpha[]>();
    const oldest = deferred<typeof alpha[]>();
    const decision = deferred<boolean>();
    invokeMock.mockResolvedValue([alpha]);
    await mount();
    invokeMock.mockImplementationOnce(() => oldest.promise).mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => { newer.resolve([alpha, beta]); });
    invokeMock.mockImplementation(() => decision.promise);
    fireEvent.click(row().getByRole('button', { name: 'Approve' }));
    await act(async () => { decision.resolve(true); older.resolve([alpha]); oldest.reject(new Error('obsolete failure')); });
    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();
    expect(row(beta.description).getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.queryByText(/obsolete failure/)).not.toBeInTheDocument();
  });

  it('filters a refresh started before settlement even when it is the newest list request', async () => {
    const refresh = deferred<typeof alpha[]>();
    const decision = deferred<boolean>();
    invokeMock.mockImplementation((command: string) => command === 'get_approvals' ? Promise.resolve([alpha]) : decision.promise);
    await mount();
    fireEvent.click(row().getByRole('button', { name: 'Approve' }));
    invokeMock.mockImplementation(() => refresh.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => { decision.resolve(true); });
    await act(async () => { refresh.resolve([alpha, beta]); });
    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();
    expect(screen.getByText(beta.description)).toBeInTheDocument();
  });

  it.each(['Approve', 'Reject'])('retains rejected %s decisions with safe inline retry and no premature success', async (action) => {
    const decision = deferred<boolean>();
    const retry = deferred<boolean>();
    invokeMock.mockImplementation((command: string) => command === 'get_approvals' ? Promise.resolve([alpha]) : decision.promise);
    await mount();
    fireEvent.click(row().getByRole('button', { name: action }));
    await act(async () => { decision.reject(new Error('private native detail')); });
    expect(row().getByRole('alert')).toHaveTextContent('Could not save this decision');
    expect(screen.queryByText(/private native detail/)).not.toBeInTheDocument();
    expect(row().getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(row().getByRole('button', { name: 'Reject' })).toBeEnabled();
    invokeMock.mockImplementation((command: string) => command === 'get_approvals' ? Promise.resolve([]) : retry.promise);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
    fireEvent.click(row().getByRole('button', { name: 'Retry' }));
    expect(row().getByRole('button', { name: 'Retry' })).toBeDisabled();
    fireEvent.click(row().getByRole('button', { name: 'Retry' }));
    expect(decisions()).toEqual(Array(2).fill([action === 'Approve' ? 'approve_request' : 'reject_request', { id: 'a' }]));
    expect(screen.queryByText(/^(Approved|Rejected) request$/)).not.toBeInTheDocument();
    await act(async () => { retry.resolve(true); });
    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();
    expect(screen.getByText(action === 'Approve' ? 'Approved request' : 'Rejected request')).toBeInTheDocument();
  });

  it('keeps a pending decision visible when refresh omits it or fails', async () => {
    const decision = deferred<boolean>();
    invokeMock.mockImplementation((command: string) => command === 'get_approvals' ? Promise.resolve([alpha]) : decision.promise);
    await mount();
    fireEvent.click(row().getByRole('button', { name: 'Reject' }));
    invokeMock.mockResolvedValue([]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
    expect(row().getByRole('status')).toHaveTextContent('Rejecting');
    invokeMock.mockRejectedValue(new Error('refresh failed'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
    expect(row().getByRole('status')).toHaveTextContent('Rejecting');
    expect(row().getByRole('button', { name: 'Approve' })).toBeDisabled();
    await act(async () => { decision.resolve(true); });
    expect(screen.getByText('Rejected request')).toBeInTheDocument();
  });
});
