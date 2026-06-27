// ═══════════════════════════════════════════════════════════════
// ── ControlCenterView — operations dashboard (the "Control" subview)
// ═══════════════════════════════════════════════════════════════
//
// Self-contained (no props) so it matches JarvisView's `<ControlCenterView />`
// call site. Config editing and live status already live in JarvisView's own
// ConfigPanel / StatusPanel, so this surface covers what those don't:
//   • Profiles    — list_model_profiles / set_active_profile / delete_profile
//   • Diagnostics — get_system_health (HealthData) + get_doctor_report
//   • Overview    — active profile + a consolidated health glance

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  cn,
  ConfirmModal,
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
  LoadingState,
  ErrorState,
  EmptyState,
  useToast,
} from '../ui';

// ── Types (mirror the Rust command return shapes) ──────────────

interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  api_base: string;
  max_tokens: number;
  temperature: number;
  top_p: number;
  is_active: boolean;
  engine: string;
}

interface HealthData {
  ollama: { running: boolean; model: string | null; url: string };
  bun_server: { running: boolean; url: string };
  bridge: { running: boolean; port: number };
  claude_proxy: { running: boolean; port: number };
  disk: { total: string; used: string; available: string; use_percent: string };
  memory: { total_mb: number; available_mb: number; used_mb: number; used_percent: number };
  /**
   * Supervisor backoff snapshot. Present on builds that include the
   * supervisor-give-up reporting; legacy servers simply omit the field.
   * When `*_give_up` is true the watchdog has hit `MAX_CONSECUTIVE_RESTARTS`
   * and is no longer auto-restarting that service. Surfacing this prevents
   * the silent-give-up failure mode where a down service just sits there
   * with the supervisor quietly doing nothing.
   */
  supervisor?: {
    bun_give_up: boolean;
    proxy_give_up: boolean;
    ollama_give_up: boolean;
  };
  timestamp: string;
}

// Subsystem row in the Diagnostics grid; the restart command is invoked
// verbatim, so the keys map directly to Tauri handlers (see
// src-tauri/src/lib.rs invoke_handler! and recovery_stubs.rs).
type SubsystemKey = 'ollama' | 'bun' | 'bridge' | 'proxy';

interface SubsystemRow {
  key: SubsystemKey;
  name: string;
  up: boolean;
  detail: string;
  command: string;
  /**
   * True if the supervisor has hit `MAX_CONSECUTIVE_RESTARTS` consecutive
   * spawn failures for this service and has stopped auto-restarting. When
   * `up` is false AND `giveUp` is true, the UI shows an "auto-restart paused"
   * pill so the user knows the watchdog is no longer poking the port and
   * should press Restart to clear the backoff.
   */
  giveUp: boolean;
}

interface DoctorCheck {
  name: string;
  status: string;
  detail: string;
}

interface DoctorReport {
  checks: DoctorCheck[];
  summary: { total: number; ok: number; warn: number; error: number; overall: string };
  timestamp: string;
}

type Tab = 'overview' | 'profiles' | 'diagnostics';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

// ── Helpers ────────────────────────────────────────────────────

