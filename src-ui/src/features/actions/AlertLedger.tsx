import { RefreshCw } from 'lucide-react';
import { Badge, Button, Panel, StatusLine, AlertLine, type Tone } from '../../design';
import type { ActionRegistryAlert, RegistrySnapshotState } from '../../domain/action-registry-state';

function severityTone(severity: string): Tone {
  if (severity === 'high' || severity === 'critical') return 'error';
  if (severity === 'medium') return 'warn';
  if (severity === 'low') return 'ok';
  return 'neutral';
}

function alertValue(value: string | number | null | undefined): string {
  return value === undefined || value === null || value === '' ? 'Not supplied' : String(value);
}

/**
 * Persisted Action Registry alerts. Read independently of the action buckets:
 * an alert failure never hides actions and an action failure never hides alerts.
 */
export function AlertLedger({
  state,
  onRefresh,
}: {
  state: RegistrySnapshotState<ActionRegistryAlert[]>;
  onRefresh: () => void;
}) {
  const { snapshot, loading, error } = state;
  const stale = snapshot !== null && (loading || error);

  return (
    <Panel as="section" role="region" aria-label="Action registry alerts" flush>
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold text-ink">Alert ledger</h3>
            {snapshot !== null && (
              <span className="font-mono text-[11px] tabular text-ink-3">{snapshot.length}</span>
            )}
            {stale && <Badge tone="warn" size="xs">stale</Badge>}
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
            Persisted Action Registry alerts; this ledger is independent of action bucket loading.
          </p>
        </div>
        <Button
          variant="ghost"
          size="xs"
          icon={<RefreshCw aria-hidden="true" />}
          onClick={onRefresh}
          disabled={loading}
        >
          {error ? 'Retry alerts' : 'Refresh alerts'}
        </Button>
      </div>

      <div className="space-y-2 px-4 pt-2">
        {loading && (
          <StatusLine label="Action registry alerts loading">
            {snapshot ? 'Refreshing Action Registry alerts…' : 'Loading Action Registry alerts…'}
          </StatusLine>
        )}
        {error && (
          <AlertLine label="Action registry alerts error">
            {snapshot
              ? 'Could not refresh Action Registry alerts. Showing previously loaded alerts; they may be stale.'
              : 'Could not load Action Registry alerts.'}
          </AlertLine>
        )}
      </div>

      {snapshot !== null && snapshot.length > 0 ? (
        <ul
          aria-label="Action Registry alert entries"
          className="mt-3 grid gap-px overflow-hidden rounded-b-[10px] border-t border-line bg-line md:grid-cols-2 xl:grid-cols-4"
        >
          {snapshot.map((alert, index) => (
            <li key={`${alert.id}-${index}`} className="flex min-w-0 flex-col bg-surface px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
                <span className="inline-flex items-center gap-1.5">
                  severity: <Badge tone={severityTone(alert.severity)} size="xs">{alert.severity}</Badge>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  kind: <Badge tone="neutral" size="xs">{alert.kind}</Badge>
                </span>
              </div>
              <h4 className="mt-2 text-[13px] font-medium leading-snug text-ink">{alert.title}</h4>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{alert.message}</p>
              <div className="mt-auto flex flex-wrap gap-x-3 gap-y-0.5 pt-2.5 font-mono text-[10px] leading-snug text-ink-4">
                <span>alert_id: {alertValue(alert.id)}</span>
                <span>action_id: {alertValue(alert.action_id)}</span>
                <span>count: {alertValue(alert.count)}</span>
                <span>created_at: {alertValue(alert.created_at)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : snapshot?.length === 0 && !loading && !error ? (
        <p className="px-4 pb-4 pt-2 text-[12.5px] text-ink-3">No Action Registry alerts.</p>
      ) : (
        <div className="h-3.5" />
      )}
    </Panel>
  );
}
