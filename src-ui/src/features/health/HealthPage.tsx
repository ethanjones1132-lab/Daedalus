// ═══════════════════════════════════════════════════════════════
// ── HealthPage — the instrument panel
// ═══════════════════════════════════════════════════════════════
//
// One page for what used to be three: the legacy JarvisView Status panel
// (backend requirements, bridge start/stop), the Control Center Diagnostics tab
// (subsystem restarts with read-back, resources, doctor) and the orphaned
// SystemHealthView (Bun runtime telemetry), plus build provenance.
//
// Four independent reads, each request-id fenced and none able to erase
// another's last good snapshot:
//   jarvis_check_status   — the Inference backend's own verdict (same derivation
//                           the global HealthBanner uses)
//   get_system_health     — subsystem gauges, resources, supervisor state
//   get_doctor_report     — the checklist
//   GET /health*          — Bun runtime telemetry (optional, independent)

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RotateCw } from 'lucide-react';
import {
  Badge,
  Button,
  Page,
  PageHeader,
  Skeleton,
  Panel,
  Tabs,
  useToast,
  type Tone,
} from '../../design';
import { parseHealthData, type HealthData } from '../../domain/system-telemetry-state';
import {
  initialServiceRestartState,
  reduceServiceRestartState,
  restartServiceRunning,
  serviceRestartBusy,
  type ConfirmableRestartKey,
  type ServiceRestartState,
} from '../../domain/service-restart-state';
import type { JarvisStatus } from '../../domain/types';
import { deriveHealthPresentation, healthGraceAnchor, type HealthLevel } from '../system/health-derivation';
import { defaultCopy, Observation, type ObservationCopy } from './Observation';
import { buildSubsystemRows, RestartFeedback, SubsystemGauges, type SubsystemRow } from './SubsystemGauges';
import { ResourceHero } from './ResourceHero';
import { BackendPanel, BridgeActionsPanel, ProvenancePanel } from './OverviewPanels';
import { DoctorPanel, ResourceDetailPanel } from './DiagnosticsPanels';
import { RuntimeView } from './RuntimePanels';
import { parseDoctorReport, parseJarvisStatus, type DoctorReport } from './health-format';
import { useNativeResource } from './useNativeResource';
import { useRuntimeTelemetry } from './useRuntimeTelemetry';

type HealthTab = 'overview' | 'diagnostics' | 'runtime';

const TABS: Array<{ id: HealthTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'runtime', label: 'Runtime' },
];

const STATUS_COPY: ObservationCopy = {
  loading: 'Loading status…',
  refreshing: 'Refreshing status…',
  failed: 'Could not load status.',
  failedWithSnapshot: 'Could not refresh status. Showing previously loaded status; it may be stale.',
};

const LEVEL_TONE: Record<HealthLevel, Tone> = {
  ok: 'ok',
  starting: 'info',
  warn: 'warn',
  down: 'error',
  unavailable: 'warn',
};

function isConfirmable(key: string): key is ConfirmableRestartKey {
  return key === 'ollama' || key === 'bun' || key === 'proxy';
}

/** The masthead sentence: the same derivation the global banner shows. */
function Verdict({
  status,
  statusError,
  statusLoading,
  mountedAt,
}: {
  status: JarvisStatus | null;
  statusError: boolean;
  statusLoading: boolean;
  mountedAt: number;
}) {
  if (!status) {
    return (
      <p className="d-display text-[24px] leading-tight text-ink-3">
        {statusError ? 'Health observation is unavailable.' : statusLoading ? 'Checking health…' : 'Health has not been observed yet.'}
      </p>
    );
  }
  const presentation = deriveHealthPresentation(status, null, Date.now() - mountedAt);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Badge tone={LEVEL_TONE[presentation.level]} dot>{presentation.label}</Badge>
      <p className="d-display text-[24px] leading-tight text-ink-2">{presentation.summary}</p>
    </div>
  );
}

function GaugeSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(176px,1fr))] gap-3" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <Panel key={i} className="space-y-3">
          <Skeleton className="w-24" />
          <Skeleton className="w-full" />
          <Skeleton className="w-2/3" />
        </Panel>
      ))}
    </div>
  );
}

