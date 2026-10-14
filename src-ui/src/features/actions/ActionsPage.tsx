import { lazy, Suspense } from 'react';
import { FeatureModes } from '../workflows/FeatureModes';
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { RefreshCw, RefreshCcwDot } from 'lucide-react';
import {
  AlertLine,
  Button,
  Page,
  PageHeader,
  Panel,
  Skeleton,
  Stat,
  StatusLine,
  useToast,
} from '../../design';
import {
  initialRegistryState,
  parseActionRegistryAlerts,
  reduceRegistryState,
  type ActionRegistryAlert,
} from '../../domain/action-registry-state';
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
} from '../../domain/action-registry-mutation-state';
import { ActionCard, type RegistryAction, type RegistryBucketId } from './ActionCard';
import { AlertLedger } from './AlertLedger';

interface ActionRegistrySummary {
  active: number;
  blocked: number;
  done: number;
  pending_approvals: number;
  escalated: number;
  alerts: number;
}

interface ActionRegistryBucket {
  bucket: string;
  actions: RegistryAction[];
}

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

const BOARD_GRID = 'grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_260px]';

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

function ActionsPage() {
  const [state, dispatch] = useReducer(reduceRegistryState<RegistrySnapshot>, initialRegistryState<RegistrySnapshot>());
  const [alertState, dispatchAlerts] = useReducer(
    reduceRegistryState<ActionRegistryAlert[]>,
    initialRegistryState<ActionRegistryAlert[]>(),
  );
  const requestId = useRef(0);
  const alertRequestId = useRef(0);
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
      <AlertLine label="Action registry mutation" tone="warn" onRetry={retryMutation}>
        {DISPATCH_UNAVAILABLE_MESSAGE}
      </AlertLine>
    ) : mutation.phase === 'write-failed' ? (
      <AlertLine label="Action registry mutation" onRetry={retryMutation}>
        {mutationFailureText(mutation)}
      </AlertLine>
    ) : mutation.phase === 'read-failed' ? (
      <AlertLine label="Action registry mutation" onRetry={retryMutation}>
        {mutationReadFailureText(mutation)}
      </AlertLine>
    ) : (
      <StatusLine label="Action registry mutation">{mutationStatusText(mutation)}</StatusLine>
    )
  ) : null;

  const onApprove = useCallback((id: string) => void handleMutation('approve', id), [handleMutation]);
  const onWaive = useCallback((id: string) => void handleMutation('waive', id), [handleMutation]);
  const onDispatch = useCallback((id: string) => void handleMutation('dispatch', id), [handleMutation]);

  const syncing = mutation?.kind === 'sync' && mutation.phase === 'writing';

  return (
    <Page wide>
      <PageHeader
        eyebrow="Automate"
        title="Actions"
        description="The Action Registry: a cross-project work queue synced from live adapters. An action that needs approval is held until you approve or waive it; only then can it be dispatched."
        actions={
          <>
            <Button
              variant="ghost"
              icon={<RefreshCw aria-hidden="true" />}
              onClick={() => void fetchData()}
              disabled={loading || mutationLocked}
            >
              {error ? 'Retry' : 'Refresh'}
            </Button>
            <Button
              variant="primary"
              icon={<RefreshCcwDot aria-hidden="true" />}
              busy={syncing}
              onClick={() => void handleMutation('sync')}
              disabled={mutationLocked}
            >
              {syncing ? 'Syncing…' : 'Sync Adapters'}
            </Button>
          </>
        }
      />

      <div className="mb-5 space-y-2.5 empty:hidden">
        {mutationFeedback}
        {loading && (
          <StatusLine label="Action registry loading">
            {snapshot ? 'Refreshing action registry…' : 'Loading action registry…'}
          </StatusLine>
        )}
        {error && (
          <AlertLine>
            {snapshot
              ? 'Could not refresh action registry. Showing previously loaded action registry; it may be stale.'
              : 'Could not load action registry.'}
          </AlertLine>
        )}
      </div>

      <div className="mb-6">
        <AlertLedger state={alertState} onRefresh={() => void fetchAlerts()} />
      </div>

      {snapshot && summary ? (
        <div className={`d-rise ${BOARD_GRID}`}>
          <BucketColumn
            id="active"
            title="Active"
            count={summary.active}
            hint="Open or in progress"
            actions={active}
            emptyText="No active actions"
            disabled={mutationLocked}
            onApprove={onApprove}
            onWaive={onWaive}
            onDispatch={onDispatch}
          />
          <BucketColumn
            id="blocked"
            title="Blocked"
            count={summary.blocked}
            hint="Waiting on something else"
            actions={blocked}
            emptyText="No blocked actions"
            disabled={mutationLocked}
            onApprove={onApprove}
            onWaive={onWaive}
            onDispatch={onDispatch}
          />
          <RegistryTallies summary={summary} />
        </div>
      ) : (
        !error && <BoardSkeleton />
      )}
    </Page>
  );
}

