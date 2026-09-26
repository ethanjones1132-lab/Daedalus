import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommitmentsView from './CommitmentsView';
import DevicesView from './DevicesView';
import HooksView from './HooksView';
import NodesView from './NodesView';
import RecordIdBadge from './RecordIdBadge';
import { createFailureSentence } from './create-readback';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const clipboardWriteMock = vi.fn();

beforeEach(() => {
  clipboardWriteMock.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWriteMock },
    configurable: true,
  });
  invokeMock.mockReset().mockImplementation((command: string) => {
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

interface Surface {
  View: React.ComponentType;
  resource: 'device' | 'node' | 'hook' | 'commitment';
  list: string;
  create: string;
  field: string;
  extraField?: string;
  extraDraft?: string;
  button: string;
  pending: string;
  retryLabel: string;
  labelField: string;
  draft: string;
  stored: Record<string, unknown> & { id: string };
  success: string;
  idLabel: string;
}

const SURFACES: Surface[] = [
  {
    View: DevicesView,
    resource: 'device',
    list: 'get_devices',
    create: 'add_device',
    field: 'Device name',
    button: 'Add',
    pending: 'Adding…',
    retryLabel: 'Retry adding the device',
    labelField: 'name',
    draft: 'studio-mac',
    stored: { id: 'dev-1', name: 'studio-mac', device_type: 'desktop', status: 'online', last_seen: new Date().toISOString() },
    success: 'Added device studio-mac',
    idLabel: 'Copy device id',
  },
  {
    View: NodesView,
    resource: 'node',
    list: 'get_nodes',
    create: 'add_node',
    field: 'Node name',
    extraField: 'Address (host:port)',
    extraDraft: '10.0.0.5:7000',
    button: 'Add',
    pending: 'Adding…',
    retryLabel: 'Retry adding the node',
    labelField: 'name',
    draft: 'edge-1',
    stored: { id: 'node-1', name: 'edge-1', address: '10.0.0.5:7000', status: 'unknown', latency_ms: null, last_ping: '', capabilities: [] },
    success: 'Added node edge-1',
    idLabel: 'Copy node id',
  },
  {
    View: HooksView,
    resource: 'hook',
    list: 'get_hooks',
    create: 'register_hook',
    field: 'Hook name',
    extraField: 'Script / command (optional)',
    extraDraft: 'run.sh',
    button: 'Register',
    pending: 'Registering…',
    retryLabel: 'Retry registering the hook',
    labelField: 'name',
    draft: 'on-start',
    stored: { id: 'hook-1', name: 'on-start', event: 'session.start', script: 'run.sh', enabled: true, created_at: '' },
    success: 'Registered hook on-start',
    idLabel: 'Copy hook id',
  },
  {
    View: CommitmentsView,
    resource: 'commitment',
    list: 'get_commitments',
    create: 'add_commitment',
    field: 'What needs to be done?',
    button: 'Add',
    pending: 'Adding…',
    retryLabel: 'Retry adding the commitment',
    labelField: 'text',
    draft: 'Ship the weekly report',
    stored: { id: 'commit-1', text: 'Ship the weekly report', status: 'open', due: null, created_at: '', completed_at: null, agent_id: null },
    success: 'Commitment added',
    idLabel: 'Copy commitment id',
  },
];

function fillDraft(surface: Surface) {
  fireEvent.change(screen.getByPlaceholderText(surface.field), { target: { value: surface.draft } });
  if (surface.extraField) {
    fireEvent.change(screen.getByPlaceholderText(surface.extraField), { target: { value: surface.extraDraft } });
  }
}

/** Empty first read, a deferred create, and a deferred second (confirming) read. */
function stageCreate(surface: Surface) {
  const creation = deferred<unknown>();
  const confirming = deferred<unknown>();
  let listCalls = 0;
  invokeMock.mockImplementation((command: string) => {
    if (command === surface.list) {
      listCalls += 1;
      return listCalls === 1 ? Promise.resolve([]) : confirming.promise;
    }
    if (command === surface.create) return creation.promise;
    throw new Error(`Unexpected command: ${command}`);
  });
  return { creation, confirming, createCalls: () => invokeMock.mock.calls.filter(([c]) => c === surface.create).length };
}

async function renderSurface(surface: Surface) {
  render(
    <ToastProvider>
      <surface.View />
    </ToastProvider>,
  );
  await screen.findByRole('button', { name: surface.button });
}

function createAlert() {
  const found = screen.getAllByRole('alert').filter(node => /draft was kept/.test(node.textContent ?? ''));
  expect(found).toHaveLength(1);
  return found[0];
}

function submit(surface: Surface) {
  fireEvent.change(screen.getByPlaceholderText(surface.field), { target: { value: surface.draft } });
  if (surface.extraField) {
    fireEvent.change(screen.getByPlaceholderText(surface.extraField), { target: { value: surface.extraDraft } });
  }
  fireEvent.click(screen.getByRole('button', { name: surface.button }));
}

describe.each(SURFACES)('$resource create read-back', (surface) => {
  it('announces success only after a confirming read that contains the record', async () => {
    const { creation, confirming } = stageCreate(surface);
    await renderSurface(surface);
    fillDraft(surface);
    fireEvent.click(screen.getByRole('button', { name: surface.button }));

    // The write is in flight: nothing is announced and the draft is intact.
    expect(screen.queryByText(surface.success)).not.toBeInTheDocument();
    await act(async () => { creation.resolve(surface.stored); });

    // The write resolved, but nothing has confirmed it yet.
    expect(screen.queryByText(surface.success)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => { confirming.resolve([surface.stored]); });
    expect(screen.getByText(surface.success)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(surface.field)).toHaveValue('');
    // The confirmed row carries the id Native assigned, and the operator can copy it.
    expect(screen.getByTestId('record-id')).toHaveTextContent(surface.stored.id);
    expect(screen.getByRole('button', { name: surface.idLabel })).toBeInTheDocument();
  });

  it('refuses to report success when the confirmed read does not contain the record', async () => {
    const { creation, confirming } = stageCreate(surface);
    await renderSurface(surface);
    submit(surface);
    await act(async () => { creation.resolve(surface.stored); });
    await act(async () => { confirming.resolve([]); });

    expect(screen.queryByText(surface.success)).not.toBeInTheDocument();
    expect(createAlert()).toHaveTextContent(createFailureSentence(surface.resource, 'unconfirmed'));
    // The draft survives so the write can be repeated deliberately.
    expect(screen.getByPlaceholderText(surface.field)).toHaveValue(surface.draft);
    expect(screen.getByRole('button', { name: surface.retryLabel })).toBeInTheDocument();
    expect(screen.queryByTestId('record-id')).not.toBeInTheDocument();
  });

  it('announces a successful write that no read could confirm', async () => {
    const { creation, confirming } = stageCreate(surface);
    await renderSurface(surface);
    submit(surface);
    await act(async () => { creation.resolve(surface.stored); });
    await act(async () => { confirming.reject(new Error('store locked: api_key=sk-leaked')); });

    expect(screen.queryByText(surface.success)).not.toBeInTheDocument();
    const alert = createAlert();
    expect(alert).toHaveTextContent(createFailureSentence(surface.resource, 'unavailable'));
    // The create alert never repeats what the failing call said.
    expect(alert).not.toHaveTextContent('store locked');
    expect(alert).not.toHaveTextContent('sk-leaked');
    expect(screen.getByPlaceholderText(surface.field)).toHaveValue(surface.draft);
  });

  it('announces a write that returned no record to confirm', async () => {
    const { creation, confirming } = stageCreate(surface);
    await renderSurface(surface);
    submit(surface);
    await act(async () => { creation.resolve({ name: surface.draft }); });
    await act(async () => { confirming.resolve([surface.stored]); });

    expect(screen.queryByText(surface.success)).not.toBeInTheDocument();
    expect(createAlert()).toHaveTextContent(createFailureSentence(surface.resource, 'unreadable'));
    expect(screen.getByPlaceholderText(surface.field)).toHaveValue(surface.draft);
  });

  it('reports the stored row when the confirming read disagrees with the write', async () => {
    const disagreeing = { ...surface.stored, [surface.labelField]: `${surface.draft} (stored)` };
    const { creation, confirming } = stageCreate(surface);
    await renderSurface(surface);
    submit(surface);
    await act(async () => { creation.resolve(surface.stored); });
    await act(async () => { confirming.resolve([disagreeing]); });

    // Confirmed, but rendered and announced from the stored record, not the draft.
    expect(screen.getByText(`${surface.draft} (stored)`)).toBeInTheDocument();
    if (surface.success.includes(surface.draft)) {
      expect(screen.getByText(surface.success.replace(surface.draft, `${surface.draft} (stored)`))).toBeInTheDocument();
    }
    expect(screen.getByPlaceholderText(surface.field)).toHaveValue('');
  });

  it('blocks a second create while the confirming read is in flight', async () => {
    const { creation, confirming, createCalls } = stageCreate(surface);
    await renderSurface(surface);
    submit(surface);
    await act(async () => { creation.resolve(surface.stored); });

    expect(screen.getByRole('button', { name: surface.pending })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: surface.pending }));
    fireEvent.keyDown(screen.getByPlaceholderText(surface.field), { key: 'Enter' });
    expect(createCalls()).toBe(1);

    await act(async () => { confirming.resolve([surface.stored]); });
    expect(createCalls()).toBe(1);
    expect(screen.getByText(surface.success)).toBeInTheDocument();
  });

  it('re-issues the create exactly once from the retained draft, and cannot re-issue it twice', async () => {
    const { creation, confirming, createCalls } = stageCreate(surface);
    await renderSurface(surface);
    submit(surface);
    await act(async () => { creation.resolve(surface.stored); });
    await act(async () => { confirming.reject(new Error('read unavailable')); });
    expect(createCalls()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: surface.retryLabel }));
    expect(createCalls()).toBe(2);
    // The retry repeats exactly the write the first attempt issued, and is
    // itself guarded: neither the pending button nor Enter issues a third.
    const issued = invokeMock.mock.calls.filter(([c]) => c === surface.create);
    expect(issued[1][1]).toEqual(issued[0][1]);
    fireEvent.click(screen.getByRole('button', { name: surface.pending }));
    fireEvent.keyDown(screen.getByPlaceholderText(surface.field), { key: 'Enter' });
    expect(createCalls()).toBe(2);
  });

  it('keeps the list retry read-only: it reloads without re-issuing the create', async () => {
    const reload = deferred<unknown>();
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === surface.list) {
        listCalls += 1;
        if (listCalls === 1) return Promise.resolve([]);
        if (listCalls === 2) return Promise.reject(new Error('read unavailable'));
        return reload.promise;
      }
      if (command === surface.create) return Promise.resolve(surface.stored);
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderSurface(surface);
    submit(surface);
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));

    const createRetries = screen.queryByRole('button', { name: surface.retryLabel });
    expect(createRetries).toBeInTheDocument();
    const listRetries = screen.getAllByRole('button', { name: 'Retry' });
    expect(listRetries).toHaveLength(1);
    fireEvent.click(listRetries[0]);
    expect(invokeMock.mock.calls.filter(([c]) => c === surface.create)).toHaveLength(1);
    await act(async () => { reload.resolve([surface.stored]); });
    expect(screen.getByTestId('record-id')).toHaveTextContent(surface.stored.id);
  });
});

describe('RecordIdBadge', () => {
  it('copies the stored id and reports a fixed message when the clipboard refuses', async () => {
    render(<RecordIdBadge id="dev-1" label="device" />);
    expect(screen.getByTestId('record-id')).toHaveTextContent('dev-1');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy device id' })); });
    expect(clipboardWriteMock).toHaveBeenCalledWith('dev-1');
    expect(screen.getByRole('button', { name: 'Copied device id' })).toBeInTheDocument();

    clipboardWriteMock.mockRejectedValueOnce(new Error('clipboard denied: token=abc'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copied device id' })); });
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Could not copy the id.')).toBeInTheDocument();
    expect(alert).not.toHaveTextContent('token=abc');
  });
});
