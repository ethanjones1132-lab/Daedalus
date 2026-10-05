import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  initialRegistryState,
  parseActionRegistryAlerts,
  reduceRegistryState,
  type ActionRegistryAlert,
  type RegistrySnapshotState,
} from './action-registry-state';
import {
  isRegistryDispatchUnavailable,
  isVerifiedRegistryDispatchEvidence,
  registryMutationConfirmed,
  registryMutationLocked,
  startRegistryMutation,
  transitionRegistryMutation,
  type RegistryDispatchEvidence,
  type RegistryMutation,
  type RegistryMutationKind,
} from './action-registry-mutation-state';
import { motion } from 'framer-motion';
import {
  PageTransition,
  AnimatedList,
  GlassCard,
  StatusDot,
  Pill,
  SectionHeader,
  LoadingState,
  ErrorState,
  MetricBlock,
  useToast,
} from '../ui';
import {
  acceptanceStatusVariant,
  criterionEvidenceSummary,
  evidenceSummary,
  executionStatusVariant,
  isTrustedAcceptanceReceipt,
  isTrustedExecutionReceipt,
  type TrustedAcceptanceReceipt,
  type TrustedExecutionReceipt,
} from './trusted-receipt-state';

interface ActionRegistrySummary {
  active: number;
  blocked: number;
  done: number;
  pending_approvals: number;
  escalated: number;
  alerts: number;
}

interface RegistryAction {
  id: string;
  project: string;
  source_system: string;
  source_area: string;
  priority: string;
  risk_level: string;
  category: string;
  action_type: string;
  title: string;
  description: string;
  status: string;
  owner: string;
  approval_required: boolean;
  approval_status?: string;
  next_due?: string;
  escalated?: boolean;
  escalation_note?: string;
  updated_at: string;
}

interface ActionRegistryBucket {
  bucket: string;
  actions: RegistryAction[];
}

function alertSeverityVariant(severity: string): 'error' | 'warning' | 'success' | 'default' {
  if (severity === 'high' || severity === 'critical') return 'error';
  if (severity === 'medium') return 'warning';
  if (severity === 'low') return 'success';
  return 'default';
}

function alertValue(value: string | number | null | undefined): string {
  return value === undefined || value === null || value === '' ? 'Not supplied' : String(value);
}

