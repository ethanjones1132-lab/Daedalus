import { Badge, EmptyState, KeyValue, Panel, PanelHeader, RowList, Skeleton, StatusDot } from '../../design';
import type { HealthData } from '../../domain/system-telemetry-state';
import { checkTone, type DoctorReport } from './health-format';

/** The doctor checklist: every check with its state in words, not only colour. */
export function DoctorPanel({ doctor, pending }: { doctor: DoctorReport | null; pending: boolean }) {
  if (!doctor) {
    return (
      <Panel>
        <PanelHeader title="Doctor report" description="Static checks of the install, configuration and tool runtime." />
        {pending ? (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="w-1/2" />
            <Skeleton className="w-2/3" />
            <Skeleton className="w-1/3" />
          </div>
        ) : (
          <p className="text-[12.5px] text-ink-3">No doctor report has been observed yet.</p>
        )}
      </Panel>
    );
  }
  const { summary } = doctor;
  return (
    <Panel flush>
      <div className="px-4 pt-4">
        <PanelHeader
          title="Doctor report"
          description="Static checks of the install, configuration and tool runtime."
          actions={
            <Badge tone={summary.overall === 'ok' ? 'ok' : 'warn'}>
              {summary.ok} ok · {summary.warn} warn · {summary.error} error
            </Badge>
          }
        />
      </div>
      {doctor.checks.length === 0 ? (
        <EmptyState compact title="The doctor reported no checks." />
      ) : (
        <RowList>
          {doctor.checks.map((check, i) => (
            <li key={`${check.name}-${i}`} className="flex items-center gap-3 px-4 py-2.5">
              <StatusDot tone={checkTone(check.status)} />
              <span className="text-[13px] text-ink">{check.name}</span>
              <Badge tone={checkTone(check.status)} size="xs">{check.status}</Badge>
              <span className="ml-auto max-w-[55%] truncate text-right font-mono text-[11px] text-ink-3" title={check.detail}>
                {check.detail}
              </span>
            </li>
          ))}
        </RowList>
      )}
      {doctor.timestamp && (
        <div className="border-t border-line px-4 py-2 font-mono text-[10.5px] text-ink-4">{doctor.timestamp}</div>
      )}
    </Panel>
  );
}

/** Raw resource figures and the supervisor's restart-limit state. */
export function ResourceDetailPanel({ health }: { health: HealthData | null }) {
  if (!health) return null;
  const supervisor = health.supervisor;
  return (
    <Panel>
      <PanelHeader title="Resources" description="Observed by the native shell at the last health read." />
      <KeyValue
        items={[
          ['Memory', `${health.memory.used_mb} MB used of ${health.memory.total_mb} MB · ${health.memory.available_mb} MB available`],
          ['Disk', `${health.disk.used} used of ${health.disk.total} · ${health.disk.available} available`],
          ['Supervisor', supervisor
            ? [
                supervisor.bun_give_up && 'Bun server',
                supervisor.proxy_give_up && 'Claude proxy',
                supervisor.ollama_give_up && 'Ollama',
                supervisor.llama_cpp_give_up && 'Gemma llama.cpp',
              ].filter(Boolean).join(', ') || 'auto-restart active for every service'
            : 'not reported by this build'],
          ['Observed', health.timestamp],
        ]}
      />
    </Panel>
  );
}