function BucketColumn({
  id,
  title,
  count,
  hint,
  actions,
  emptyText,
  disabled,
  onApprove,
  onWaive,
  onDispatch,
}: {
  id: RegistryBucketId;
  title: string;
  count: number;
  hint: string;
  actions: RegistryAction[];
  emptyText: string;
  disabled: boolean;
  onApprove: (id: string) => void;
  onWaive: (id: string) => void;
  onDispatch: (id: string) => void;
}) {
  return (
    <section aria-label={`${title} actions`} className="min-w-0">
      <header className="mb-3 flex items-end justify-between gap-3 border-b border-line pb-3">
        <div>
          <h3 className="d-label">{title}</h3>
          <p className="mt-1 text-[12px] text-ink-3">{hint}</p>
        </div>
        <span className="d-display tabular text-[40px] leading-none text-ink">{count}</span>
      </header>
      {actions.length === 0 ? (
        <Panel className="flex items-center justify-center border-dashed py-10 shadow-none">
          <p className="text-[12.5px] text-ink-3">{emptyText}</p>
        </Panel>
      ) : (
        <ul className="space-y-2.5">
          {actions.map((action) => (
            <ActionCard
              key={action.id}
              action={action}
              bucket={id}
              disabled={disabled}
              onApprove={onApprove}
              onWaive={onWaive}
              onDispatch={onDispatch}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The other registry buckets are counted by the summary but not listed on this board. */
function RegistryTallies({ summary }: { summary: ActionRegistrySummary }) {
  return (
    <aside aria-label="Registry tallies" className="min-w-0">
      <header className="mb-3 min-h-[61px] border-b border-line pb-3">
        <h3 className="d-label">Registry</h3>
        <p className="mt-1 text-[12px] text-ink-3">Counts from the registry summary</p>
      </header>
      <Panel className="space-y-5">
        <Stat
          label="Pending approvals"
          value={summary.pending_approvals}
          sub="held until approved or waived"
          tone={summary.pending_approvals > 0 ? 'warn' : undefined}
        />
        <Stat
          label="Escalated"
          value={summary.escalated}
          sub="flagged on their cards"
          tone={summary.escalated > 0 ? 'error' : undefined}
        />
        <Stat label="Done" value={summary.done} sub="completed, not listed here" tone={summary.done > 0 ? 'ok' : undefined} />
        <Stat label="Alerts" value={summary.alerts} sub="see the alert ledger above" />
      </Panel>
    </aside>
  );
}

function BoardSkeleton() {
  return (
    <div aria-hidden="true" className={BOARD_GRID}>
      {[0, 1].map((col) => (
        <div key={col} className="space-y-2.5">
          <Skeleton className="mb-4 h-10 w-full" />
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-[10px]" />
          ))}
        </div>
      ))}
      <Skeleton className="h-64 w-full rounded-[10px]" />
    </div>
  );
}

const AdvancedActionsPage = lazy(() => import('./TrustedActionsPage'));
export default function ActionsPageSurface() { return <FeatureModes label="Trusted receipts" primary={<ActionsPage />} advanced={<Suspense fallback={<div role="status">Loading controls…</div>}><AdvancedActionsPage /></Suspense>} />; }
