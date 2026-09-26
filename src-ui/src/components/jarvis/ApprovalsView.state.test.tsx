import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApprovalsView from './ApprovalsView';
import { LIVE_GATE_CAVEAT, NO_REQUESTS_LISTED, type ApprovalRow } from './approval-queue-state';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const alpha: ApprovalRow = { id: 'a', request_type: 'tool', description: 'Alpha request', agent_id: 'agent', created_at: '', status: 'pending', tool_name: null, tool_args: null };
const beta: ApprovalRow = { ...alpha, id: 'b', description: 'Beta request' };
function row(description = alpha.description) {
  return within(screen.getByText(description).closest('li')!);
}
const decisions = () => invokeMock.mock.calls.filter(([command]) => command !== 'get_approvals');
const reads = () => invokeMock.mock.calls.filter(([command]) => command === 'get_approvals').length;
/** Route each native call through the promise the test has queued for it. */
function route(nextRead: () => Promise<ApprovalRow[]>, nextWrite: () => Promise<boolean>) {
  invokeMock.mockImplementation((command: string) => (command === 'get_approvals' ? nextRead() : nextWrite()));
}
async function mount() {
  render(<ToastProvider><ApprovalsView /></ToastProvider>);
  await screen.findByText(alpha.description);
}
function mountEmpty() {
  render(<ToastProvider><ApprovalsView /></ToastProvider>);
}
beforeEach(() => { invokeMock.mockReset(); });
afterEach(cleanup);

