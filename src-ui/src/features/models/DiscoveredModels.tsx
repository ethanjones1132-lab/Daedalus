import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button, Chip, EmptyState, Panel, PanelHeader, RowList, SearchInput, formatCount } from '../../design';
import { backendLabel } from './backends';
import type { DiscoveredModel } from './types';

const PAGE = 40;

/** Models the Bun server can currently reach, each one a shortcut to a new profile. */
export function DiscoveredModels({
  models,
  onCreate,
  disabled,
}: {
  models: DiscoveredModel[];
  onCreate: (model: DiscoveredModel) => void;
  disabled: boolean;
}) {
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const q = filter.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? models.filter((m) => `${m.provider} ${m.name} ${m.id}`.toLowerCase().includes(q)) : models),
    [models, q],
  );
  const shown = matches.slice(0, limit);

  return (
    <Panel flush aria-label="Discovered models" className="d-rise">
      <div className="px-4 pt-4">
        <PanelHeader
          title="Discovered models"
          meta={models.length}
          description="Reachable through your Inference backends right now. Create a profile from one to keep it."
          actions={
            models.length > 8 ? (
              <SearchInput
                value={filter}
                onChange={(v) => {
                  setFilter(v);
                  setLimit(PAGE);
                }}
                clearLabel="Clear model filter"
                aria-label="Filter discovered models"
                placeholder="Filter models…"
                className="w-56"
              />
            ) : null
          }
        />
      </div>
      {models.length === 0 ? (
        <EmptyState compact title="No models discovered." description="No Inference backend reported a model. Check that the backend is running." />
      ) : matches.length === 0 ? (
        <EmptyState compact title={`No discovered models match "${filter}".`} />
      ) : (
        <RowList className="border-t border-line">
          {shown.map((m) => (
            <li key={`${m.provider}/${m.id}`} className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover">
              <Chip className="w-24 justify-center">{backendLabel(m.provider)}</Chip>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-ink">{m.name}</p>
                <p className="truncate font-mono text-[11px] text-ink-3">
                  {m.id}
                  {typeof m.context_length === 'number' ? ` · ${formatCount(m.context_length)} ctx` : ''}
                </p>
              </div>
              <Button
                variant="ghost"
                size="xs"
                icon={<Plus />}
                disabled={disabled}
                aria-label={`Create profile from this model, ${m.provider}/${m.name}`}
                onClick={() => onCreate(m)}
                className="opacity-70 group-hover:opacity-100 focus-visible:opacity-100"
              >
                Create profile from this
              </Button>
            </li>
          ))}
        </RowList>
      )}
      {matches.length > shown.length && (
        <div className="border-t border-line px-4 py-2.5">
          <Button variant="quiet" size="xs" onClick={() => setLimit((n) => n + PAGE)}>
            Show {Math.min(PAGE, matches.length - shown.length)} more of {matches.length - shown.length} remaining
          </Button>
        </div>
      )}
    </Panel>
  );
}
