import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
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

export default function ActionRegistryView() {
  const [summary, setSummary] = useState<ActionRegistrySummary | null>(null);
  const [active, setActive] = useState<RegistryAction[]>([]);
  const [blocked, setBlocked] = useState<RegistryAction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const { success, error: toastError } = useToast();

  const fetchData = useCallback(async () => {
    try {
      const [summaryData, activeData, blockedData] = await Promise.all([
        invoke<ActionRegistrySummary>('get_action_registry_summary'),
        invoke<ActionRegistryBucket>('get_action_registry_bucket', { bucket: 'active' }),
        invoke<ActionRegistryBucket>('get_action_registry_bucket', { bucket: 'blocked' }),
      ]);
      setSummary(summaryData);
      setActive(activeData.actions);
      setBlocked(blockedData.actions);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await invoke('sync_action_registry');
      success('Action registry synced from live adapters.', 'Registry Synced');
      await fetchData();
    } catch (e) {
      toastError(`Sync failed: ${e}`, 'Registry Sync Error');
    } finally {
      setSyncing(false);
    }
  };

  const handleUpdateApproval = async (id: string, status: 'approved' | 'waived') => {
    try {
      await invoke('update_action_approval', { actionId: id, status });
      success(`Action ${status === 'approved' ? 'approved' : 'waived'} successfully.`, 'Action Updated');
      await fetchData();
    } catch (e) {
      toastError(`Failed to update action: ${e}`, 'Update Error');
    }
  };

  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

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
          onClick={() => void handleSync()}
          disabled={syncing}
          className="px-4 py-2 text-xs font-mono uppercase tracking-wider rounded-lg border border-royal/40 text-royal-light hover:bg-royal/10 transition-colors disabled:opacity-50"
        >
          {syncing ? 'Syncing…' : 'Sync Adapters'}
        </button>
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
                  onApprove={(id) => void handleUpdateApproval(id, 'approved')}
                  onWaive={(id) => void handleUpdateApproval(id, 'waived')}
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
                  onApprove={(id) => void handleUpdateApproval(id, 'approved')}
                  onWaive={(id) => void handleUpdateApproval(id, 'waived')}
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
  onApprove,
  onWaive,
}: {
  action: RegistryAction;
  onApprove: (id: string) => void;
  onWaive: (id: string) => void;
}) {
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
            {action.approval_required && action.approval_status !== 'approved' && action.approval_status !== 'waived' && (
              <div className="flex items-center gap-2 mt-3">
                <button
                  type="button"
                  onClick={() => onApprove(action.id)}
                  className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider rounded border border-success/30 bg-success/5 text-success-light hover:bg-success/15 transition-all duration-150 cursor-pointer"
                >
                  ✓ Approve
                </button>
                <button
                  type="button"
                  onClick={() => onWaive(action.id)}
                  className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider rounded border border-iron/30 bg-iron/5 text-bone-dim hover:bg-iron/15 transition-all duration-150 cursor-pointer"
                >
                  Waive
                </button>
              </div>
            )}
          </div>
        </div>
      </GlassCard>
    </motion.div>
  );
}