describe('Approval queue coverage', () => {
  it('states only what a confirmed empty read proved, and names where the live gate is', async () => {
    route(() => Promise.resolve([]), () => Promise.resolve(true));
    mountEmpty();
    expect(await screen.findByText(NO_REQUESTS_LISTED)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(NO_REQUESTS_LISTED);
    expect(screen.getByText(LIVE_GATE_CAVEAT)).toBeInTheDocument();
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });

  it.each([
    ['a null root', null],
    ['an object root', { rows: [] }],
    ['a malformed entry', [{ ...alpha, status: null }]],
    ['an entry with no id', [{ ...alpha, id: '' }]],
  ])('reads a queue delivered as %s as unavailable rather than empty', async (_label, payload) => {
    route(() => Promise.resolve(payload as ApprovalRow[]), () => Promise.resolve(true));
    mountEmpty();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load approvals');
    expect(screen.queryByText(NO_REQUESTS_LISTED)).not.toBeInTheDocument();
  });

  it('never renders the empty verdict while a read is in flight', async () => {
    const pending = deferred<ApprovalRow[]>();
    route(() => pending.promise, () => Promise.resolve(true));
    mountEmpty();
    expect(await screen.findByText('Loading approvals…')).toBeInTheDocument();
    expect(screen.queryByText(NO_REQUESTS_LISTED)).not.toBeInTheDocument();
  });
});

describe('Decision read-back', () => {
  it('keeps the request visible until a read confirms the decision landed', async () => {
    const decision = deferred<boolean>();
    const readback = deferred<ApprovalRow[]>();
    let queued: Promise<ApprovalRow[]> = Promise.resolve([alpha, beta]);
    route(() => queued, () => decision.promise);
    await mount();

    fireEvent.click(row().getByRole('button', { name: 'Approve' }));
    queued = readback.promise;
    await act(async () => { decision.resolve(true); });

    // The write resolved, but nothing has read it back yet: no success, no removal.
    expect(row().getByRole('status')).toHaveTextContent('Confirming');
    expect(screen.queryByText('Approved request')).not.toBeInTheDocument();
    expect(screen.getByText(alpha.description)).toBeInTheDocument();
    expect(reads()).toBe(2);
    expect(row().getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(row().getByRole('button', { name: 'Reject' })).toBeDisabled();

    // A second decision on the same request must not reach Native.
    fireEvent.click(row().getByRole('button', { name: 'Approve' }));
    fireEvent.click(row().getByRole('button', { name: 'Reject' }));
    expect(decisions()).toEqual([['approve_request', { id: 'a' }]]);

    await act(async () => { readback.resolve([beta]); });
    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();
    expect(screen.getByText(beta.description)).toBeInTheDocument();
    expect(screen.getByText('Approved request')).toBeInTheDocument();
  });

  it('keeps a decision visible when the read-back still lists the request', async () => {
    const decision = deferred<boolean>();
    const readback = deferred<ApprovalRow[]>();
    const retryRead = deferred<ApprovalRow[]>();
    let queued: Promise<ApprovalRow[]> = Promise.resolve([alpha]);
    route(() => queued, () => decision.promise);
    await mount();

    fireEvent.click(row().getByRole('button', { name: 'Reject' }));
    queued = readback.promise;
    await act(async () => { decision.resolve(true); });
    await act(async () => { readback.resolve([alpha, beta]); });

    expect(row().getByRole('alert')).toHaveTextContent('still listed');
    expect(screen.queryByText('Rejected request')).not.toBeInTheDocument();
    expect(row().getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(row().getByRole('button', { name: 'Reject' })).toBeDisabled();

    // Retry re-reads; it must not decide the request a second time.
    queued = retryRead.promise;
    fireEvent.click(row().getByRole('button', { name: 'Retry' }));
    expect(decisions()).toEqual([['reject_request', { id: 'a' }]]);
    expect(reads()).toBe(3);
    expect(row().getByRole('status')).toHaveTextContent('Confirming');
    expect(row().queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    await act(async () => { retryRead.resolve([]); });
    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();
    expect(screen.getByText('Rejected request')).toBeInTheDocument();
  });

  it('keeps a decision visible when the read-back itself fails, and retries it read-only', async () => {
    const decision = deferred<boolean>();
    const unreadable = deferred<ApprovalRow[]>();
    let queued: Promise<ApprovalRow[]> = Promise.resolve([alpha]);
    route(() => queued, () => decision.promise);
    await mount();

    fireEvent.click(row().getByRole('button', { name: 'Approve' }));
    queued = unreadable.promise;
    await act(async () => { decision.resolve(true); });
    await act(async () => { unreadable.reject(new Error('store.json unreadable')); });

    expect(row().getByRole('alert')).toHaveTextContent('could not be confirmed');
    expect(screen.queryByText('Approved request')).not.toBeInTheDocument();
    expect(screen.queryByText(/store\.json unreadable/)).not.toBeInTheDocument();

    queued = Promise.resolve([beta]);
    await act(async () => { fireEvent.click(row().getByRole('button', { name: 'Retry' })); });
    expect(decisions()).toEqual([['approve_request', { id: 'a' }]]);
    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();
    expect(screen.getByText('Approved request')).toBeInTheDocument();
  });

  it.each([
    ['false', false],
    ['a non-boolean result', 'ok'],
    ['no result at all', undefined],
  ])('keeps the request when the native decision write resolves with %s', async (_label, result) => {
    const decision = deferred<boolean>();
    const retry = deferred<boolean>();
    let queued: Promise<ApprovalRow[]> = Promise.resolve([alpha]);
    route(() => queued, () => decision.promise);
    await mount();

    fireEvent.click(row().getByRole('button', { name: 'Reject' }));
    await act(async () => { decision.resolve(result as boolean); });

    expect(row().getByRole('alert')).toHaveTextContent('Could not save this decision');
    expect(screen.queryByText('Rejected request')).not.toBeInTheDocument();
    expect(reads()).toBe(1);

    route(() => queued, () => retry.promise);
    fireEvent.click(row().getByRole('button', { name: 'Retry' }));
    expect(decisions()).toEqual([['reject_request', { id: 'a' }], ['reject_request', { id: 'a' }]]);
  });

  it('does not resurrect a request a read already confirmed as decided', async () => {
    const decision = deferred<boolean>();
    const settlement = deferred<ApprovalRow[]>();
    const later = deferred<ApprovalRow[]>();
    let queued: Promise<ApprovalRow[]> = Promise.resolve([alpha, beta]);
    route(() => queued, () => decision.promise);
    await mount();

    fireEvent.click(row().getByRole('button', { name: 'Approve' }));
    queued = settlement.promise;
    await act(async () => { decision.resolve(true); });
    await act(async () => { settlement.resolve([beta]); });
    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();

    queued = later.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => { later.resolve([alpha, beta]); });
    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();
    expect(screen.getByText(beta.description)).toBeInTheDocument();
    expect(screen.getByText('Approved request')).toBeInTheDocument();
  });
});

describe('Approval decision coordination', () => {
  it('keeps a pending row visible through refresh and serializes both buttons by id while other rows remain independent', async () => {
    const decision = deferred<boolean>();
    const refresh = deferred<ApprovalRow[]>();
    const settlement = deferred<ApprovalRow[]>();
    let queued: Promise<ApprovalRow[]> = Promise.resolve([alpha, beta]);
    route(() => queued, () => decision.promise);
    await mount();
    fireEvent.click(row().getByRole('button', { name: 'Approve' }));
    expect(row().getByRole('status')).toHaveTextContent('Approving');
    expect(row().getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(row().getByRole('button', { name: 'Reject' })).toBeDisabled();
    expect(screen.queryByText('Approved request')).not.toBeInTheDocument();
    queued = refresh.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(row().getByRole('status')).toHaveTextContent('Approving');
    await act(async () => { refresh.resolve([alpha, beta]); });
    fireEvent.click(row().getByRole('button', { name: 'Reject' }));
    fireEvent.click(row().getByRole('button', { name: 'Approve' }));
    expect(decisions()).toEqual([['approve_request', { id: 'a' }]]);
    fireEvent.click(row(beta.description).getByRole('button', { name: 'Reject' }));
    expect(decisions()).toEqual([['approve_request', { id: 'a' }], ['reject_request', { id: 'b' }]]);
    queued = settlement.promise;
    await act(async () => { decision.resolve(true); });
    expect(row().getByRole('status')).toHaveTextContent('Confirming');
    expect(screen.getByText(alpha.description)).toBeInTheDocument();
    await act(async () => { settlement.resolve([]); });
    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();
    expect(screen.queryByText(beta.description)).not.toBeInTheDocument();
    expect(screen.getByText('Approved request')).toBeInTheDocument();
    expect(screen.getByText('Rejected request')).toBeInTheDocument();
  });

  it('ignores older refresh results and errors without resurrecting settled requests', async () => {
    const older = deferred<ApprovalRow[]>();
    const newer = deferred<ApprovalRow[]>();
    const oldest = deferred<ApprovalRow[]>();
    const settlement = deferred<ApprovalRow[]>();
    const decision = deferred<boolean>();
    let queued: Promise<ApprovalRow[]> = Promise.resolve([alpha]);
    route(() => queued, () => decision.promise);
    await mount();
    queued = oldest.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    queued = older.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    queued = newer.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => { newer.resolve([alpha, beta]); });
    expect(screen.getByText(beta.description)).toBeInTheDocument();
    fireEvent.click(row().getByRole('button', { name: 'Approve' }));
    queued = settlement.promise;
    await act(async () => { decision.resolve(true); });
    await act(async () => { settlement.resolve([beta]); });
    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();
    expect(screen.getByText(beta.description)).toBeInTheDocument();
    expect(row(beta.description).getByRole('button', { name: 'Approve' })).toBeEnabled();
    await act(async () => { older.resolve([alpha]); oldest.reject(new Error('obsolete failure')); });
    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();
    expect(screen.queryByText(/obsolete failure/)).not.toBeInTheDocument();
  });

  it('lets only the newest read decide, so a refresh started before the decision was saved cannot settle it', async () => {
    const beforeSettlement = deferred<ApprovalRow[]>();
    const afterSettlement = deferred<ApprovalRow[]>();
    const decision = deferred<boolean>();
    let queued: Promise<ApprovalRow[]> = Promise.resolve([alpha]);
    route(() => queued, () => decision.promise);
    await mount();
    fireEvent.click(row().getByRole('button', { name: 'Approve' }));
    queued = beforeSettlement.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    queued = afterSettlement.promise;
    await act(async () => { decision.resolve(true); });
    await act(async () => { beforeSettlement.resolve([alpha, beta]); });
    expect(row().getByRole('status')).toHaveTextContent('Confirming');
    expect(screen.queryByText(beta.description)).not.toBeInTheDocument();
    await act(async () => { afterSettlement.resolve([alpha, beta]); });
    expect(row().getByRole('alert')).toHaveTextContent('still listed');
    expect(screen.queryByText('Approved request')).not.toBeInTheDocument();
  });

  it.each(['Approve', 'Reject'])('retains rejected %s decisions with safe inline retry and no premature success', async (action) => {
    const decision = deferred<boolean>();
    const retry = deferred<boolean>();
    const settlement = deferred<ApprovalRow[]>();
    let queued: Promise<ApprovalRow[]> = Promise.resolve([alpha]);
    route(() => queued, () => decision.promise);
    await mount();
    fireEvent.click(row().getByRole('button', { name: action }));
    await act(async () => { decision.reject(new Error('private native detail')); });
    expect(row().getByRole('alert')).toHaveTextContent('Could not save this decision');
    expect(screen.queryByText(/private native detail/)).not.toBeInTheDocument();
    expect(row().getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(row().getByRole('button', { name: 'Reject' })).toBeEnabled();
    queued = Promise.resolve([]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
    route(() => queued, () => retry.promise);
    fireEvent.click(row().getByRole('button', { name: 'Retry' }));
    expect(row().getByRole('button', { name: 'Retry' })).toBeDisabled();
    fireEvent.click(row().getByRole('button', { name: 'Retry' }));
    expect(decisions()).toEqual(Array(2).fill([action === 'Approve' ? 'approve_request' : 'reject_request', { id: 'a' }]));
    expect(screen.queryByText(/^(Approved|Rejected) request$/)).not.toBeInTheDocument();
    queued = settlement.promise;
    await act(async () => { retry.resolve(true); });
    expect(row().getByRole('status')).toHaveTextContent('Confirming');
    expect(screen.queryByText(alpha.description)).toBeInTheDocument();
    await act(async () => { settlement.resolve([]); });
    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();
    expect(screen.getByText(action === 'Approve' ? 'Approved request' : 'Rejected request')).toBeInTheDocument();
  });

  it('keeps a pending decision visible when refresh omits it or fails', async () => {
    const decision = deferred<boolean>();
    const unreadable = deferred<ApprovalRow[]>();
    let queued: Promise<ApprovalRow[]> = Promise.resolve([alpha]);
    route(() => queued, () => decision.promise);
    await mount();
    fireEvent.click(row().getByRole('button', { name: 'Reject' }));
    queued = Promise.resolve([]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
    expect(row().getByRole('status')).toHaveTextContent('Rejecting');
    queued = Promise.reject(new Error('refresh failed'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
    expect(row().getByRole('status')).toHaveTextContent('Rejecting');
    expect(row().getByRole('button', { name: 'Approve' })).toBeDisabled();
    queued = unreadable.promise;
    await act(async () => { decision.resolve(true); });
    expect(row().getByRole('status')).toHaveTextContent('Confirming');
    await act(async () => { unreadable.reject(new Error('private native detail')); });
    expect(row().getByRole('alert')).toHaveTextContent('could not be confirmed');
    expect(screen.queryByText('Rejected request')).not.toBeInTheDocument();
    expect(screen.queryByText(/private native detail/)).not.toBeInTheDocument();
    queued = Promise.resolve([]);
    await act(async () => { fireEvent.click(row().getByRole('button', { name: 'Retry' })); });
    expect(decisions()).toEqual([['reject_request', { id: 'a' }]]);
    expect(screen.queryByText(alpha.description)).not.toBeInTheDocument();
    expect(screen.getByText('Rejected request')).toBeInTheDocument();
  });
});