function ActionAlertLedger({
  state,
  onRefresh,
}: {
  state: RegistrySnapshotState<ActionRegistryAlert[]>;
  onRefresh: () => void;
}) {
  const { snapshot, loading, error } = state;
  const stale = snapshot !== null && (loading || error);

  return (
    <section
      role="region"
      aria-label="Action registry alerts"
      className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-bone">Alert ledger</h3>
          <p className="text-[10px] text-bone/50">Persisted Action Registry alerts; this ledger is independent of action bucket loading.</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="shrink-0 px-3 py-1 text-xs rounded-md bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {error ? 'Retry alerts' : 'Refresh alerts'}
        </button>
      </div>

      {loading && (
        <div role="status" aria-label="Action registry alerts loading" className="text-xs text-bone/60">
          {snapshot ? 'Refreshing Action Registry alerts…' : 'Loading Action Registry alerts…'}
        </div>
      )}
      {error && (
        <div role="alert" aria-label="Action registry alerts error" className="text-xs text-red-200">
          {snapshot
            ? 'Could not refresh Action Registry alerts. Showing previously loaded alerts; they may be stale.'
            : 'Could not load Action Registry alerts.'}
        </div>
      )}
      {stale && <div className="text-[10px] text-amber-200/70">stale</div>}
      {snapshot !== null && snapshot.length > 0 ? (
        <ul aria-label="Action Registry alert entries" className="space-y-2">
          {snapshot.map((alert, index) => (
            <li key={`${alert.id}-${index}`} className="rounded-lg border border-white/5 bg-black/10 p-3 text-[11px] text-bone/60 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span>severity: <Pill variant={alertSeverityVariant(alert.severity)}>{alert.severity}</Pill></span>
                <span>kind: <Pill>{alert.kind}</Pill></span>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-bone">{alert.title}</h4>
                <p className="mt-1 text-xs leading-relaxed">{alert.message}</p>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px]">
                <span>alert_id: {alertValue(alert.id)}</span>
                <span>action_id: {alertValue(alert.action_id)}</span>
                <span>count: {alertValue(alert.count)}</span>
                <span>created_at: {alertValue(alert.created_at)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : snapshot?.length === 0 && !loading && !error ? (
        <p className="text-xs text-bone/50">No Action Registry alerts.</p>
      ) : null}
    </section>
  );
}

const priorityVariant = (priority: string) => {
  switch (priority) {
    case 'P0': return 'error';
    case 'P1': return 'warning';
    case 'P2': return 'info';
    default: return 'default';
  }
};

const riskVariant = (risk: string) => {
  switch (risk) {
    case 'critical':
    case 'high': return 'error';
    case 'medium': return 'warning';
    default: return 'success';
  }
};

interface RegistrySnapshot {
  summary: ActionRegistrySummary;
  active: RegistryAction[];
  blocked: RegistryAction[];
}

type RegistryReadResult =
  | { status: 'success'; requestId: number; snapshot: RegistrySnapshot }
  | { status: 'failure' | 'stale' };

const DISPATCH_UNAVAILABLE_MESSAGE =
  'Action dispatch is unavailable because no authoritative verification path is configured. Registry data was not changed.';

function mutationStatusText(mutation: RegistryMutation): string {
  if (mutation.unavailable && mutation.phase === 'reconciling') return 'Refreshing action registry after unavailable dispatch…';
  if (mutation.phase === 'reconciling') return 'Action registry write saved. Reconciling the confirmed snapshot…';
  if (mutation.kind === 'sync') return 'Syncing action registry…';
  if (mutation.kind === 'approve') return 'Approving action…';
  if (mutation.kind === 'waive') return 'Waiving action…';
  return 'Dispatching action…';
}

function mutationFailureText(mutation: RegistryMutation): string {
  if (mutation.kind === 'sync') return 'Could not sync the action registry. Previous snapshot was kept.';
  if (mutation.kind === 'dispatch') return 'Could not dispatch the action. Previous snapshot was kept.';
  return `Could not ${mutation.kind === 'approve' ? 'approve' : 'waive'} the action. Previous snapshot was kept.`;
}

function mutationReadFailureText(mutation: RegistryMutation): string {
  if (mutation.unavailable) return 'Action dispatch is unavailable. The action registry could not be refreshed; showing the previous snapshot; it may be stale.';
  if (mutation.kind === 'sync') return 'Action registry sync was saved, but the confirmed snapshot could not be reconciled. Showing the previous snapshot; it may be stale.';
  return 'The action registry write was saved, but the confirmed snapshot could not be reconciled. Showing the previous snapshot; it may be stale.';
}

function mutationSuccessText(mutation: RegistryMutation): string {
  if (mutation.kind === 'sync') return 'Action registry synced from live adapters.';
  if (mutation.kind === 'approve') return 'Action approved successfully.';
  if (mutation.kind === 'waive') return 'Action waived successfully.';
  return 'Action registry update confirmed.';
}

/**
 * Authoritative native receipt evidence for one exact Action Registry action id.
 * Loads on demand only, decodes strictly, and binds every returned record to the
 * displayed action id. The file-backed row's `execution_evidence` /
 * `acceptance_evidence` is never read: only `list_trusted_executions` and
 * `get_trusted_acceptance` are displayed. Any failed/mismatched read shows an
 * explicit unavailable state instead of evidence.
 */
function ActionNativeReceipts({ actionId }: { actionId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [executions, setExecutions] = useState<TrustedExecutionReceipt[]>([]);
  const [receipts, setReceipts] = useState<Record<string, TrustedAcceptanceReceipt | null>>({});
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const raw = await invoke<unknown>('list_trusted_executions', { actionId });
      if (id !== requestId.current) return;
      if (!Array.isArray(raw)) throw new Error('unreadable');
      const rows: TrustedExecutionReceipt[] = [];
      for (const item of raw) {
        if (!isTrustedExecutionReceipt(item) || item.action_id !== actionId) {
          throw new Error('malformed');
        }
        rows.push(item);
      }
      const nextReceipts: Record<string, TrustedAcceptanceReceipt | null> = {};
      for (const execution of rows) {
        let receipt: TrustedAcceptanceReceipt | null = null;
        try {
          const rawReceipt = await invoke<unknown>('get_trusted_acceptance', {
            executionId: execution.execution_id,
          });
          if (id !== requestId.current) return;
          if (rawReceipt !== null && rawReceipt !== undefined) {
            if (
              !isTrustedAcceptanceReceipt(rawReceipt) ||
              rawReceipt.execution_id !== execution.execution_id ||
              rawReceipt.action_id !== actionId ||
              rawReceipt.manifest_id !== execution.manifest_id
            ) {
              throw new Error('malformed');
            }
            receipt = rawReceipt;
          }
        } catch {
          if (id !== requestId.current) return;
          throw new Error('receipt-unreadable');
        }
        nextReceipts[execution.execution_id] = receipt;
      }
      if (id !== requestId.current) return;
      setExecutions(rows);
      setReceipts(nextReceipts);
      setUnavailable(false);
      setLoaded(true);
    } catch {
      if (id !== requestId.current) return;
      setExecutions([]);
      setReceipts({});
      setLoaded(false);
      setUnavailable(true);
      setError(
        'Native execution/acceptance receipts could not be read for this action. Evidence is unavailable; the file-backed Action Registry row is not a proof source.',
      );
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [actionId]);

  useEffect(() => {
    requestId.current++;
    setExecutions([]);
    setReceipts({});
    setLoaded(false);
    setUnavailable(false);
    setError(null);
    setLoading(false);
    if (open) void load();
  }, [actionId, open, load]);

  return (
    <div className="mt-3 border-t border-white/10 pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="text-[10px] font-mono uppercase tracking-wider text-bone/50 hover:text-bone transition-colors"
      >
        {open ? '▾' : '▸'} Native receipts
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {loading && (
            <div role="status" className="text-[11px] text-bone/50">
              Loading native execution/acceptance receipts…
            </div>
          )}
          {error && (
            <div role="alert" className="text-[11px] text-red-200">
              {error}
            </div>
          )}
          {!loading && !unavailable && loaded && executions.length === 0 && (
            <div className="text-[11px] text-bone/40">
              No native trusted execution receipts exist for this action.
            </div>
          )}
          {executions.map((execution) => {
            const receipt = receipts[execution.execution_id] ?? null;
            return (
              <div
                key={execution.execution_id}
                className="rounded-lg border border-white/10 bg-black/10 p-2"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <Pill variant={executionStatusVariant(execution.status)}>{execution.status}</Pill>
                  {receipt && (
                    <Pill variant={acceptanceStatusVariant(receipt.status)}>
                      acceptance: {receipt.status}
                    </Pill>
                  )}
                  {receipt?.confirmed && <Pill variant="success">native confirmed</Pill>}
                </div>
                <div className="mt-1 text-[10px] font-mono text-bone/50 break-all">
                  <div>action {execution.action_id}</div>
                  <div>execution {execution.execution_id}</div>
                  <div>
                    manifest {execution.manifest_id} · v{execution.manifest_registry_version} ·{' '}
                    {execution.manifest_content_hash.slice(0, 12)}… · schema{' '}
                    {execution.manifest_schema_version}
                  </div>
                  <div>
                    agent {execution.agent_id} · workspace {execution.project_root}
                  </div>
                  <div>
                    runtime {execution.runtime_started_at ?? '—'} →{' '}
                    {execution.runtime_finished_at ?? '—'}
                  </div>
                </div>
                {execution.terminal_reason && (
                  <div className="mt-1 text-[10px] text-bone/50">
                    reason: {execution.terminal_reason}
                  </div>
                )}
                {execution.conflict?.detail && (
                  <div className="mt-1 text-[10px] text-amber-200/80">
                    conflict: {execution.conflict.detail}
                  </div>
                )}
                {evidenceSummary(execution.evidence) && (
                  <div className="mt-1 text-[10px] text-bone/40">
                    run evidence: {evidenceSummary(execution.evidence)}
                  </div>
                )}
                {receipt && (
                  <div className="mt-2 space-y-1">
                    <div className="text-[10px] font-mono text-bone/50 break-all">
                      acceptance {receipt.acceptance_key} · goal {receipt.goal_id}
                    </div>
                    {receipt.terminal_reason && (
                      <div className="text-[10px] text-bone/50">
                        delivery note: {receipt.terminal_reason}
                      </div>
                    )}
                    <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40">
                      Criterion checks
                    </div>
                    <ul className="space-y-1">
                      {receipt.criteria.map((criterion) => (
                        <li
                          key={`${criterion.criterion_id}:${criterion.check_index}`}
                          className="text-[10px] font-mono text-bone/70"
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <Pill variant={criterion.accepted ? 'success' : 'error'}>
                              {criterion.accepted ? 'accepted' : 'not accepted'}
                            </Pill>
                            <span>{criterion.tool}</span>
                            <span className="text-bone/40">check {criterion.check_index}</span>
                          </div>
                          <div className="text-bone/40 break-all">
                            criterion {criterion.criterion_id} · expected{' '}
                            {criterion.expected_sha256.slice(0, 12)}… · actual{' '}
                            {criterion.actual_sha256
                              ? `${criterion.actual_sha256.slice(0, 12)}…`
                              : '—'}
                          </div>
                          {criterionEvidenceSummary(criterion.evidence) && (
                            <div className="text-bone/40">
                              {criterionEvidenceSummary(criterion.evidence)}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {!receipt && !loading && (
                  <div className="mt-1 text-[10px] text-bone/40">
                    No native acceptance receipt for this execution.
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-[10px] font-mono text-bone-faint">
            Evidence is read only from authoritative native execution/acceptance receipts bound to
            this exact action id. The file-backed Action Registry row&apos;s evidence fields are
            never displayed or trusted.
          </p>
        </div>
      )}
    </div>
  );
}

export default function ActionRegistryView() {
  const [state, dispatch] = useReducer(reduceRegistryState<RegistrySnapshot>, initialRegistryState<RegistrySnapshot>());
  const [alertState, dispatchAlerts] = useReducer(
    reduceRegistryState<ActionRegistryAlert[]>,
    initialRegistryState<ActionRegistryAlert[]>(),
  );
  const requestId = useRef(0);
  const alertRequestId = useRef(0);
  const mutationRef = useRef<RegistryMutation | null>(null);
  const [mutation, setMutation] = useState<RegistryMutation | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [doneActions, setDoneActions] = useState<RegistryAction[] | null>(null);
  const [doneLoading, setDoneLoading] = useState(false);
  const [doneError, setDoneError] = useState(false);
  const [doneRetry, setDoneRetry] = useState(0);
  const doneRequestId = useRef(0);
  const { snapshot, loading, error } = state;
  const summary = snapshot?.summary;
  const active = snapshot?.active ?? [];
  const blocked = snapshot?.blocked ?? [];
  const mutationLocked = registryMutationLocked(mutation);
  const { success } = useToast();
  const publishMutation = useCallback((next: RegistryMutation | null) => {
    mutationRef.current = next;
    setMutation(next);
  }, []);

  const readSnapshot = useCallback(async (options?: { duringMutation?: boolean; suppressError?: boolean }): Promise<RegistryReadResult> => {
    if (!options?.duringMutation && registryMutationLocked(mutationRef.current)) return { status: 'stale' };
    const id = ++requestId.current;
    dispatch({ type: 'pending', requestId: id });
    try {
      const [summaryData, activeData, blockedData] = await Promise.all([
        invoke<ActionRegistrySummary>('get_action_registry_summary'),
        invoke<ActionRegistryBucket>('get_action_registry_bucket', { bucket: 'active' }),
        invoke<ActionRegistryBucket>('get_action_registry_bucket', { bucket: 'blocked' }),
      ]);
      if (id !== requestId.current) return { status: 'stale' };
      return {
        status: 'success',
        requestId: id,
        snapshot: { summary: summaryData, active: activeData.actions, blocked: blockedData.actions },
      };
    } catch {
      if (id !== requestId.current) return { status: 'stale' };
      dispatch({ type: options?.suppressError ? 'invalidate' : 'failure', requestId: id });
      return { status: 'failure' };
    }
  }, []);

  const fetchData = useCallback(async () => {
    const result = await readSnapshot();
    if (result.status !== 'success') return false;
    dispatch({ type: 'success', requestId: result.requestId, snapshot: result.snapshot });
    return true;
  }, [readSnapshot]);

  const fetchAlerts = useCallback(async () => {
    const id = ++alertRequestId.current;
    dispatchAlerts({ type: 'pending', requestId: id });
    try {
      const response = await invoke<unknown>('get_action_registry_alerts');
      dispatchAlerts({ type: 'success', requestId: id, snapshot: parseActionRegistryAlerts(response) });
    } catch {
      dispatchAlerts({ type: 'failure', requestId: id });
    }
  }, []);

  // Done actions are loaded on demand so terminal actions absent from the
  // active/blocked buckets remain inspectable, including their authoritative
  // native execution/acceptance receipt evidence. A failed read is unavailable,
  // never an empty done bucket.
  const fetchDone = useCallback(async () => {
    const id = ++doneRequestId.current;
    setDoneLoading(true);
    try {
      const raw = await invoke<unknown>('get_action_registry_bucket', { bucket: 'done' });
      if (id !== doneRequestId.current) return;
      if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { actions?: unknown }).actions)) {
        throw new Error('unreadable');
      }
      setDoneActions((raw as { actions: RegistryAction[] }).actions);
      setDoneError(false);
    } catch {
      if (id !== doneRequestId.current) return;
      setDoneActions(null);
      setDoneError(true);
    } finally {
      if (id === doneRequestId.current) setDoneLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!doneOpen) return;
    void fetchDone();
  }, [doneOpen, doneRetry, fetchDone]);

  useEffect(() => {
    void fetchData();
    void fetchAlerts();
    const interval = setInterval(() => {
      void fetchData();
      void fetchAlerts();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchAlerts, fetchData]);

  const reconcileMutation = useCallback(async (operation: RegistryMutation, dispatchEvidence?: RegistryDispatchEvidence) => {
    const result = await readSnapshot({ duringMutation: true, suppressError: true });
    if (result.status !== 'success') {
      const next = transitionRegistryMutation(operation, 'read-failed');
      if (next) publishMutation(next);
      return;
    }
    if (!operation.unavailable && !registryMutationConfirmed(operation, result.snapshot, dispatchEvidence)) {
      dispatch({ type: 'invalidate', requestId: result.requestId });
      publishMutation(transitionRegistryMutation(operation, 'read-failed'));
      return;
    }
    dispatch({ type: 'success', requestId: result.requestId, snapshot: result.snapshot });
    publishMutation(null);
    if (!operation.unavailable) {
      success(mutationSuccessText(operation), operation.kind === 'sync' ? 'Registry Synced' : 'Action Updated');
    }
  }, [publishMutation, readSnapshot, success]);

  const handleMutation = useCallback(async (kind: RegistryMutationKind, id?: string) => {
    if (registryMutationLocked(mutationRef.current)) return;
    if (kind !== 'sync' && id === undefined) return;
    if (kind === 'dispatch' && !active.some(action =>
      action.id === id && (action.status === 'open' || action.status === 'in_progress'))) return;
    const operation = startRegistryMutation(kind, id);
    publishMutation(operation);
    const invalidationId = ++requestId.current;
    dispatch({ type: 'invalidate', requestId: invalidationId });
    let dispatchEvidence: RegistryDispatchEvidence | undefined;
    try {
      if (kind === 'sync') {
        const result = await invoke<unknown>('sync_action_registry');
        if (result === false || result == null) throw new Error('Sync was not confirmed');
      } else if (kind === 'approve' || kind === 'waive') {
        const result = await invoke<boolean>('update_action_approval', {
          actionId: id,
          status: kind === 'approve' ? 'approved' : 'waived',
        });
        if (result !== true) throw new Error('Approval was not confirmed');
      } else {
        const result = await invoke<unknown>('dispatch_action', { actionId: id });
        if (result === false || result == null) throw new Error('Dispatch was not confirmed');
        if (isRegistryDispatchUnavailable(result) || !isVerifiedRegistryDispatchEvidence(result)) {
          const unavailable = transitionRegistryMutation(operation, 'dispatch-unavailable');
          if (unavailable) publishMutation(unavailable);
          return;
        }
        dispatchEvidence = result;
      }
    } catch {
      publishMutation(transitionRegistryMutation(operation, 'write-failed'));
      return;
    }
    const reconciling = transitionRegistryMutation(operation, 'write-succeeded');
    if (reconciling) {
      publishMutation(reconciling);
      await reconcileMutation(reconciling, dispatchEvidence);
    }
  }, [active, publishMutation, reconcileMutation]);

  const retryMutation = useCallback(() => {
    const operation = mutationRef.current;
    if (!operation) return;
    if (operation.phase === 'unavailable') {
      const retrying = transitionRegistryMutation(operation, 'retry-read');
      if (retrying) {
        publishMutation(retrying);
        void reconcileMutation(retrying);
      }
      return;
    }
    if (operation.phase === 'write-failed') {
      void handleMutation(operation.kind, operation.id);
      return;
    }
    if (operation.phase === 'read-failed') {
      const retrying = transitionRegistryMutation(operation, 'retry-read');
      if (retrying) {
        publishMutation(retrying);
        void reconcileMutation(retrying);
      }
    }
  }, [handleMutation, publishMutation, reconcileMutation]);


  const mutationFeedback = mutation ? (
    mutation.phase === 'unavailable' ? (
      <div role="alert" aria-label="Action registry mutation" className="text-sm text-amber-200">
        {DISPATCH_UNAVAILABLE_MESSAGE}{' '}
        <button type="button" className="underline" onClick={retryMutation}>Retry</button>
      </div>
    ) : mutation.phase === 'write-failed' ? (
      <div role="alert" aria-label="Action registry mutation" className="text-sm text-red-200">
        {mutationFailureText(mutation)}{' '}
        <button type="button" className="underline" onClick={retryMutation}>Retry</button>
      </div>
    ) : mutation.phase === 'read-failed' ? (
      <div role="alert" aria-label="Action registry mutation" className="text-sm text-red-200">
        {mutationReadFailureText(mutation)}{' '}
        <button type="button" className="underline" onClick={retryMutation}>Retry</button>
      </div>
    ) : (
      <div role="status" aria-label="Action registry mutation" className="text-sm text-bone/60">
        {mutationStatusText(mutation)}
      </div>
    )
  ) : null;

  const resourceFeedback = (
    <>
      {loading && (
        <div role="status" aria-label="Action registry loading">
          <LoadingState message={snapshot ? 'Refreshing action registry…' : 'Loading action registry…'} />
        </div>
      )}
      {error && (
        <div role="alert">
          <ErrorState error={snapshot
            ? 'Could not refresh action registry. Showing previously loaded action registry; it may be stale.'
            : 'Could not load action registry.'} />
        </div>
      )}
      <button
        type="button"
        onClick={() => void fetchData()}
        disabled={loading || mutationLocked}
        className="mb-4 px-3 py-1 text-xs rounded-md bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-50"
      >
        {error ? 'Retry' : 'Refresh'}
      </button>
    </>
  );

  return (
    <PageTransition>
      <div className="flex items-start justify-between gap-4 mb-6">
        <SectionHeader
          title="Action Registry"
          subtitle="cross-project work queue"
          count={summary?.active}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-expanded={doneOpen}
            onClick={() => setDoneOpen((value) => !value)}
            className="px-4 py-2 text-xs font-mono uppercase tracking-wider rounded-lg border border-white/20 text-bone-dim hover:bg-white/10 transition-colors"
          >
            {doneOpen ? 'Hide done actions' : 'Show done actions'}
          </button>
          <button
            type="button"
            onClick={() => void handleMutation('sync')}
            disabled={mutationLocked}
            className="px-4 py-2 text-xs font-mono uppercase tracking-wider rounded-lg border border-royal/40 text-royal-light hover:bg-royal/10 transition-colors disabled:opacity-50"
          >
            {mutation?.kind === 'sync' && mutation.phase === 'writing' ? 'Syncing…' : 'Sync Adapters'}
          </button>
        </div>
      </div>

      {mutationFeedback}
      {resourceFeedback}
      <div className="mb-6">
        <ActionAlertLedger state={alertState} onRefresh={() => void fetchAlerts()} />
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-6">
          <MetricBlock label="Active" value={summary.active} tone="cyan" />
          <MetricBlock label="Blocked" value={summary.blocked} tone="amber" />
          <MetricBlock label="Done" value={summary.done} tone="success" />
          <MetricBlock label="Approvals" value={summary.pending_approvals} tone="royal" />
          <MetricBlock label="Escalated" value={summary.escalated} tone="amber" />
          <MetricBlock label="Alerts" value={summary.alerts} tone="bone" />
        </div>
      )}

      {snapshot && (
        <div className="grid gap-6 xl:grid-cols-2">
          <section>
            <h3 className="text-sm font-semibold text-bone mb-3">Active</h3>
            {active.length === 0 ? (
              <GlassCard className="text-center py-10">
                <p className="text-bone-dim text-sm font-mono">No active actions</p>
              </GlassCard>
            ) : (
              <AnimatedList>
                {active.map((action) => (
                  <ActionCard
                    key={action.id}
                    action={action}
                    bucket="active"
                    disabled={mutationLocked}
                    onApprove={(id) => void handleMutation('approve', id)}
                    onWaive={(id) => void handleMutation('waive', id)}
                    onDispatch={(id) => void handleMutation('dispatch', id)}
                  />
                ))}
              </AnimatedList>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-bone mb-3">Blocked</h3>
            {blocked.length === 0 ? (
              <GlassCard className="text-center py-10">
                <p className="text-bone-dim text-sm font-mono">No blocked actions</p>
              </GlassCard>
            ) : (
              <AnimatedList>
                {blocked.map((action) => (
                  <ActionCard
                    key={action.id}
                    action={action}
                    bucket="blocked"
                    disabled={mutationLocked}
                    onApprove={(id) => void handleMutation('approve', id)}
                    onWaive={(id) => void handleMutation('waive', id)}
                    onDispatch={(id) => void handleMutation('dispatch', id)}
                  />
                ))}
              </AnimatedList>
            )}
          </section>
        </div>
      )}

      {doneOpen && (
        <section className="mt-6">
          <h3 className="text-sm font-semibold text-bone mb-3">Done</h3>
          {doneLoading && <LoadingState message="Loading done actions…" />}
          {doneError && !doneLoading && (
            <div role="alert">
              <ErrorState error="Could not load done actions from the native authority." />
              <button
                type="button"
                onClick={() => setDoneRetry((value) => value + 1)}
                className="mt-2 px-3 py-1 text-xs rounded-md bg-white/5 hover:bg-white/10 transition-colors"
              >
                Retry done
              </button>
            </div>
          )}
          {!doneLoading && !doneError && doneActions !== null && doneActions.length === 0 && (
            <GlassCard className="text-center py-10">
              <p className="text-bone-dim text-sm font-mono">No done actions</p>
            </GlassCard>
          )}
          {!doneLoading && !doneError && doneActions !== null && doneActions.length > 0 && (
            <AnimatedList>
              {doneActions.map((action) => (
                <ActionCard
                  key={action.id}
                  action={action}
                  bucket="done"
                  disabled
                  onApprove={() => {}}
                  onWaive={() => {}}
                  onDispatch={() => {}}
                />
              ))}
            </AnimatedList>
          )}
        </section>
      )}
    </PageTransition>
  );
}

function ActionCard({
  action,
  bucket,
  disabled,
  onApprove,
  onWaive,
  onDispatch,
}: {
  action: RegistryAction;
  bucket: 'active' | 'blocked' | 'done';
  disabled: boolean;
  onApprove: (id: string) => void;
  onWaive: (id: string) => void;
  onDispatch: (id: string) => void;
}) {
  const canDispatch = bucket === 'active' &&
    (action.status === 'open' || action.status === 'in_progress') &&
    (!action.approval_required || action.approval_status === 'approved' || action.approval_status === 'waived');

  return (
    <motion.div layout>
      <GlassCard glowOnHover className="!p-4">
        <div className="flex items-start gap-3">
          <StatusDot ok={action.status === 'open'} warn={action.status === 'in_progress' || action.status === 'blocked'} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <Pill variant={priorityVariant(action.priority) as 'error' | 'warning' | 'info' | 'default'}>{action.priority}</Pill>
              <Pill variant={riskVariant(action.risk_level) as 'error' | 'warning' | 'success' | 'default'}>{action.risk_level}</Pill>
              <Pill>{action.project}</Pill>
              {action.approval_required && (
                <Pill variant={action.approval_status === 'approved' ? 'success' : action.approval_status === 'waived' ? 'default' : 'warning'}>
                  {action.approval_status === 'approved' ? 'approved' : action.approval_status === 'waived' ? 'waived' : 'needs approval'}
                </Pill>
              )}
              {action.escalated && <Pill variant="error">escalated</Pill>}
            </div>
            <h4 className="text-sm font-semibold text-bone mb-1">{action.title}</h4>
            <p className="text-xs text-bone-muted leading-relaxed">{action.description}</p>
            <div className="text-[10px] font-mono text-bone-faint mt-2 flex flex-wrap gap-3">
              <span>{action.source_system} / {action.source_area}</span>
              {action.next_due && <span>due {action.next_due}</span>}
              <span>updated {action.updated_at}</span>
            </div>
            {action.escalation_note && (
              <p className="text-[11px] text-amber-200/80 mt-2 font-mono">{action.escalation_note}</p>
            )}
            {bucket !== 'done' && action.approval_required && action.approval_status !== 'approved' && action.approval_status !== 'waived' && (
              <div className="flex items-center gap-2 mt-3">
                <button
                  type="button"
                  aria-label={`Approve ${action.title}`}
                  disabled={disabled}
                  onClick={() => onApprove(action.id)}
                  className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider rounded border border-success/30 bg-success/5 text-success-light hover:bg-success/15 transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ✓ Approve
                </button>
                <button
                  type="button"
                  aria-label={`Waive ${action.title}`}
                  disabled={disabled}
                  onClick={() => onWaive(action.id)}
                  className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider rounded border border-iron/30 bg-iron/5 text-bone-dim hover:bg-iron/15 transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Waive
                </button>
              </div>
            )}
            {canDispatch && (
              <div className="flex items-center gap-2 mt-3">
                <button
                  type="button"
                  aria-label={`Dispatch ${action.title}`}
                  disabled={disabled}
                  onClick={() => onDispatch(action.id)}
                  className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider rounded border border-cyan-neon/30 bg-cyan-neon/5 text-cyan-glow hover:bg-cyan-neon/15 transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ▶ Dispatch
                </button>
              </div>
            )}
            <ActionNativeReceipts actionId={action.id} />
          </div>
        </div>
      </GlassCard>
    </motion.div>
  );
}