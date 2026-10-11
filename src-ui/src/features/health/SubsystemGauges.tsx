import { AlertLine, Badge, Button, cn, Panel, StatusDot, StatusLine, type Tone } from '../../design';
import { RotateCw } from 'lucide-react';
import {
  projectServiceRequirements,
  type HealthData,
  type ServiceRequirement,
} from '../../domain/system-telemetry-state';
import type { ServiceRestartState } from '../../domain/service-restart-state';

/*
 * Subsystem gauges. The restart commands are invoked verbatim, so each key maps
 * directly to a Tauri handler (src-tauri/src/lib.rs invoke_handler!,
 * recovery_stubs.rs). `llama_cpp` has no restart command: the Bun server owns
 * its process lifecycle, so its gauge reports state and requirement only.
 */
export type SubsystemKey = 'bun' | 'bridge' | 'ollama' | 'llama_cpp' | 'proxy';

export interface SubsystemRow {
  key: SubsystemKey;
  name: string;
  up: boolean;
  detail: string;
  command: string | null;
  /**
   * The supervisor hit `MAX_CONSECUTIVE_RESTARTS` consecutive spawn failures
   * and stopped auto-restarting. While the service is also down, the gauge
   * says so and steers the operator toward Restart, which clears the backoff.
   */
  giveUp: boolean;
  requirement: ServiceRequirement;
}

export function buildSubsystemRows(health: HealthData, activeBackend: unknown): SubsystemRow[] {
  const { backend, requirements } = projectServiceRequirements(activeBackend);
  const rows: SubsystemRow[] = [
    { key: 'bun', name: 'Bun server', up: health.bun_server.running, detail: health.bun_server.url, command: 'jarvis_restart_server', giveUp: health.supervisor?.bun_give_up === true, requirement: requirements.bun },
    { key: 'bridge', name: 'Bridge', up: health.bridge.running, detail: `:${health.bridge.port}`, command: 'restart_bridge', giveUp: false, requirement: requirements.bridge },
  ];
  const ollama: SubsystemRow = {
    key: 'ollama',
    name: 'Ollama',
    up: health.ollama.running,
    detail: health.ollama.url,
    command: 'jarvis_restart_ollama',
    giveUp: health.supervisor?.ollama_give_up === true,
    requirement: backend === 'llama_cpp' ? 'not_required' : requirements.ollama,
  };
  if (health.llama_cpp || backend === 'llama_cpp') {
    rows.push({
      key: 'llama_cpp',
      name: 'Gemma llama.cpp',
      up: health.llama_cpp?.running === true,
      detail: health.llama_cpp?.url ?? ':8080',
      command: null,
      giveUp: health.supervisor?.llama_cpp_give_up === true,
      requirement: backend === 'unknown' ? 'unknown' : backend === 'llama_cpp' ? 'required' : 'not_required',
    });
  }
  rows.push(
    ollama,
    { key: 'proxy', name: 'Claude proxy', up: health.claude_proxy.running, detail: `:${health.claude_proxy.port}`, command: 'jarvis_restart_proxy', giveUp: health.supervisor?.proxy_give_up === true, requirement: requirements.proxy },
  );
  return rows;
}

const REQUIREMENT_TEXT: Record<ServiceRequirement, string> = {
  required: 'Required by the active Inference backend',
  not_required: 'Not required by the active Inference backend',
  unknown: 'Requirement unknown — the active Inference backend is not confirmed',
};

function gaugeTone(row: SubsystemRow): Tone {
  if (row.up) return 'ok';
  if (row.requirement === 'not_required') return 'muted';
  if (row.requirement === 'required') return 'error';
  return 'warn';
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink-2',
  muted: 'text-ink-3',
  accent: 'text-accent',
  ok: 'text-ok',
  info: 'text-info',
  warn: 'text-warn',
  error: 'text-err',
};

const TONE_RULE: Record<Tone, string> = {
  neutral: 'before:bg-ink-3',
  muted: 'before:bg-line-strong',
  accent: 'before:bg-accent',
  ok: 'before:bg-ok',
  info: 'before:bg-info',
  warn: 'before:bg-warn',
  error: 'before:bg-err',
};

