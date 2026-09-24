import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ActionRegistryView from './ActionRegistryView';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

type Action = {
  id: string;
  title: string;
  project: string;
  source_system: string;
  source_area: string;
  priority: string;
  risk_level: string;
  category: string;
  action_type: string;
  description: string;
  status: string;
  owner: string;
  approval_required: boolean;
  approval_status?: string;
  updated_at: string;
};

type Summary = {
  active: number;
  blocked: number;
  done: number;
  pending_approvals: number;
  escalated: number;
  alerts: number;
};

type Bucket = { bucket: string; actions: Action[] };
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};
type ReadRequest = {
  summary: Deferred<Summary>;
  active: Deferred<Bucket>;
  blocked: Deferred<Bucket>;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const action = (id: string, title: string, approvalRequired = false): Action => ({
  id,
  title,
  project: 'synthetic',
  source_system: 'test',
  source_area: 'test',
  priority: 'P2',
  risk_level: 'low',
  category: 'test',
  action_type: 'test',
  description: `Description for ${title}`,
  status: 'open',
  owner: 'test',
  approval_required: approvalRequired,
  ...(approvalRequired ? { approval_status: 'pending' } : {}),
  updated_at: '2026-09-23',
});

const alpha = action('alpha', 'Alpha');
const beta = action('beta', 'Beta', true);
const blocked = action('blocked', 'Blocked');
const unavailableDispatch = { status: 'unavailable', code: 'verification_manifest_missing' } as const;

let reads: ReadRequest[] = [];
let latestRead: ReadRequest;
let nextWrite: Deferred<unknown> | null = null;

function summaryFor(active: Action[], blockedActions: Action[]): Summary {
  return {
    active: active.length,
    blocked: blockedActions.length,
    done: 0,
    pending_approvals: [...active, ...blockedActions].filter(item => item.approval_required && item.approval_status !== 'approved' && item.approval_status !== 'waived').length,
    escalated: 0,
    alerts: 0,
  };
}

beforeEach(() => {
  reads = [];
  nextWrite = null;
  invokeMock.mockReset().mockImplementation((command: string, args?: { bucket?: string }) => {
    if (command === 'get_action_registry_summary') {
      latestRead = {
        summary: deferred<Summary>(),
        active: deferred<Bucket>(),
        blocked: deferred<Bucket>(),
      };
      reads.push(latestRead);
      return latestRead.summary.promise;
    }
    if (command === 'get_action_registry_bucket' && args?.bucket === 'active') return latestRead.active.promise;
    if (command === 'get_action_registry_bucket' && args?.bucket === 'blocked') return latestRead.blocked.promise;
    if (command === 'sync_action_registry') return nextWrite?.promise ?? Promise.resolve({ synced: true });
    if (command === 'update_action_approval' || command === 'dispatch_action') return nextWrite?.promise ?? Promise.resolve(command === 'dispatch_action' ? unavailableDispatch : true);
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => cleanup());

async function resolveRead(index: number, active: Action[], blockedActions: Action[] = []) {
  const request = reads[index];
  await act(async () => {
    request.summary.resolve(summaryFor(active, blockedActions));
    request.active.resolve({ bucket: 'active', actions: active });
    request.blocked.resolve({ bucket: 'blocked', actions: blockedActions });
  });
}

async function failRead(index: number) {
  const request = reads[index];
  await act(async () => request.blocked.reject(new Error('private native readback detail')));
}

async function mount() {
  render(<ToastProvider><ActionRegistryView /></ToastProvider>);
  await resolveRead(0, [alpha, beta], [blocked]);
  await screen.findByText('Alpha');
}

function queueWrite(): Deferred<unknown> {
  const pending = deferred<unknown>();
  nextWrite = pending;
  return pending;
}

function mutationCalls() {
  return invokeMock.mock.calls.filter(([command]) => ['sync_action_registry', 'update_action_approval', 'dispatch_action'].includes(command));
}

describe('ActionRegistryView mutation coordination', () => {
  it('serializes sync, approval, waiver, and dispatch through one confirmed snapshot lifetime', async () => {
    await mount();
    const write = queueWrite();
    fireEvent.click(screen.getByRole('button', { name: 'Approve Beta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Waive Beta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sync Adapters' }));

    expect(mutationCalls()).toEqual([
      ['update_action_approval', { actionId: 'beta', status: 'approved' }],
    ]);
    expect(screen.getByRole('status', { name: 'Action registry mutation' })).toHaveTextContent('Approving');
    expect(screen.getByRole('button', { name: 'Approve Beta' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sync Adapters' })).toBeDisabled();
    expect(screen.queryByText('Action approved successfully.')).not.toBeInTheDocument();

    await act(async () => write.resolve(true));
    expect(reads).toHaveLength(2);
    expect(screen.queryByText('Action approved successfully.')).not.toBeInTheDocument();
    await resolveRead(1, [{ ...beta, approval_status: 'approved' }, alpha], [blocked]);
    expect(screen.getByText('Action approved successfully.')).toBeInTheDocument();
  });

  it.each([
    { label: 'rejected approval', command: 'update_action_approval', button: 'Approve Beta', outcome: 'reject' },
    { label: 'false approval', command: 'update_action_approval', button: 'Approve Beta', outcome: 'false' },
    { label: 'rejected dispatch', command: 'dispatch_action', button: 'Dispatch Alpha', outcome: 'reject' },
    { label: 'false dispatch', command: 'dispatch_action', button: 'Dispatch Alpha', outcome: 'false' },
  ] as const)('keeps the last confirmed snapshot when a $label write fails', async ({ command, button, outcome }) => {
    await mount();
    const write = queueWrite();
    fireEvent.click(screen.getByRole('button', { name: button }));
    await act(async () => {
      if (outcome === 'reject') write.reject(new Error('private native mutation detail'));
      else write.resolve(false);
    });

    expect(screen.getByText(button === 'Approve Beta' ? 'Beta' : 'Alpha')).toBeInTheDocument();
    expect(screen.getByRole('alert', { name: 'Action registry mutation' })).toHaveTextContent('Previous snapshot was kept.');
    expect(screen.queryByText('Action dispatched and verified.')).not.toBeInTheDocument();
    expect(screen.queryByText('private native mutation detail')).not.toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry' });
    const next = queueWrite();
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(mutationCalls()).toHaveLength(2);
    await act(async () => next.resolve(command === 'dispatch_action' ? unavailableDispatch : true));
  });

  it('keeps an approved action active when dispatch is unavailable and offers read-only recovery', async () => {
    await mount();
    const write = queueWrite();
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch Alpha' }));
    await act(async () => write.resolve(unavailableDispatch));

    expect(screen.getByRole('alert', { name: 'Action registry mutation' })).toHaveTextContent(
      'Action dispatch is unavailable because no authoritative verification path is configured. Registry data was not changed.',
    );
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Action dispatched and verified.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dispatch Alpha' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(reads).toHaveLength(2);
    expect(mutationCalls()).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith('dispatch_action', { actionId: 'alpha' });
    await resolveRead(1, [alpha, beta], [blocked]);
    expect(screen.queryByRole('alert', { name: 'Action registry mutation' })).not.toBeInTheDocument();
    expect(screen.queryByText('Action dispatched and verified.')).not.toBeInTheDocument();
  });

  it('does not treat an evidence-free dispatch response as verification', async () => {
    await mount();
    const write = queueWrite();
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch Alpha' }));
    await act(async () => write.resolve({}));

    expect(screen.getByRole('alert', { name: 'Action registry mutation' })).toHaveTextContent(
      'Action dispatch is unavailable because no authoritative verification path is configured. Registry data was not changed.',
    );
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Action dispatched and verified.')).not.toBeInTheDocument();
  });

  it('does not announce a confirmed write until readback and retries a failed read without rewriting', async () => {
    await mount();
    const write = queueWrite();
    fireEvent.click(screen.getByRole('button', { name: 'Approve Beta' }));
    await act(async () => write.resolve(true));

    expect(reads).toHaveLength(2);
    expect(screen.queryByText('Action approved successfully.')).not.toBeInTheDocument();
    await failRead(1);
    expect(screen.getByRole('alert', { name: 'Action registry mutation' })).toHaveTextContent(/saved.*reconcil/i);
    expect(screen.getByRole('button', { name: 'Approve Beta' })).toBeDisabled();
    expect(screen.queryByText('private native readback detail')).not.toBeInTheDocument();

    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(reads).toHaveLength(3);
    expect(mutationCalls()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Approve Beta' })).toBeDisabled();
    await resolveRead(2, [{ ...beta, approval_status: 'approved' }, alpha], [blocked]);
    expect(screen.getByText('Action approved successfully.')).toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: 'Action registry mutation' })).not.toBeInTheDocument();
  });

  it('ignores a pre-write read that completes during a mutation and publishes only post-write confirmation', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(reads).toHaveLength(2);
    const write = queueWrite();
    fireEvent.click(screen.getByRole('button', { name: 'Approve Beta' }));
    await resolveRead(1, [action('stale', 'Stale')], []);
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    await act(async () => write.resolve(true));
    expect(reads).toHaveLength(3);
    await resolveRead(2, [{ ...beta, approval_status: 'approved' }, alpha], [blocked]);
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('only exposes dispatch for the active bucket', async () => {
    await mount();
    expect(screen.getByRole('button', { name: 'Dispatch Alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dispatch Blocked' })).not.toBeInTheDocument();
  });
});
