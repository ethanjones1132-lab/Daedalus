// Job-list state for the Cron page: the confirmed list, in-flight ids, pending
// missed jobs, per-job operations, and the missed-job recovery operation.
//
// This is the legacy CronView data layer moved verbatim: every read is fenced
// by a request id, every mutation is followed by a confirmed read-back, and
// background reads stand down while any mutation is unresolved.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../design';
import {
  reconcileCronOperations,
  startCronOperation,
  transitionCronOperation,
  type CronOperation,
  type CronOperationKind,
} from '../../domain/cron-operation-state';
import {
  cronOperationSuccessText,
  type CronJob,
  type CronJobDraft,
  type CronOperationMap,
  type CronReadResult,
  type CronSnapshot,
  type MissedOperation,
  type MissedOperationKind,
} from './cron-model';

export function useCronJobs() {
  const { success } = useToast();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const jobsRef = useRef<CronJob[]>([]);
  const [inFlightIds, setInFlightIds] = useState<Set<string>>(new Set());
  const [pendingMissed, setPendingMissed] = useState<CronJob[]>([]);
  const pendingMissedRef = useRef<CronJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const createPending = useRef(false);
  const [operations, setOperations] = useState<CronOperationMap>({});
  const operationsRef = useRef<CronOperationMap>({});
  const [missedOperation, setMissedOperation] = useState<MissedOperation | null>(null);
  const missedOperationRef = useRef<MissedOperation | null>(null);
  const jobsRequestId = useRef(0);
  const inFlightRequestId = useRef(0);
  const missedRequestId = useRef(0);
  const snapshotVersion = useRef(0);
  const readbackTail = useRef<Promise<unknown>>(Promise.resolve());

  const publishOperations = useCallback((next: CronOperationMap) => {
    operationsRef.current = next;
    setOperations(next);
  }, []);

  const publishMissedOperation = useCallback((next: MissedOperation | null) => {
    missedOperationRef.current = next;
    setMissedOperation(next);
  }, []);

  const updateJobs = useCallback((next: CronJob[]) => {
    jobsRef.current = next;
    setJobs(next);
  }, []);

  const updatePendingMissed = useCallback((next: CronJob[]) => {
    pendingMissedRef.current = next;
    setPendingMissed(next);
  }, []);

  const hasMutation = useCallback(() => (
    Object.keys(operationsRef.current).length > 0 || missedOperationRef.current !== null
  ), []);

  const invalidateResourceReads = useCallback(() => {
    jobsRequestId.current += 1;
    inFlightRequestId.current += 1;
    missedRequestId.current += 1;
    snapshotVersion.current += 1;
    setRefreshing(false);
    return snapshotVersion.current;
  }, []);

  const fetchInFlight = useCallback(async () => {
    if (hasMutation()) return;
    const requestId = ++inFlightRequestId.current;
    try {
      const ids = await invoke<string[]>('get_in_flight_cron_jobs');
      if (requestId !== inFlightRequestId.current) return;
      setInFlightIds(new Set(ids));
    } catch {
      return;
    }
  }, [hasMutation]);

  const fetchJobs = useCallback(async () => {
    if (hasMutation()) return false;
    const requestId = ++jobsRequestId.current;
    setRefreshing(true);
    try {
      const nextJobs = await invoke<CronJob[]>('list_cron_jobs');
      if (requestId !== jobsRequestId.current) return false;
      updateJobs(nextJobs);
      setHasLoaded(true);
      setError(null);
      return true;
    } catch {
      if (requestId === jobsRequestId.current) {
        setError(jobsRef.current.length > 0
          ? 'Could not refresh cron jobs. Showing the previous list; it may be stale.'
          : 'Could not load cron jobs.');
      }
      return false;
    } finally {
      if (requestId === jobsRequestId.current) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, [hasMutation, updateJobs]);

  const fetchPendingMissed = useCallback(async () => {
    if (hasMutation()) return;
    const requestId = ++missedRequestId.current;
    try {
      const nextMissed = await invoke<CronJob[]>('list_pending_missed_jobs');
      if (requestId !== missedRequestId.current) return;
      updatePendingMissed(nextMissed);
    } catch {
      return;
    }
  }, [hasMutation, updatePendingMissed]);

  useEffect(() => {
    void fetchJobs();
    void fetchInFlight();
    void fetchPendingMissed();
    const interval = setInterval(() => void fetchInFlight(), 3000);

    const missedListen = listen<CronJob[]>('cron://missed-jobs', (event) => {
      if (hasMutation()) return;
      updatePendingMissed(event.payload);
    });

    return () => {
      clearInterval(interval);
      void Promise.resolve(missedListen).then((unlisten) => unlisten());
    };
  }, [fetchInFlight, fetchJobs, fetchPendingMissed, hasMutation, updatePendingMissed]);

  const readOperationSnapshot = useCallback((): Promise<CronReadResult> => {
    const run = async (): Promise<CronReadResult> => {
      const requestId = ++snapshotVersion.current;
      try {
        const [nextJobs, nextInFlight, nextMissed] = await Promise.all([
          invoke<CronJob[]>('list_cron_jobs'),
          invoke<string[]>('get_in_flight_cron_jobs'),
          invoke<CronJob[]>('list_pending_missed_jobs'),
        ]);
        return {
          status: 'success',
          snapshot: { jobs: nextJobs, inFlightIds: nextInFlight, pendingMissed: nextMissed, requestId },
        };
      } catch {
        return { status: 'failure' };
      }
    };

    const result = readbackTail.current.then(run, run);
    readbackTail.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const updateFromSnapshot = useCallback((snapshot: CronSnapshot) => {
    const reconciliation = reconcileCronOperations(snapshot.jobs, operationsRef.current, snapshot.requestId);
    publishOperations(reconciliation.operations);
    updateJobs(reconciliation.rows);
    setInFlightIds(new Set(snapshot.inFlightIds));
    updatePendingMissed(snapshot.pendingMissed);
    jobsRequestId.current = Math.max(jobsRequestId.current, snapshot.requestId);
    inFlightRequestId.current = Math.max(inFlightRequestId.current, snapshot.requestId);
    missedRequestId.current = Math.max(missedRequestId.current, snapshot.requestId);
    setLoading(false);
    setHasLoaded(true);
    setRefreshing(false);
    setError(null);
    return reconciliation;
  }, [publishOperations, updateJobs, updatePendingMissed]);

  const applyOperationSnapshot = useCallback((result: CronReadResult) => {
    if (result.status !== 'success' || !result.snapshot) return;
    const reconciliation = updateFromSnapshot(result.snapshot);
    for (const confirmed of reconciliation.confirmed) {
      success(cronOperationSuccessText(confirmed.operation), 'Cron Job Updated');
    }
  }, [success, updateFromSnapshot]);

  const reconcileOperation = useCallback(async (operation: CronOperation<CronJob>) => {
    const result = await readOperationSnapshot();
    if (result.status === 'stale') return;
    if (result.status === 'failure') {
      const failed = transitionCronOperation(operation, 'read-failed');
      if (failed && operationsRef.current[operation.id]) {
        publishOperations({ ...operationsRef.current, [operation.id]: failed });
      }
      return;
    }
    applyOperationSnapshot(result);
  }, [applyOperationSnapshot, publishOperations, readOperationSnapshot]);

  const handleOperation = useCallback(async (kind: CronOperationKind, job: CronJob) => {
    if (operationsRef.current[job.id] || missedOperationRef.current) return;
    const after = invalidateResourceReads();
    const targetEnabled = kind === 'toggle' ? !job.enabled : undefined;
    const operation = startCronOperation(kind, job.id, job, after, targetEnabled);
    publishOperations({ ...operationsRef.current, [job.id]: operation });

    try {
      let result: unknown;
      if (kind === 'toggle') {
        result = await invoke<boolean>(job.enabled ? 'disable_cron_job' : 'enable_cron_job', { id: job.id });
      } else if (kind === 'run') {
        result = await invoke<boolean>('run_cron_job', { id: job.id });
      } else {
        result = await invoke<boolean>('delete_cron_job', { id: job.id });
      }
      if (result !== true) throw new Error('Cron operation was not confirmed');
    } catch {
      const failed = transitionCronOperation(operation, 'write-failed');
      if (failed) publishOperations({ ...operationsRef.current, [job.id]: failed });
      return;
    }

    const reconciling = transitionCronOperation(operation, 'write-succeeded');
    if (!reconciling) return;
    publishOperations({ ...operationsRef.current, [job.id]: reconciling });
    await reconcileOperation(reconciling);
  }, [invalidateResourceReads, publishOperations, reconcileOperation]);

  const handleToggle = useCallback((job: CronJob) => {
    void handleOperation('toggle', job);
  }, [handleOperation]);

  const handleRun = useCallback((job: CronJob) => {
    void handleOperation('run', job);
  }, [handleOperation]);

  const handleDelete = useCallback((job: CronJob) => {
    if (operationsRef.current[job.id] || missedOperationRef.current) return;
    if (!confirm(`Delete cron job "${job.name}"?`)) return;
    void handleOperation('delete', job);
  }, [handleOperation]);

  const handleRetry = useCallback((job: CronJob) => {
    const operation = operationsRef.current[job.id];
    if (!operation) return;
    if (operation.phase === 'write-failed') {
      const next = { ...operationsRef.current };
      delete next[job.id];
      publishOperations(next);
      void handleOperation(operation.kind, job);
      return;
    }
    if (operation.phase === 'read-failed') {
      const retrying = transitionCronOperation(operation, 'retry-read');
      if (!retrying) return;
      publishOperations({ ...operationsRef.current, [job.id]: retrying });
      void reconcileOperation(retrying);
    }
  }, [handleOperation, publishOperations, reconcileOperation]);

  const handleCreate = useCallback(async (draft: CronJobDraft) => {
    if (createPending.current) return;
    createPending.current = true;
    setCreating(true);
    try {
      const job = await invoke<CronJob>('add_cron_job', {
        name: draft.name,
        schedule: draft.schedule,
        prompt: draft.prompt,
        agentId: draft.agentId,
      });
      updateJobs([job, ...jobsRef.current]);
      setHasLoaded(true);
      setCreateError(false);
      setShowAddForm(false);
      success(`Cron job "${job.name}" created successfully.`, 'Cron Job Added');
    } catch {
      setCreateError(true);
    } finally {
      createPending.current = false;
      setCreating(false);
    }
  }, [success, updateJobs]);

  const handleToggleAddForm = useCallback(() => {
    if (createPending.current) return;
    setCreateError(false);
    setShowAddForm((current) => !current);
  }, []);

  const handleCancelAdd = useCallback(() => {
    if (createPending.current) return;
    setCreateError(false);
    setShowAddForm(false);
  }, []);

  const reconcileMissedOperation = useCallback(async (operation: MissedOperation) => {
    const result = await readOperationSnapshot();
    if (result.status === 'stale') return;
    if (result.status === 'failure' || !result.snapshot) {
      if (missedOperationRef.current?.after === operation.after) {
        publishMissedOperation({ ...operation, phase: 'read-failed' });
      }
      return;
    }

    const previousNames = new Map(pendingMissedRef.current.map((job) => [job.id, job.name]));
    updateFromSnapshot(result.snapshot);
    const current = missedOperationRef.current;
    if (!current || current.after !== operation.after) return;
    const pendingIds = new Set(result.snapshot.pendingMissed.map((job) => job.id));
    if (current.failedIds && current.failedIds.some((id) => pendingIds.has(id))) {
      publishMissedOperation({ ...current, phase: 'write-failed' });
      return;
    }
    if (current.phase === 'write-failed') {
      publishMissedOperation(null);
      return;
    }
    if (current.ids.every((id) => !pendingIds.has(id))) {
      const name = previousNames.get(current.ids[0]);
      publishMissedOperation(null);
      if (current.kind === 'dismiss-all') {
        success('All missed jobs dismissed.', 'Missed Jobs Dismissed');
      } else if (current.kind === 'trigger') {
        success(`Missed job "${name ?? current.ids[0]}" is executing now.`, 'Missed Job Started');
      } else {
        success(`Missed job "${name ?? current.ids[0]}" dismissed and rescheduled.`, 'Missed Job Dismissed');
      }
    } else {
      publishMissedOperation({ ...current, phase: 'read-failed' });
    }
  }, [publishMissedOperation, readOperationSnapshot, success, updateFromSnapshot]);

  const executeMissedMutation = useCallback(async (
    kind: MissedOperationKind,
    ids: string[],
    originalIds: string[] = ids,
  ) => {
    if (missedOperationRef.current || Object.keys(operationsRef.current).length > 0 || ids.length === 0) return;
    const after = invalidateResourceReads();
    const operation: MissedOperation = { kind, ids: originalIds, phase: 'writing', after };
    publishMissedOperation(operation);
    const results = await Promise.all(ids.map(async (id) => {
      try {
        const command = kind === 'trigger' ? 'trigger_missed_cron_job' : 'dismiss_missed_cron_job';
        return { id, ok: await invoke<boolean>(command, { id }) === true };
      } catch {
        return { id, ok: false };
      }
    }));
    const failedIds = results.filter((result) => !result.ok).map((result) => result.id);
    if (failedIds.length > 0) {
      const failed = { ...operation, phase: 'write-failed' as const, failedIds };
      publishMissedOperation(failed);
      if (kind === 'dismiss-all') await reconcileMissedOperation(failed);
      return;
    }
    const reconciling = { ...operation, phase: 'reconciling' as const };
    publishMissedOperation(reconciling);
    await reconcileMissedOperation(reconciling);
  }, [invalidateResourceReads, publishMissedOperation, reconcileMissedOperation]);

  const handleTriggerMissed = useCallback((id: string) => {
    void executeMissedMutation('trigger', [id]);
  }, [executeMissedMutation]);

  const handleDismissMissed = useCallback((id: string) => {
    void executeMissedMutation('dismiss', [id]);
  }, [executeMissedMutation]);

  const handleDismissAllMissed = useCallback(() => {
    void executeMissedMutation('dismiss-all', pendingMissedRef.current.map((job) => job.id));
  }, [executeMissedMutation]);

  const handleRetryMissed = useCallback(() => {
    const operation = missedOperationRef.current;
    if (!operation) return;
    if (operation.phase === 'write-failed') {
      const ids = operation.failedIds && operation.failedIds.length > 0 ? operation.failedIds : operation.ids;
      publishMissedOperation(null);
      void executeMissedMutation(operation.kind, ids, operation.ids);
      return;
    }
    if (operation.phase === 'read-failed') {
      const retrying = { ...operation, phase: 'reconciling' as const };
      publishMissedOperation(retrying);
      void reconcileMissedOperation(retrying);
    }
  }, [executeMissedMutation, publishMissedOperation, reconcileMissedOperation]);

  return {
    jobs,
    inFlightIds,
    pendingMissed,
    error,
    loading,
    hasLoaded,
    refreshing,
    showAddForm,
    creating,
    createError,
    operations,
    missedOperation,
    hasMutation,
    fetchJobs,
    handleToggle,
    handleRun,
    handleDelete,
    handleRetry,
    handleCreate,
    handleToggleAddForm,
    handleCancelAdd,
    handleTriggerMissed,
    handleDismissMissed,
    handleDismissAllMissed,
    handleRetryMissed,
  };
}
