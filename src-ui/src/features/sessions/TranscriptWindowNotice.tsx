// The one place a bounded transcript states its bound.
//
// Two surfaces render a Session's messages — the Jarvis chat panel and the
// shell's Chat Feeds — and both read the same unbounded
// `get_session_history` with no paging argument. Each asks `lib/transcript-window`
// what it is showing, and this component is what both render from its answer, so
// the sentence an operator reads and the control that lifts the bound cannot
// differ between the two routes.
//
// The region is a `status` because the bound is a live fact: a press changes what
// the surface is showing, and the operator who pressed it is told what they now
// have rather than left to count bubbles. In the chat panel it sits inside the
// transcript's own `role="log"`, whose `aria-relevant="additions"` means the
// messages the press reveals are announced as the additions they are; the window
// sentence announces itself here, beside the control that changed it.
import { transcriptWindowNotice, type TranscriptWindow } from '../../lib/transcript-window';

export function TranscriptWindowNotice({
  window,
  onExtend,
  className,
}: {
  window: TranscriptWindow;
  onExtend: () => void;
  className?: string;
}) {
  const stated = transcriptWindowNotice(window);
  if (!stated) return null;
  return (
    <div
      role="status"
      aria-label="Transcript window"
      className={className ?? 'mb-3 flex items-center gap-3 text-[11px] font-mono text-ink-4'}
    >
      <span>{stated.notice}</span>
      <button
        type="button"
        onClick={onExtend}
        className="shrink-0 underline underline-offset-2 hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        {stated.extendLabel}
      </button>
    </div>
  );
}
