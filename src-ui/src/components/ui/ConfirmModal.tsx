// ── ConfirmModal — on-brand replacement for window.confirm
//
// Usage:
//   const [pending, setPending] = useState<string | null>(null);
//   <ConfirmModal
//     open={pending !== null}
//     message={`Delete "${pending}"?`}
//     confirmLabel="Delete"
//     danger
//     onConfirm={() => { doDelete(pending!); setPending(null); }}
//     onCancel={() => setPending(null)}
//   />
//
// Focus contract: on open the Cancel button takes focus and Tab wraps between
// the two buttons; focus that escapes the dialog is pulled back to Cancel.
// On close, focus returns to the invoking control, or to the document body
// (transient tabindex, never left behind) if the opener was removed/disabled.
// Escape cancels exactly once, from the window handler only.

import { useEffect, useRef } from 'react';
import { cn } from './index';

interface Props {
  open: boolean;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  message,
  detail,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Own focus for the open lifetime, not the lifetime of inline callbacks.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    const containFocus = (e: FocusEvent) => {
      if (e.target instanceof Node && !dialogRef.current?.contains(e.target)) {
        cancelRef.current?.focus();
      }
    };
    document.addEventListener('focusin', containFocus);
    // Cancel is the safer default for destructive actions.
    cancelRef.current?.focus();
    return () => {
      document.removeEventListener('focusin', containFocus);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      // A successful deletion may remove or disable the invoking control.
      if (document.activeElement !== opener || !opener?.isConnected) {
        const tabIndex = document.body.getAttribute('tabindex');
        document.body.setAttribute('tabindex', '-1');
        document.body.focus();
        if (tabIndex === null) document.body.removeAttribute('tabindex');
        else document.body.setAttribute('tabindex', tabIndex);
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Tab') {
        // These are the dialog's only two focusable controls. Leave interior
        // traversal to the browser, intercepting only the wrap boundaries.
        const first = cancelRef.current;
        const last = confirmRef.current;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={message}
      onClick={onCancel}
    >
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className="w-full max-w-sm mx-4 rounded-xl border border-white/10 bg-[#0d0f14] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-medium text-bone">{message}</p>
        {detail && <p className="mt-1 text-xs text-bone/50">{detail}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 rounded-lg text-xs text-bone/70 hover:text-bone border border-white/10 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={cn(
              'px-4 py-1.5 rounded-lg text-xs font-medium transition-colors',
              danger
                ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30 border border-red-500/30'
                : 'bg-accent/20 text-accent hover:bg-accent/30 border border-accent/20',
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmModal;
