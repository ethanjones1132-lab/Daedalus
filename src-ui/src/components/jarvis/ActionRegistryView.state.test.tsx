import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ActionRegistryView from './ActionRegistryView';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const summary = { active: 1, blocked: 1, done: 0, pending_approvals: 0, escalated: 0, alerts: 0 };
function action(title: string) {
  return {
    id: title, title, project: 'synthetic', source_system: 'test', source_area: 'test',
    priority: 'P2', risk_level: 'low', category: 'test', action_type: 'test',
    description: 'Synthetic action', status: 'open', owner: 'test',
    approval_required: false, updated_at: '2026-09-16',
  };
}
type Alert = {
  id: string;
  kind: string;
  severity: string;
  title: string;
  message: string;
  action_id: string | null;
  count: number | null;
  created_at: string;
};
function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'escalated-action-1',
    kind: 'escalation',
    severity: 'high',
    title: 'Escalated action',
    message: 'P0 action escalated',
    action_id: 'action-1',
    count: null,
    created_at: '2026-09-24T01:00:00',
    ...overrides,
  };
}
function request() {
  return {
    summary: deferred<typeof summary>(),
    active: deferred<{ bucket: string; actions: ReturnType<typeof action>[] }>(),
    blocked: deferred<{ bucket: string; actions: ReturnType<typeof action>[] }>(),
  };
}
let requests: ReturnType<typeof request>[];
let current: ReturnType<typeof request>;
let alertRequests: ReturnType<typeof deferred<Alert[]>>[];
beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  alertRequests = [];
  invokeMock.mockReset().mockImplementation((command: string, args?: { bucket: string }) => {
    if (command === 'get_action_registry_summary') {
      current = request();
      requests.push(current);
      return current.summary.promise;
    }
    if (command === 'get_action_registry_bucket' && args?.bucket === 'active') return current.active.promise;
    if (command === 'get_action_registry_bucket' && args?.bucket === 'blocked') return current.blocked.promise;
    if (command === 'get_action_registry_alerts') {
      const next = deferred<Alert[]>();
      alertRequests.push(next);
      return next.promise;
    }
    if (command === 'sync_action_registry') return Promise.resolve({});
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
function mount() {
  render(<ToastProvider><ActionRegistryView /></ToastProvider>);
}
async function resolveRequest(index: number, label: string, empty = false) {
  await act(async () => {
    requests[index].summary.resolve(empty ? { ...summary, active: 0, blocked: 0 } : summary);
    requests[index].active.resolve({ bucket: 'active', actions: empty ? [] : [action(`${label} active`)] });
    requests[index].blocked.resolve({ bucket: 'blocked', actions: empty ? [] : [action(`${label} blocked`)] });
  });
}
async function failRequest(index: number) {
  await act(async () => { requests[index].blocked.reject(new Error('private native failure detail')); });
}
async function resolveAlerts(index: number, alerts: Alert[] = []) {
  await act(async () => { alertRequests[index].resolve(alerts); });
}
async function failAlerts(index: number) {
  await act(async () => { alertRequests[index].reject(new Error('private native alert detail')); });
}
async function poll() {
  await act(async () => { vi.advanceTimersByTime(30000); });
}

describe('ActionRegistryView snapshot recovery', () => {
  it('announces initial loading, commits all three results together, and permits successful empty buckets', async () => {
    mount();
    expect(screen.getByRole('status', { name: 'Action registry loading' })).toBeInTheDocument();
    expect(screen.queryByText('No active actions')).not.toBeInTheDocument();
    expect(invokeMock.mock.calls).toEqual([
      ['get_action_registry_summary'],
      ['get_action_registry_bucket', { bucket: 'active' }],
      ['get_action_registry_bucket', { bucket: 'blocked' }],
      ['get_action_registry_alerts'],
    ]);
    await act(async () => {
      requests[0].summary.resolve(summary);
      requests[0].active.resolve({ bucket: 'active', actions: [action('partial active')] });
    });
    expect(screen.queryByText('partial active')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Action registry loading' })).toBeInTheDocument();
    await act(async () => { requests[0].blocked.resolve({ bucket: 'blocked', actions: [] }); });
    await resolveAlerts(0);
    expect(screen.getByText('partial active')).toBeInTheDocument();
    expect(screen.getByText('No blocked actions')).toBeInTheDocument();
    expect(screen.getByText('No Action Registry alerts.')).toBeInTheDocument();
    await poll();
    await resolveRequest(1, '', true);
    await resolveAlerts(1);
    expect(screen.getByText('No active actions')).toBeInTheDocument();
    expect(screen.getByText('No blocked actions')).toBeInTheDocument();
    expect(screen.getByText('No Action Registry alerts.')).toBeInTheDocument();
  });

  it('offers immediate read-only Retry after rejection and retains the error until successful recovery', async () => {
    mount();
    await failRequest(0);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load action registry.');
    expect(screen.queryByText(/private native/)).not.toBeInTheDocument();
    expect(screen.queryByText('No active actions')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(requests).toHaveLength(2);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await resolveRequest(1, 'recovered');
    expect(screen.getByText('recovered active')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(invokeMock.mock.calls.every(([command]) => command.startsWith('get_action_registry_'))).toBe(true);
  });

  it('retains the entire previous snapshot as stale on a partial refresh failure and retries without polling', async () => {
    mount();
    await resolveRequest(0, 'known');
    await poll();
    expect(screen.getByRole('status', { name: 'Action registry loading' })).toHaveTextContent('Refreshing');
    await act(async () => {
      requests[1].summary.resolve({ ...summary, active: 99 });
      requests[1].active.resolve({ bucket: 'active', actions: [action('uncommitted active')] });
    });
    await failRequest(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Showing previously loaded action registry; it may be stale.');
    expect(screen.getByText('known active')).toBeInTheDocument();
    expect(screen.getByText('known blocked')).toBeInTheDocument();
    expect(screen.queryByText('uncommitted active')).not.toBeInTheDocument();
    expect(screen.queryByText('99')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('alert')).toHaveTextContent('stale');
    await resolveRequest(2, 'fresh');
    expect(screen.getByText('fresh active')).toBeInTheDocument();
    expect(screen.queryByText('known active')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['success', 'failure'] as const)('ignores an older poll %s after a post-sync snapshot succeeds', async (result) => {
    mount();
    await resolveRequest(0, 'initial');
    await poll();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sync Adapters' })); });
    expect(requests).toHaveLength(3);
    expect(invokeMock).toHaveBeenCalledWith('sync_action_registry');
    await resolveRequest(2, 'latest');
    if (result === 'success') await resolveRequest(1, 'obsolete');
    else await failRequest(1);
    expect(screen.getByText('latest active')).toBeInTheDocument();
    expect(screen.getByText('latest blocked')).toBeInTheDocument();
    expect(screen.queryByText('obsolete active')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Action registry loading' })).not.toBeInTheDocument();
  });

  it('does not end a newer pending poll when an older manual refresh completes', async () => {
    mount();
    await resolveRequest(0, 'known');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await poll();
    expect(requests).toHaveLength(3);
    await resolveRequest(1, 'obsolete');
    expect(screen.getByText('known active')).toBeInTheDocument();
    expect(screen.queryByText('obsolete active')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Action registry loading' })).toBeInTheDocument();
    await resolveRequest(2, 'latest');
    expect(screen.getByText('latest active')).toBeInTheDocument();
  });
});

describe('ActionRegistryView alert ledger', () => {
  it('renders every supplied alert field even when the action snapshot fails independently', async () => {
    mount();
    const escalation = alert();
    const approvalSummary = alert({
      id: 'approval-summary-2026-09-24T01:00:00',
      kind: 'approval_summary',
      severity: 'medium',
      title: 'Actions awaiting approval',
      message: '3 actions require approval before execution.',
      action_id: null,
      count: 3,
      created_at: '2026-09-24T01:00:01',
    });
    await resolveAlerts(0, [escalation, approvalSummary]);
    await failRequest(0);

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load action registry.');
    const region = screen.getByRole('region', { name: 'Action registry alerts' });
    const rows = within(region).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('severity: high');
    expect(rows[0]).toHaveTextContent('kind: escalation');
    expect(within(rows[0]).getByText('Escalated action')).toBeInTheDocument();
    expect(within(rows[0]).getByText('P0 action escalated')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('count: Not supplied');
    expect(rows[0]).toHaveTextContent('created_at: 2026-09-24T01:00:00');
    expect(rows[0]).toHaveTextContent('action_id: action-1');
    expect(rows[1]).toHaveTextContent('severity: medium');
    expect(rows[1]).toHaveTextContent('kind: approval_summary');
    expect(within(rows[1]).getByText('Actions awaiting approval')).toBeInTheDocument();
    expect(within(rows[1]).getByText('3 actions require approval before execution.')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('count: 3');
    expect(rows[1]).toHaveTextContent('created_at: 2026-09-24T01:00:01');
    expect(rows[1]).toHaveTextContent('action_id: Not supplied');
  });

  it('keeps action rows usable through alert failure and retries only the alert read', async () => {
    mount();
    await resolveRequest(0, 'known');
    await failAlerts(0);

    expect(screen.getByText('known active')).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'Action registry alerts' });
    expect(within(region).getByRole('alert')).toHaveTextContent('Could not load Action Registry alerts.');
    expect(within(region).queryByText('No Action Registry alerts.')).not.toBeInTheDocument();
    expect(screen.queryByText(/private native alert detail/)).not.toBeInTheDocument();

    const retry = within(region).getByRole('button', { name: 'Retry alerts' });
    fireEvent.click(retry);
    expect(within(region).getByRole('button', { name: 'Retry alerts' })).toBeDisabled();
    fireEvent.click(within(region).getByRole('button', { name: 'Retry alerts' }));
    expect(alertRequests).toHaveLength(2);
    expect(invokeMock.mock.calls.filter(([command]) => command.startsWith('sync_action_registry'))).toHaveLength(0);
    expect(invokeMock.mock.calls.filter(([command]) => ['update_action_approval', 'dispatch_action'].includes(command))).toHaveLength(0);
    expect(within(region).getByRole('status')).toHaveTextContent('Loading Action Registry alerts');

    await resolveAlerts(1);
    expect(within(region).getByText('No Action Registry alerts.')).toBeInTheDocument();
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retains loaded alerts as stale through refresh failure and clears them only after successful empty retry', async () => {
    mount();
    await resolveRequest(0, 'known');
    await resolveAlerts(0, [alert()]);
    const region = screen.getByRole('region', { name: 'Action registry alerts' });
    expect(within(region).getByText('Escalated action')).toBeInTheDocument();

    fireEvent.click(within(region).getByRole('button', { name: 'Refresh alerts' }));
    expect(within(region).getByText('stale')).toBeInTheDocument();
    expect(within(region).getByText('Escalated action')).toBeInTheDocument();
    await failAlerts(1);
    expect(within(region).getByRole('alert')).toHaveTextContent('Showing previously loaded alerts; they may be stale.');
    expect(within(region).getByText('Escalated action')).toBeInTheDocument();
    expect(within(region).getByText('stale')).toBeInTheDocument();

    fireEvent.click(within(region).getByRole('button', { name: 'Retry alerts' }));
    await resolveAlerts(2);
    expect(within(region).queryByRole('listitem')).not.toBeInTheDocument();
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(region).getByText('No Action Registry alerts.')).toBeInTheDocument();
  });

  it('publishes only the newest result when a manual alert read overlaps the 30-second poll', async () => {
    mount();
    await resolveRequest(0, 'known');
    await resolveAlerts(0, [alert({ id: 'initial', title: 'Initial alert' })]);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh alerts' }));
    await poll();
    expect(alertRequests).toHaveLength(3);
    await resolveAlerts(2, [alert({ id: 'latest', title: 'Latest alert' })]);
    await resolveAlerts(1, [alert({ id: 'obsolete', title: 'Obsolete alert' })]);

    const region = screen.getByRole('region', { name: 'Action registry alerts' });
    expect(within(region).getByText('Latest alert')).toBeInTheDocument();
    expect(within(region).queryByText('Obsolete alert')).not.toBeInTheDocument();
    expect(within(region).queryByText('Initial alert')).not.toBeInTheDocument();
  });
});
