// ═══════════════════════════════════════════════════════════════
// ── HealthBanner — slim, self-hiding system-health strip
// ═══════════════════════════════════════════════════════════════
//
// Polls `jarvis_check_status` and stays invisible while the active backend
// is healthy; shows amber (degraded) or red (down) the moment something
// needs attention.

import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../ui';
import { usePolling } from '../../hooks/usePolling';
import type { JarvisStatus } from './types';

type Level = 'ok' | 'warn' | 'down';

// ── Health derivation using the new JarvisStatus shape ─────────

function backendOk(s: JarvisStatus): boolean {
  const backend = s.active_backend.toLowerCase();
  if (backend === 'ollama') return s.ollama_running && s.model_available;
  if (backend === 'openrouter') return s.openrouter_key_set;
  if (backend === 'claude_cli') return s.claude_proxy_running;
  return false;
}

function overallLevel(s: JarvisStatus, fetchError: string | null): Level {
  if (fetchError) return 'down';
  if (!backendOk(s)) return 'down';
  if (!s.bun_server_running) return 'warn';
  return 'ok';
}

function summaryFor(s: JarvisStatus, level: Level, fetchError: string | null): string {
  if (fetchError) return fetchError;
  if (level === 'down') {
    if (!backendOk(s)) return `Backend "${s.active_backend}" is unreachable`;
    return 'Status check failed';
  }
  if (!s.bun_server_running) return 'Bun server is not running — tools and skills unavailable';
  return 'Inference is responding slowly';
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
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const result = await invoke<JarvisStatus>('jarvis_check_status');
      setStatus(result);
      setFetchError(null);
    } catch (e) {
      setFetchError('Status check failed');
    }
  }, []);

  usePolling(fetchStatus, 15000, [fetchStatus]);

  if (!status) return null;
  const level = overallLevel(status, fetchError);
  if (level === 'ok') return null;

  const style = LEVEL_STYLES[level];
  const subsystems: Array<{ name: string; up: boolean; detail?: string }> = [
    { name: 'Bun server', up: status.bun_server_running, detail: status.bun_server_url },
    { name: 'Ollama', up: status.ollama_running, detail: status.model_available ? status.model : 'model not loaded' },
    { name: 'Model', up: status.model_available, detail: status.model || '—' },
    { name: 'OR key', up: status.openrouter_key_set },
    { name: 'Claude proxy', up: status.claude_proxy_running, detail: ':19878' },
    { name: 'Bridge', up: status.bridge_active, detail: `:${status.bridge_port}` },
  ];

  return (
    <div className={cn('border-b px-6 py-1.5 text-xs', style.bar)}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-2 w-full text-left"
      >
        <span className={cn('w-2 h-2 rounded-full animate-pulse', style.dot)} />
        <span className="font-medium uppercase tracking-wider text-[10px]">{style.label}</span>
        <span className="truncate opacity-90">{summaryFor(status, level, fetchError)}</span>
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
              {subsystems.map(sub => (
                <span key={sub.name} className="inline-flex items-center gap-1">
                  <span className={cn('w-1.5 h-1.5 rounded-full', sub.up ? 'bg-emerald-400' : 'bg-red-400')} />
                  {sub.name}
                  {sub.detail && <span className="opacity-50">({sub.detail})</span>}
                </span>
              ))}
              <span className="opacity-50">active: {status.active_backend}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
