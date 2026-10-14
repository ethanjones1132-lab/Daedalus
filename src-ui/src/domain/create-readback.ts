// ── create-readback — decide whether a create is confirmed by a fresh read ──
//
// A Native create command returns the record it stored, but that return value is
// the writer's own account of its own write. The only confirmation is a later
// read that contains the record under the identity the writer was given. These
// helpers turn (write return, confirming read) into one of four verdicts and a
// fixed sentence per failure, so a surface can never announce an unconfirmed
// create, and never has to invent its own wording for one.

export type CreateResource = 'device' | 'node' | 'hook' | 'commitment';

export type CreateFailure = 'write-failed' | 'unreadable' | 'unavailable' | 'unconfirmed';

const CREATE_VERB: Record<CreateResource, string> = {
  device: 'add',
  node: 'add',
  hook: 'register',
  commitment: 'add',
};

export interface CreateIdentity {
  readonly id: string;
}

export type CreateVerdict<T> =
  | { readonly status: 'confirmed'; readonly row: T }
  | { readonly status: 'unconfirmed' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'unreadable' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The record a create command returned, or null when it carries no identity to
 * confirm. A string `id` is the only thing the confirming read can match on, so
 * anything else is treated as no record at all rather than as a usable one.
 */
export function decodeCreatedRecord<T extends CreateIdentity>(value: unknown): T | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id.trim() === '') return null;
  return value as T;
}

/**
 * Compare the record the write returned against the list a later read produced.
 *
 * - `unreadable`  the write returned nothing with an id, so there is nothing to look for.
 * - `unavailable` the read produced no usable list, so nothing was observed either way.
 * - `unconfirmed` the read succeeded and does not contain the record.
 * - `confirmed`   the read contains it. The confirmed verdict carries the *stored*
 *                 row, not the value the write returned, so a surface reports what
 *                 is actually stored when the two disagree.
 */
export function decideCreateReadback<T extends CreateIdentity>(
  returned: unknown,
  snapshot: readonly unknown[] | null | undefined,
): CreateVerdict<T> {
  const created = decodeCreatedRecord<T>(returned);
  if (!created) return { status: 'unreadable' };
  if (!Array.isArray(snapshot)) return { status: 'unavailable' };
  const row = snapshot.find(entry => isRecord(entry) && entry.id === created.id);
  return row ? { status: 'confirmed', row: row as T } : { status: 'unconfirmed' };
}

/**
 * One fixed sentence per reason. Nothing from the failing call is interpolated:
 * these strings are what an operator reads when a create could not be confirmed.
 * The write-failed sentence keeps each surface's existing verb — a hook is
 * registered, not added — so this does not rewrite vocabulary an operator reads.
 */
export function createFailureSentence(resource: CreateResource, failure: CreateFailure): string {
  switch (failure) {
    case 'write-failed':
      return `Could not ${CREATE_VERB[resource]} the ${resource}. Your draft was kept.`;
    case 'unreadable':
      return `The ${resource} was submitted, but Daedalus received no record id to confirm it. Your draft was kept.`;
    case 'unavailable':
      return `The ${resource} was submitted, but the ${resource} list could not be read back, so it is unconfirmed. Your draft was kept.`;
    case 'unconfirmed':
      return `The ${resource} was submitted, but a confirmed read of the ${resource} list does not contain it, so it is unconfirmed. Your draft was kept.`;
  }
}
