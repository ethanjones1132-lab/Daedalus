import type { ReactNode } from 'react';
import { Chip, Panel, StatusLine, cn } from '../../design';
import type { RegistrySnapshotState } from '../../domain/action-registry-state';
import { Notice } from './Notice';
import { runtimeEntryLabel, type RuntimeEntry, type SkillCandidateDetail } from './skill-model';

function Feedback<S>({ label, state, onRetry }: { label: string; state: RegistrySnapshotState<S>; onRetry: () => void }) {
  return (
    <>
      {state.loading && <StatusLine>Loading {label}…</StatusLine>}
      {state.error && (
        <Notice tone="warn" onRetry={onRetry} retryDisabled={state.loading}>
          Could not load {label}. {state.snapshot !== null && 'Showing previous observations; they may be stale.'}
        </Notice>
      )}
      {state.loading && !state.error && state.snapshot !== null && (
        <p className="text-[12px] text-ink-3">Showing previous observations; they may be stale.</p>
      )}
    </>
  );
}

function Cell({ title, hint, children, className }: { title: string; hint: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn('flex min-w-0 flex-col gap-2 px-4 py-3', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        <span className="d-label">{hint}</span>
      </div>
      {children}
    </section>
  );
}

function NameList({ entries }: { entries: RuntimeEntry[] }) {
  return (
    <ul className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
      {entries.map((entry, index) => (
        <li key={`${runtimeEntryLabel(entry)}:${index}`}>
          <Chip className="max-w-[220px]">{runtimeEntryLabel(entry)}</Chip>
        </li>
      ))}
    </ul>
  );
}

/**
 * What the Bun server's Tool runtime currently reports. Each read is
 * independent of the native skill list, has its own pending / failed / stale
 * state and retries alone.
 */
export function ObservationStrip({
  runtimeSkills,
  runtimeTools,
  candidateState,
  onRetrySkills,
  onRetryTools,
  onRetryCandidates,
  candidateCurrent,
}: {
  runtimeSkills: RegistrySnapshotState<RuntimeEntry[]>;
  runtimeTools: RegistrySnapshotState<RuntimeEntry[]>;
  candidateState: RegistrySnapshotState<Record<string, SkillCandidateDetail>>;
  onRetrySkills: () => void;
  onRetryTools: () => void;
  onRetryCandidates: () => void;
  candidateCurrent: boolean;
}) {
  const candidates = candidateState.snapshot;
  return (
    <Panel flush className="mt-8 grid divide-y divide-line md:grid-cols-3 md:divide-x md:divide-y-0">
      <Cell title="Runtime skills" hint="Tool runtime">
        <Feedback label="runtime skills" state={runtimeSkills} onRetry={onRetrySkills} />
        {runtimeSkills.snapshot !== null &&
          (runtimeSkills.snapshot.length > 0 ? (
            <NameList entries={runtimeSkills.snapshot} />
          ) : (
            !runtimeSkills.loading && !runtimeSkills.error && <p className="text-[12px] text-ink-3">No runtime skills observed.</p>
          ))}
      </Cell>
      <Cell title="Runtime tools" hint="Tool runtime">
        <Feedback label="runtime tools" state={runtimeTools} onRetry={onRetryTools} />
        {runtimeTools.snapshot !== null &&
          (runtimeTools.snapshot.length > 0 ? (
            <NameList entries={runtimeTools.snapshot} />
          ) : (
            !runtimeTools.loading && !runtimeTools.error && <p className="text-[12px] text-ink-3">No runtime tools observed.</p>
          ))}
      </Cell>
      <Cell title="Skill candidates" hint="Bun server">
        <Feedback label="skill candidates" state={candidateState} onRetry={onRetryCandidates} />
        {candidates !== null &&
          (Object.keys(candidates).length > 0 ? (
            <p className="text-[12.5px] text-ink-2">{Object.keys(candidates).length} candidate observations</p>
          ) : (
            candidateCurrent && <p className="text-[12px] text-ink-3">No skill candidates observed.</p>
          ))}
      </Cell>
    </Panel>
  );
}
