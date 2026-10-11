/*
 * Fixture registry for the dev mock harness (see ./mock.ts). Fixtures in
 * ./fixtures/*.ts import ONLY from this module.
 */
import { emit } from '@tauri-apps/api/event';

export type CommandFixture = (args: Record<string, unknown>) => unknown | Promise<unknown>;
export type HttpFixture = (req: { method: string; path: string; body: unknown; signal?: AbortSignal | null }) => Response | Promise<Response>;

export const commands = new Map<string, CommandFixture>();
export const http = new Map<string, HttpFixture>();

export function defineCommands(map: Record<string, CommandFixture>) {
  for (const [k, v] of Object.entries(map)) commands.set(k, v);
}

/** Key format: "GET /health/inference" or "POST /chat/stream". */
export function defineHttp(map: Record<string, HttpFixture>) {
  for (const [k, v] of Object.entries(map)) http.set(k, v);
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build an SSE Response from an async generator of frame objects. */
export function sse(frames: () => AsyncGenerator<Record<string, unknown>>, signal?: AbortSignal | null) {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of frames()) {
          if (signal?.aborted) break;
          controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

/** Fire a Tauri event from a fixture (e.g. cron://missed-jobs). */
export function emitEvent(name: string, payload: unknown) {
  void emit(name, payload);
}