export function SubsystemGauges({
  rows,
  restartBusy,
  restartKey,
  onRestart,
}: {
  rows: SubsystemRow[];
  restartBusy: boolean;
  restartKey: string | null;
  onRestart: (row: SubsystemRow) => void;
}) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fit,minmax(176px,1fr))] gap-3" aria-label="Subsystems">
      {rows.map((row) => {
        const tone = gaugeTone(row);
        const busy = restartBusy && restartKey === row.key;
        return (
          <li key={row.key} className="contents">
            <Panel
              as="article"
              aria-label={`${row.name} gauge`}
              className={cn(
                'relative flex flex-col gap-2.5 overflow-hidden pl-5',
                'before:absolute before:inset-y-0 before:left-0 before:w-[2px]',
                TONE_RULE[tone],
              )}
            >
              <span className={cn('d-label flex items-center gap-1.5', TONE_TEXT[tone])}>
                <StatusDot tone={tone} live={row.up} />
                {row.up ? 'Running' : 'Stopped'}
              </span>
              <h3 className="-mt-1 text-[15px] font-semibold leading-tight tracking-[-0.005em] text-ink">{row.name}</h3>
              <p className="text-[12px] leading-snug text-ink-3">{REQUIREMENT_TEXT[row.requirement]}</p>
              <p className="truncate font-mono text-[11.5px] text-ink-2" title={row.detail}>
                {row.detail}
              </p>
              <div className="mt-auto flex min-h-6 flex-wrap items-center justify-between gap-x-2 gap-y-1.5 pt-1">
                {!row.up && row.giveUp ? (
                  <Badge
                    tone="warn"
                    size="xs"
                    title="Supervisor hit the consecutive-restart limit and stopped trying. Use Restart to clear the backoff and resume auto-restart."
                  >
                    auto-restart paused
                  </Badge>
                ) : (
                  <span />
                )}
                {row.command && (
                  <Button
                    size="xs"
                    variant="secondary"
                    icon={<RotateCw aria-hidden="true" />}
                    busy={busy}
                    disabled={restartBusy}
                    onClick={() => onRestart(row)}
                    aria-label={`Restart ${row.name}`}
                    className="ml-auto"
                  >
                    Restart
                  </Button>
                )}
              </div>
            </Panel>
          </li>
        );
      })}
    </ul>
  );
}

export function RestartFeedback({
  state,
  name,
  busy,
  onRetryRestart,
  onRetryHealth,
}: {
  state: ServiceRestartState;
  name: string;
  busy: boolean;
  onRetryRestart: () => void;
  onRetryHealth: () => void;
}) {
  const label = `Restart ${name}`;
  if (state.phase === 'writing') return <StatusLine label={label}>Restarting {name}…</StatusLine>;
  if (state.phase === 'confirming') return <StatusLine label={label}>Confirming {name} restart…</StatusLine>;
  if (state.phase === 'confirmed') return <StatusLine label={label} busy={false} tone="ok">{name} restart confirmed.</StatusLine>;
  if (state.phase === 'noop') return <StatusLine label={label} busy={false}>{name} restart not required; no restart was performed.</StatusLine>;
  if (state.phase === 'write-failed') {
    return (
      <AlertLine label={label} onRetry={onRetryRestart} retryText="Retry restart" retryDisabled={busy}>
        Could not restart {name}. Showing the last observed health snapshot.
      </AlertLine>
    );
  }
  if (state.phase === 'read-failed' || state.phase === 'read-mismatch') {
    const message =
      state.phase === 'read-failed'
        ? `${name} restart was requested, but health did not confirm it. Showing the last observed health snapshot; it may be stale.`
        : `${name} restart was requested, but health reported it not running. Showing the last observed health snapshot; it may be stale.`;
    return (
      <AlertLine label={label} onRetry={onRetryHealth} retryText="Retry health confirmation" retryDisabled={busy}>
        {message}
      </AlertLine>
    );
  }
  return null;
}
