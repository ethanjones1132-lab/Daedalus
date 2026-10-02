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

import { useCallback, useEffect, useRef, useState } from 'react';
import { initialRegistryState, reduceRegistryState } from './action-registry-state';
import { profileOperationLocked, reduceProfileOperation, type ProfileOperationPhase } from './profile-operation-state';
import { invoke } from '@tauri-apps/api/core';
import {
  cn,
  ConfirmModal,
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
  EmptyState,
  useToast,
} from '../ui';
import McpPanel from './McpPanel';
import {
  initialServiceRestartState,
  reduceServiceRestartState,
  restartServiceRunning,
  serviceRestartBusy,
  type ServiceRestartState,
} from './service-restart-state';
import {
  DEFAULT_MODEL_PROFILE_DRAFT,
  validateCreateProfileDraft,
  type CreateProfileArgs,
  type ModelProfileDraft,
} from './model-profile-creation-state';

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
  llama_cpp?: { running: boolean; model: string; url: string };
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

export type ControlCenterTab = 'overview' | 'profiles' | 'diagnostics' | 'mcp';

const TABS: Array<{ id: ControlCenterTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'mcp', label: 'MCP' },
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

// Each native resource owns its observation lifetime. Post-operation reads may
// supersede pending reads; only the newest completion can publish a snapshot.
interface ResourceLoadResult<S> {
  snapshot: S | null;
  accepted: boolean;
  failed: boolean;
}

function useControlResource<S>(command: string) {
  const [state, setState] = useState(initialRegistryState<S>);
  const request = useRef(0);
  const pending = useRef(false);
  const loadDetailed = useCallback(async (supersede = false): Promise<ResourceLoadResult<S> | null> => {
    if (pending.current && !supersede) return null;
    pending.current = true;
    const requestId = ++request.current;
    setState((prev) => reduceRegistryState(prev, { type: 'pending', requestId }));
    try {
      const snapshot = await invoke<S>(command);
      if (snapshot == null) throw new Error('Missing observation');
      if (request.current !== requestId) return { snapshot: null, accepted: false, failed: false };
      setState((prev) => reduceRegistryState(prev, { type: 'success', requestId, snapshot }));
      return { snapshot, accepted: true, failed: false };
    } catch {
      if (request.current !== requestId) return { snapshot: null, accepted: false, failed: false };
      setState((prev) => reduceRegistryState(prev, { type: 'failure', requestId }));
      return { snapshot: null, accepted: true, failed: true };
    } finally {
      if (request.current === requestId) pending.current = false;
    }
  }, [command]);
  const load = useCallback(async (supersede = false) => {
    const result = await loadDetailed(supersede);
    return result?.snapshot ?? null;
  }, [loadDetailed]);
  const invalidate = useCallback(() => {
    const requestId = ++request.current;
    pending.current = false;
    setState((prev) => ({ ...prev, requestId, loading: false }));
  }, []);
  return { ...state, load, loadDetailed, invalidate };
}

function ObservationFeedback({ label, resource }: {
  label: string;
  resource: { loading: boolean; error: boolean; snapshot: unknown; load: () => Promise<unknown> };
}) {
  return (
    <div className="space-y-2 text-xs text-bone/60">
      {resource.loading && (
        <div role="status" aria-label={`${label} observation`}>
          {resource.snapshot === null ? 'Loading' : 'Refreshing'} {label}…
        </div>
      )}
      {resource.error && (
        <div role="alert" aria-label={`${label} observation`}>
          Could not load {label}.
          {resource.snapshot !== null && ' Showing previously observed data; it may be stale.'}
          <button type="button" disabled={resource.loading} onClick={() => resource.load()}
            className="ml-2 px-2 py-1 rounded border border-white/10 disabled:opacity-50">
            Retry {label}
          </button>
        </div>
      )}
    </div>
  );
}

