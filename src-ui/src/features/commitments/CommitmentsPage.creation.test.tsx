import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommitmentsPage from './CommitmentsPage';
import { ToastProvider } from '../../design';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'get_commitments') return Promise.resolve([]);
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

async function renderIdle() {
  render(
    <ToastProvider>
      <CommitmentsPage />
    </ToastProvider>,
  );
  await screen.findByText('Nothing here.');
}

function fillDraft(text = 'Ship the weekly report', due = '2026-10-01') {
  fireEvent.change(screen.getByPlaceholderText('What needs to be done?'), { target: { value: text } });
  const dueInput = screen.getByDisplayValue('') as HTMLInputElement;
  fireEvent.change(dueInput, { target: { value: due } });
  return dueInput;
}

describe('CommitmentsPage creation guard', () => {
  it('invokes add_commitment exactly once across click and Enter repetition while pending', async () => {
    const first = deferred<unknown>();
    const store: unknown[] = [];
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_commitments') return Promise.resolve([...store]);
      if (command === 'add_commitment') return first.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle();

    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    // Enter must not bypass the pending guard.
    fireEvent.keyDown(screen.getByPlaceholderText('What needs to be done?'), { key: 'Enter' });
    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_commitment')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Adding…' }));

    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_commitment')).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_commitment')[0]).toEqual([
      'add_commitment',
      { text: 'Ship the weekly report', due: '2026-10-01T00:00:00.000Z' },
    ]);

    // Pending feedback: frozen form, in-flight label, no premature success toast.
    expect(screen.queryByText('Commitment added')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
    expect(screen.getByPlaceholderText('What needs to be done?')).toBeDisabled();
    expect(screen.getByDisplayValue('2026-10-01')).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('What needs to be done?'), { target: { value: 'later edit' } });
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-11-01' } });
    expect(screen.getByPlaceholderText('What needs to be done?')).toHaveValue('Ship the weekly report');
    expect(screen.getByLabelText('Due date')).toHaveValue('2026-10-01');

    const created = { id: 'c1', text: 'Ship the weekly report', status: 'open', due: '2026-10-01T00:00:00.000Z', created_at: '', completed_at: null, agent_id: null };
    await act(async () => {
      store.push(created);
      first.resolve(created);
    });
    expect(screen.getByText('Commitment added')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('What needs to be done?')).toHaveValue('');
    expect(screen.getByPlaceholderText('What needs to be done?')).toBeEnabled();
  });

  it('retains text and due after a rejected add with retryable inline feedback and no native detail', async () => {
    const first = deferred<unknown>();
    const retry = deferred<unknown>();
    const store: unknown[] = [];
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_commitments') return Promise.resolve([...store]);
      if (command === 'add_commitment') return first.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle();

    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await act(async () => { first.reject(new Error('boom: api_key=sk-leaked')); });

    expect(screen.getByRole('alert')).toHaveTextContent('Could not add the commitment');
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sk-leaked/)).not.toBeInTheDocument();
    // The draft survives the failure and the form is editable again.
    expect(screen.getByPlaceholderText('What needs to be done?')).toHaveValue('Ship the weekly report');
    expect(screen.getByDisplayValue('2026-10-01')).toHaveValue('2026-10-01');
    expect(screen.getByPlaceholderText('What needs to be done?')).toBeEnabled();

    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_commitments') return Promise.resolve([...store]);
      if (command === 'add_commitment') return retry.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry adding the commitment' }));
    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_commitment')).toHaveLength(2);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_commitment')[1]).toEqual([
      'add_commitment',
      { text: 'Ship the weekly report', due: '2026-10-01T00:00:00.000Z' },
    ]);
    // Retry is guarded while pending.
    fireEvent.click(screen.getByRole('button', { name: 'Adding…' }));
    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_commitment')).toHaveLength(2);

    const created = { id: 'c2', text: 'Ship the weekly report', status: 'open', due: '2026-10-01T00:00:00.000Z', created_at: '', completed_at: null, agent_id: null };
    await act(async () => {
      store.push(created);
      retry.resolve(created);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('What needs to be done?')).toHaveValue('');
    expect(screen.getByLabelText('Due date')).toHaveValue('');
  });

  it('does not report a create the confirming read could not confirm, and the list retry reloads only the list', async () => {
    const creation = deferred<unknown>();
    const confirming = deferred<unknown>();
    const reload = deferred<unknown>();
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_commitments') {
        listCalls += 1;
        if (listCalls === 1) return Promise.resolve([]);
        if (listCalls === 2) return confirming.promise;
        return reload.promise;
      }
      if (command === 'add_commitment') return creation.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await renderIdle();

    fillDraft('next commitment');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.queryByText('Commitment added')).not.toBeInTheDocument();
    await act(async () => { creation.resolve({ id: 'c1', text: 'next commitment', status: 'open', due: null, created_at: '', completed_at: null, agent_id: null }); });
    // The write resolved; nothing has confirmed it yet.
    expect(screen.queryByText('Commitment added')).not.toBeInTheDocument();

    await act(async () => { confirming.reject(new Error('List refresh unavailable')); });
    // A failed read-back is a list failure *and* an unconfirmed create, not a success.
    expect(screen.queryByText('Commitment added')).not.toBeInTheDocument();
    expect(screen.queryByText('Add failed')).not.toBeInTheDocument();
    expect(screen.getAllByRole('alert').map(node => node.textContent ?? '').join(' '))
      .toContain('Could not refresh commitments. Retry reloads the list only.');
    expect(screen.getAllByRole('alert').map(node => node.textContent ?? '').join(' '))
      .toContain('the commitment list could not be read back');
    expect(screen.queryByText('List refresh unavailable')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('What needs to be done?')).toHaveValue('next commitment');

    // The list Retry reloads the list and never repeats the create.
    const listRetries = screen.getAllByRole('button', { name: 'Retry' });
    expect(listRetries).toHaveLength(1);
    fireEvent.click(listRetries[0]);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'add_commitment')).toHaveLength(1);
    await act(async () => { reload.resolve([{ id: 'c1', text: 'next commitment', status: 'open', due: null, created_at: '', completed_at: null, agent_id: null }]); });
    expect(screen.getByTestId('record-id')).toHaveTextContent('c1');
    expect(screen.getByPlaceholderText('What needs to be done?')).toHaveValue('next commitment');
  });
});
