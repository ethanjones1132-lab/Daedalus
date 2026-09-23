import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { initialRegistryState, reduceRegistryState } from './action-registry-state';
import {
  registryMutationConfirmed,
  registryMutationLocked,
  startRegistryMutation,
  transitionRegistryMutation,
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

interface ActionRegistrySummary {
  active: number;
  blocked: number;
  done: number;
  pending_approvals: number;
  escalated: number;
  alerts: number;
}

interface ExecutionEvidence {
  run_id: string;
  status: string;
  acceptance_result?: string;
  error_code?: string;
  started_at?: string;
  finished_at?: string;
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
  execution_evidence?: ExecutionEvidence;
  updated_at: string;
}

interface ActionRegistryBucket {
  bucket: string;
  actions: RegistryAction[];
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

function mutationStatusText(mutation: RegistryMutation): string {
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
  if (mutation.kind === 'sync') return 'Action registry sync was saved, but the confirmed snapshot could not be reconciled. Showing the previous snapshot; it may be stale.';
  return 'The action registry write was saved, but the confirmed snapshot could not be reconciled. Showing the previous snapshot; it may be stale.';
}

function mutationSuccessText(mutation: RegistryMutation): string {
  if (mutation.kind === 'sync') return 'Action registry synced from live adapters.';
  if (mutation.kind === 'approve') return 'Action approved successfully.';
  if (mutation.kind === 'waive') return 'Action waived successfully.';
  return 'Action dispatched and verified.';
}

export default function ActionRegistryView() {
  const [state, dispatch] = useReducer(reduceRegistryState<RegistrySnapshot>, initialRegistryState<RegistrySnapshot>());
  const requestId = useRef(0);
  const mutationRef = useRef<RegistryMutation | null>(null);
  const [mutation, setMutation] = useState<RegistryMutation | null>(null);
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

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const reconcileMutation = useCallback(async (operation: RegistryMutation) => {
    const result = await readSnapshot({ duringMutation: true, suppressError: true });
    if (result.status !== 'success') {
      const next = transitionRegistryMutation(operation, 'read-failed');
      if (next) publishMutation(next);
      return;
    }
    if (!registryMutationConfirmed(operation, result.snapshot)) {
      dispatch({ type: 'invalidate', requestId: result.requestId });
      publishMutation(transitionRegistryMutation(operation, 'read-failed'));
      return;
    }
    dispatch({ type: 'success', requestId: result.requestId, snapshot: result.snapshot });
    publishMutation(null);
    success(mutationSuccessText(operation), operation.kind === 'sync' ? 'Registry Synced' : 'Action Updated');
  }, [publishMutation, readSnapshot, success]);

  const handleMutation = useCallback(async (kind: RegistryMutationKind, id?: string) => {
    if (registryMutationLocked(mutationRef.current)) return;
    if (kind !== 'sync' && id === undefined) return;
    if (kind === 'dispatch' && !active.some(action => action.id === id)) return;
    const operation = startRegistryMutation(kind, id);
    publishMutation(operation);
    const invalidationId = ++requestId.current;
    dispatch({ type: 'invalidate', requestId: invalidationId });
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
      }
    } catch {
      publishMutation(transitionRegistryMutation(operation, 'write-failed'));
      return;
    }
    const reconciling = transitionRegistryMutation(operation, 'write-succeeded');
    if (reconciling) {
      publishMutation(reconciling);
      await reconcileMutation(reconciling);
    }
  }, [active, publishMutation, reconcileMutation]);

  const retryMutation = useCallback(() => {
    const operation = mutationRef.current;
    if (!operation) return;
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
    mutation.phase === 'write-failed' ? (
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

  if (!snapshot) return <PageTransition>{resourceFeedback}</PageTransition>;

  return (
    <PageTransition>
      <div className="flex items-start justify-between gap-4 mb-6">
        <SectionHeader
          title="Action Registry"
          subtitle="cross-project work queue"
          count={summary?.active ?? 0}
        />
        <button
          type="button"
          onClick={() => void handleMutation('sync')}
          disabled={mutationLocked}
          className="px-4 py-2 text-xs font-mono uppercase tracking-wider rounded-lg border border-royal/40 text-royal-light hover:bg-royal/10 transition-colors disabled:opacity-50"
        >
          {mutation?.kind === 'sync' && mutation.phase === 'writing' ? 'Syncing…' : 'Sync Adapters'}
        </button>
      </div>

      {mutationFeedback}
      {resourceFeedback}

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
  bucket: 'active' | 'blocked';
  disabled: boolean;
  onApprove: (id: string) => void;
  onWaive: (id: string) => void;
  onDispatch: (id: string) => void;
}) {
  const canDispatch = bucket === 'active' && action.status !== 'done' &&
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
              {action.execution_evidence && (
                <Pill variant={action.execution_evidence.status === 'verified' ? 'success' : 'warning'}>
                  {action.execution_evidence.status}
                </Pill>
              )}
            </div>
            <h4 className="text-sm font-semibold text-bone mb-1">{action.title}</h4>
            <p className="text-xs text-bone-muted leading-relaxed">{action.description}</p>
            <div className="text-[10px] font-mono text-bone-faint mt-2 flex flex-wrap gap-3">
              <span>{action.source_system} / {action.source_area}</span>
              {action.next_due && <span>due {action.next_due}</span>}
              <span>updated {action.updated_at}</span>
            </div>
            {action.execution_evidence?.acceptance_result && (
              <p className="text-[10px] font-mono text-bone-dim mt-2 line-clamp-2">
                {action.execution_evidence.acceptance_result}
              </p>
            )}
            {action.escalation_note && (
              <p className="text-[11px] text-amber-200/80 mt-2 font-mono">{action.escalation_note}</p>
            )}
            {action.approval_required && action.approval_status !== 'approved' && action.approval_status !== 'waived' && (
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
          </div>
        </div>
      </GlassCard>
    </motion.div>
  );
}