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

  // Focus the cancel button on open (safer default for destructive actions).
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => cancelRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
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
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
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
