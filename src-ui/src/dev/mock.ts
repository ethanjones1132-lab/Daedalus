/*
 * Dev-only mock harness. Load the app with `?mock` (e.g. http://localhost:5173/?mock)
 * to run every surface in a plain browser: Tauri IPC is served from fixtures, and
 * fetches to the Bun server (127.0.0.1:19877) are served from HTTP fixtures —
 * including a simulated SSE `/chat/stream` turn.
 *
 * Fixtures live in ./fixtures/*.ts and call `defineCommands` / `defineHttp` from ./registry.
 * Never imported in production builds (main.tsx gates it on import.meta.env.DEV).
 */
import { mockIPC } from '@tauri-apps/api/mocks';
import { commands, http, json, sleep } from './registry';

export async function installDevMocks() {
  const modules = import.meta.glob('./fixtures/*.ts', { eager: true });
  void modules;

  mockIPC(
    async (cmd, args) => {
      const fx = commands.get(cmd);
      if (!fx) {
        console.warn(`[mock] no fixture for command "${cmd}"`, args);
        throw new Error(`mock: no fixture for ${cmd}`);
      }
      await sleep(120 + Math.random() * 220);
      return fx((args ?? {}) as Record<string, unknown>);
    },
    { shouldMockEvents: true },
  );

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === '127.0.0.1' && url.port === '19877') {
      const method = (init?.method ?? 'GET').toUpperCase();
      const fx = http.get(`${method} ${url.pathname}`);
      if (!fx) {
        console.warn(`[mock] no HTTP fixture for ${method} ${url.pathname}`);
        return json({ error: 'no fixture' }, 404);
      }
      let body: unknown = undefined;
      try {
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      } catch {
        body = init?.body;
      }
      await sleep(80);
      return fx({ method, path: url.pathname, body, signal: init?.signal });
    }
    return realFetch(input, init);
  };
  console.info(`[mock] dev mocks installed: ${commands.size} commands, ${http.size} HTTP routes`);
}
