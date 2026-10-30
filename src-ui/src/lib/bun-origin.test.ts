import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
import { bunOrigin, DEFAULT_BUN_ORIGIN, resetBunOriginForTests, resolveBunOrigin } from './bun-origin';

afterEach(() => {
  resetBunOriginForTests();
  invokeMock.mockReset();
});

describe('resolveBunOrigin', () => {
  it('prefers a discovered origin and trims its trailing slash', () => {
    expect(resolveBunOrigin('http://192.168.1.20:19877/')).toBe('http://192.168.1.20:19877');
    expect(resolveBunOrigin('http://127.0.0.1:19999')).toBe('http://127.0.0.1:19999');
  });

  it('falls back to the documented default', () => {
    expect(resolveBunOrigin(null)).toBe(DEFAULT_BUN_ORIGIN);
    expect(resolveBunOrigin('')).toBe(DEFAULT_BUN_ORIGIN);
    expect(resolveBunOrigin('   ')).toBe(DEFAULT_BUN_ORIGIN);
  });
});

describe('bunOrigin', () => {
  it('resolves through the native runtime discovery and sticks for the session', async () => {
    invokeMock.mockResolvedValue('http://192.168.1.20:19877/');
    expect(await bunOrigin()).toBe('http://192.168.1.20:19877');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // A later failed call cannot unset the answer.
    invokeMock.mockRejectedValue(new Error('gone'));
    expect(await bunOrigin()).toBe('http://192.168.1.20:19877');
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('uses the documented default when the resolver cannot answer', async () => {
    invokeMock.mockRejectedValue(new Error('no runtime'));
    expect(await bunOrigin()).toBe(DEFAULT_BUN_ORIGIN);
  });
});
