import { Pencil, Power, Trash2 } from 'lucide-react';
import type { Agent, AgentOperation, AgentOperationAction } from '../../domain/agent-operation-state';
import { AlertLine, Chip, cn, IconButton, StatusDot, StatusLine } from '../../design';
import { Monogram } from './Monogram';

/*
 * One native Agent in the roster. The title button is the select control and
 * stretches over the row; the row actions are its siblings (never nested) and
 * sit above it. Every action is fenced while the row has an operation in
 * flight; a failed operation unlocks it so Retry can repeat the same write.
 */
export function AgentRow({
  agent,
  operation,
  selected,
  listLoading,
  onSelect,
  onToggle,
  onEdit,
  onDelete,
  onRetryMutation,
  onRetryRead,
}: {
  agent: Agent;
  operation: AgentOperation | undefined;
  selected: boolean;
  listLoading: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRetryMutation: (action: Exclude<AgentOperationAction, 'create'>) => void;
  onRetryRead: () => void;
}) {
  const locked = operation !== undefined;
  const rowOp = operation && operation.action !== 'edit' ? operation : undefined;
  return (
    <li className={cn('group relative px-4 py-3 transition-colors', selected ? 'bg-raised' : 'hover:bg-hover')}>
      {selected && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
      <div className="flex items-start gap-3">
        <Monogram name={agent.name} muted={!agent.enabled} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 truncate text-[13.5px] font-medium text-ink">
              <button
                type="button"
                onClick={onSelect}
                aria-current={selected ? 'true' : undefined}
                className="max-w-full truncate rounded-sm text-left after:absolute after:inset-0 after:content-['']"
              >
                {agent.name}
              </button>
            </h3>
            <span className={cn('flex shrink-0 items-center gap-1.5 text-[11.5px]', agent.enabled ? 'text-ink-2' : 'text-ink-3')}>
              <StatusDot tone={agent.enabled ? 'ok' : 'warn'} />
              {agent.enabled ? 'enabled' : 'disabled'}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip>{agent.model}</Chip>
            {agent.backend && agent.backend !== 'jarvis' && <Chip className="text-info">{agent.backend}</Chip>}
          </div>
          {agent.description && <p className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-ink-3">{agent.description}</p>}
        </div>
        <div
          className={cn(
            'relative z-10 -mr-1 flex shrink-0 items-center gap-0.5 transition-opacity',
            selected ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
          )}
        >
          <IconButton size="xs" aria-label={agent.enabled ? 'Disable' : 'Enable'} title={agent.enabled ? 'Disable' : 'Enable'} onClick={onToggle} disabled={locked}>
            <Power aria-hidden="true" />
          </IconButton>
          <IconButton size="xs" aria-label="Edit" title="Edit" onClick={onEdit} disabled={locked}>
            <Pencil aria-hidden="true" />
          </IconButton>
          <IconButton size="xs" variant="danger" aria-label="Delete" title="Delete" onClick={onDelete} disabled={locked}>
            <Trash2 aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      {rowOp && (
        <div className="relative z-10 mt-2.5 pl-12">
          {rowOp.phase === 'writing' && <StatusLine>Saving agent change…</StatusLine>}
          {rowOp.phase === 'reconciling' && <StatusLine>Change saved. Reconciling agents…</StatusLine>}
          {rowOp.phase === 'write-failed' && (
            <AlertLine onRetry={() => onRetryMutation(rowOp.action as Exclude<AgentOperationAction, 'create'>)}>
              Agent change failed. Confirmed state was kept.
            </AlertLine>
          )}
          {rowOp.phase === 'read-failed' && (
            <AlertLine onRetry={onRetryRead} retryDisabled={listLoading}>
              Change saved, but the agent list could not be reconciled. Showing previous state. Retry reloads the list only.
            </AlertLine>
          )}
        </div>
      )}
    </li>
  );
}
