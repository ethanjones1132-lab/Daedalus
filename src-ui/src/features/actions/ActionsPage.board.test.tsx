import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ActionsPage from './ActionsPage';
import { ToastProvider } from '../../design';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const base = {
  project: 'home-base', source_system: 'github', source_area: 'ci', priority: 'P1', risk_level: 'low',
  category: 'x', action_type: 'x', description: 'd', owner: 'o', approval_required: false,
  updated_at: '2026-09-23T00:00:00Z',
};

afterEach(cleanup);

describe('Actions board', () => {
  it('shows summary counts in the column headers and the other buckets as registry tallies', async () => {
    invokeMock.mockImplementation(async (command: string, args?: { bucket?: string }) => {
      if (command === 'get_action_registry_summary') {
        return { active: 7, blocked: 2, done: 31, pending_approvals: 4, escalated: 1, alerts: 5 };
      }
      if (command === 'get_action_registry_bucket') {
        return {
          bucket: args?.bucket,
          actions: args?.bucket === 'active'
            ? [{ ...base, id: 'a1', title: 'Ship it', status: 'open', escalated: true, escalation_note: 'Paged twice' }]
            : [{ ...base, id: 'b1', title: 'Stuck thing', status: 'blocked' }],
        };
      }
      if (command === 'get_action_registry_alerts') return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<ToastProvider><ActionsPage /></ToastProvider>);
    await screen.findByText('Ship it');

    const active = screen.getByRole('region', { name: 'Active actions' });
    expect(within(active).getByText('7')).toBeInTheDocument();
    expect(within(active).getByText('Paged twice')).toBeInTheDocument();
    expect(within(active).getByText('escalated')).toBeInTheDocument();
    const blocked = screen.getByRole('region', { name: 'Blocked actions' });
    expect(within(blocked).getByText('2')).toBeInTheDocument();
    expect(within(blocked).getByText('Stuck thing')).toBeInTheDocument();

    const tallies = screen.getByLabelText('Registry tallies');
    expect(within(tallies).getByText('31')).toBeInTheDocument();
    expect(within(tallies).getByText('4')).toBeInTheDocument();
    expect(within(tallies).getByText('5')).toBeInTheDocument();
  });
});