function parsePercent(value: string): number {
  const n = Number(String(value).replace('%', '').trim());
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function checkVariant(status: string): 'success' | 'warn' | 'error' | 'default' {
  const s = status.toLowerCase();
  if (s === 'ok' || s === 'pass') return 'success';
  if (s === 'warn' || s === 'warning') return 'warn';
  if (s === 'error' || s === 'fail') return 'error';
  return 'default';
}

function Bar({ percent, danger }: { percent: number; danger?: boolean }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-500',
          danger || percent >= 90 ? 'bg-red-400' : percent >= 75 ? 'bg-amber-400' : 'bg-emerald-400',
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────

export default function ControlCenterView() {
  const [tab, setTab] = useState<Tab>('overview');
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ModelProfile | null>(null);
  const [restarting, setRestarting] = useState<SubsystemKey | null>(null);
  const { success, error: toastError } = useToast();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [profileList, healthData, doctorReport] = await Promise.all([
        invoke<ModelProfile[]>('list_model_profiles'),
        invoke<HealthData>('get_system_health').catch(() => null),
        invoke<DoctorReport>('get_doctor_report').catch(() => null),
      ]);
      setProfiles(profileList);
      setHealth(healthData);
      setDoctor(doctorReport);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const activate = useCallback(
    async (profile: ModelProfile) => {
      setProfiles((prev) => prev.map((p) => ({ ...p, is_active: p.id === profile.id })));
      try {
        await invoke<boolean>('set_active_profile', { id: profile.id });
        success(`Activated ${profile.name}`);
        await fetchAll();
      } catch (e) {
        toastError(String(e), 'Activation failed');
        await fetchAll();
      }
    },
    [fetchAll, success, toastError],
  );

  const remove = useCallback((profile: ModelProfile) => { setPendingDelete(profile); }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const profile = pendingDelete;
    setPendingDelete(null);
    try {
      await invoke<boolean>('delete_profile', { id: profile.id });
      success(`Deleted ${profile.name}`);
      await fetchAll();
    } catch (e) {
      toastError(String(e), 'Delete failed');
    }
  }, [pendingDelete, fetchAll, success, toastError]);

  // Per-row restart handler. The backend commands return a specific error
  // string (see lib.rs force_restart_jarvis_server / recovery_stubs
  // jarvis_restart_*) so the toast surfaces the real reason instead of
  // silently doing nothing.
  const restartSubsystem = useCallback(
    async (row: SubsystemRow) => {
      if (restarting) return;
      setRestarting(row.key);
      try {
        await invoke<boolean>(row.command);
        success(`${row.name} restarted`, 'Restart');
        await fetchAll();
      } catch (e) {
        toastError(String(e), `Restart ${row.name} failed`);
        await fetchAll();
      } finally {
        setRestarting(null);
      }
    },
    [restarting, fetchAll, success, toastError],
  );

  const activeProfile = profiles.find((p) => p.is_active) ?? null;

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <ConfirmModal
        open={pendingDelete !== null}
        message={`Delete profile "${pendingDelete?.name}"?`}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
      <SectionHeader
        title="Control Center"
        subtitle="Profiles, diagnostics, and system operations"
        action={
          <button
            type="button"
            onClick={fetchAll}
            className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-bone/60 hover:text-bone transition-colors"
          >
            Refresh
          </button>
        }
      />

      <div className="flex gap-1 text-[11px]">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'px-3 py-1.5 rounded-lg transition-colors',
              tab === t.id ? 'bg-white/10 text-bone' : 'text-bone/40 hover:text-bone/70',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <LoadingState message="Loading control center…" />
        ) : error ? (
          <ErrorState error={error} onRetry={fetchAll} />
        ) : tab === 'overview' ? (
          <div className="space-y-3">
            <GlassCard className="p-4">
              <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40 mb-2">
                Active profile
              </div>
              {activeProfile ? (
                <div className="flex items-center gap-2">
                  <StatusDot ok />
                  <span className="text-sm font-medium text-bone">{activeProfile.name}</span>
                  <Pill variant="info">{activeProfile.provider}</Pill>
                  <Pill variant="default">{activeProfile.model}</Pill>
                  <span className="ml-auto text-[10px] font-mono text-bone/40">
                    temp {activeProfile.temperature} · {activeProfile.max_tokens} tok
                  </span>
                </div>
              ) : (
                <span className="text-sm text-bone/50">No active profile.</span>
              )}
            </GlassCard>

            <div className="grid grid-cols-3 gap-3">
              <GlassCard className="p-3">
                <div className="text-2xl font-semibold text-bone">{profiles.length}</div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40">
                  profiles
                </div>
              </GlassCard>
              <GlassCard className="p-3">
                <div
                  className={cn(
                    'text-2xl font-semibold',
                    doctor?.summary.overall === 'ok' ? 'text-emerald-300' : 'text-amber-300',
                  )}
                >
                  {doctor ? `${doctor.summary.ok}/${doctor.summary.total}` : '—'}
                </div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40">
                  checks ok
                </div>
              </GlassCard>
              <GlassCard className="p-3">
                <div className="text-2xl font-semibold text-bone">
                  {health ? `${health.memory.used_percent}%` : '—'}
                </div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40">
                  memory used
                </div>
              </GlassCard>
            </div>
          </div>
        ) : tab === 'profiles' ? (
          profiles.length === 0 ? (
            <EmptyState message="No model profiles configured." />
          ) : (
            <ul className="space-y-2">
              {profiles.map((p) => (
                <li key={p.id}>
                  <GlassCard className={cn('p-3', p.is_active && 'border-accent/40 bg-white/[0.06]')}>
                    <div className="flex items-center gap-2">
                      <StatusDot ok={p.is_active} warn={!p.is_active} />
                      <span className="text-sm font-medium text-bone truncate">{p.name}</span>
                      <Pill variant="info">{p.provider}</Pill>
                      <Pill variant="default">{p.model}</Pill>
                      {p.is_active && <Pill variant="success">active</Pill>}
                      <div className="ml-auto flex items-center gap-1 text-[11px]">
                        {!p.is_active && (
                          <button
                            type="button"
                            onClick={() => activate(p)}
                            className="px-2 py-0.5 rounded-md border border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10 transition-colors"
                          >
                            Activate
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => remove(p)}
                          className="px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <div className="mt-1.5 text-[10px] font-mono text-bone/40">
                      engine {p.engine} · temp {p.temperature} · top_p {p.top_p} · {p.max_tokens} tok
                    </div>
                  </GlassCard>
                </li>
              ))}
            </ul>
          )
        ) : (
          // ── Diagnostics ──
          <div className="space-y-3">
            {health ? (
              <GlassCard className="p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40">
                    Subsystems
                  </div>
                  <span className="text-[10px] font-mono text-bone/30">
                    click restart to re-spawn
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  {([
                    { key: 'ollama', name: 'Ollama', up: health.ollama.running, detail: health.ollama.url, command: 'jarvis_restart_ollama', giveUp: health.supervisor?.ollama_give_up === true },
                    { key: 'bun', name: 'Bun server', up: health.bun_server.running, detail: health.bun_server.url, command: 'jarvis_restart_server', giveUp: health.supervisor?.bun_give_up === true },
                    { key: 'bridge', name: 'Bridge', up: health.bridge.running, detail: `:${health.bridge.port}`, command: 'restart_bridge', giveUp: false },
                    { key: 'proxy', name: 'Claude proxy', up: health.claude_proxy.running, detail: `:${health.claude_proxy.port}`, command: 'jarvis_restart_proxy', giveUp: health.supervisor?.proxy_give_up === true },
                  ] as SubsystemRow[]).map((s) => {
                    const busy = restarting === s.key;
                    // Surface the silent-give-up state: the supervisor has hit
                    // `MAX_CONSECUTIVE_RESTARTS` and is no longer auto-restarting
                    // this service. The pill + the inline hint steer the user
                    // toward the Restart button rather than waiting on a watchdog
                    // that isn't running.
                    const showGiveUpHint = !s.up && s.giveUp;
                    return (
                      <div key={s.key} className="flex items-center gap-2">
                        <StatusDot ok={s.up} warn={!s.up} />
                        <span className="text-bone">{s.name}</span>
                        {showGiveUpHint && (
                          <span
                            className="px-1.5 py-0.5 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-200 text-[9px] font-mono uppercase tracking-wider"
                            title="Supervisor hit the consecutive-restart limit and stopped trying. Use Restart to clear the backoff and resume auto-restart."
                          >
                            auto-restart paused
                          </span>
                        )}
                        <span className="ml-auto font-mono text-[10px] text-bone/40 truncate max-w-[40%]">
                          {s.detail}
                        </span>
                        <button
                          type="button"
                          onClick={() => restartSubsystem(s)}
                          disabled={busy || restarting !== null}
                          className={cn(
                            'px-2 py-0.5 rounded-md border text-[10px] font-mono transition-colors',
                            'border-white/10 text-bone/60 hover:text-bone hover:border-white/20',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                          )}
                          aria-label={`Restart ${s.name}`}
                        >
                          {busy ? '…' : 'Restart'}
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div className="space-y-2 pt-1">
                  <div>
                    <div className="flex justify-between text-[10px] font-mono text-bone/50 mb-1">
                      <span>Disk ({health.disk.used} / {health.disk.total})</span>
                      <span>{health.disk.use_percent}</span>
                    </div>
                    <Bar percent={parsePercent(health.disk.use_percent)} />
                  </div>
                  <div>
                    <div className="flex justify-between text-[10px] font-mono text-bone/50 mb-1">
                      <span>Memory ({health.memory.used_mb} / {health.memory.total_mb} MB)</span>
                      <span>{health.memory.used_percent}%</span>
                    </div>
                    <Bar percent={health.memory.used_percent} />
                  </div>
                </div>
              </GlassCard>
            ) : (
              <EmptyState message="System health unavailable." />
            )}

            {doctor && (
              <GlassCard className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-bone/40">
                    Doctor
                  </span>
                  <Pill variant={doctor.summary.overall === 'ok' ? 'success' : 'warn'}>
                    {doctor.summary.ok} ok · {doctor.summary.warn} warn · {doctor.summary.error} error
                  </Pill>
                </div>
                <ul className="space-y-1.5">
                  {doctor.checks.map((c, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <span className="mt-0.5">
                        <StatusDot
                          ok={checkVariant(c.status) === 'success'}
                          warn={checkVariant(c.status) === 'warn'}
                        />
                      </span>
                      <span className="text-bone">{c.name}</span>
                      <span className="ml-auto text-right font-mono text-[10px] text-bone/40 max-w-[55%] truncate">
                        {c.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </GlassCard>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
