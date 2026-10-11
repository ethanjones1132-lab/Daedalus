import type { LifecycleAgent } from '../../domain/agent-discovery-state';
import {
  canActivateLifecycle,
  canDeactivateLifecycle,
  effectiveLifecycleState,
  type AgentProjection,
} from '../../domain/agent-lifecycle-state';
import { AlertLine, Badge, Button, cn, StatusLine } from '../../design';
import { directoryStations } from './lifecycle-stations';
import { MiniTrack } from './LifecycleTrack';
import { Monogram } from './Monogram';
import type { LifecycleOperation } from './types';

/*
 * One discovered Agent directory. Activate / Deactivate act on the Agent
 * lifecycle; a changed source keeps the previous projection (marked as such)
 * until it is explicitly re-activated at the Activation boundary.
 */
export function DirectoryRow({
  agent,
  projection,
  operation,
  projectionsError,
  selected,
  onSelect,
  onActivate,
  onDeactivate,
  onRetry,
}: {
  agent: LifecycleAgent;
  projection: AgentProjection | undefined;
  operation: LifecycleOperation | undefined;
  projectionsError: boolean;
  selected: boolean;
  onSelect: () => void;
  onActivate: () => void;
  onDeactivate: () => void;
  onRetry: () => void;
}) {
  const state = effectiveLifecycleState(agent, projection);
  const operationLocked = operation !== undefined && operation.phase !== 'write-failed';
  const canActivate = canActivateLifecycle(agent, projection) && !projectionsError && !operationLocked;
  const canDeactivate = canDeactivateLifecycle(agent, projection) && !projectionsError && !operationLocked;
  const title = agent.name ?? agent.slug;
  return (
    <li className={cn('group relative px-4 py-3 transition-colors', selected ? 'bg-raised' : 'hover:bg-hover')}>
      {selected && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
      <div className="flex items-start gap-3">
        <Monogram name={title} muted={state !== 'active'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 truncate text-[13.5px] font-medium text-ink">
              <button
                type="button"
                onClick={onSelect}
                aria-current={selected ? 'true' : undefined}
                className="max-w-full truncate rounded-sm text-left after:absolute after:inset-0 after:content-['']"
              >
                {title}
              </button>
            </h3>
            <Badge tone={agent.status === 'valid' ? 'ok' : agent.status === 'invalid' ? 'error' : 'neutral'}>{agent.status}</Badge>
            {projection && <Badge tone={projection.active ? 'accent' : 'muted'}>{projection.active ? 'active' : 'inactive'}</Badge>}
          </div>
          {agent.name && agent.name !== agent.slug && (
            <p className="mt-0.5 truncate font-mono text-[11px] text-ink-3">{agent.slug}</p>
          )}
          {state === 'stale' && <p className="mt-1.5 text-[12px] leading-snug text-warn">Source changed; previous projection is stale.</p>}
          {state === 'unavailable' && (
            <p className="mt-1.5 text-[12px] leading-snug text-ink-3">Activation unavailable until source provenance is observed.</p>
          )}
          <div className="relative z-10 mt-2.5 flex items-center justify-between gap-2">
            <MiniTrack stations={directoryStations(agent, projection, operation)} />
            <div className="flex items-center gap-1.5">
              {state !== 'active' && (
                <Button size="xs" variant="secondary" aria-label={`Activate agent ${agent.slug}`} onClick={onActivate} disabled={!canActivate}>
                  Activate
                </Button>
              )}
              <Button size="xs" variant="ghost" aria-label={`Deactivate agent ${agent.slug}`} onClick={onDeactivate} disabled={!canDeactivate}>
                Deactivate
              </Button>
            </div>
          </div>
        </div>
      </div>
      {operation && (
        <div className="relative z-10 mt-2.5 pl-12">
          {operation.phase === 'writing' && (
            <StatusLine>{operation.action === 'activate' ? 'Activating Agent…' : 'Deactivating Agent…'}</StatusLine>
          )}
          {operation.phase === 'reconciling' && <StatusLine>Change saved. Confirming Agent projection…</StatusLine>}
          {operation.phase === 'write-failed' && (
            <AlertLine onRetry={onRetry}>Agent {operation.action} failed. Confirmed lifecycle state was kept.</AlertLine>
          )}
          {operation.phase === 'read-failed' && (
            <AlertLine onRetry={onRetry} retryLabel={`Retry reconciliation for ${agent.slug}`}>
              Agent change was saved, but confirmation readback failed. Retry reloads both lifecycle sources only.
            </AlertLine>
          )}
        </div>
      )}
    </li>
  );
}