export default function HealthPage() {
  const mountedAt = healthGraceAnchor(useRef(Date.now()).current);
  const statusRes = useNativeResource<JarvisStatus>('jarvis_check_status', parseJarvisStatus);
  const healthRes = useNativeResource<HealthData>('get_system_health', parseHealthData);
  const doctorRes = useNativeResource<DoctorReport>('get_doctor_report', parseDoctorReport);
  const telemetry = useRuntimeTelemetry();
  const { load: loadStatus } = statusRes;
  const { load: loadHealth, loadDetailed: loadHealthDetailed, invalidate: invalidateHealth } = healthRes;
  const { load: loadDoctor } = doctorRes;
  const { load: loadTelemetry } = telemetry;
  const status = statusRes.snapshot;
  const health = healthRes.snapshot;
  const doctor = doctorRes.snapshot;
  const loading = statusRes.loading || healthRes.loading || doctorRes.loading;

  const [tab, setTab] = useState<HealthTab>('overview');
  const [restartState, setRestartState] = useState<ServiceRestartState>(initialServiceRestartState);
  const restartPending = useRef(false);
  const restartOperation = useRef(0);
  const restartBusy = serviceRestartBusy(restartState);
  const { success, info } = useToast();

  const fetchAll = useCallback(async () => {
    await Promise.all([loadStatus(true), loadHealth(true), loadDoctor(true), loadTelemetry()]);
  }, [loadStatus, loadHealth, loadDoctor, loadTelemetry]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const subsystemRows = health ? buildSubsystemRows(health, status?.active_backend) : [];

  const confirmRestartReadback = useCallback(
    async (row: SubsystemRow, operationId: number) => {
      if (operationId !== restartOperation.current) return;
      setRestartState((current) => reduceServiceRestartState(current, { type: 'readback-start', key: row.key }));
      const result = await loadHealthDetailed(true);
      if (operationId !== restartOperation.current) return;
      if (!result?.accepted || result.failed || result.snapshot === null) {
        setRestartState((current) => reduceServiceRestartState(current, { type: 'readback-failed', key: row.key }));
        return;
      }
      if (isConfirmable(row.key) && !restartServiceRunning(row.key, result.snapshot)) {
        setRestartState((current) => reduceServiceRestartState(current, { type: 'readback-mismatch', key: row.key }));
        return;
      }
      setRestartState((current) => reduceServiceRestartState(current, { type: 'readback-confirmed', key: row.key }));
      success(`${row.name} restarted`, 'Restart');
      // The masthead verdict reads `jarvis_check_status`; re-read it so it
      // agrees with the gauge that just confirmed the restart.
      void loadStatus(true);
      void loadDoctor(true);
    },
    [loadDoctor, loadHealthDetailed, loadStatus, success],
  );

  const restartSubsystem = useCallback(
    async (row: SubsystemRow) => {
      if (restartPending.current || !row.command) return;
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
    },
    [confirmRestartReadback, info, invalidateHealth, success],
  );

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

  return (
    <Page>
      <PageHeader
        eyebrow="System"
        title="Health"
        description="Subsystems, resources and diagnostics for the Bun server, the bridge and the active Inference backend."
        actions={
          <Button
            variant="ghost"
            icon={<RotateCw aria-hidden="true" />}
            disabled={loading || restartBusy}
            onClick={() => {
              if (!loading && !restartBusy) void fetchAll();
            }}
          >
            Refresh
          </Button>
        }
      >
        <Verdict status={status} statusError={statusRes.error} statusLoading={statusRes.loading} mountedAt={mountedAt} />
      </PageHeader>

      {(statusRes.loading || statusRes.error || healthRes.loading || healthRes.error || doctorRes.loading || doctorRes.error) && (
        <div className="mb-5 space-y-2">
          <Observation name="Status" resource={statusRes} copy={STATUS_COPY} retryLabel="Retry status" />
          <Observation name="System health" resource={healthRes} copy={defaultCopy('System health')} retryLabel="Retry System health" />
          <Observation name="Doctor report" resource={doctorRes} copy={defaultCopy('Doctor report')} retryLabel="Retry Doctor report" />
        </div>
      )}

      <section aria-labelledby="health-subsystems" className="mb-6">
        <h2 id="health-subsystems" className="d-label mb-3">Subsystems</h2>
        {restartRow && (
          <div className="mb-3">
            <RestartFeedback
              state={restartState}
              name={restartRow.name}
              busy={restartBusy}
              onRetryRestart={retryRestart}
              onRetryHealth={() => {
                void retryRestartHealth();
              }}
            />
          </div>
        )}
        {health ? (
          <SubsystemGauges rows={subsystemRows} restartBusy={restartBusy} restartKey={restartState.key} onRestart={(row) => void restartSubsystem(row)} />
        ) : (
          <GaugeSkeleton />
        )}
      </section>

      <div className="mb-6">
        <ResourceHero health={health} pending={healthRes.loading} doctor={doctor} inference={telemetry.inference} />
      </div>

      <Tabs aria-label="Health sections" idBase="health" items={TABS} value={tab} onChange={setTab} className="mb-5" />
      <div role="tabpanel" id={`health-panel-${tab}`} aria-labelledby={`health-tab-${tab}`} className="d-rise">
        {tab === 'overview' && (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <BackendPanel status={status} statusLoading={statusRes.loading} onRefresh={() => void loadStatus()} />
            <div className="space-y-4">
              <ProvenancePanel />
              <BridgeActionsPanel
                onChanged={() => {
                  void loadStatus();
                  void loadHealth();
                }}
              />
            </div>
          </div>
        )}
        {tab === 'diagnostics' && (
          <div className="space-y-4">
            <DoctorPanel doctor={doctor} pending={doctorRes.loading} />
            <ResourceDetailPanel health={health} />
          </div>
        )}
        {tab === 'runtime' && <RuntimeView telemetry={telemetry} onRetry={() => void loadTelemetry()} />}
      </div>
    </Page>
  );
}
