import { describe, expect, it } from 'vitest';
import { parseSessionGrantsResponse } from './workspace-grants-state';

describe('parseSessionGrantsResponse', () => {
  it('returns a copy of a matching response', () => {
    const grants = ['/workspace/one', '/workspace/two'];
    const result = parseSessionGrantsResponse({ session_id: 'session-a', grants }, 'session-a');
    expect(result).toEqual(grants);
    expect(result).not.toBe(grants);
  });

  it('accepts a successful empty response', () => {
    expect(parseSessionGrantsResponse({ session_id: 'session-a', grants: [] }, 'session-a')).toEqual([]);
  });

  it('rejects a response for another Session', () => {
    expect(parseSessionGrantsResponse({ session_id: 'session-b', grants: ['/workspace/one'] }, 'session-a')).toBeNull();
  });

  it.each([
    null,
    {},
    { session_id: 'session-a' },
    { session_id: 'session-a', grants: null },
    { session_id: 'session-a', grants: '/workspace/one' },
    { session_id: 'session-a', grants: ['/workspace/one', 7] },
  ])('rejects malformed response %#', (value) => {
    expect(parseSessionGrantsResponse(value, 'session-a')).toBeNull();
  });
});
