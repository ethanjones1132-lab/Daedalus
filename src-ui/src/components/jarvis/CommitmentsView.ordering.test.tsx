import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
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
const a = { id: 'a', text: 'Alpha', status: 'open', due: null, created_at: '', completed_at: null, agent_id: null };
const b = { ...a, id: 'b', text: 'Beta' };
const row = (text: string) => within(screen.getByText(text).closest('li')!);
afterEach(cleanup);

it('ignores an obsolete failed read after another row reconciles both writes', async () => {
  invokeMock.mockReset().mockResolvedValue([a, b]);
  render(<ToastProvider><CommitmentsView /></ToastProvider>);
  await screen.findByText(a.text);
  const older = deferred<unknown[]>();
  invokeMock.mockResolvedValueOnce(true).mockReturnValueOnce(older.promise);
  await act(async () => fireEvent.click(row(a.text).getByRole('button', { name: 'Delete' })));
  invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce([]);
  await act(async () => fireEvent.click(row(b.text).getByRole('button', { name: 'Delete' })));
  await act(async () => older.reject(new Error('obsolete private failure')));
  expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('keeps an inconsistent post-write snapshot locked and never repeats the write on retry', async () => {
  invokeMock.mockReset().mockResolvedValue([a]);
  render(<ToastProvider><CommitmentsView /></ToastProvider>);
  await screen.findByText(a.text);
  invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce([a]);
  await act(async () => fireEvent.click(row(a.text).getByRole('button', { name: 'Delete' })));
  expect(row(a.text).getByRole('alert')).toHaveTextContent('does not confirm');
  fireEvent.click(row(a.text).getByRole('button', { name: 'Complete' }));
  invokeMock.mockResolvedValueOnce([]);
  await act(async () => fireEvent.click(row(a.text).getByRole('button', { name: 'Retry' })));
  expect(invokeMock.mock.calls.filter(([cmd]) => cmd !== 'get_commitments')).toEqual([['delete_commitment', { id: 'a' }]]);
  expect(screen.getByText('Nothing here.')).toBeInTheDocument();
});

it('does not treat a false write result as confirmation', async () => {
  invokeMock.mockReset().mockResolvedValue([a]);
  render(<ToastProvider><CommitmentsView /></ToastProvider>);
  await screen.findByText(a.text);
  invokeMock.mockResolvedValueOnce(false);
  await act(async () => fireEvent.click(row(a.text).getByRole('button', { name: 'Complete' })));
  expect(row(a.text).getByRole('alert')).toHaveTextContent('Could not complete');
  expect(screen.queryByText('Marked complete')).not.toBeInTheDocument();
  expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'get_commitments')).toHaveLength(1);
});
