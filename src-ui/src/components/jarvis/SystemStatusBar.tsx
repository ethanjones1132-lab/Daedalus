import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { cn, StatusDot, Pill } from '../ui';

interface HealthData {
  ollama: { running: boolean; model: string | null; url: string };
  bun_server: { running: boolean; url: string };
  bridge: { running: boolean; port: number };
  claude_proxy: { running: boolean; port: number };
  disk: { total: string; used: string; available: string; use_percent: string };
  memory: { total_mb: number; available_mb: number; used_mb: number; used_percent: number };
  timestamp: string;
  supervisor?: {
    bun_give_up: boolean;
    proxy_give_up: boolean;
    ollama_give_up: boolean;
  };
}

interface BackendStats {
  backend: string;
  requests: number;
  errors: number;
  error_rate: number;
  p50_ms: number;
  p95_ms: number;
  total_tokens_in: number;
  total_tokens_out: number;
  last_error?: string;
  last_model?: string;
}

interface InferenceMetrics {
  window_size: number;
  backends: BackendStats[];
  generated_at: number;
  recent_attempts: unknown[];
  runtime?: {
    event_loop_delay_ms?: { p95?: number; p99?: number };
    event_loop_utilization?: number;
    rss_bytes?: number;
  };
  conductor_cache?: {
    window_size: number;
    cache_hit_rate: number;
    avg_prefix_recomputed: number;
    records: unknown[];
    generated_at: number;
  } | null;
}

const BUN_URL = 'http://127.0.0.1:19877';

/**
 * Compact system status bar for the JarvisView header.
 * Shows at-a-glance health without navigation:
 * - Bun server status (core backend)
 * - Memory & disk usage
 * - Inference error rate (if any recent attempts)
 * - Conductor cache hit rate (when available)
 * - Supervisor give-up indicators
 */
export default function SystemStatusBar() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [inferenceMetrics, setInferenceMetrics] = useState<InferenceMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const [h, im] = await Promise.all([
        invoke<HealthData>('get_system_health').catch(() => null),
        globalThis.fetch?.(`${BUN_URL}/health/inference`)
          .then(r => r.ok ? r.json() as Promise<InferenceMetrics> : null)
          .catch(() => null) ?? Promise.resolve(null),
      ]);
      setHealth(h);
      setInferenceMetrics(im);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 30_000); // 30s refresh
    return () => clearInterval(interval);
  }, [fetchHealth]);

  // Derive overall status
  const bunUp = health?.bun_server.running ?? false;
  const ollamaUp = health?.ollama.running ?? false;
  const bridgeUp = health?.bridge.running ?? false;

  const coreHealthy = bunUp && bridgeUp; // Bun + bridge are essential
  const memoryPct = health?.memory.used_percent ?? 0;
  const diskPct = health?.disk.use_percent ? parseFloat(health.disk.use_percent.replace('%', '')) : 0;

  // Inference health: any backend with >10% error rate in recent window
  const hasInferenceErrors = inferenceMetrics && inferenceMetrics.window_size > 0 &&
    inferenceMetrics.backends.some(b => b.error_rate > 0.1);
  const inferenceErrorRate = inferenceMetrics && inferenceMetrics.window_size > 0
    ? Math.max(...inferenceMetrics.backends.map(b => b.error_rate))
    : 0;

  // Conductor cache hit rate (when available)
  const conductorHitRate = inferenceMetrics?.conductor_cache?.cache_hit_rate;

  // Supervisor give-up flags
  const bunGiveUp = health?.supervisor?.bun_give_up ?? false;
  const proxyGiveUp = health?.supervisor?.proxy_give_up ?? false;

  // Overall status dot: green if core healthy, amber if warnings, red if critical
  const overallOk = coreHealthy && !bunGiveUp && memoryPct < 90 && diskPct < 90;
  const overallWarn = !coreHealthy || hasInferenceErrors || bunGiveUp || proxyGiveUp || memoryPct >= 80 || diskPct >= 80;

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-1 py-1.5',
        'text-[10px] font-mono',
        'border-b border-white/[0.03]'
      )}
      title={error ? `Health fetch error: ${error}` : 'System health (click to refresh)'}
      onClick={fetchHealth}
      style={{ cursor: 'pointer' }}
    >
      {/* Core status dot */}
      <StatusDot ok={overallOk} warn={overallWarn} size="sm" />

      {/* Bun server - the backbone */}
      <span className={cn('px-1.5 py-0.5 rounded', bunUp ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300')}>
        BUN
      </span>

      {/* Bridge */}
      <span className={cn('px-1.5 py-0.5 rounded', bridgeUp ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300')}>
        BRG
      </span>

      {/* Ollama (optional but good to know) */}
      <span className={cn('px-1.5 py-0.5 rounded', ollamaUp ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300')}>
        OLL
      </span>

      {/* Memory */}
      <span className={cn('px-1.5 py-0.5 rounded', memoryPct >= 90 ? 'bg-red-500/15 text-red-300' : memoryPct >= 80 ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300')}>
        MEM {memoryPct}%
      </span>

      {/* Disk */}
      <span className={cn('px-1.5 py-0.5 rounded', diskPct >= 90 ? 'bg-red-500/15 text-red-300' : diskPct >= 80 ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300')}>
        DSK {diskPct}%
      </span>

      {/* Inference error rate (when we have data) */}
      {inferenceMetrics && inferenceMetrics.window_size > 0 && (
        <span className={cn('px-1.5 py-0.5 rounded', hasInferenceErrors ? 'bg-red-500/15 text-red-300' : 'bg-emerald-500/15 text-emerald-300')}>
          ERR {Math.round(inferenceErrorRate * 100)}%
        </span>
      )}

      {/* Conductor cache hit rate (when available) */}
      {conductorHitRate !== undefined && conductorHitRate !== null && (
        <span className={cn('px-1.5 py-0.5 rounded', conductorHitRate >= 0.8 ? 'bg-emerald-500/15 text-emerald-300' : conductorHitRate >= 0.5 ? 'bg-amber-500/15 text-amber-300' : 'bg-red-500/15 text-red-300')}>
          CND {Math.round(conductorHitRate * 100)}%
        </span>
      )}

      {/* Supervisor give-up indicators */}
      {bunGiveUp && (
        <Pill variant="error" className="text-[9px]">BUN GIVE-UP</Pill>
      )}
      {proxyGiveUp && (
        <Pill variant="error" className="text-[9px]">PRX GIVE-UP</Pill>
      )}

      {/* Click hint */}
      <span className="ml-auto text-bone/20">click ↻</span>
    </div>
  );
}