import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
import {
  BUN_ORIGIN_RETRY_MS,
  bunFetch,
  bunOrigin,
  DEFAULT_BUN_ORIGIN,
  resetBunOriginForTests,
  resolveBunOrigin,
} from './bun-origin';

afterEach(() => {
  resetBunOriginForTests();
  invokeMock.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it('does not re-invoke the failed resolver on every fetch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
    invokeMock.mockRejectedValue(new Error('no runtime'));

    expect(await bunOrigin()).toBe(DEFAULT_BUN_ORIGIN);
    expect(await bunOrigin()).toBe(DEFAULT_BUN_ORIGIN);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.parse('2026-10-30T00:00:00Z') + BUN_ORIGIN_RETRY_MS + 1));
    expect(await bunOrigin()).toBe(DEFAULT_BUN_ORIGIN);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('retries after the cooldown and then sticks once resolved', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
    invokeMock.mockRejectedValueOnce(new Error('cold cache'));
    expect(await bunOrigin()).toBe(DEFAULT_BUN_ORIGIN);

    vi.setSystemTime(new Date(Date.parse('2026-10-30T00:00:00Z') + BUN_ORIGIN_RETRY_MS + 1));
    invokeMock.mockResolvedValueOnce('http://192.168.1.20:19877');
    expect(await bunOrigin()).toBe('http://192.168.1.20:19877');
    expect(await bunOrigin()).toBe('http://192.168.1.20:19877');
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});

describe('bunFetch', () => {
  it('uses the native IPC proxy for a non-loopback Bun origin', async () => {
    invokeMock.mockResolvedValueOnce('http://192.168.1.20:19877');
    invokeMock.mockResolvedValueOnce({
      status: 503,
      body: Array.from(new TextEncoder().encode('{"error":"offline"}')),
      content_type: 'application/json',
    });
    const fetch = vi.spyOn(globalThis, 'fetch');

    const response = await bunFetch('/health?detail=full');

    expect(invokeMock).toHaveBeenNthCalledWith(2, 'bun_server_request', {
      pathAndQuery: '/health?detail=full',
      method: 'GET',
      body: null,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"offline"}');
  });

  it('keeps the documented loopback origin on the existing fetch path', async () => {
    invokeMock.mockResolvedValueOnce('http://127.0.0.1:19877');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    const response = await bunFetch('/health');

    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:19877/health', {});
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe('ok');
  });
});
