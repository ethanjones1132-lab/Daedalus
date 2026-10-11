import { X } from 'lucide-react';
import { IconButton, Panel } from '../../design';
import { getMemoryTier, type MemoryEntry } from '../../domain/memory-recall-state';
import { displayValue, fmtConfidence, safeMessageIds, safeTags } from './memory-format';

export function MemoryDetail({ memory, regionId, onClose }: { memory: MemoryEntry; regionId: string; onClose: () => void }) {
  const items: Array<[string, string]> = [
    ['ID', displayValue(memory.id)],
    ['Source', displayValue(memory.source)],
    ['Agent', displayValue(memory.agent_id)],
    ['Source Session', displayValue(memory.source_session_id)],
    ['Source message IDs', safeMessageIds(memory.source_message_ids).join(', ') || 'Not supplied'],
    ['Category', displayValue(memory.category)],
    ['Status', displayValue(memory.status)],
    ['Tier', getMemoryTier(memory) ?? 'Not supplied'],
    ['Tags', safeTags(memory.tags).join(', ') || 'Not supplied'],
    ['Created', displayValue(memory.created_at)],
    ['Updated', displayValue(memory.updated_at)],
    ['Last used', displayValue(memory.last_used_at)],
    ['Expires', displayValue(memory.expires_at)],
    ['Review after', displayValue(memory.review_after)],
    ['Supersedes', displayValue(memory.supersedes_id)],
    ['Usage count', displayValue(memory.usage_count)],
    ['Confidence', fmtConfidence(memory.confidence)],
  ];
  return (
    <Panel
      ticks
      as="section"
      role="region"
      id={regionId}
      aria-label={`Memory details: ${memory.title || memory.id}`}
      className="d-rise flex max-h-[calc(100vh-7rem)] flex-col gap-4 overflow-y-auto"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="d-label text-accent">Full memory</span>
          <h3 className="d-display mt-1 break-words text-[22px] leading-tight text-ink">{memory.title || memory.id}</h3>
        </div>
        <IconButton aria-label="Close" onClick={onClose} className="-mr-1.5 -mt-1">
          <X aria-hidden="true" />
        </IconButton>
      </div>
      <p
        aria-label="Full memory content"
        className="whitespace-pre-wrap break-words rounded-lg border border-line bg-sunken p-3.5 text-[13.5px] leading-relaxed text-ink"
      >
        {displayValue(memory.content)}
      </p>
      <div>
        <h4 className="d-label mb-2">Provenance</h4>
        <dl aria-label="Memory provenance" className="grid grid-cols-1 gap-x-5 gap-y-2.5 text-[12.5px] sm:grid-cols-2">
          {items.map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">{key}</dt>
              <dd className="break-words text-ink-2">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Panel>
  );
}
