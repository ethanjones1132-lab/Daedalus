import {
  AlertLine,
  Badge,
  Chip,
  EmptyState,
  Meter,
  Panel,
  PanelHeader,
  Skeleton,
  Sparkline,
  StatusLine,
  loadTone,
  toneOf,
} from '../../design';
import {
  cacheTone,
  errorRateTone,
  formatAttemptSummary,
  formatRuntimeProvenance,
  type ConductorCacheSummary,
  type ConductorDirectiveSummary,
  type InferenceMetrics,
  type ReadinessHealth,
  type RuntimeHealth,
} from './health-format';
import type { RuntimeTelemetryState } from './useRuntimeTelemetry';

const READINESS_TONE = { ready: 'ok', degraded: 'error', disabled: 'neutral', warming: 'warn', pending: 'warn' } as const;

function RuntimeProvenance({ runtime }: { runtime: RuntimeHealth | null }) {
  return (
    <Panel>
      <PanelHeader
        title="Runtime provenance"
        description="The Bun server's own version, commit and effective model."
        actions={
          <Badge tone={runtime?.model_resolved ? 'ok' : 'warn'}>
            {runtime?.model_resolved ? 'model resolved' : 'model unresolved'}
          </Badge>
        }
      />
      <p className="font-mono text-[12.5px] text-ink">{formatRuntimeProvenance(runtime)}</p>
      {runtime?.built_at && <p className="mt-1 text-[11.5px] text-ink-3">built {runtime.built_at}</p>}
    </Panel>
  );
}

function ConductorReadinessPanel({ readiness }: { readiness: ReadinessHealth }) {
  const c = readiness.conductor;
  return (
    <Panel>
      <PanelHeader
        title="Conductor readiness"
        description="Warm-up state of the orchestration conductor model."
        actions={<Badge tone={READINESS_TONE[c.state] ?? 'warn'}>{c.state}</Badge>}
      />
      <p className="truncate font-mono text-[12.5px] text-ink">
        {c.enabled ? c.model : 'disabled'}
        {c.latency_ms !== null ? ` · warm-up ${c.latency_ms}ms` : ''}
      </p>
      {c.error && <p className="mt-1.5 break-words text-[11.5px] text-warn">{c.error}</p>}
    </Panel>
  );
}

