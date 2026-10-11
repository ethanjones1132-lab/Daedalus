import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check, RotateCw, ShieldAlert, X } from 'lucide-react';
import { Kbd, Spinner, cn, useDialogFocus, useDialogKeys } from '../../design';

function prettyArgs(value: unknown): string {
  try {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Live tool approval for a Session turn.
 *
 * Contract (ported tests): role=dialog aria-modal on the backdrop, named
 * "Tool approval required"; Reject has initial focus (the safe default);
 * Tab/Shift+Tab wrap across the enabled buttons and escaped focus is pulled
 * back; Escape and a backdrop click both REJECT; every control is disabled
 * while a decision is in flight; on close focus returns to the opener, or to
 * <body> when the opener is gone. Retry repeats only the failed decision.
 */
export function ApprovalModal({
  callId,
  name,
  args,
  error,
  pending,
  onRetry,
  onApprove,
  onReject,
}: {
  callId: string;
  name: string;
  args: unknown;
  error: string | null;
  pending: boolean;
  onRetry?: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const onRejectRef = useRef(onReject);
  const onApproveRef = useRef(onApprove);
  onRejectRef.current = onReject;
  onApproveRef.current = onApprove;

  useDialogFocus(true, dialogRef, rejectRef);
  useDialogKeys(true, dialogRef, () => onRejectRef.current());

  const argText = prettyArgs(args);

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Tool approval required"
      aria-busy={pending}
      tabIndex={-1}
      onClick={() => onRejectRef.current()}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-canvas/70 px-4 outline-none backdrop-blur-[3px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="d-rise d-ticks w-full max-w-[540px] rounded-xl border border-line-strong bg-overlay shadow-pop"
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <span aria-hidden="true" className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-lg border border-accent-line bg-accent-wash text-accent">
            <ShieldAlert className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <div className="d-label text-[9.5px] text-accent">Session turn paused</div>
            <h2 className="d-display mt-1 text-[24px] text-ink">Tool Approval Required</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
              The orchestrator wants to execute <span className="font-mono text-[12.5px] text-accent-hot">{name}</span> with:
            </p>
          </div>
        </div>

        <div className="px-5 pt-3">
          <pre
            aria-label="Tool arguments"
            className="max-h-60 overflow-auto rounded-lg border border-line bg-sunken px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-ink"
          >
            {argText || '(no arguments)'}
          </pre>
          {pending && (
            <p role="status" aria-label="Tool approval decision pending" className="mt-2.5 flex items-center gap-2 text-[12px] text-ink-3">
              <Spinner size={12} />
              Submitting tool approval decision.
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2.5 rounded-lg border border-err/25 bg-err-wash px-3 py-2 text-[12.5px] text-ink">
              {error}
            </p>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          <p className="mr-auto font-mono text-[10.5px] text-ink-4">
            Call id: <span className="font-mono text-ink-3">{callId.slice(0, 12)}</span>
          </p>
          <button
            ref={rejectRef}
            type="button"
            aria-label="Reject tool call"
            onClick={() => onRejectRef.current()}
            disabled={pending}
            className={cn(
              'inline-flex h-8 items-center gap-2 rounded-[7px] border border-err/30 bg-err-wash px-3 text-[12.5px] font-medium text-err',
              'transition-colors hover:border-err/50 hover:bg-err/20 disabled:pointer-events-none disabled:opacity-45',
            )}
          >
            <X aria-hidden="true" className="size-3.5" />
            Reject
            <Kbd className="border-err/30 bg-transparent text-err/80">Esc</Kbd>
          </button>
          {onRetry && (
            <button
              type="button"
              aria-label="Retry tool decision"
              onClick={onRetry}
              disabled={pending}
              className="inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-line-strong bg-raised px-3 text-[12.5px] text-ink transition-colors hover:bg-overlay disabled:pointer-events-none disabled:opacity-45"
            >
              <RotateCw aria-hidden="true" className="size-3.5" />
              Retry decision
            </button>
          )}
          <button
            type="button"
            aria-label="Approve tool call"
            onClick={() => onApproveRef.current()}
            disabled={pending}
            className="inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-transparent bg-accent px-3.5 text-[12.5px] font-medium text-accent-ink shadow-[0_6px_18px_-8px_var(--d-accent)] transition-colors hover:bg-accent-hot disabled:pointer-events-none disabled:opacity-45"
          >
            <Check aria-hidden="true" className="size-3.5" />
            Approve
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
