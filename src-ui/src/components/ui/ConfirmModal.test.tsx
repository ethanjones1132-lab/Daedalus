import { StrictMode, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmModal } from './ConfirmModal';

afterEach(cleanup);

function Harness({ removeOpener = false }: { removeOpener?: boolean }) {
  const [open, setOpen] = useState(false);
  const [removed, setRemoved] = useState(false);
  return (
    <>
      {!removed && <button onClick={() => setOpen(true)}>Open confirmation</button>}
      <button>Outside</button>
      <ConfirmModal
        open={open}
        message="Delete entry?"
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          if (removeOpener) setRemoved(true);
          setOpen(false);
        }}
      />
    </>
  );
}

async function openDialog() {
  const opener = screen.getByRole('button', { name: 'Open confirmation' });
  opener.focus();
  fireEvent.click(opener);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
  return opener;
}

describe('ConfirmModal keyboard focus', () => {
  it('starts on Cancel and wraps Tab forward and backward inside the dialog', async () => {
    render(<Harness />);
    await openDialog();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    // jsdom does not perform native Tab traversal; assert the intercepted boundaries.
    expect(fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(confirm).toHaveFocus();
    expect(fireEvent.keyDown(confirm, { key: 'Tab' })).toBe(false);
    expect(cancel).toHaveFocus();
  });

  it.each(['Cancel', 'Confirm'])('restores the opener after %s, including StrictMode', async (action) => {
    render(<StrictMode><Harness /></StrictMode>);
    const opener = await openDialog();
    const button = screen.getByRole('button', { name: action });
    button.focus();
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('cancels exactly once for Escape from a focused child', async () => {
    const onCancel = vi.fn();
    render(<ConfirmModal open message="Delete entry?" onCancel={onCancel} onConfirm={vi.fn()} />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('contains focus moved outside and releases the guard when closed', async () => {
    render(<Harness />);
    await openDialog();
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    outside.focus();
    expect(outside).toHaveFocus();
  });

  it('falls back safely to the document when confirmation removes the opener', async () => {
    render(<Harness removeOpener />);
    const opener = await openDialog();
    const focus = vi.spyOn(opener, 'focus');
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    confirm.focus();
    fireEvent.click(confirm);
    expect(opener.isConnected).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(document.body).toHaveFocus();
    expect(document.body).not.toHaveAttribute('tabindex');
  });

  it('does not reset focus on callback updates and uses the latest cancellation callback', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(<ConfirmModal open message="Delete entry?" onCancel={first} onConfirm={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    confirm.focus();
    rerender(<ConfirmModal open message="Delete entry?" onCancel={latest} onConfirm={vi.fn()} />);
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: 'Escape' });
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('preserves backdrop cancellation without cancelling clicks on the dialog content', async () => {
    render(<Harness />);
    const opener = await openDialog();
    fireEvent.click(screen.getByText('Delete entry?'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
