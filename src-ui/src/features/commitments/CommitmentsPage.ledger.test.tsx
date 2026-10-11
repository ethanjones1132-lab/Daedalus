import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommitmentsPage from './CommitmentsPage';
import { ToastProvider } from '../../design';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const day = 24 * 60 * 60 * 1000;
const late = { id: 'l', text: 'Late one', status: 'open', due: new Date(Date.now() - 2 * day).toISOString(), created_at: '', completed_at: null, agent_id: 'scribe' };
const done = { id: 'd', text: 'Done one', status: 'completed', due: null, created_at: '', completed_at: new Date().toISOString(), agent_id: null };

beforeEach(() => invokeMock.mockReset().mockResolvedValue([late, done]));
afterEach(cleanup);

describe('Commitments ledger', () => {
  it('flags overdue open commitments and names the owner Agent', async () => {
    render(<ToastProvider><CommitmentsPage /></ToastProvider>);
    const row = within((await screen.findByText('Late one')).closest('li')!);
    expect(row.getByText(/overdue/)).toBeInTheDocument();
    expect(row.getByText('owner scribe')).toBeInTheDocument();
  });

  it('offers a Refresh that re-reads the list only', async () => {
    render(<ToastProvider><CommitmentsPage /></ToastProvider>);
    await screen.findByText('Late one');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(invokeMock.mock.calls.filter(([c]) => c === 'get_commitments')).toHaveLength(2);
    expect(invokeMock.mock.calls.every(([c]) => c === 'get_commitments')).toBe(true);
  });

  it('counts the open and total commitments and filters to completed', async () => {
    render(<ToastProvider><CommitmentsPage /></ToastProvider>);
    await screen.findByText('Late one');
    expect(screen.getByText(/1 to keep · 2 on the ledger/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'completed' } });
    expect(screen.queryByText('Late one')).not.toBeInTheDocument();
    expect(screen.getByText('Done one')).toBeInTheDocument();
  });
});
