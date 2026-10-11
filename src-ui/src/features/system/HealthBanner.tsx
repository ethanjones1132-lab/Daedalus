// ═══════════════════════════════════════════════════════════════
// ── HealthBanner — slim, self-hiding system-health band
// ═══════════════════════════════════════════════════════════════
//
// Polls `jarvis_check_status` and stays invisible while the active Inference
// backend is healthy; shows a warn (degraded), err (offline) or info
// (starting) band the moment something needs attention. Recovery unmounts the
// band, so the verdict is also carried by a live region that survives it —
// otherwise a self-hiding band can never announce that it came back.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown } from 'lucide-react';
import { Button, cn, StatusDot, type Tone } from '../../design';
import { usePolling } from '../../hooks/usePolling';
import type { JarvisStatus } from '../../domain/types';
import { initialRegistryState, reduceRegistryState } from '../../domain/action-registry-state';
import {
  projectHealthSubsystems,
  recoverAnnouncement,
  type HealthSubsystemState,
} from '../../domain/health-banner-subsystems';
import { deriveHealthPresentation, recordFirstHealthObservation, type HealthLevel } from './health-derivation';

export { deriveHealthPresentation, STARTUP_GRACE_MS } from './health-derivation';

interface BandStyle {
  band: string;
  tone: Tone;
}

// Literal class strings so Tailwind can see them.
const BAND_STYLES: Record<Exclude<HealthLevel, 'ok'>, BandStyle> = {
  unavailable: { band: 'border-l-warn bg-warn-wash text-ink', tone: 'warn' },
  starting: { band: 'border-l-info bg-info-wash text-ink', tone: 'info' },
  warn: { band: 'border-l-warn bg-warn-wash text-ink', tone: 'warn' },
  down: { band: 'border-l-err bg-err-wash text-ink', tone: 'error' },
};

const LABEL_TEXT: Record<HealthLevel, string> = {
  ok: 'text-ok',
  unavailable: 'text-warn',
  starting: 'text-info',
  warn: 'text-warn',
  down: 'text-err',
};

const DOT_TONE: Record<HealthSubsystemState, Tone> = {
  up: 'ok',
  down: 'error',
  unknown: 'warn',
  unprobed: 'muted',
};

const STATE_TEXT: Record<HealthSubsystemState, string> = {
  up: 'text-ink-2',
  down: 'text-warn',
  unknown: 'text-warn',
  unprobed: 'text-ink-3',
};

export default function HealthBanner() {
  const mountedAtRef = useRef(Date.now());
  recordFirstHealthObservation(mountedAtRef.current);
  const [observation, dispatch] = useReducer(reduceRegistryState<JarvisStatus>, initialRegistryState<JarvisStatus>());
  const requestIdRef = useRef(0);
  const { snapshot: status, loading, error } = observation;
  const [expanded, setExpanded] = useState(false);
  // A focused Retry disappears with the band the moment its read recovers.
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
  const style = level === 'ok' ? null : BAND_STYLES[level];
  const subsystems = projectHealthSubsystems(status);
  // The band unmounts itself when healthy, so recovery is only ever said here.
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

  // First read still in flight: a calm info band, not an amber warning.
  const checking = !status && loading && !error;

  return (
    <>
      <div role="status" aria-label="Health announcement" aria-atomic="true" className="sr-only">
        <div ref={announcementRef} tabIndex={-1} className="focus:outline-none">
          {announcement}
        </div>
      </div>
      {style && (
        <div
          data-health-level={level}
          className={cn(
            'd-rise shrink-0 border-b border-l-2 border-b-line px-4 text-[12.5px]',
            checking ? 'border-l-info bg-info-wash text-ink' : style.band,
          )}
        >
          {loading && (
            <div role="status" aria-label="Health observation" className="flex min-h-8 items-center text-ink-3">
              {status ? 'Refreshing health observation…' : 'Checking health…'}
            </div>
          )}
          {error && (
            <div role="alert" className="flex min-h-8 items-center gap-3">
              <span>
                Health observation is unavailable.
                {status && ' Showing previously observed health details; they may be stale.'}
              </span>
              <Button size="xs" variant="secondary" disabled={loading} onClick={retry}>
                Retry
              </Button>
            </div>
          )}
          {status && (
            <>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((e) => !e)}
                className="group flex min-h-8 w-full items-center gap-3 text-left"
              >
                <StatusDot tone={style.tone} live={level !== 'unavailable'} />
                <span className={cn('d-label shrink-0 font-medium', LABEL_TEXT[level])}>{presentation.label}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{presentation.summary}</span>
                <span className="d-label flex shrink-0 items-center gap-1 text-ink-3 group-hover:text-ink-2">
                  {expanded ? 'hide details' : 'details'}
                  <ChevronDown
                    aria-hidden="true"
                    className={cn('size-3 transition-transform duration-200', expanded && 'rotate-180')}
                  />
                </span>
              </button>

              {expanded && (
                <ul className="d-rise flex flex-wrap gap-x-5 gap-y-1.5 pb-2.5 pt-0.5 font-mono text-[11px] text-ink-3">
                  {subsystems.rows.map((row) => (
                    <li key={row.key} aria-label={row.announcement} className="inline-flex items-center gap-1.5">
                      <StatusDot tone={DOT_TONE[row.state]} />
                      <span className="text-ink-2">{row.name}</span>
                      <span className={STATE_TEXT[row.state]}>{row.stateWord}</span>
                      <span className="text-ink-4">· {row.requirementLabel}</span>
                      {row.detail && <span className="text-ink-4">({row.detail})</span>}
                    </li>
                  ))}
                  <li className="text-ink-4">active: {status.active_backend}</li>
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
