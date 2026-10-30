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

import { invoke } from '@tauri-apps/api/core';

/** The same default the native side documents (`DEFAULT_BUN_ORIGIN`). */
export const DEFAULT_BUN_ORIGIN = 'http://127.0.0.1:19877';

let cached: string | null = null;

export function resetBunOriginForTests(): void {
  cached = null;
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
  try {
    const value = await invoke<unknown>('bun_server_origin');
    if (typeof value === 'string') cached = resolveBunOrigin(value);
  } catch {
    // The documented default stands in; the read itself reports its own
    // failure rather than this resolution being guessed at.
    return DEFAULT_BUN_ORIGIN;
  }
  return cached ?? DEFAULT_BUN_ORIGIN;
}
