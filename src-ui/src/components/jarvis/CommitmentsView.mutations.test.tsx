import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
import CommitmentsView from './CommitmentsView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const alpha = { id: 'a', text: 'Alpha task', status: 'open', due: null, created_at: '', completed_at: null, agent_id: null };
const beta = { ...alpha, id: 'b', text: 'Beta task' };
const done = { ...alpha, status: 'completed', completed_at: '2026-09-16T00:00:00Z' };
const row = (text = alpha.text) => within(screen.getByText(text).closest('li')!);
const writes = () => invokeMock.mock.calls.filter(([cmd]) => cmd === 'complete_commitment' || cmd === 'delete_commitment');
async function open() {
  render(<ToastProvider><CommitmentsView /></ToastProvider>);
  await screen.findByText(alpha.text);
}
beforeEach(() => invokeMock.mockReset().mockResolvedValue([alpha, beta]));
afterEach(cleanup);

it('serializes Complete and Delete on one row through readback, retaining confirmed values', async () => {
  await open();
  const write = deferred<boolean>();
  const read = deferred<unknown[]>();
  invokeMock.mockReturnValueOnce(write.promise).mockReturnValueOnce(read.promise);
  const complete = row().getByRole('button', { name: 'Complete' });
  fireEvent.click(complete);
  fireEvent.click(complete);
  fireEvent.click(row().getByRole('button', { name: 'Delete' }));
  expect(writes()).toEqual([['complete_commitment', { id: 'a' }]]);
  expect(row().getByText('open')).toBeInTheDocument();
  expect(row().getByRole('status')).toHaveTextContent(/Completing/);
  expect(row().getByRole('button', { name: 'Delete' })).toBeDisabled();
  expect(row(beta.text).getByRole('button', { name: 'Complete' })).toBeEnabled();
  expect(screen.queryByText('Marked complete')).not.toBeInTheDocument();
  await act(async () => write.resolve(true));
  expect(row().getByRole('button', { name: 'Delete' })).toBeDisabled();
  await act(async () => read.resolve([done, beta]));
  expect(screen.queryByText(alpha.text)).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'completed' } });
  expect(row().queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument();
});

it.each(['complete_commitment', 'delete_commitment'])('keeps rejected %s inline and retries the same write once', async (command) => {
  await open();
  const write = deferred<boolean>();
  invokeMock.mockReturnValueOnce(write.promise);
  fireEvent.click(row().getByRole('button', { name: command === 'complete_commitment' ? 'Complete' : 'Delete' }));
  await act(async () => write.reject(new Error('synthetic private detail')));
  expect(row().getByText('open')).toBeInTheDocument();
  const alert = row().getByRole('alert');
  expect(alert).toHaveTextContent('Could not');
  expect(screen.queryByText(/synthetic private detail/)).not.toBeInTheDocument();
  const retry = deferred<boolean>();
  invokeMock.mockReturnValueOnce(retry.promise);
  const button = within(alert).getByRole('button', { name: 'Retry' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(writes()).toEqual([[command, { id: 'a' }], [command, { id: 'a' }]]);
});

it.each(['complete_commitment', 'delete_commitment'])('recovers confirmed %s with guarded reads only', async (command) => {
  await open();
  invokeMock.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('private readback detail'));
  await act(async () => fireEvent.click(row().getByRole('button', { name: command === 'complete_commitment' ? 'Complete' : 'Delete' })));
  const alert = row().getByRole('alert');
  expect(alert).toHaveTextContent('saved');
  expect(alert).toHaveTextContent('Retry reloads the list only');
  expect(screen.queryByText(/private readback detail/)).not.toBeInTheDocument();
  expect(row().getByRole('button', { name: 'Delete' })).toBeDisabled();
  const read = deferred<unknown[]>();
  invokeMock.mockReturnValueOnce(read.promise);
  const retry = within(alert).getByRole('button', { name: 'Retry' });
  fireEvent.click(retry);
  fireEvent.click(retry);
  expect(retry).toBeDisabled();
  expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'get_commitments')).toHaveLength(3);
  await act(async () => read.resolve(command === 'complete_commitment' ? [done, beta] : [beta]));
  expect(writes()).toHaveLength(1);
  expect(screen.queryByText(alpha.text)).not.toBeInTheDocument();
});

it('does not let older independent-row or creation reads resurrect settled rows', async () => {
  await open();
  const oldRead = deferred<unknown[]>();
  const newRead = deferred<unknown[]>();
  invokeMock.mockResolvedValueOnce(true).mockReturnValueOnce(oldRead.promise);
  await act(async () => fireEvent.click(row().getByRole('button', { name: 'Complete' })));
  invokeMock.mockResolvedValueOnce(true).mockReturnValueOnce(newRead.promise);
  await act(async () => fireEvent.click(row(beta.text).getByRole('button', { name: 'Delete' })));
  await act(async () => newRead.resolve([done]));
  await act(async () => oldRead.resolve([alpha, beta]));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'all' } });
  expect(row().queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument();
  expect(screen.queryByText(beta.text)).not.toBeInTheDocument();

  const creationRead = deferred<unknown[]>();
  const created = { ...beta, id: 'c', text: 'Created task' };
  invokeMock.mockResolvedValueOnce(created).mockReturnValueOnce(creationRead.promise);
  fireEvent.change(screen.getByPlaceholderText('What needs to be done?'), { target: { value: created.text } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add' })));
  invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce([created]);
  await act(async () => fireEvent.click(row().getByRole('button', { name: 'Delete' })));
  await act(async () => creationRead.resolve([done, created]));
  expect(screen.queryByText(alpha.text)).not.toBeInTheDocument();
  expect(screen.getByText(created.text)).toBeInTheDocument();
});

it('protects a pending row from a read started by creation before the write settles', async () => {
  await open();
  const creationRead = deferred<unknown[]>();
  invokeMock.mockResolvedValueOnce({ ...beta, id: 'c' }).mockReturnValueOnce(creationRead.promise);
  fireEvent.change(screen.getByPlaceholderText('What needs to be done?'), { target: { value: 'Created task' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add' })));
  const write = deferred<boolean>();
  invokeMock.mockReturnValueOnce(write.promise);
  fireEvent.click(row().getByRole('button', { name: 'Complete' }));
  await act(async () => creationRead.resolve([done, beta]));
  expect(row().getByText('open')).toBeInTheDocument();
  expect(row().getByRole('button', { name: 'Delete' })).toBeDisabled();
});
