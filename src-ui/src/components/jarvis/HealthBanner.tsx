// ═══════════════════════════════════════════════════════════════
// ── HealthBanner — slim, self-hiding system-health strip
// ═══════════════════════════════════════════════════════════════
//
// Rendered globally between the header and main content (App.tsx). Polls
// `jarvis_check_status` and stays invisible while the active backend is healthy
// and config is clean; surfaces a colored strip (amber = degraded/warnings,
// red = disconnected/errors) the moment something needs attention, expandable
// to per-subsystem detail.

import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../ui';
import { usePolling } from '../../hooks/usePolling';
import type { JarvisStatus } from './types';

// ── Health derivation ──────────────────────────────────────────

type Level = 'ok' | 'warn' | 'down';

function backendLevel(s: JarvisStatus): Level {
  const backend = (s.active_backend || s.backend || '').toLowerCase();
  if (backend.includes('ollama')) {
    if (!s.ollama_running) return 'down';
    return s.ollama_latency_ms > 2000 ? 'warn' : 'ok';
  }
  if (backend.includes('openrouter')) {
    if (!s.openrouter_ok) return 'down';
    return s.openrouter_latency_ms > 2000 ? 'warn' : 'ok';
  }
  if (backend.includes('claude')) {
    return s.claude_cli_available || s.claude_proxy_active ? 'ok' : 'down';
  }
  // Unknown backend: healthy if anything is reachable.
  return s.ollama_running || s.openrouter_ok || s.claude_proxy_active ? 'ok' : 'down';
}

function overallLevel(s: JarvisStatus): Level {
  if (s.error || (s.config_errors?.length ?? 0) > 0) return 'down';
  const b = backendLevel(s);
  if (b === 'down') return 'down';
  if (b === 'warn' || (s.config_warnings?.length ?? 0) > 0) return 'warn';
  return 'ok';
}

function summaryFor(s: JarvisStatus, level: Level): string {
  if (s.error) return s.error;
  const backend = s.active_backend || s.backend || 'backend';
  if (level === 'down') {
    if ((s.config_errors?.length ?? 0) > 0) return `Configuration error: ${s.config_errors[0]}`;
    return `Inference backend "${backend}" is unreachable`;
  }
  if ((s.config_warnings?.length ?? 0) > 0) return s.config_warnings[0];
  return `Inference backend "${backend}" is responding slowly`;
}

const LEVEL_STYLES: Record<Exclude<Level, 'ok'>, { bar: string; dot: string; label: string }> = {
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

// ── Component ──────────────────────────────────────────────────

export default function HealthBanner() {
  const [status, setStatus] = useState<JarvisStatus | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const result = await invoke<JarvisStatus>('jarvis_check_status');
      setStatus(result);
    } catch {
      // Treat an unreachable status command as "everything down".
      setStatus((prev) =>
        prev
          ? { ...prev, error: 'Status check failed' }
          : ({ error: 'Status check failed' } as JarvisStatus),
      );
    }
  }, []);

  usePolling(fetchStatus, 15000, [fetchStatus]);

  if (!status) return null;
  const level = overallLevel(status);
  if (level === 'ok') return null; // self-hiding when healthy

  const style = LEVEL_STYLES[level];
  const subsystems: Array<{ name: string; up: boolean; detail?: string }> = [
    {
      name: 'Ollama',
      up: status.ollama_running,
      detail: status.ollama_running ? `${status.ollama_latency_ms}ms` : 'stopped',
    },
    {
      name: 'OpenRouter',
      up: status.openrouter_ok,
      detail: status.openrouter_ok ? `${status.openrouter_latency_ms}ms` : 'unreachable',
    },
    { name: 'Claude proxy', up: status.claude_proxy_active },
    {
      name: 'Bridge',
      up: status.bridge_active,
      detail: status.bridge_active ? `:${status.bridge_port}` : 'down',
    },
    { name: 'Bun', up: status.bun_available },
  ];

  return (
    <div className={cn('border-b px-6 py-1.5 text-xs', style.bar)}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-2 w-full text-left"
      >
        <span className={cn('w-2 h-2 rounded-full animate-pulse', style.dot)} />
        <span className="font-medium uppercase tracking-wider text-[10px]">{style.label}</span>
        <span className="truncate opacity-90">{summaryFor(status, level)}</span>
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
            <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 pb-1 font-mono text-[10px] text-bone/70">
              {subsystems.map((sub) => (
                <span key={sub.name} className="inline-flex items-center gap-1">
                  <span
                    className={cn(
                      'w-1.5 h-1.5 rounded-full',
                      sub.up ? 'bg-emerald-400' : 'bg-red-400',
                    )}
                  />
                  {sub.name}
                  {sub.detail && <span className="opacity-50">({sub.detail})</span>}
                </span>
              ))}
              <span className="opacity-50">
                active: {status.active_backend || status.backend || '—'}
              </span>
            </div>

            {(status.config_errors?.length ?? 0) > 0 && (
              <ul className="mt-1 space-y-0.5 text-[10px] text-red-200">
                {status.config_errors.map((e, i) => (
                  <li key={i}>• {e}</li>
                ))}
              </ul>
            )}
            {(status.config_warnings?.length ?? 0) > 0 && (
              <ul className="mt-1 space-y-0.5 text-[10px] text-amber-200/90">
                {status.config_warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