function RestartFeedback({ state, name, busy, onRetryRestart, onRetryHealth }: {
  state: ServiceRestartState;
  name: string;
  busy: boolean;
  onRetryRestart: () => void;
  onRetryHealth: () => void;
}) {
  const label = `Restart ${name}`;
  if (state.phase === 'writing') return <div role="status" aria-label={label}>Restarting {name}…</div>;
  if (state.phase === 'confirming') return <div role="status" aria-label={label}>Confirming {name} restart…</div>;
  if (state.phase === 'confirmed') return <div role="status" aria-label={label}>{name} restart confirmed.</div>;
  if (state.phase === 'noop') return <div role="status" aria-label={label}>{name} restart not required; no restart was performed.</div>;
  if (state.phase === 'write-failed') {
    return (
      <div role="alert" aria-label={label}>
        Could not restart {name}. Showing the last observed health snapshot.
        <button type="button" disabled={busy} onClick={onRetryRestart} className="ml-2 px-2 py-1 rounded border border-white/10 disabled:opacity-50">Retry restart</button>
      </div>
    );
  }
  if (state.phase === 'read-failed' || state.phase === 'read-mismatch') {
    const message = state.phase === 'read-failed'
      ? `${name} restart was requested, but health did not confirm it. Showing the last observed health snapshot; it may be stale.`
      : `${name} restart was requested, but health reported it not running. Showing the last observed health snapshot; it may be stale.`;
    return (
      <div role="alert" aria-label={label}>
        {message}
        <button type="button" disabled={busy} onClick={onRetryHealth} className="ml-2 px-2 py-1 rounded border border-white/10 disabled:opacity-50">Retry health confirmation</button>
      </div>
    );
  }
  return null;
}

// ── Main view ──────────────────────────────────────────────────

interface ControlCenterViewProps {
  initialTab?: ControlCenterTab;
}

