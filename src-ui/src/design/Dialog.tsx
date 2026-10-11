import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from './cn';

/*
 * Dialog focus contract (shared by every modal in Jarvis):
 *  - on open, focus moves to `initialFocus` (or the first focusable control)
 *  - Tab / Shift+Tab wrap inside the dialog; focus that escapes is pulled back
 *  - Escape calls onClose exactly once (window handler, propagation stopped)
 *  - backdrop click closes; clicks inside do not
 *  - on close, focus returns to the opener, or to <body> via a transient
 *    tabindex when the opener was removed or disabled (never stranded)
 *  - callback identity changes never reset focus (effects keyed on `open`)
 */

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusBodyFallback(opener: Element | null) {
  if (document.activeElement !== opener || !(opener as HTMLElement | null)?.isConnected) {
    const prev = document.body.getAttribute('tabindex');
    document.body.setAttribute('tabindex', '-1');
    document.body.focus();
    if (prev === null) document.body.removeAttribute('tabindex');
    else document.body.setAttribute('tabindex', prev);
  }
}

export function useDialogFocus(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    const first = () =>
      initialFocusRef?.current ?? containerRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? containerRef.current;
    const contain = (e: FocusEvent) => {
      if (e.target instanceof Node && containerRef.current && !containerRef.current.contains(e.target)) {
        first()?.focus();
      }
    };
    document.addEventListener('focusin', contain);
    first()?.focus();
    return () => {
      document.removeEventListener('focusin', contain);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      focusBodyFallback(opener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

export function useDialogKeys(open: boolean, containerRef: RefObject<HTMLElement | null>, onEscape: () => void) {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        latest.current();
        return;
      }
      if (e.key !== 'Tab' || !containerRef.current) return;
      const nodes = Array.from(containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) return;
      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === firstNode) {
        e.preventDefault();
        lastNode.focus();
      } else if (!e.shiftKey && document.activeElement === lastNode) {
        e.preventDefault();
        firstNode.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, containerRef]);
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name. */
  label: string;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  size?: 'sm' | 'md' | 'lg';
  /** Hide the × close button. */
  hideClose?: boolean;
  busy?: boolean;
  className?: string;
}

export function Dialog({
  open,
  onClose,
  label,
  title,
  description,
  children,
  footer,
  initialFocusRef,
  size = 'md',
  hideClose,
  busy,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref, initialFocusRef);
  useDialogKeys(open, ref, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-[rgba(8,6,4,0.62)] px-4 pt-[12vh] backdrop-blur-[3px]" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'd-rise d-ticks w-full rounded-xl border border-line-strong bg-overlay shadow-pop outline-none',
          size === 'sm' && 'max-w-sm',
          size === 'md' && 'max-w-lg',
          size === 'lg' && 'max-w-2xl',
          className,
        )}
      >
        {(title || !hideClose) && (
          <div className="flex items-start justify-between gap-3 px-5 pt-4">
            <div className="min-w-0">
              {title && <h2 className="d-display text-[22px] text-ink">{title}</h2>}
              {description && <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{description}</p>}
            </div>
            {!hideClose && (
              <button
                type="button"
                aria-label="Close dialog"
                onClick={onClose}
                className="-mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            )}
          </div>
        )}
        {children && <div className="px-5 py-4">{children}</div>}
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmModalProps {
  open: boolean;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation dialog. Contract (tested): role=dialog aria-modal
 * aria-label={message}; Cancel focused on open; Tab wraps across exactly the
 * two buttons; Escape cancels once; backdrop cancels; focus restored.
 */
export function ConfirmModal({
  open,
  message,
  detail,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(open, dialogRef, cancelRef);
  useDialogKeys(open, dialogRef, onCancel);
  if (!open) return null;
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={message}
      onClick={onCancel}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(8,6,4,0.62)] px-4 backdrop-blur-[3px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="d-rise d-ticks w-full max-w-sm rounded-xl border border-line-strong bg-overlay p-5 shadow-pop"
      >
        <p className="text-[14px] font-medium leading-snug text-ink">{message}</p>
        {detail && <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">{detail}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="h-8 rounded-[7px] border border-line-strong bg-raised px-3.5 text-[12.5px] text-ink-2 transition-colors hover:text-ink"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              'h-8 rounded-[7px] border px-3.5 text-[12.5px] font-medium transition-colors',
              danger
                ? 'border-err/40 bg-err-wash text-err hover:bg-err/20'
                : 'border-transparent bg-accent text-accent-ink hover:bg-accent-hot',
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
