// The one place a list header decides what number it may state.
//
// `SectionHeader` prints its count inside the heading as the view's own name —
// `Devices(0)` — whenever `typeof count === 'number'`, and it renders whatever
// its `action` slot holds beside that name. Both halves are the same claim about
// the same read: `Channels(3)` next to `1 connected · 0 delivery verified` is
// one sentence an operator reads in one pass. Nine mounted surfaces kept their
// list in a `useState<T[]>([])` and passed the length of it to a header that sits
// above and independently of the read gate the same component implements in its
// body, so a read still in flight and a read that had just failed both printed a
// confident `0`. That is the reading which most strongly says "there is nothing
// here", produced by a read that returned nothing, and it is indistinguishable
// from a genuinely empty install — the body one line below was already
// withholding its `EmptyState` and saying so, so the header was the only
// dishonest thing on the surface. The same count left the slot's own pills
// untouched, so `0 enabled` and `0 connected` sat above `Could not load…` and
// the operator had no way to tell which of the four numbers was real.
//
// This module reduces the class to one decision, so a header, the slot beside it
// and the body beneath it cannot disagree about the same read:
//
// - rows on screen mean a read returned them, so the count is the real number
//   even while a refresh is in flight or has failed — those surfaces say so in
//   their own words ("Previously loaded … may be stale"), and the number of the
//   rows above them is not in doubt;
// - no rows and a read in flight means nothing is known yet;
// - no rows and a failed read means nothing is known, and a failed read must not
//   borrow a confirmed empty read's `0`;
// - no rows and a settled read is a confirmed empty read, so it states a real
//   `0` and stays distinguishable from a failure.
//
// A read's own message never reaches here: the flags are two booleans, so there
// is no string for a heading or a pill to print. Pure: no React, no Tauri, no
// clock.

/** What a surface knows about the list its header is counting. */
export type ListRead =
  /** A read is in flight and nothing has come back. */
  | 'pending'
  /** A read returned the list on screen, so its size is a measurement. */
  | 'confirmed'
  /** A read failed and left nothing on screen, so nothing is known. */
  | 'failed';

/**
 * The two facts every one of these surfaces already keeps, and the one wording
 * that matters: `loading` and `failed` describe the newest read, while the rows
 * on screen are what a read already returned.
 */
export interface ListReadFlags {
  /** The newest read has not settled. */
  loading: boolean;
  /** The newest read failed. */
  failed: boolean;
}

export interface ListTally {
  // null means the current read has not returned a list to count. A confirmed
  // empty read is a real 0, never null, so a genuine zero stays a zero.
  count: number | null;
}

export function listRead<T>(items: readonly T[], flags: ListReadFlags): ListRead {
  if (items.length > 0) return 'confirmed';
  // Both true at once is a retry: the surface is waiting, not reporting a fault.
  if (flags.loading) return 'pending';
  if (flags.failed) return 'failed';
  return 'confirmed';
}

export function projectListTally<T>(items: readonly T[], read: ListRead): ListTally {
  return { count: read === 'confirmed' ? items.length : null };
}

/**
 * The `SectionHeader` prop value for a tally: `undefined` is how the primitive
 * is told to print no parenthetical at all, and a number — including `0` — is
 * how it is told to print one.
 */
export function countProp(tally: ListTally): number | undefined {
  return tally.count ?? undefined;
}

/** What a header passes straight to `count={…}`, from the list it titles. */
export function sectionCount<T>(items: readonly T[], flags: ListReadFlags): number | undefined {
  return countProp(projectListTally(items, listRead(items, flags)));
}

/**
 * A second number about the same read, for the pill beside the count.
 *
 * It takes the `ListTally` the count was printed from rather than the read
 * itself, so it is absent exactly when the count is absent: a surface cannot
 * print `Channels(3)` and drop `1 connected`, or keep the pill after a failed
 * read took the count away. A confirmed empty list is a real `0` here too, so an
 * install with nothing enabled stays distinguishable from one whose list could
 * not be read.
 */
export function tallyNumber<T>(
  items: readonly T[],
  tally: ListTally,
  selected: (item: T) => boolean,
): number | null {
  if (tally.count === null) return null;
  return items.filter(selected).length;
}

/** The tone a stated tally is printed in, as a subset of `Pill`'s variants. */
export type TallyTone = 'default' | 'success';

/**
 * The threshold every one of these pills already wrote out — `> 0 ? 'success' :
 * 'default'` — in one place, so three surfaces cannot drift on what a number
 * looks like. `null` is answered with the quiet tone and is never rendered: a
 * surface leaves the slot empty instead of printing a number it has no read for.
 */
export function tallyTone(value: number | null): TallyTone {
  return value !== null && value > 0 ? 'success' : 'default';
}