export default function ControlCenterView({ initialTab = 'overview' }: ControlCenterViewProps) {
  const [tab, setTab] = useState<ControlCenterTab>(initialTab);
  const profileResource = useControlResource<ModelProfile[]>('list_model_profiles');
  const healthResource = useControlResource<HealthData>('get_system_health');
  const doctorResource = useControlResource<DoctorReport>('get_doctor_report');
  const { load: loadProfiles, invalidate: invalidateProfiles } = profileResource;
  const { load: loadHealth, loadDetailed: loadHealthDetailed, invalidate: invalidateHealth } = healthResource;
  const { load: loadDoctor } = doctorResource;
  const profiles = profileResource.snapshot ?? [];
  const health = healthResource.snapshot;
  const doctor = doctorResource.snapshot;
  const loading = profileResource.loading || healthResource.loading || doctorResource.loading;
  const [pendingDelete, setPendingDelete] = useState<ModelProfile | null>(null);
  const [profileDraft, setProfileDraft] = useState<ModelProfileDraft>({ ...DEFAULT_MODEL_PROFILE_DRAFT });
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [profileCreateStage, setProfileCreateStage] = useState<'write' | 'readback' | null>(null);
  const [profileCreationError, setProfileCreationError] = useState<'validation' | 'write' | 'reconciliation' | null>(null);
  const [profileCreationMessage, setProfileCreationMessage] = useState<string | null>(null);
  const profileCreatePending = useRef(false);
  const createdProfileId = useRef<string | null>(null);
  const operationPhase = useRef<ProfileOperationPhase>('idle');
  const [phase, setPhase] = useState<ProfileOperationPhase>('idle');
  const [operation, setOperation] = useState<{ kind: 'activate' | 'delete'; profile: ModelProfile } | null>(null);
  const [reconciliationError, setReconciliationError] = useState(false);
  const transition = useCallback((event: Parameters<typeof reduceProfileOperation>[1]) => {
    operationPhase.current = reduceProfileOperation(operationPhase.current, event);
    setPhase(operationPhase.current);
  }, []);
  const mutationLocked = profileOperationLocked(phase) || creatingProfile || profileCreationError === 'reconciliation';
  const [restartState, setRestartState] = useState<ServiceRestartState>(initialServiceRestartState);
  const restartPending = useRef(false);
  const restartOperation = useRef(0);
  const restartBusy = serviceRestartBusy(restartState);
  const { success, info } = useToast();

  const refreshProfiles = useCallback(async (supersede = false) => {
    if (profileOperationLocked(operationPhase.current) || profileCreatePending.current) return null;
    return loadProfiles(supersede);
  }, [loadProfiles]);

  const fetchAll = useCallback(async () => {
    await Promise.all([refreshProfiles(true), loadHealth(true), loadDoctor(true)]);
  }, [refreshProfiles, loadHealth, loadDoctor]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const reconcileProfiles = useCallback(async () => {
    const observed = await loadProfiles(true);
    setReconciliationError(!observed);
    transition(observed ? 'observed' : 'read-failed');
  }, [loadProfiles, transition]);

  const retryReconciliation = useCallback(async () => {
    if (operationPhase.current !== 'reconciliation-failed') return;
    transition('retry-read');
    await reconcileProfiles();
  }, [transition, reconcileProfiles]);

  const createProfile = useCallback(async () => {
    if (profileCreatePending.current || profileOperationLocked(operationPhase.current)) return;
    const validation = validateCreateProfileDraft(profileDraft);
    if (!validation.valid) {
      setProfileCreationError('validation');
      setProfileCreationMessage(validation.message);
      return;
    }
    const args: CreateProfileArgs = validation.args;
    profileCreatePending.current = true;
    setCreatingProfile(true);
    setProfileCreateStage('write');
    if (profileCreationError === 'validation') {
      setProfileCreationError(null);
      setProfileCreationMessage(null);
    }
    setPendingDelete(null);
    createdProfileId.current = null;
    invalidateProfiles();
    let stage: 'write' | 'reconciliation' = 'write';
    try {
      const created = await invoke<ModelProfile>('create_profile', args);
      stage = 'reconciliation';
      setProfileCreateStage('readback');
      if (!created || typeof created.id !== 'string' || created.id.length === 0) {
        throw new Error('Missing created profile identity');
      }
      createdProfileId.current = created.id;
      const observed = await loadProfiles(true);
      if (!observed?.some((profile) => profile.id === created.id)) {
        setProfileCreationError('reconciliation');
        setProfileCreationMessage('Profile created, but the profile list did not confirm it. Retry reloads the list only.');
        setProfileCreateStage(null);
        setShowProfileForm(false);
        return;
      }
      createdProfileId.current = null;
      setProfileDraft({ ...DEFAULT_MODEL_PROFILE_DRAFT });
      setShowProfileForm(false);
      setProfileCreationError(null);
      setProfileCreationMessage(null);
      setProfileCreateStage(null);
      success(`Created "${args.name}"`);
    } catch {
      setProfileCreateStage(null);
      if (stage === 'write') {
        setProfileCreationError('write');
        setProfileCreationMessage('Could not create profile. Your draft has been kept.');
        setShowProfileForm(true);
      } else {
        setProfileCreationError('reconciliation');
        setProfileCreationMessage('Profile created, but the profile list did not confirm it. Retry reloads the list only.');
        setShowProfileForm(false);
      }
    } finally {
      profileCreatePending.current = false;
      setCreatingProfile(false);
    }
  }, [profileDraft, profileCreationError, invalidateProfiles, loadProfiles, success]);

  const retryProfileReadback = useCallback(async () => {
    if (profileCreationError !== 'reconciliation' || profileCreatePending.current) return;
    const id = createdProfileId.current;
    if (!id) return;
    profileCreatePending.current = true;
    setCreatingProfile(true);
    setProfileCreateStage('readback');
    try {
      const observed = await loadProfiles(true);
      if (!observed?.some((profile) => profile.id === id)) {
        setProfileCreationError('reconciliation');
        setProfileCreationMessage('Profile created, but the profile list did not confirm it. Retry reloads the list only.');
        return;
      }
      createdProfileId.current = null;
      setProfileDraft({ ...DEFAULT_MODEL_PROFILE_DRAFT });
      setProfileCreationError(null);
      setProfileCreationMessage(null);
      setProfileCreateStage(null);
      success(`Created "${profileDraft.name.trim()}"`);
    } catch {
      setProfileCreationError('reconciliation');
      setProfileCreationMessage('Profile created, but the profile list did not confirm it. Retry reloads the list only.');
    } finally {
      profileCreatePending.current = false;
      setCreatingProfile(false);
    }
  }, [loadProfiles, profileCreationError, profileDraft.name, success]);

  const mutateProfile = useCallback(async (kind: 'activate' | 'delete', profile: ModelProfile) => {
    if (profileOperationLocked(operationPhase.current) || profileCreatePending.current) return;
    transition('submit');
    setOperation({ kind, profile });
    setPendingDelete(null);
    setReconciliationError(false);
    // Fence reads issued before the write, not merely before its readback.
    invalidateProfiles();
    try {
      if (kind === 'activate') {
        const effective = await invoke<{ provider: string; model: string; source: string; applied_at: string; restart_required: boolean }>('set_active_profile', { id: profile.id });
        success(`Activated ${profile.name} · ${effective.provider}/${effective.model}`);
      } else {
        const deleted = await invoke<boolean>('delete_profile', { id: profile.id });
        if (deleted !== true) throw new Error('Deletion not confirmed');
        success(`Deleted ${profile.name}`);
      }
    } catch {
      transition('write-failed');
      return;
    }
    transition('written');
    await reconcileProfiles();
  }, [transition, invalidateProfiles, success, reconcileProfiles]);

  const activate = useCallback((profile: ModelProfile) => mutateProfile('activate', profile), [mutateProfile]);
  const remove = useCallback((profile: ModelProfile) => {
    if (!profileOperationLocked(operationPhase.current) && !profileCreatePending.current) setPendingDelete(profile);
  }, []);
  const confirmDelete = useCallback(async () => {
    if (pendingDelete) await mutateProfile('delete', pendingDelete);
  }, [pendingDelete, mutateProfile]);

  const subsystemRows: SubsystemRow[] = health ? [
    { key: 'ollama', name: 'Ollama', up: health.ollama.running, detail: health.ollama.url, command: 'jarvis_restart_ollama', giveUp: health.supervisor?.ollama_give_up === true },
    { key: 'bun', name: 'Bun server', up: health.bun_server.running, detail: health.bun_server.url, command: 'jarvis_restart_server', giveUp: health.supervisor?.bun_give_up === true },
    { key: 'bridge', name: 'Bridge', up: health.bridge.running, detail: `:${health.bridge.port}`, command: 'restart_bridge', giveUp: false },
    { key: 'proxy', name: 'Claude proxy', up: health.claude_proxy.running, detail: `:${health.claude_proxy.port}`, command: 'jarvis_restart_proxy', giveUp: health.supervisor?.proxy_give_up === true },
  ] : [];

  const confirmRestartReadback = useCallback(async (row: SubsystemRow, operationId: number) => {
    if (operationId !== restartOperation.current) return;
    setRestartState((current) => reduceServiceRestartState(current, { type: 'readback-start', key: row.key }));
    const result = await loadHealthDetailed(true);
    if (operationId !== restartOperation.current) return;
    if (!result?.accepted || result.failed || result.snapshot === null) {
      setRestartState((current) => reduceServiceRestartState(current, { type: 'readback-failed', key: row.key }));
      return;
    }
    if (row.key !== 'bridge' && !restartServiceRunning(row.key, result.snapshot)) {
      setRestartState((current) => reduceServiceRestartState(current, { type: 'readback-mismatch', key: row.key }));
      return;
    }
    setRestartState((current) => reduceServiceRestartState(current, { type: 'readback-confirmed', key: row.key }));
    success(`${row.name} restarted`, 'Restart');
    void loadDoctor(true);
  }, [loadDoctor, loadHealthDetailed, success]);

  const restartSubsystem = useCallback(async (row: SubsystemRow) => {
    if (restartPending.current) return;
    restartPending.current = true;
    const operationId = ++restartOperation.current;
    invalidateHealth();
    setRestartState((current) => reduceServiceRestartState(current, { type: 'start', key: row.key }));
    try {
      const result = await invoke<boolean>(row.command);
      if (operationId !== restartOperation.current) return;
      if (result !== true) {
        setRestartState((current) => reduceServiceRestartState(current, { type: 'command-false', key: row.key }));
        info(`${row.name} restart not required; no restart was performed.`, 'Restart');
        return;
      }
      if (row.key === 'bridge') {
        setRestartState((current) => reduceServiceRestartState(current, { type: 'readback-confirmed', key: row.key }));
        success(`${row.name} restarted`, 'Restart');
        return;
      }
      await confirmRestartReadback(row, operationId);
    } catch {
      if (operationId === restartOperation.current) {
        setRestartState((current) => reduceServiceRestartState(current, { type: 'command-failed', key: row.key }));
      }
    } finally {
      if (operationId === restartOperation.current) restartPending.current = false;
    }
  }, [confirmRestartReadback, info, invalidateHealth, success]);

  const retryRestartHealth = useCallback(async () => {
    if (restartPending.current || (restartState.phase !== 'read-failed' && restartState.phase !== 'read-mismatch')) return;
    const row = subsystemRows.find((candidate) => candidate.key === restartState.key);
    if (!row || row.key === 'bridge') return;
    restartPending.current = true;
    const operationId = ++restartOperation.current;
    await confirmRestartReadback(row, operationId);
    if (operationId === restartOperation.current) restartPending.current = false;
  }, [confirmRestartReadback, restartState, subsystemRows]);

  const retryRestart = useCallback(() => {
    const row = subsystemRows.find((candidate) => candidate.key === restartState.key);
    if (row) void restartSubsystem(row);
  }, [restartState, restartSubsystem, subsystemRows]);

  const restartRow = restartState.key ? subsystemRows.find((row) => row.key === restartState.key) : undefined;

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
        title={tab === 'profiles' ? 'Model Profiles' : 'Control Center'}
        subtitle="Profiles, diagnostics, and system operations"
        action={
          <button
            type="button"
            onClick={() => { if (!loading && !creatingProfile && !restartBusy) void fetchAll(); }}
            disabled={loading || creatingProfile || restartBusy}
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
        {(tab === 'overview' || tab === 'profiles') && (
           <div className="space-y-2 text-xs text-bone/60">
             {!mutationLocked && <ObservationFeedback label="Profiles" resource={{ ...profileResource, load: refreshProfiles }} />}
             {creatingProfile && (
               <div role="status" aria-label="Profile creation">
                 {profileCreateStage === 'readback' ? 'Refreshing profile list…' : 'Creating profile…'}
               </div>
             )}
             {profileCreationError === 'validation' && (
               <div role="alert" aria-label="Profile creation">{profileCreationMessage}</div>
             )}
             {profileCreationError === 'write' && (
               <div role="alert" aria-label="Profile creation">
                 {profileCreationMessage}
                 <button type="button" className="ml-2 px-2 py-1 rounded border border-white/10" onClick={createProfile} disabled={creatingProfile}>
                   Retry profile creation
                 </button>
               </div>
             )}
             {profileCreationError === 'reconciliation' && (
               <div role="alert" aria-label="Profile reconciliation">
                 {profileCreationMessage}
                 <button type="button" className="ml-2 px-2 py-1 rounded border border-white/10" onClick={retryProfileReadback} disabled={creatingProfile}>
                   Retry profile list
                 </button>
               </div>
             )}
             {(phase === 'writing' || phase === 'reconciling') && (
              <div role="status" aria-label="Profile operation">
                {phase === 'writing' ? `${operation?.kind === 'activate' ? 'Activating' : 'Deleting'} ${operation?.profile.name}…` : 'Reconciling profiles…'}
                {' Showing previously observed profiles; they may be stale.'}
              </div>
            )}
            {phase === 'write-failed' && operation && (
              <div role="alert" aria-label="Profile operation">
                Could not {operation.kind} {operation.profile.name}. Showing last confirmed profiles.
                <button type="button" className="ml-2 px-2 py-1 rounded border border-white/10"
                  onClick={() => operation.kind === 'activate' ? activate(operation.profile) : remove(operation.profile)}>
                  Retry {operation.kind === 'activate' ? 'activation' : 'deletion'}
                </button>
              </div>
            )}
            {reconciliationError && (
              <div role="alert" aria-label="Profile operation">
                Profile write succeeded, but reconciliation failed. Showing previously observed profiles; they may be stale.
                <button type="button" disabled={phase === 'reconciling'} onClick={retryReconciliation}
                  className="ml-2 px-2 py-1 rounded border border-white/10 disabled:opacity-50">
                  Retry profile reconciliation
                </button>
              </div>
            )}
          </div>
        )}
        {(tab === 'overview' || tab === 'diagnostics') && (
          <div className="space-y-2 mb-3">
            <ObservationFeedback label="System health" resource={healthResource} />
            <ObservationFeedback label="Doctor report" resource={doctorResource} />
          </div>
        )}
        {tab === 'overview' ? (
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
              ) : profileResource.snapshot !== null ? (
                <span className="text-sm text-bone/50">No active profile.</span>
              ) : <span className="text-sm text-bone/50">Active profile not yet observed.</span>}
            </GlassCard>

            <div className="grid grid-cols-3 gap-3">
              <GlassCard className="p-3">
                <div className="text-2xl font-semibold text-bone">{profileResource.snapshot === null ? '—' : profiles.length}</div>
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
          <div className="space-y-3">
            <div className="flex justify-end">
              <button
                type="button"
                aria-expanded={showProfileForm}
                onClick={() => {
                  if (mutationLocked) return;
                  setProfileCreationError(null);
                  setProfileCreationMessage(null);
                  setShowProfileForm(true);
                }}
                disabled={mutationLocked}
                className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-bone/60 hover:text-bone transition-colors disabled:opacity-50"
              >
                New profile
              </button>
            </div>
            {showProfileForm && (
              <GlassCard className="p-4">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createProfile();
                  }}
                >
                  <fieldset disabled={creatingProfile} className="border-0 p-0 m-0 min-w-0 space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40">New profile</div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label htmlFor="profile-name" className="block text-[10px] font-mono text-bone/50 mb-1">Name</label>
                        <input
                          id="profile-name"
                          type="text"
                          value={profileDraft.name}
                          onChange={(event) => {
                            if (profileCreatePending.current) return;
                            setProfileDraft((current) => ({ ...current, name: event.target.value }));
                          }}
                          className="w-full px-2 py-1.5 text-xs font-mono bg-white/5 border border-white/10 rounded text-bone focus:outline-none focus:border-white/20 transition-colors"
                        />
                      </div>
                      <div>
                        <label htmlFor="profile-backend" className="block text-[10px] font-mono text-bone/50 mb-1">Backend</label>
                        <input
                          id="profile-backend"
                          type="text"
                          value={profileDraft.backend}
                          onChange={(event) => {
                            if (profileCreatePending.current) return;
                            setProfileDraft((current) => ({ ...current, backend: event.target.value }));
                          }}
                          className="w-full px-2 py-1.5 text-xs font-mono bg-white/5 border border-white/10 rounded text-bone focus:outline-none focus:border-white/20 transition-colors"
                        />
                      </div>
                      <div>
                        <label htmlFor="profile-model" className="block text-[10px] font-mono text-bone/50 mb-1">Model</label>
                        <input
                          id="profile-model"
                          type="text"
                          value={profileDraft.model}
                          onChange={(event) => {
                            if (profileCreatePending.current) return;
                            setProfileDraft((current) => ({ ...current, model: event.target.value }));
                          }}
                          className="w-full px-2 py-1.5 text-xs font-mono bg-white/5 border border-white/10 rounded text-bone focus:outline-none focus:border-white/20 transition-colors"
                        />
                      </div>
                      <div>
                        <label htmlFor="profile-max-tokens" className="block text-[10px] font-mono text-bone/50 mb-1">Max tokens</label>
                        <input
                          id="profile-max-tokens"
                          type="number"
                          min="1"
                          step="1"
                          value={profileDraft.maxTokens}
                          onChange={(event) => {
                            if (profileCreatePending.current) return;
                            setProfileDraft((current) => ({ ...current, maxTokens: event.target.value === '' ? Number.NaN : Number(event.target.value) }));
                          }}
                          className="w-full px-2 py-1.5 text-xs font-mono bg-white/5 border border-white/10 rounded text-bone focus:outline-none focus:border-white/20 transition-colors"
                        />
                      </div>
                      <div>
                        <label htmlFor="profile-temperature" className="block text-[10px] font-mono text-bone/50 mb-1">Temperature</label>
                        <input
                          id="profile-temperature"
                          type="number"
                          min="0"
                          max="2"
                          step="0.1"
                          value={profileDraft.temperature}
                          onChange={(event) => {
                            if (profileCreatePending.current) return;
                            setProfileDraft((current) => ({ ...current, temperature: event.target.value === '' ? Number.NaN : Number(event.target.value) }));
                          }}
                          className="w-full px-2 py-1.5 text-xs font-mono bg-white/5 border border-white/10 rounded text-bone focus:outline-none focus:border-white/20 transition-colors"
                        />
                      </div>
                      <div>
                        <label htmlFor="profile-top-p" className="block text-[10px] font-mono text-bone/50 mb-1">Top P</label>
                        <input
                          id="profile-top-p"
                          type="number"
                          min="0"
                          max="1"
                          step="0.1"
                          value={profileDraft.topP}
                          onChange={(event) => {
                            if (profileCreatePending.current) return;
                            setProfileDraft((current) => ({ ...current, topP: event.target.value === '' ? Number.NaN : Number(event.target.value) }));
                          }}
                          className="w-full px-2 py-1.5 text-xs font-mono bg-white/5 border border-white/10 rounded text-bone focus:outline-none focus:border-white/20 transition-colors"
                        />
                      </div>
                      <div>
                        <label htmlFor="profile-engine" className="block text-[10px] font-mono text-bone/50 mb-1">Engine</label>
                        <input
                          id="profile-engine"
                          type="text"
                          value={profileDraft.engine}
                          onChange={(event) => {
                            if (profileCreatePending.current) return;
                            setProfileDraft((current) => ({ ...current, engine: event.target.value }));
                          }}
                          className="w-full px-2 py-1.5 text-xs font-mono bg-white/5 border border-white/10 rounded text-bone focus:outline-none focus:border-white/20 transition-colors"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          if (profileCreatePending.current) return;
                          setShowProfileForm(false);
                          setProfileCreationError(null);
                          setProfileCreationMessage(null);
                        }}
                        className="px-3 py-1.5 text-xs font-mono rounded-lg border border-white/10 text-bone/60 hover:text-bone transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        onClick={() => { void createProfile(); }}
                        className="px-4 py-1.5 text-xs font-mono rounded-lg border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-50 transition-colors"
                      >
                        {creatingProfile ? 'Creating…' : 'Create profile'}
                      </button>
                    </div>
                  </fieldset>
                </form>
              </GlassCard>
            )}
            {profileResource.snapshot === null ? null : profiles.length === 0 ? (
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
                              disabled={mutationLocked}
                              className="px-2 py-0.5 rounded-md border border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10 transition-colors"
                            >
                              Activate
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => remove(p)}
                            disabled={mutationLocked}
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
            )}
          </div>
        ) : tab === 'diagnostics' ? (
          // ── Diagnostics ──
          <div className="space-y-3">
            {restartRow && (
              <RestartFeedback
                state={restartState}
                name={restartRow.name}
                busy={restartBusy}
                onRetryRestart={retryRestart}
                onRetryHealth={() => { void retryRestartHealth(); }}
              />
            )}
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
                  {subsystemRows.map((s) => {
                    const busy = restartBusy && restartState.key === s.key;
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
                          disabled={restartBusy || busy}
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
            ) : null}

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
        ) : (
          <McpPanel />
        )}
      </div>
    </div>
  );
}
