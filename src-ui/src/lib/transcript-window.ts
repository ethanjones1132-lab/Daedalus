// The one decision about how much of a Session's transcript is on screen.
//
// A Session read is unbounded. `get_session_history` selects every row for the
// Session with no `LIMIT` and takes no paging argument
// (`src-tauri/src/commands/sessions.rs:514-527`), and both transcripts rendered
// every row they were handed — `messages.map(...)` in the Jarvis chat panel and
// `history.map(...)` in the shell's Chat Feeds — with one `MarkdownView` per
// message, each running highlight.js language detection over every code block
// while the transcript mounts. Session length is unbounded by design, so the work
// a route does on open is unbounded too, and it is the route an operator opens
// most (`case 'jarvis-chat'` and `chat-feeds`).
//
// What made that more than a performance property is that nothing on screen said
// so. The Jarvis transcript is a bare list under `aria-label="Jarvis chat
// transcript"`, so "this is the whole conversation" and "this is everything that
// rendered" were the same pixels. The one number in the sibling surface —
// `{history.length} msgs` — was a true count over the rows it did render, which
// is exactly why it could not be read as the length of the conversation: a
// number describing what is drawn is not a number describing what exists.
//
// So the window is a stated fact, and the withheld messages are reachable:
//
//   - the window shows the **newest** `visible` messages, so the end of the
//     conversation — the part the operator sent, and the part the transcript's
//     scroll-to-end and the streaming bubble depend on — is never the part that
//     is withheld, and the withheld run is a prefix of the Session;
//   - `withheld > 0` is the only state that says anything. A Session at or under
//     the bound has nothing withheld and therefore states no bound at all, and
//     the pill keeps the exact string it has always printed — a confirmed read
//     that fits is not a bounded one;
//   - an empty or unanswered read is `complete`, because nothing is being
//     withheld from it, so a pending and an empty transcript never acquire a
//     window notice;
//   - `visible` is a floor on *reach*, not a set of messages. A list that grows
//     while the window is open keeps the newest on screen and withholds one more
//     from the top; it never quietly reduces a window the operator extended, and
//     a `visible` left over from another Session can withhold nothing from a
//     shorter one.
//
// A read's own message never reaches here: every fact below is a number, so
// there is no string for a transcript to print. Pure: no React, no Tauri, no
// clock, and no rendering decision beyond the slice itself.

/**
 * How many messages a transcript shows before it has to say so, and how many one
 * press of the extension control adds. One number for both, so the control can
 * never be described in a different unit from the bound it lifts.
 */
export const TRANSCRIPT_WINDOW = 100;

export interface TranscriptWindow {
  /** Messages the surface is rendering right now. */
  shown: number;
  /** Messages the read returned that are not on screen. */
  withheld: number;
  /** Messages the read returned. */
  total: number;
  /** True when nothing is withheld: the window reaches the first message. */
  complete: boolean;
}

/**
 * A count a surface can state, or zero. A read's length and a window's reach are
 * both numbers this app computed, so a non-finite or negative one is a bug
 * somewhere else; failing to zero keeps it off the screen rather than printing
 * `NaN of 342 messages.`
 */
function asCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function transcriptWindow(total: number, visible: number): TranscriptWindow {
  const read = asCount(total);
  const shown = Math.min(asCount(visible), read);
  return { shown, withheld: read - shown, total: read, complete: shown === read };
}

/** Index of the first message in the window: where the withheld run begins. */
export function windowStart(total: number, visible: number): number {
  return asCount(total) - transcriptWindow(total, visible).shown;
}

/**
 * The slice a transcript renders, in conversation order.
 *
 * A read that fits the window is returned as the caller's own array, so a short
 * transcript is not re-sliced by a rule that exists for long ones.
 */
export function windowSlice<T>(items: readonly T[], visible: number): readonly T[] {
  const start = windowStart(items.length, visible);
  return start === 0 ? items : items.slice(start);
}

/**
 * What one press of the extension control reaches: one step further, and never
 * further than the read returned — a control that can grow past the messages
 * that exist is a control that can claim reach it does not have.
 */
export function extendWindow(visible: number, total: number): number {
  return Math.min(asCount(total), asCount(visible) + TRANSCRIPT_WINDOW);
}

export interface ScrollAnchor {
  scrollHeight: number;
  scrollTop: number;
}

/**
 * The scroll offset that keeps the reader looking at the same message after a run
 * of earlier messages is inserted above them.
 *
 * The transcript's own scroll-to-end and its "Jump to latest" control are
 * untouched; this is the arithmetic for the one case they do not cover, which is
 * the operator reading up inside the window while a press adds content above
 * their position. A container with no layout yet reports `scrollHeight === 0`,
 * and neither it nor jsdom may produce a jump from it.
 */
export function anchoredScrollTop(before: ScrollAnchor, afterScrollHeight: number): number {
  if (!Number.isFinite(afterScrollHeight) || before.scrollHeight <= 0) return before.scrollTop;
  const inserted = afterScrollHeight - before.scrollHeight;
  return inserted > 0 ? before.scrollTop + inserted : before.scrollTop;
}

export interface TranscriptWindowNotice {
  /** The bound, in the "Showing …" vocabulary this app's other surfaces use. */
  notice: string;
  /** The control that lifts the bound, naming only what is still withheld. */
  extendLabel: string;
}

/**
 * What a bounded transcript says about itself, or `null` when nothing is
 * withheld. A complete window has no sentence: the confirmed half of this rule
 * is that a Session that fits looks exactly as it did before the rule existed.
 */
export function transcriptWindowNotice(window: TranscriptWindow): TranscriptWindowNotice | null {
  if (window.complete) return null;
  const reachable = Math.min(TRANSCRIPT_WINDOW, window.withheld);
  return {
    notice: `Showing the newest ${window.shown} of ${window.total} messages.`,
    extendLabel: `Show ${reachable} earlier message${reachable === 1 ? '' : 's'}`,
  };
}

/**
 * The message count beside a transcript, counting what is on screen. A complete
 * window keeps the string this app has always printed; a bounded one cannot
 * claim the length of a read it is not showing.
 */
export function transcriptCountLabel(window: TranscriptWindow): string {
  return window.complete ? `${window.total} msgs` : `${window.shown} of ${window.total} msgs`;
}
