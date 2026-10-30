import { describe, expect, it } from 'vitest';
import { memoryRecallStatusLabel } from './memory-turn-state';

describe('memoryRecallStatusLabel', () => {
  it('distinguishes no candidate from candidates that were filtered out', () => {
    expect(memoryRecallStatusLabel('empty')).toBe('no candidates matched');
    expect(memoryRecallStatusLabel('filtered')).toBe('filtered out (expired / unreadable)');
  });

  it('degrades an unknown status to unavailable instead of inventing one', () => {
    expect(memoryRecallStatusLabel('nonsense' as never)).toBe('unavailable');
  });
});
