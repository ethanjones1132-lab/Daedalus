import { describe, expect, it } from 'vitest';
import { sessionScroll } from './session-scroll';

describe('session-scroll persistence', () => {
  it('saves and loads scroll offset by session id', () => {
    sessionScroll.save('s-1', { offset: 240, pinnedToBottom: true });
    const loaded = sessionScroll.load('s-1');
    expect(loaded).toBeDefined();
    expect(loaded!.offset).toBe(240);
    expect(loaded!.pinnedToBottom).toBe(true);
  });

  it('returns undefined for unknown session', () => {
    expect(sessionScroll.load('no- such-id')).toBeUndefined();
  });

  it('clears entry', () => {
    sessionScroll.save('x', { offset: 10, pinnedToBottom: false });
    sessionScroll.clear('x');
    expect(sessionScroll.load('x')).toBeUndefined();
  });
});
