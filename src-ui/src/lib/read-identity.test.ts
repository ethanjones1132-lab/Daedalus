// Contracts for the shared read identity.
//
// Before this module, ordering was each caller's private responsibility:
// `usePolling` fired its callback on a bare `setInterval`, so an observation
// that outlived its interval could resolve after a newer one and silently revert
// the surface. Four callers hand-rolled a `requestId` or `pending` ref; one had
// none. These contracts pin the two properties the hook and the callers now
// share, without changing which reads are issued:
//
//   - a read is told, by identity, whether it is still the newest one — a stuck
//     read must never block the newer observation that supersedes it;
//   - a superseded observation is never published, so a late response cannot
//     revert a confirmed one.
import { describe, expect, it, vi } from 'vitest';
import { createReadGuard } from './read-identity';

describe('createReadGuard', () => {
  it('reports no read issued before the first identity', () => {
    const guard = createReadGuard();
    expect(guard.latest()).toBe(0);
    expect(guard.isCurrent(0)).toBe(false);
    expect(guard.isCurrent(1)).toBe(false);
  });

  it('issues strictly increasing identities that are current until superseded', () => {
    const guard = createReadGuard();
    const first = guard.issue();
    expect(first.id).toBe(1);
    expect(first.isCurrent(), 'a read is newest when it is issued').toBe(true);
    const second = guard.issue();
    expect(second.id).toBe(2);
    expect(guard.latest()).toBe(2);
    expect(second.isCurrent()).toBe(true);
    expect(
      first.isCurrent(),
      'the older read is superseded the moment a newer one is issued',
    ).toBe(false);
  });

  it('drops a superseded publication and runs the newest one', () => {
    const guard = createReadGuard();
    const older = guard.issue();
    const newer = guard.issue();
    const published: string[] = [];
    expect(guard.publish(newer.id, () => published.push('newer'))).toBe(true);
    expect(guard.publish(older.id, () => published.push('older'))).toBe(false);
    expect(published).toEqual(['newer']);
  });

  it('refuses an identity it never issued', () => {
    // A token from a foreign or torn-down generation must not be able to
    // publish; only an identity this guard handed out is honoured.
    const guard = createReadGuard();
    const issued = guard.issue();
    const apply = vi.fn();
    expect(guard.publish(0, apply)).toBe(false);
    expect(guard.publish(issued.id + 1, apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(guard.publish(issued.id, apply)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('keeps a late response from touching the surface', () => {
    // The exact failure: a slow read from the previous poll resolves after the
    // newer one and would revert a confirmed observation.
    const guard = createReadGuard();
    const slow = guard.issue();
    const fast = guard.issue();
    let surface = 'initial';
    guard.publish(fast.id, () => { surface = 'newest confirmed'; });
    guard.publish(slow.id, () => { surface = 'stale response'; });
    expect(surface).toBe('newest confirmed');
  });

  it('does not run a superseded apply at all', () => {
    const guard = createReadGuard();
    const older = guard.issue();
    guard.issue();
    const apply = vi.fn();
    expect(guard.publish(older.id, apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });
});
