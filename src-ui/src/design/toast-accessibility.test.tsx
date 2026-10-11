import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast, type ToastContextValue } from './Toast';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

let toastApi: ToastContextValue;

function CaptureToastApi() {
  toastApi = useToast();
  return null;
}

function renderProvider() {
  return render(
    <ToastProvider>
      <button type="button">Opener</button>
      <CaptureToastApi />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ToastProvider accessibility', () => {
  it('keeps a live region mounted and gives each variant its announced semantics', () => {
    const { container } = renderProvider();

    expect(container.querySelector('[aria-live="polite"]')).toBeInTheDocument();
    expect(container.querySelector('[aria-live="assertive"]')).toBeInTheDocument();

    act(() => {
      toastApi.info('Informational message', 'Information');
      toastApi.success('Successful message', 'Success');
      toastApi.warn('Warning message', 'Warning');
      toastApi.error('Error message', 'Error');
    });

    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toHaveAttribute('aria-live', 'polite');
    expect(statuses[0]).toHaveTextContent('InformationInformational message');
    expect(statuses[1]).toHaveTextContent('SuccessSuccessful message');

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveAttribute('aria-live', 'assertive');
    expect(alerts[0]).toHaveTextContent('WarningWarning message');
    expect(alerts[1]).toHaveTextContent('ErrorError message');
  });

  it('auto-dismisses only non-action informational toasts', async () => {
    vi.useFakeTimers();
    renderProvider();
    let actionCalls = 0;

    act(() => {
      toastApi.info('Timed info', 'Info');
      toastApi.success('Timed success', 'Success');
      toastApi.warn('Persistent warning', 'Warning');
      toastApi.error('Persistent error', 'Error');
      toastApi.info(
        'Persistent action',
        'Actionable',
        undefined,
        { label: 'Retry', onClick: () => { actionCalls += 1; } },
      );
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });

    expect(screen.queryByText('Timed info')).not.toBeInTheDocument();
    expect(screen.queryByText('Timed success')).not.toBeInTheDocument();
    expect(screen.getByText('Persistent warning')).toBeInTheDocument();
    expect(screen.getByText('Persistent error')).toBeInTheDocument();
    expect(screen.getByText('Persistent action')).toBeInTheDocument();
    expect(actionCalls).toBe(0);
  });

  it('dismisses a persistent toast from its keyboard-operable close control', async () => {
    const user = userEvent.setup();
    renderProvider();

    act(() => { toastApi.error('Error message', 'Error'); });
    const close = screen.getByRole('button', { name: 'Dismiss notification' });
    close.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.queryByText('Error message')).not.toBeInTheDocument());
  });

  it('runs an action once, keeps the stack, and does not steal focus', async () => {
    const user = userEvent.setup();
    let actionCalls = 0;
    renderProvider();
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();

    act(() => {
      toastApi.error(
        'First error',
        'First',
        undefined,
        { label: 'Retry', onClick: () => { actionCalls += 1; } },
      );
      toastApi.error('Second error', 'Second');
    });

    expect(opener).toHaveFocus();
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    const actionable = alerts.find((alert) => alert.textContent?.includes('First error'));
    expect(actionable).toBeDefined();
    await user.click(within(actionable!).getByRole('button', { name: 'Retry' }));

    expect(actionCalls).toBe(1);
    expect(screen.getByText('Second error')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('First error')).not.toBeInTheDocument());
  });
});
