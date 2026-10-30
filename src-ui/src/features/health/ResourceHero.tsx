import { Dial, loadTone, Panel, Skeleton, Stat } from '../../design';
import type { HealthData } from '../../domain/system-telemetry-state';
import { decodeDiskReading, decodeMemoryReading } from '../../lib/memory-reading';
import { cacheTone, type DoctorReport, type InferenceMetrics } from './health-format';

function Readout({
  label,
  percent,
  display,
  sub,
}: {
  label: string;
  percent: number;
  display: string;
  sub: string;
}) {
  return (
    <div className="flex items-center gap-4">
      <Dial value={percent} tone={loadTone(percent)} size={108}>
        <span className="d-display tabular text-[28px] leading-none text-ink">{display}</span>
      </Dial>
      <div className="min-w-0">
        <div className="d-label">{label}</div>
        <div className="mt-1 text-[12px] leading-snug text-ink-3">{sub}</div>
      </div>
    </div>
  );
}

/**
 * One resource readout for a record this build cannot vouch for: the dial
 * renders its muted "not measured" state (empty arc), the label is the shared
 * sentinel and the sub-sentence names what could not be read. Never 0, never
 * green-ok, never a number.
 */
function UnmeasuredReadout({ label, display, sub }: { label: string; display: string; sub: string }) {
  return (
    <div className="flex items-center gap-4">
      <Dial value={null} tone={loadTone(null)} size={108}>
        <span className="text-[13px] leading-tight text-ink-3">{display}</span>
      </Dial>
      <div className="min-w-0">
        <div className="d-label">{label}</div>
        <div className="mt-1 text-[12px] leading-snug text-ink-3">{sub}</div>
      </div>
    </div>
  );
}

/**
 * The instrument cluster: memory and disk dials with their numbers as text,
 * plus three readouts. A readout that has not been observed says "—", never 0.
 */
export function ResourceHero({
  health,
  pending,
  doctor,
  inference,
}: {
  health: HealthData | null;
  pending: boolean;
  doctor: DoctorReport | null;
  inference: InferenceMetrics | null;
}) {
  const cache = inference?.conductor_cache ?? null;
  const worstError = inference && inference.window_size > 0 && inference.backends.length > 0
    ? Math.max(...inference.backends.map((b) => b.error_rate ?? 0))
    : null;
  const memoryReading = health ? decodeMemoryReading(health.memory) : null;
  const diskReading = health ? decodeDiskReading(health.disk) : null;
  return (
    <Panel ticks className="grid gap-6 lg:grid-cols-[auto_auto_1fr] lg:items-center">
      {health && memoryReading && diskReading ? (
        <>
          {memoryReading.kind === 'measured' ? (
            <Readout
              label="Memory"
              percent={memoryReading.percent}
              display={memoryReading.label}
              sub={`${health.memory.used_mb} / ${health.memory.total_mb} MB in use`}
            />
          ) : (
            <UnmeasuredReadout label="Memory" display={memoryReading.label} sub={memoryReading.basis} />
          )}
          {diskReading.kind === 'measured' ? (
            <Readout
              label="Disk"
              percent={diskReading.percent}
              display={diskReading.label}
              sub={`${diskReading.used} / ${diskReading.total} used · ${diskReading.available} free`}
            />
          ) : (
            <UnmeasuredReadout label="Disk" display={diskReading.label} sub={diskReading.basis} />
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-4" aria-hidden="true">
            <Skeleton className={pending ? 'size-[108px] rounded-full' : 'size-[108px] rounded-full opacity-40'} />
            <div className="space-y-2"><Skeleton className="w-16" /><Skeleton className="w-28" /></div>
          </div>
          <div className="flex items-center gap-4" aria-hidden="true">
            <Skeleton className={pending ? 'size-[108px] rounded-full' : 'size-[108px] rounded-full opacity-40'} />
            <div className="space-y-2"><Skeleton className="w-16" /><Skeleton className="w-28" /></div>
          </div>
        </>
      )}
      <div className="grid grid-cols-3 gap-5 border-t border-line pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
        <Stat
          label="Doctor checks"
          value={doctor ? `${doctor.summary.ok}/${doctor.summary.total}` : '—'}
          sub={doctor ? (doctor.summary.overall === 'ok' ? 'all passing' : `${doctor.summary.warn} warn · ${doctor.summary.error} error`) : 'not observed'}
          tone={doctor ? (doctor.summary.error > 0 ? 'error' : doctor.summary.warn > 0 ? 'warn' : 'ok') : undefined}
        />
        <Stat
          label="Error rate"
          value={worstError === null ? '—' : `${Math.round(worstError * 100)}%`}
          sub={inference && worstError !== null ? `worst of ${inference.window_size} turns` : 'no turns recorded'}
          tone={worstError === null ? undefined : worstError > 0.1 ? 'error' : worstError > 0 ? 'warn' : 'ok'}
        />
        <Stat
          label="Conductor cache"
          value={cache ? `${Math.round(cache.cache_hit_rate * 100)}%` : '—'}
          sub={cache ? `hit rate · ${cache.window_size} turns` : 'no conductor turns'}
          tone={cache ? ({ ok: 'ok', warn: 'warn', error: 'error' } as const)[cacheTone(cache.cache_hit_rate) as 'ok' | 'warn' | 'error'] : undefined}
        />
      </div>
    </Panel>
  );
}
