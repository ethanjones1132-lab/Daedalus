import { useCallback, useReducer, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import {
  AlertLine,
  Button,
  Chip,
  Dial,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  RowList,
  Skeleton,
  Stat,
  StatusDot,
  StatusLine,
  cn,
  formatIsoAge,
  formatCount,
  loadTone,
  toneText,
  type Tone,
} from '../../design';
import { initialRegistryState, reduceRegistryState } from '../../domain/action-registry-state';
import { usePolling } from '../../hooks/usePolling';
import { useNavigation } from '../../shell/navigation';
import type { BackendSession } from '../../types';
import { Familiar } from '../companion/Familiar';
import { useCompanionSignals } from '../companion/companion-store';
import { describeCompanion } from '../companion/companion-view';
import {
  activeSessions,
  greetingFor,
  newestFirst,
  parsePercent,
  systemVerdict,
  totalMessages,
  type AgentSummary,
  type HealthData,
  type OverviewData,
} from './overview-model';

const POLL_MS = 15_000;
const RECENT_LIMIT = 8;

export default function OverviewPage() {
  const [{ snapshot: data, error, loading }, dispatch] = useReducer(
    reduceRegistryState<OverviewData>,
    initialRegistryState<OverviewData>(),
  );
  const requestId = useRef(0);

  const fetchData = useCallback(async () => {
    const id = ++requestId.current;
    dispatch({ type: 'pending', requestId: id });
    try {
      // Publish a complete request group, not a transactional native snapshot.
      const [health, agents, sessions] = await Promise.all([
        invoke<HealthData>('get_system_health'),
        invoke<AgentSummary[]>('list_agents'),
        invoke<BackendSession[]>('list_sessions'),
      ]);
      // A malformed payload is a failed read, not an empty system.
      if (!health || !Array.isArray(agents) || !Array.isArray(sessions)) throw new Error('Invalid overview payload');
      dispatch({ type: 'success', requestId: id, snapshot: { health, agents, sessions } });
    } catch {
      dispatch({ type: 'failure', requestId: id });
    }
  }, []);

  usePolling(fetchData, POLL_MS, [fetchData]);

  return (
    <Page>
      <PageHeader
        eyebrow="Work"
        title="Overview"
        description="A pulse of the Bun server, its Agents and recent Sessions."
        actions={
          <Button variant="ghost" icon={<RefreshCw aria-hidden="true" />} onClick={fetchData} disabled={loading}>
            Refresh overview
          </Button>
        }
      />

      <div className="mb-5 space-y-2.5 empty:hidden">
        {loading && (
          <StatusLine label="Overview snapshot">{data === null ? 'Loading overview…' : 'Refreshing overview…'}</StatusLine>
        )}
        {error && (
          <AlertLine onRetry={fetchData} retryDisabled={loading}>
            {data === null
              ? 'Could not load overview.'
              : 'Could not refresh overview. Showing previously loaded overview; it may be stale.'}
          </AlertLine>
        )}
      </div>

      {data ? <Pulse data={data} /> : loading && !error ? <PulseSkeleton /> : null}
    </Page>
  );
}

/* ── Hero ─────────────────────────────────────────────────────────────── */

function Hero({ data }: { data: OverviewData | null }) {
  const signals = useCompanionSignals();
  const display = describeCompanion(signals);
  const companion = display.kind === 'ready' ? display.companion : null;

  return (
    <Panel ticks className="relative overflow-hidden p-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-10 top-1/2 size-[420px] -translate-y-1/2 rounded-full"
        style={{ background: 'radial-gradient(closest-side, color-mix(in srgb, var(--d-accent) 17%, transparent), transparent)' }}
      />
      <div className="relative flex flex-wrap items-center justify-between gap-x-10 gap-y-6 px-8 py-8">
        <div className="min-w-0 max-w-[620px]">
          <h2 className="d-display text-[44px] leading-[1.05] text-ink">{greetingFor(new Date())}</h2>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
            {data ? systemVerdict(data) : <Skeleton className="h-4 w-96 max-w-full" />}
          </p>
          <p className="mt-3 flex items-baseline gap-2.5 text-[12.5px] text-ink-3">
            <span className="d-label shrink-0">Cron</span>
            <span>{signals.awareness}</span>
          </p>
        </div>

        <figure className="flex shrink-0 items-center gap-4 pr-2">
          <Familiar
            size={120}
            species={companion?.species}
            rarity={companion?.rarity}
            mood={companion?.mood}
            live={companion?.mood === 'thinking'}
          />
          <figcaption className="flex min-w-[110px] flex-col gap-1">
            <span className="d-display text-[26px] leading-none text-ink">{display.name}</span>
            <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-3">{display.line}</span>
          </figcaption>
        </figure>
      </div>
    </Panel>
  );
}

/* ── Snapshot ─────────────────────────────────────────────────────────── */

function Pulse({ data }: { data: OverviewData }) {
  const { navigate } = useNavigation();
  const { health, agents, sessions } = data;
  const enabled = agents.filter((a) => a.enabled);
  const active = activeSessions(sessions);
  const recent = newestFirst(sessions).slice(0, RECENT_LIMIT);
  const memory = Number.isFinite(health.memory.used_percent) ? health.memory.used_percent : null;
  const disk = parsePercent(health.disk.use_percent);

  return (
    <div className="space-y-5">
      <Hero data={data} />

      <Panel as="div" className="p-0">
        <div className="grid grid-cols-2 md:grid-cols-4">
          {[
            { label: 'Agents', value: agents.length, sub: `${enabled.length} enabled · ${agents.length - enabled.length} disabled`, tone: enabled.length === 0 ? ('warn' as const) : undefined },
            { label: 'Sessions', value: sessions.length, sub: `${sessions.filter((s) => !s.archived).length} unarchived` },
            { label: 'Messages', value: totalMessages(sessions), sub: 'across all Sessions' },
            { label: 'Active · 1h', value: active.length, sub: 'Sessions touched' },
          ].map((s, i) => (
            <div
              key={s.label}
              className={cn('border-line px-6 py-5 md:border-t-0', i % 2 === 1 && 'border-l', i >= 2 && 'border-t', i > 0 ? 'md:border-l' : 'md:border-l-0')}
            >
              <Stat label={s.label} value={formatCount(s.value)} sub={s.sub} tone={s.tone} />
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Panel flush>
          <div className="px-4 pt-4">
            <PanelHeader
              title="Recent Sessions"
              meta={Math.min(sessions.length, RECENT_LIMIT)}
              actions={
                <Button variant="ghost" size="xs" trailing={<ArrowUpRight aria-hidden="true" />} onClick={() => navigate('sessions')}>
                  All Sessions
                </Button>
              }
            />
          </div>
          {recent.length === 0 ? (
            <EmptyState compact title="No Sessions yet" description="Start a Session and it will show up here." />
          ) : (
            <RowList className="border-t border-line">
              {recent.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => navigate('sessions', { sessionId: session.id })}
                    className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:bg-hover"
                  >
                    <StatusDot tone={session.archived ? 'warn' : 'ok'} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{session.title || session.agent_id}</span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-3">
                        {session.id}
                        {session.archived && <span className="ml-2 text-warn">archived</span>}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-right sm:block">
                      <span className="block font-mono text-[11.5px] text-ink-2">{session.model || session.backend}</span>
                      <span className="mt-0.5 block text-[11.5px] text-ink-3 tabular">{session.message_count} messages</span>
                    </span>
                    <span className="w-[76px] shrink-0 text-right font-mono text-[11px] text-ink-3 tabular">
                      {formatIsoAge(session.updated_at)}
                    </span>
                  </button>
                </li>
              ))}
            </RowList>
          )}
        </Panel>

        <div className="space-y-5">
          <Panel>
            <PanelHeader title="Services" />
            <ul className="space-y-3">
              <ServiceRow
                name="Bun server"
                up={health.bun_server.running}
                detail={health.bun_server.url || undefined}
              />
              <ServiceRow name="Bridge" up={health.bridge.running} detail={`port ${health.bridge.port}`} />
              <ServiceRow
                name="Ollama"
                up={health.ollama.running}
                detail={
                  health.ollama.model ? <Chip>{health.ollama.model}</Chip> : <span className="text-ink-3">no model</span>
                }
              />
            </ul>
          </Panel>

          <Panel>
            <PanelHeader title="Machine" />
            <div className="grid grid-cols-2 gap-3">
              <Gauge
                label="Memory"
                pct={memory}
                text={memory === null ? '—' : `${memory.toFixed(1)}%`}
                sub={`${Math.round(health.memory.used_mb)} of ${Math.round(health.memory.total_mb)} MB`}
              />
              <Gauge label="Disk" pct={disk} text={health.disk.use_percent || '—'} sub={`${health.disk.used || '—'} of ${health.disk.total || '—'}`} />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function ServiceRow({ name, up, detail }: { name: string; up: boolean; detail?: React.ReactNode }) {
  const tone: Tone = up ? 'ok' : 'error';
  return (
    <li className="flex items-center gap-3">
      <StatusDot tone={tone} live={up} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-ink">{name}</div>
        {detail && <div className="mt-0.5 truncate font-mono text-[11px] text-ink-3">{detail}</div>}
      </div>
      <span className={cn('font-mono text-[11px] uppercase tracking-[0.08em]', toneText[tone])}>{up ? 'running' : 'offline'}</span>
    </li>
  );
}

function Gauge({ label, pct, text, sub }: { label: string; pct: number | null; text: string; sub: string }) {
  const tone = loadTone(pct);
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-sunken/60 px-2 py-3 text-center">
      <Dial value={pct} tone={tone} size={96}>
        <span className="d-display tabular text-[22px] leading-none text-ink">{text}</span>
      </Dial>
      <div>
        <div className="d-label">{label}</div>
        <div className="mt-0.5 text-[11px] text-ink-3 tabular">{sub}</div>
      </div>
    </div>
  );
}

function PulseSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-5">
      <Panel ticks className="h-[200px]">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="mt-5 h-4 w-96 max-w-full" />
      </Panel>
      <Panel className="h-[104px]" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Panel className="h-[300px]" />
        <Panel className="h-[300px]" />
      </div>
    </div>
  );
}
