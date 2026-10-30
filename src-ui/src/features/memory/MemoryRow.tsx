import type { Ref } from 'react';
import { Chip, cn, Meter } from '../../design';
import { getMemoryTier, type MemoryEntry } from '../../domain/memory-recall-state';
import { fmtConfidence, fmtDate, safeTags, type RecallMeta } from './memory-format';
import { INJECTION_BASIS, injectionLabel, type InjectionVerdict } from './memory-injectability';

export function MemoryRow({
  memory,
  selected,
  regionId,
  recall,
  injection = null,
  inspectRef,
  onSelect,
}: {
  memory: MemoryEntry;
  selected: boolean;
  regionId: string;
  recall: RecallMeta | null;
  /** Read-only admission verdict for a chosen Session scope; null when not observed. */
  injection?: InjectionVerdict | null;
  inspectRef: Ref<HTMLButtonElement>;
  onSelect: () => void;
}) {
  const tier = getMemoryTier(memory);
  const relevance = recall ? Math.round(Math.max(0, Math.min(1, recall.score)) * 100) : null;
  return (
    <li
      onClick={onSelect}
      className={cn(
        'relative flex cursor-pointer flex-col gap-1.5 px-4 py-3 transition-colors duration-150 hover:bg-hover',
        selected && 'bg-raised before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-accent',
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="min-w-0 text-[13.5px] font-medium text-ink">
          <button
            ref={inspectRef}
            type="button"
            aria-label={`Inspect memory: ${memory.title || memory.id}`}
            aria-expanded={selected}
            aria-pressed={selected}
            aria-controls={regionId}
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
            className="max-w-full cursor-pointer truncate rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
          >
            {memory.title || 'Untitled memory'}
          </button>
        </h4>
        <span className="shrink-0 font-mono text-[10.5px] text-ink-3">conf {fmtConfidence(memory.confidence)}</span>
      </div>
      <p className="line-clamp-2 text-[12.5px] leading-relaxed text-ink-2">{memory.content}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip mono={false}>{memory.category}</Chip>
        {safeTags(memory.tags)
          .slice(0, 3)
          .map((t) => (
            <Chip key={t} className="border-accent-line/60 bg-accent-wash text-accent-hot">
              #{t}
            </Chip>
          ))}
        {recall && recall.matched.length > 0 && (
          <span className="text-[11px] text-ink-3">
            matched <span className="font-mono text-ink-2">{recall.matched.join(', ')}</span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 font-mono text-[10.5px] text-ink-3">
          {injection && (
            <span
              role="status"
              aria-label={`Injectability: ${injectionLabel(injection)}`}
              title={INJECTION_BASIS}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[10px] tracking-[0.02em]',
                injection.admitted
                  ? 'border-ok/40 bg-ok-wash text-ok'
                  : 'border-line-strong bg-sunken text-ink-4',
              )}
            >
              {injectionLabel(injection)}
            </span>
          )}
          {relevance !== null && (
            <span className="flex items-center gap-2">
              <Meter className="w-16" tone="accent" value={relevance} label={`Relevance ${relevance}%`} />
              <span className="tabular text-ink-2">{relevance}%</span>
            </span>
          )}
          {tier && <span className="uppercase tracking-[0.08em]">{tier}</span>}
          <span>{fmtDate(memory.updated_at)}</span>
        </span>
      </div>
    </li>
  );
}