function InferenceTable({ metrics }: { metrics: InferenceMetrics }) {
  return (
    <Panel flush>
      <div className="px-4 pt-4">
        <PanelHeader title={`Inference (last ${metrics.window_size} turns)`} description="Per-backend latency and error rate from the Bun server's ring buffer." />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="d-label border-y border-line text-ink-3">
              <th scope="col" className="px-4 py-2 font-normal">Backend</th>
              <th scope="col" className="px-2 py-2 font-normal">Errors</th>
              <th scope="col" className="px-2 py-2 text-right font-normal">p50</th>
              <th scope="col" className="px-2 py-2 text-right font-normal">p95</th>
              <th scope="col" className="px-4 py-2 font-normal">Last model</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {metrics.backends.map((b) => (
              <tr key={b.backend}>
                <th scope="row" className="px-4 py-2.5 font-mono text-[12px] font-medium text-ink">{b.backend}</th>
                <td className="px-2 py-2.5">
                  <Badge tone={errorRateTone(b?.error_rate)} size="xs">
                    {b?.errors ?? 0}/{b?.requests ?? 1} err
                  </Badge>
                  {b.last_error && <span className="ml-2 max-w-[260px] truncate align-middle text-[11px] text-err">{b.last_error}</span>}
                </td>
                <td className="tabular px-2 py-2.5 text-right font-mono text-[11.5px] text-ink-2">{b.p50_ms}ms</td>
                <td className="tabular px-2 py-2.5 text-right font-mono text-[11.5px] text-ink-2">{b.p95_ms}ms</td>
                <td className="max-w-[220px] truncate px-4 py-2.5 font-mono text-[11px] text-ink-3">{b.last_model ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function OrchestrationPanel({ metrics }: { metrics: InferenceMetrics }) {
  const runtime = metrics.runtime;
  const utilisation = Math.round((runtime?.event_loop_utilization ?? 0) * 100);
  return (
    <Panel>
      <PanelHeader title="Orchestration performance" description="Event-loop health and the most recent inference attempts." />
      {runtime && (
        <div className="mb-4 grid grid-cols-3 gap-4">
          <div>
            <div className="d-label">Event loop p95</div>
            <div className="tabular mt-1 font-mono text-[13px] text-ink">{runtime.event_loop_delay_ms?.p95 ?? 0}ms</div>
          </div>
          <div>
            <div className="d-label">Utilization</div>
            <div className="tabular mt-1 font-mono text-[13px] text-ink">{utilisation}%</div>
            <Meter className="mt-1.5" value={utilisation} tone={loadTone(utilisation)} label="Event loop utilization" />
          </div>
          <div>
            <div className="d-label">RSS</div>
            <div className="tabular mt-1 font-mono text-[13px] text-ink">{Math.round((runtime.rss_bytes ?? 0) / 1024 / 1024)}MB</div>
          </div>
        </div>
      )}
      {metrics.recent_attempts.length > 0 ? (
        <ul className="space-y-1">
          {metrics.recent_attempts.slice(-5).reverse().map((attempt, index) => (
            <li key={`${attempt.ts ?? index}-${index}`} className="truncate font-mono text-[11.5px] text-ink-2">
              {formatAttemptSummary(attempt)}
              {attempt.first_token_ms !== undefined ? ` · first ${attempt.first_token_ms}ms` : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p className="font-mono text-[11.5px] text-ink-3">No attempt data yet</p>
      )}
    </Panel>
  );
}

function ConductorCachePanel({ cache }: { cache: ConductorCacheSummary }) {
  const tone = cacheTone(cache.cache_hit_rate);
  const series = cache.records
    .map((r) => r.prefix_tokens_recomputed)
    .filter((v): v is number => typeof v === 'number');
  return (
    <Panel>
      <PanelHeader
        title="Conductor cache"
        description="Warm-prefix reuse across the last conductor turns."
        actions={<Badge tone={tone}>{Math.round(cache.cache_hit_rate * 100)}% hit</Badge>}
      />
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[12px] text-ink-2">last {cache.window_size} turns</p>
          <p className="mt-1 font-mono text-[12px] text-ink-2">avg prefix recomputed: {Math.round(cache.avg_prefix_recomputed)} tokens</p>
          <p className="mt-1 text-[11.5px] text-ink-3">A-02 target: 80% hit rate on a 3-turn session</p>
        </div>
        {series.length >= 2 && (
          <div className="shrink-0 text-right">
            <Sparkline values={series} tone={tone} width={160} height={40} />
            <div className="d-label mt-1">recomputed tokens / turn</div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function DirectivesPanel({ directives }: { directives: ConductorDirectiveSummary }) {
  const entries = Object.entries(directives.by_type);
  return (
    <Panel>
      <PanelHeader title="Conductor directives" description="Request-scoped supervision actions." actions={<Chip>{directives.window_size} recent</Chip>} />
      <ul className="space-y-1.5">
        {entries.map(([type, count]) => (
          <li key={type} className="flex items-center gap-3 text-[12.5px]">
            <span className="w-32 shrink-0 font-mono text-ink">{type}</span>
            <Badge tone={toneOf(type === 'continue' ? 'success' : type === 'abort_stage' ? 'error' : 'warn')} size="xs">
              {count}
            </Badge>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** The Bun server's runtime telemetry: every panel is optional and independent. */
export function RuntimeView({ telemetry, onRetry }: { telemetry: RuntimeTelemetryState; onRetry: () => void }) {
  const { inference, directives, runtime, readiness, settled, failed, loading } = telemetry;
  const hasAny = Boolean(inference || directives || runtime || readiness);

  if (!settled) {
    return (
      <div className="space-y-3">
        <StatusLine label="Runtime telemetry observation">Loading runtime telemetry…</StatusLine>
        <Panel><div className="space-y-2.5" aria-hidden="true"><Skeleton className="w-1/3" /><Skeleton className="w-2/3" /></div></Panel>
      </div>
    );
  }
  if (!hasAny) {
    return (
      <AlertLine label="Runtime telemetry observation" tone="warn" onRetry={onRetry} retryDisabled={loading} retryLabel="Retry runtime telemetry">
        Runtime telemetry is unavailable. The Bun server did not answer its health endpoints.
      </AlertLine>
    );
  }
  return (
    <div className="space-y-4">
      {loading && <StatusLine label="Runtime telemetry observation">Refreshing runtime telemetry…</StatusLine>}
      {failed && (
        <AlertLine label="Runtime telemetry observation" tone="warn" onRetry={onRetry} retryDisabled={loading} retryLabel="Retry runtime telemetry">
          Runtime telemetry could not be refreshed. Showing previously observed data; it may be stale.
        </AlertLine>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <RuntimeProvenance runtime={runtime} />
        {readiness?.conductor ? <ConductorReadinessPanel readiness={readiness} /> : null}
      </div>
      {inference && inference.window_size > 0 && <InferenceTable metrics={inference} />}
      {inference && (inference.recent_attempts.length > 0 || inference.runtime) && <OrchestrationPanel metrics={inference} />}
      <div className="grid gap-4 lg:grid-cols-2">
        {inference?.conductor_cache && <ConductorCachePanel cache={inference.conductor_cache} />}
        {directives && directives.window_size > 0 && <DirectivesPanel directives={directives} />}
      </div>
      {inference && inference.window_size === 0 && !inference.conductor_cache && !inference.runtime && (
        <Panel>
          <EmptyState compact title="No inference turns recorded yet." description="Per-backend latency appears here once a Session turn has run." />
        </Panel>
      )}
    </div>
  );
}

