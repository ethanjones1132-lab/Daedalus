import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { cn, GlassCard, Pill, SectionHeader, StatusDot, LoadingState, ErrorState } from '../ui';

// Matches server-jarvis/src/inference-metrics.ts BackendStats shape.
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
}

interface OllamaHealth { running: boolean; model: string | null; url: string }
interface BunHealth { running: boolean; url: string }
interface BridgeHealth { running: boolean; port: number }
interface ClaudeProxyHealth { running: boolean; port: number }
interface DiskHealth { total: string; used: string; available: string; use_percent: string }
interface MemoryHealth { total_mb: number; available_mb: number; used_mb: number; used_percent: number }

interface HealthData {
  ollama: OllamaHealth;
  bun_server: BunHealth;
  bridge: BridgeHealth;
  claude_proxy: ClaudeProxyHealth;
  disk: DiskHealth;
  memory: MemoryHealth;
  timestamp: string;
}

interface DoctorCheck { name: string; status: string; detail: string }
interface DoctorReport {
  checks: DoctorCheck[];
  summary: { total: number; ok: number; warn: number; error: number; overall: string };
  timestamp: string;
}

function parsePercent(value: string): number {
  const n = Number(String(value).replace('%', '').trim());
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function Bar({ percent }: { percent: number }) {
  const color = percent >= 90 ? 'bg-red-400' : percent >= 75 ? 'bg-amber-400' : 'bg-emerald-400';
  return (
    <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
      <div className={cn('h-full rounded-full transition-[width] duration-500', color)} style={{ width: `${percent}%` }} />
    </div>
  );
}

function statusVariant(status: string): 'success' | 'warn' | 'error' | 'default' {
  const s = status.toLowerCase();
  if (s === 'ok' || s === 'pass') return 'success';
  if (s === 'warn' || s === 'warning') return 'warn';
  if (s === 'error' || s === 'fail') return 'error';
  return 'default';
}

const BUN_URL = 'http://127.0.0.1:19877';

export default function SystemHealthView() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [inferenceMetrics, setInferenceMetrics] = useState<InferenceMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [h, d, im] = await Promise.all([
        invoke<HealthData>('get_system_health').catch(() => null),
        invoke<DoctorReport>('get_doctor_report').catch(() => null),
        globalThis.fetch?.(`${BUN_URL}/health/inference`).then(r => r.ok ? r.json() as Promise<InferenceMetrics> : null).catch(() => null) ?? Promise.resolve(null),
      ]);
      setHealth(h);
      setDoctor(d);
      setInferenceMetrics(im);
      setLastRefresh(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const subsystems = health ? [
    { name: 'Ollama', up: health.ollama.running, detail: health.ollama.url },
    { name: 'Bun server', up: health.bun_server.running, detail: health.bun_server.url },
    { name: 'Bridge', up: health.bridge.running, detail: `:${health.bridge.port}` },
    { name: 'Claude proxy', up: health.claude_proxy.running, detail: `:${health.claude_proxy.port}` },
  ] : [];

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="System Health"
        subtitle="Subsystem status, resource usage, and diagnostic checks"
        action={
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-mono text-bone/30">
              {lastRefresh.toLocaleTimeString()}
            </span>
            <button
              type="button"
              onClick={fetch}
              className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-bone/60 hover:text-bone transition-colors"
            >
              Refresh
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto space-y-3 min-h-0">
        {loading ? (
          <LoadingState message="Checking system health…" />
        ) : error ? (
          <ErrorState error={error} onRetry={fetch} />
        ) : (
          <>
            {/* Subsystem status chips */}
            <GlassCard className="p-4">
              <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40 mb-3">
                Subsystems
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                {subsystems.map((s) => (
                  <div key={s.name} className="flex items-center gap-2 text-xs">
                    <StatusDot ok={s.up} warn={!s.up} />
                    <span className="text-bone font-medium">{s.name}</span>
                    <Pill variant={s.up ? 'success' : 'error'}>{s.up ? 'up' : 'down'}</Pill>
                    <span className="ml-auto font-mono text-[10px] text-bone/40 truncate">{s.detail}</span>
                  </div>
                ))}
              </div>
            </GlassCard>

            {/* Resource bars */}
            {health && (
              <GlassCard className="p-4 space-y-3">
                <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40">
                  Resources
                </div>
                <div className="space-y-2.5">
                  <div>
                    <div className="flex justify-between text-[10px] font-mono text-bone/50 mb-1">
                      <span>Memory ({health.memory.used_mb} / {health.memory.total_mb} MB)</span>
                      <span>{health.memory.used_percent}%</span>
                    </div>
                    <Bar percent={health.memory.used_percent} />
                  </div>
                  <div>
                    <div className="flex justify-between text-[10px] font-mono text-bone/50 mb-1">
                      <span>Disk ({health.disk.used} / {health.disk.total})</span>
                      <span>{health.disk.use_percent}</span>
                    </div>
                    <Bar percent={parsePercent(health.disk.use_percent)} />
                  </div>
                </div>
                <div className="text-[10px] font-mono text-bone/30 pt-1">
                  Available disk: {health.disk.available}
                </div>
              </GlassCard>
            )}

            {/* Doctor checks */}
            {doctor && (
              <GlassCard className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40">
                    Doctor report
                  </div>
                  <Pill variant={doctor.summary.overall === 'ok' ? 'success' : 'warn'}>
                    {doctor.summary.ok}/{doctor.summary.total} ok
                  </Pill>
                  {doctor.summary.warn > 0 && (
                    <Pill variant="warn">{doctor.summary.warn} warn</Pill>
                  )}
                  {doctor.summary.error > 0 && (
                    <Pill variant="error">{doctor.summary.error} error</Pill>
                  )}
                </div>
                <ul className="space-y-1.5">
                  {doctor.checks.map((c, i) => {
                    const v = statusVariant(c.status);
                    return (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        <span className="mt-0.5 shrink-0">
                          <StatusDot ok={v === 'success'} warn={v === 'warn'} />
                        </span>
                        <span className="text-bone">{c.name}</span>
                        <Pill variant={v}>{c.status}</Pill>
                        <span className="ml-auto text-right font-mono text-[10px] text-bone/40 max-w-[50%] truncate">
                          {c.detail}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-3 text-[10px] font-mono text-bone/25">
                  {doctor.timestamp}
                </div>
              </GlassCard>
            )}

            {/* Inference metrics — per-backend latency/error stats from the Bun ring buffer */}
            {inferenceMetrics && inferenceMetrics.window_size > 0 && (
              <GlassCard className="p-4">
                <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40 mb-3">
                  Inference (last {inferenceMetrics.window_size} turns)
                </div>
                <div className="space-y-2">
                  {inferenceMetrics.backends.map((b) => (
                    <div key={b.backend} className="text-xs flex items-center gap-3 flex-wrap">
                      <span className="font-mono text-bone font-medium w-28 shrink-0">{b.backend}</span>
                      <Pill variant={b.error_rate > 0.1 ? 'error' : b.error_rate > 0 ? 'warn' : 'success'}>
                        {b.errors}/{b.requests} err
                      </Pill>
                      <span className="font-mono text-bone/50 text-[10px]">p50 {b.p50_ms}ms</span>
                      <span className="font-mono text-bone/50 text-[10px]">p95 {b.p95_ms}ms</span>
                      {b.last_model && (
                        <span className="font-mono text-bone/30 text-[10px] truncate">{b.last_model}</span>
                      )}
                      {b.last_error && (
                        <span className="text-red-400 text-[10px] truncate">{b.last_error}</span>
                      )}
                    </div>
                  ))}
                </div>
              </GlassCard>
            )}
          </>
        )}
      </div>
    </div>
  );
}
