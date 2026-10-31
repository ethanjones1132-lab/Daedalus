// ═══════════════════════════════════════════════════════════════
// ── health-derivation — the one verdict the banner and Health page share
// ═══════════════════════════════════════════════════════════════
//
// Pure: no React, no Tauri, no clock. `HealthBanner` (global strip) and
// `HealthPage` (the masthead verdict sentence) both read `jarvis_check_status`
// and must never disagree about whether the active Inference backend is up,
// so both go through `deriveHealthPresentation`.

import type { JarvisStatus } from '../../domain/types';

export type HealthLevel = 'ok' | 'starting' | 'warn' | 'down' | 'unavailable';

/**
 * How long a not-yet-ready service reads as "starting" rather than failed: a
 * missing Bun server while the backend is ready, or a backend that is still
 * coming up.
 */
export const STARTUP_GRACE_MS = 20_000;

/*
 * The startup grace is measured from when the app first observed health — the
 * HealthBanner mounts with the shell, so it records that moment. Other
 * surfaces (the Health page) reuse it, so the banner and the page never
 * disagree about whether a service is still "starting".
 */
let firstObservedAt: number | null = null;

export function recordFirstHealthObservation(at: number): void {
  if (firstObservedAt === null) firstObservedAt = at;
}

/** The shared grace anchor, or `fallback` when no banner has mounted (isolated views). */
export function healthGraceAnchor(fallback: number): number {
  return firstObservedAt ?? fallback;
}

/**
 * Whether the active Inference backend can serve a Session turn.
 *
 * `llama_cpp` is the DEFAULT backend (CONTEXT.md): it is a local backend whose
 * server must be running. It used to fall through to `false`, so a healthy
 * llama.cpp install read "Offline". Native reports `model_available` as a
 * constant for every non-Ollama backend (`!is_ollama`), so it is only ever
 * consulted for Ollama; llama.cpp is judged by its own server flag.
 */
export function backendOk(s: JarvisStatus): boolean {
  const backend = (s.active_backend ?? '').toLowerCase();
  if (backend === 'ollama') return !!s.ollama_running && !!s.model_available;
  if (backend === 'llama_cpp') return !!s.llama_cpp_running;
  if (backend === 'openrouter') return !!s.openrouter_key_set;
  if (backend === 'claude_cli') return !!s.claude_proxy_running;
  return false;
}

function overallLevel(s: JarvisStatus, fetchError: string | null, mountedForMs: number): HealthLevel {
  if (fetchError) return 'unavailable';
  /*
   * A cold start is the normal case: native spawns the Inference backend in the
   * background and the first poll fires immediately, long before the model can
   * answer (`llama_cpp` needs its server up; Ollama needs its model loaded). So
   * a backend that is not ready yet gets the same bounded grace the Bun server
   * gets and reads "starting" with a loading sentence; only after the window is
   * a stopped backend a real outage. The backend still outranks the bridge
   * warning after the window.
   */
  if (!backendOk(s)) return mountedForMs < STARTUP_GRACE_MS ? 'starting' : 'down';
  if (!(s.bun_server_running ?? false)) return mountedForMs < STARTUP_GRACE_MS ? 'starting' : 'warn';
  /*
   * The bridge serves external Agent ingress only (server-jarvis/src/bridge.ts);
   * a Session turn never passes through it. So a stopped bridge is a warning
   * that names it, never "All systems ready", and never "Offline" — but only
   * while the operator's Enable Bridge setting is on. An older native surface
   * that omits the flag reads as enabled, matching how the gauges relay it.
   */
  if (s.bridge_enabled !== false && s.bridge_active === false) return 'warn';
  return 'ok';
}

function summaryFor(s: JarvisStatus, level: HealthLevel, fetchError: string | null): string {
  if (fetchError) return 'Health observation is unavailable.';
  if (level === 'down') {
    if (!backendOk(s)) return `Backend "${s.active_backend ?? ''}" is unreachable`;
    return 'Status check failed';
  }
  if (level === 'starting') {
    // A backend that is the reason for the wait says so, rather than borrowing
    // the Bun-only sentence while Bun is already up.
    if (!backendOk(s)) return 'The local model is still loading — the Inference backend is starting up';
    return 'Starting Bun server — tools and skills are warming up';
  }
  if (level === 'warn') {
    if (!(s.bun_server_running ?? false)) return 'Bun server is not running — tools and skills unavailable';
    if (s.bridge_enabled !== false && s.bridge_active === false) {
      return 'External Agent bridge is not running — Session turns and inference are unaffected';
    }
  }
  // Only `ok` reaches here. Do not label an unknown future warn cause as a slow
  // inference response.
  return 'All required services are running.';
}

const LABELS: Record<Exclude<HealthLevel, 'ok'>, string> = {
  unavailable: 'Unavailable',
  starting: 'Starting',
  warn: 'Degraded',
  down: 'Offline',
};

export interface HealthPresentation {
  level: HealthLevel;
  label: string;
  summary: string;
}

export function deriveHealthPresentation(
  status: JarvisStatus,
  fetchError: string | null,
  mountedForMs: number,
): HealthPresentation {
  const level = overallLevel(status, fetchError, mountedForMs);
  return {
    level,
    label: level === 'ok' ? 'Ready' : LABELS[level],
    summary: level === 'ok' ? 'All systems ready' : summaryFor(status, level, fetchError),
  };
}

/**
 * A snapshot that failed its most recent refresh must never read as current.
 * The verdict keeps its content but loses its plain "Ready" label and gains
 * an explicit staleness sentence, matching the observation panels' copy.
 */
export function markStalePresentation(presentation: HealthPresentation): HealthPresentation {
  return {
    level: presentation.level === 'ok' ? 'warn' : presentation.level,
    label: `${presentation.label} (stale)`,
    summary: `${presentation.summary} Showing the last observed status; it may be stale.`,
  };
}
