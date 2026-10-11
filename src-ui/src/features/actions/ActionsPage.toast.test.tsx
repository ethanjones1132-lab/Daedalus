import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ActionsPage from './ActionsPage';
import { ToastProvider } from '../../design';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Actions page toast accessibility', () => {
  it('announces a live primary-surface mutation toast', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_action_registry_summary') {
        return { active: 0, blocked: 0, done: 0, pending_approvals: 0, escalated: 0, alerts: 0 };
      }
      if (command === 'get_action_registry_bucket') return { bucket: 'active', actions: [] };
      if (command === 'get_action_registry_alerts') return [];
      if (command === 'sync_action_registry') return {};
      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ToastProvider>
        <ActionsPage />
      </ToastProvider>,
    );

    const sync = await screen.findByRole('button', { name: 'Sync Adapters' });
    fireEvent.click(sync);

    const message = await screen.findByText('Action registry synced from live adapters.');
    const status = message.closest('[role="status"]');
    expect(status).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => expect(status).toHaveTextContent('Registry Synced'));
  });
});
