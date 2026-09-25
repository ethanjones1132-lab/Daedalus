// ═══════════════════════════════════════════════════════════════
// ── HealthBanner — slim, self-hiding system-health strip
// ═══════════════════════════════════════════════════════════════
//
// Polls `jarvis_check_status` and stays invisible while the active backend
// is healthy; shows amber (degraded) or red (down) the moment something
// needs attention. Recovery unmounts the strip, so the verdict is also
// carried by a live region that survives it — otherwise a self-hiding strip
// can never announce that it came back.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../ui';
import { usePolling } from '../../hooks/usePolling';
import type { JarvisStatus } from './types';
import { initialRegistryState, reduceRegistryState } from './action-registry-state';
import { projectHealthSubsystems, recoverAnnouncement, type HealthSubsystemState } from './health-banner-subsystems';

type Level = 'ok' | 'starting' | 'warn' | 'down' | 'unavailable';
export const STARTUP_GRACE_MS = 20_000;

// ── Health derivation using the new JarvisStatus shape ─────────

function backendOk(s: JarvisStatus): boolean {
  const backend = (s.active_backend ?? '').toLowerCase();
  if (backend === 'ollama') return !!(s.ollama_running) && !!(s.model_available);
  if (backend === 'openrouter') return !!(s.openrouter_key_set);
  if (backend === 'claude_cli') return !!(s.claude_proxy_running);
  return false;
}

function overallLevel(s: JarvisStatus, fetchError: string | null, mountedForMs: number): Level {
  if (fetchError) return 'unavailable';
  if (!backendOk(s)) return 'down';
  if (! (s.bun_server_running ?? false)) return mountedForMs < STARTUP_GRACE_MS ? 'starting' : 'warn';
  return 'ok';
}

function summaryFor(s: JarvisStatus, level: Level, fetchError: string | null): string {
  if (fetchError) return 'Health observation is unavailable.';
  if (level === 'down') {
    if (!backendOk(s)) return `Backend "${s.active_backend ?? ''}" is unreachable`;
    return 'Status check failed';
  }
  if (level === 'starting') return 'Starting Bun server — tools and skills are warming up';
  if (! (s.bun_server_running ?? false)) return 'Bun server is not running — tools and skills unavailable';
  return 'Inference is responding slowly';
}

const LEVEL_STYLES: Record<Exclude<Level, 'ok'>, { bar: string; dot: string; label: string }> = {
  unavailable: {
    bar: 'bg-amber-500/10 border-amber-500/30 text-amber-100',
    dot: 'bg-amber-400',
    label: 'Unavailable',
  },
  starting: {
    bar: 'bg-cyan-500/10 border-cyan-500/30 text-cyan-100',
    dot: 'bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.6)]',
    label: 'Starting',
  },
  warn: {
    bar: 'bg-amber-500/10 border-amber-500/30 text-amber-100',
    dot: 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.6)]',
    label: 'Degraded',
  },
  down: {
    bar: 'bg-red-500/10 border-red-500/30 text-red-100',
    dot: 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]',
    label: 'Offline',
  },
};

export function deriveHealthPresentation(
  status: JarvisStatus,
  fetchError: string | null,
  mountedForMs: number,
): { level: Level; label: string; summary: string } {
  const level = overallLevel(status, fetchError, mountedForMs);
  return {
    level,
    label: level === 'ok' ? 'Ready' : LEVEL_STYLES[level].label,
    summary: level === 'ok' ? 'All systems ready' : summaryFor(status, level, fetchError),
  };
}

// ── Component ──────────────────────────────────────────────────

const DOT_CLASS: Record<HealthSubsystemState, string> = {
  up: 'bg-emerald-400',
  down: 'bg-red-400',
  unknown: 'bg-amber-400',
  unprobed: 'bg-bone/40',
};

const DETAIL_CLASS: Record<HealthSubsystemState, string> = {
  up: 'text-bone/70',
  down: 'text-amber-200',
  unknown: 'text-amber-200/80',
  unprobed: 'text-bone/50',
};

