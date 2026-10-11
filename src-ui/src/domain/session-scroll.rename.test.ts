import { describe, expect, it } from 'vitest';
import { sessionScroll } from './session-scroll';

describe('session-scroll rename (remaining slice)', () => {
  it('copies offset + pinned state to new session id on rename', () => {
    sessionScroll.save('old-id', { offset: 320, pinnedToBottom: false });
    sessionScroll.rename('old-id', 'new-id');
    expect(sessionScroll.load('new-id')!.offset).toBe(320);
    expect(sessionScroll.load('new-id')!.pinnedToBottom).toBe(false);
    expect(sessionScroll.load('old-id')).toBeUndefined();
  });

  it('does not create entry when old session unknown', () => {
    sessionScroll.rename('no-such', 'anything');
    expect(sessionScroll.load('anything')).toBeUndefined();
  });

  it('preserves pinnedToBottom true through rename', () => {
    sessionScroll.save('r', { offset: 10, pinnedToBottom: true });
    sessionScroll.rename('r', 'r2');
    expect(sessionScroll.load('r2')!.pinnedToBottom).toBe(true);
  });
});
