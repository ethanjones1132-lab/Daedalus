// ═══════════════════════════════════════════════════════════════
// ── bun-origin — where UI-side Bun HTTP reads should connect ───
// ═══════════════════════════════════════════════════════════════
//
// Pages that read the Bun server directly (skills lifecycle, health probes,
// channel receipts) used to hard-code `http://127.0.0.1:19877` in each of
// their modules, which silently broke whenever the server ran anywhere else
// (a configured port, a WSL distro — exactly what the native runtime already
// discovers and reports as `bun_server_url` in the status payload).
//
// The origin now comes from one place: the native resolver
// (`bun_server_origin`), the same
// discovery the status payload uses, with the same documented default. It is
// resolved once per session and sticks; when the resolver cannot answer (a
// test environment, a failed bridge before the server started), the
// documented default is used, which is exactly what the old constants said.

import { Channel, invoke } from '@tauri-apps/api/core';

/** The same default the native side documents (`DEFAULT_BUN_ORIGIN`). */
export const DEFAULT_BUN_ORIGIN = 'http://127.0.0.1:19877';

/**
 * How long a failed resolver answer suppresses further invokes. A page that
 * fetches repeatedly must not pay a failing Tauri invoke per request; 30 s is
 * short enough that a cold WSL cache can still resolve during normal use.
 */
export const BUN_ORIGIN_RETRY_MS = 30_000;

let cached: string | null = null;
let failedAt: number | null = null;

export function resetBunOriginForTests(): void {
  cached = null;
  failedAt = null;
}

/** Pure resolution, testable without Tauri. */
export function resolveBunOrigin(
  discovered: string | null | undefined,
): string {
  const trimmed = typeof discovered === 'string' ? discovered.trim() : '';
  if (trimmed) return trimmed.replace(/\/+$/, '');
  return DEFAULT_BUN_ORIGIN;
}

/**
 * The origin UI-side Bun HTTP reads should use. Resolved through the native
 * runtime; sticks after the first successful answer, so every fetch on a page
 * (and on later page loads) targets the same server.
 */
export async function bunOrigin(): Promise<string> {
  if (cached) return cached;
  if (failedAt !== null && Date.now() - failedAt < BUN_ORIGIN_RETRY_MS) {
    return DEFAULT_BUN_ORIGIN;
  }
  try {
    const value = await invoke<unknown>('bun_server_origin');
    if (typeof value === 'string') {
      cached = resolveBunOrigin(value);
      failedAt = null;
    } else {
      failedAt = Date.now();
    }
  } catch {
    // The documented default stands in; the read itself reports its own
    // failure rather than this resolution being guessed at. Remember the
    // failure briefly so repeated fetches do not re-invoke the resolver.
    failedAt = Date.now();
    return DEFAULT_BUN_ORIGIN;
  }
  return cached ?? DEFAULT_BUN_ORIGIN;
}

interface BunProxyResponse {
  status: number;
  body: number[];
  content_type?: string | null;
}

type BunStreamEvent =
  | { type: 'headers'; status: number; content_type?: string | null }
  | { type: 'chunk'; chunk: number[] }
  | { type: 'complete' }
  | { type: 'error'; message: string };

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function bunStreamFetch(pathAndQuery: string, init: RequestInit): Promise<Response> {
  if (init.signal?.aborted) throw abortError();

  const requestId = crypto.randomUUID();
  const channel = new Channel<BunStreamEvent>();
  const signal = init.signal;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let responseSettled = false;
  let streamFinished = false;
  let resolveResponse!: (response: Response) => void;
  let rejectResponse!: (error: unknown) => void;
  const responsePromise = new Promise<Response>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  let cancelInvoked = false;
  const cancelNative = () => {
    if (cancelInvoked) return;
    cancelInvoked = true;
    void invoke('bun_server_request_cancel', { requestId });
  };
  const onAbort = () => {
    cancelNative();
    streamFinished = true;
    const error = abortError();
    if (!responseSettled) {
      responseSettled = true;
      rejectResponse(error);
    }
    streamController?.error(error);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  channel.onmessage = (event) => {
    switch (event.type) {
      case 'headers': {
        if (responseSettled) return;
        responseSettled = true;
        const bodyForbidden = event.status === 204 || event.status === 205 || event.status === 304;
        const body = bodyForbidden ? null : new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
          cancel() {
            cancelNative();
          },
        });
        resolveResponse(new Response(body, {
          status: event.status,
          headers: event.content_type ? { 'Content-Type': event.content_type } : undefined,
        }));
        break;
      }
      case 'chunk':
        if (!streamFinished) streamController?.enqueue(new Uint8Array(event.chunk));
        break;
      case 'complete':
        streamFinished = true;
        streamController?.close();
        signal?.removeEventListener('abort', onAbort);
        break;
      case 'error': {
        streamFinished = true;
        const error = new Error(event.message);
        if (!responseSettled) {
          responseSettled = true;
          rejectResponse(error);
        }
        streamController?.error(error);
        signal?.removeEventListener('abort', onAbort);
        break;
      }
    }
  };

  void invoke('bun_server_request_stream', {
    requestId,
    pathAndQuery,
    method: init.method ?? 'GET',
    body: typeof init.body === 'string' ? init.body : null,
    onEvent: channel,
  }).catch((error: unknown) => {
    streamFinished = true;
    if (!responseSettled) {
      responseSettled = true;
      rejectResponse(error);
    }
    streamController?.error(error);
    signal?.removeEventListener('abort', onAbort);
  });

  const response = await responsePromise;
  return response;
}

/** Keep same-machine HTTP on fetch; route other hosts through native IPC. */
export async function bunFetch(pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  const origin = await bunOrigin();
  const host = new URL(origin).hostname;
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1') {
    return globalThis.fetch(`${origin}${pathAndQuery}`, init);
  }
  if (pathAndQuery === '/chat/stream') return bunStreamFetch(pathAndQuery, init);
  if (init.signal?.aborted) throw abortError();
  const result = await invoke<BunProxyResponse>('bun_server_request', {
    pathAndQuery,
    method: init.method ?? 'GET',
    body: typeof init.body === 'string' ? init.body : null,
  });
  const bodyForbidden = result.status === 204 || result.status === 205 || result.status === 304;
  return new Response(bodyForbidden ? null : new Uint8Array(result.body), {
    status: result.status,
    headers: result.content_type ? { 'Content-Type': result.content_type } : undefined,
  });
}
