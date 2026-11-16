import { afterEach, describe, expect, it, vi } from 'vitest';
import { Channel } from '@tauri-apps/api/core';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class {
    onmessage?: (message: any) => void;
  },
}));
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

  it('streams a non-loopback chat response as chunks arrive', async () => {
    type StreamEvent =
      | { type: 'headers'; status: number; content_type?: string | null }
      | { type: 'chunk'; chunk: number[] }
      | { type: 'complete' }
      | { type: 'error'; message: string };
    let channel: Channel<StreamEvent> | undefined;
    invokeMock.mockImplementation((command: string, args?: { onEvent?: Channel<StreamEvent> }) => {
      if (command === 'bun_server_origin') return Promise.resolve('http://192.168.1.20:19877');
      if (command === 'bun_server_request_stream') {
        channel = args?.onEvent;
        return new Promise(() => {});
      }
      return Promise.resolve();
    });

    const responsePromise = bunFetch('/chat/stream', { method: 'POST', body: '{}' });
    await vi.waitFor(() => expect(channel).toBeDefined());
    channel!.onmessage({ type: 'headers', status: 200 });
    const response = await responsePromise;
    const reader = response.body!.getReader();
    let lastChunkProduced = false;
    channel!.onmessage({ type: 'chunk', chunk: Array.from(new TextEncoder().encode('first')) });
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toBe('first');
    expect(first.done).toBe(false);
    expect(lastChunkProduced).toBe(false);
    lastChunkProduced = true;
    channel!.onmessage({ type: 'chunk', chunk: Array.from(new TextEncoder().encode('last')) });
    channel!.onmessage({ type: 'complete' });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('last');
    expect((await reader.read()).done).toBe(true);
  });

  it('aborts a non-loopback chat stream with AbortError and cancels native I/O', async () => {
    type StreamEvent =
      | { type: 'headers'; status: number; content_type?: string | null }
      | { type: 'chunk'; chunk: number[] }
      | { type: 'complete' }
      | { type: 'error'; message: string };
    let channel: Channel<StreamEvent> | undefined;
    invokeMock.mockImplementation((command: string, args?: { onEvent?: Channel<StreamEvent> }) => {
      if (command === 'bun_server_origin') return Promise.resolve('http://192.168.1.20:19877');
      if (command === 'bun_server_request_stream') {
        channel = args?.onEvent;
        return new Promise(() => {});
      }
      return Promise.resolve();
    });
    const controller = new AbortController();
    const responsePromise = bunFetch('/chat/stream', {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(channel).toBeDefined());
    channel!.onmessage({ type: 'headers', status: 200 });
    const reader = (await responsePromise).body!.getReader();

    controller.abort();

    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('bun_server_request_cancel', expect.any(Object)),
    );
  });

  it('rejects a non-loopback chat stream that completes before any headers', async () => {
    type StreamEvent =
      | { type: 'headers'; status: number; content_type?: string | null }
      | { type: 'chunk'; chunk: number[] }
      | { type: 'complete' }
      | { type: 'error'; message: string };
    let channel: Channel<StreamEvent> | undefined;
    invokeMock.mockImplementation((command: string, args?: { onEvent?: Channel<StreamEvent> }) => {
      if (command === 'bun_server_origin') return Promise.resolve('http://192.168.1.20:19877');
      if (command === 'bun_server_request_stream') {
        channel = args?.onEvent;
        return new Promise(() => {});
      }
      return Promise.resolve();
    });

    const responsePromise = bunFetch('/chat/stream', { method: 'POST', body: '{}' });
    const settled = expect(responsePromise).rejects.toThrow(/ended before it started/);
    await vi.waitFor(() => expect(channel).toBeDefined());

    channel!.onmessage({ type: 'complete' });

    // Must reject with a real Error, not hang and not reject with a bare value.
    await expect(responsePromise).rejects.toBeInstanceOf(Error);
    await settled;
  });

  it('rejects a non-loopback chat stream that errors before any headers', async () => {
    type StreamEvent =
      | { type: 'headers'; status: number; content_type?: string | null }
      | { type: 'chunk'; chunk: number[] }
      | { type: 'complete' }
      | { type: 'error'; message: string };
    let channel: Channel<StreamEvent> | undefined;
    invokeMock.mockImplementation((command: string, args?: { onEvent?: Channel<StreamEvent> }) => {
      if (command === 'bun_server_origin') return Promise.resolve('http://192.168.1.20:19877');
      if (command === 'bun_server_request_stream') {
        channel = args?.onEvent;
        return new Promise(() => {});
      }
      return Promise.resolve();
    });

    const responsePromise = bunFetch('/chat/stream', { method: 'POST', body: '{}' });
    const settled = expect(responsePromise).rejects.toThrow('boom');
    await vi.waitFor(() => expect(channel).toBeDefined());

    channel!.onmessage({ type: 'error', message: 'boom' });

    await expect(responsePromise).rejects.toBeInstanceOf(Error);
    await settled;
  });
});