export default function HealthBanner() {
  const mountedAtRef = useRef(Date.now());
  const [observation, dispatch] = useReducer(reduceRegistryState<JarvisStatus>, initialRegistryState<JarvisStatus>());
  const requestIdRef = useRef(0);
  const { snapshot: status, loading, error } = observation;
  const [expanded, setExpanded] = useState(false);
  // A focused Retry disappears with the strip the moment its read recovers.
  // Without a hand-off the browser strands focus on the document body, so the
  // flag is held until the announcement region is mounted and takes it instead.
  const focusAfterRetry = useRef(false);
  const announcementRef = useRef<HTMLDivElement | null>(null);

  const fetchStatus = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    dispatch({ type: 'pending', requestId });
    try {
      const result = await invoke<JarvisStatus>('jarvis_check_status');
      dispatch({ type: 'success', requestId, snapshot: result });
    } catch {
      dispatch({ type: 'failure', requestId });
    }
  }, []);

  usePolling(fetchStatus, 15000, [fetchStatus]);

  const presentation = status
    ? deriveHealthPresentation(status, error ? 'unavailable' : null, Date.now() - mountedAtRef.current)
    : { level: 'unavailable' as const, label: 'Unavailable', summary: 'Health observation is unavailable.' };
  const level = presentation.level;
  const stripStyle = level === 'ok' ? null : LEVEL_STYLES[level];
  const subsystems = projectHealthSubsystems(status);
  // The strip unmounts itself when healthy, so recovery is only ever said here.
  const announcement = level === 'ok' ? recoverAnnouncement(subsystems) : presentation.summary;

  useEffect(() => {
    if (!focusAfterRetry.current || !announcement) return;
    const node = announcementRef.current;
    if (!node) return;
    focusAfterRetry.current = false;
    node.focus();
  }, [announcement]);

  const retry = () => {
    focusAfterRetry.current = true;
    void fetchStatus();
  };

  return (
    <>
      <div role="status" aria-label="Health announcement" aria-atomic="true" className="sr-only">
        <div ref={announcementRef} tabIndex={-1} className="focus:outline-none">{announcement}</div>
      </div>
      {stripStyle && (
        <div className={cn('border-b px-6 py-1.5 text-xs', stripStyle.bar)}>
        {loading && (
          <div role="status" aria-label="Health observation">
            {status ? 'Refreshing health observation…' : 'Checking health…'}
          </div>
        )}
        {error && (
          <div role="alert" className="flex items-center gap-2">
            <span>
              Health observation is unavailable.
              {status && ' Showing previously observed health details; they may be stale.'}
            </span>
            <button type="button" disabled={loading} onClick={retry}
              className="rounded border px-2 py-0.5 disabled:opacity-50">
              Retry
            </button>
          </div>
        )}
        {status && <>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(e => !e)}
          className="flex items-center gap-2 w-full text-left"
        >
          <span className={cn('w-2 h-2 rounded-full animate-pulse', stripStyle.dot)} />
          <span className="font-medium uppercase tracking-wider text-[10px]">{presentation.label}</span>
          <span className="truncate opacity-90">{presentation.summary}</span>
          <span className="ml-auto opacity-60 font-mono text-[10px]">
            {expanded ? 'hide ▲' : 'details ▼'}
          </span>
        </button>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-2 pb-1 font-mono text-[10px] text-bone/70">
                {subsystems.rows.map(row => (
                  <li key={row.key} aria-label={row.announcement} className="inline-flex items-center gap-1">
                    <span className={cn('w-1.5 h-1.5 rounded-full', DOT_CLASS[row.state])} />
                    {row.name}
                    <span className={DETAIL_CLASS[row.state]}>{row.stateWord}</span>
                    <span className="opacity-50">· {row.requirementLabel}</span>
                    {row.detail && <span className="opacity-50">({row.detail})</span>}
                  </li>
                ))}
                <li className="opacity-50">active: {status.active_backend}</li>
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
        </>}
        </div>
      )}
    </>
  );
}
