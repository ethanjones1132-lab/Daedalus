import { projectImprovementScore } from '../../lib/skill-score-reading';
import type { Ref } from 'react';
import { Badge, Chip, cn, Panel, StatusDot } from '../../design';
import type { SkillCandidateAction, SkillCandidateMutation } from '../../domain/skill-candidate-operation-state';
import { CandidateActions } from './CandidateActions';
import { Notice } from './Notice';
import { SkillToggle } from './SkillToggle';
import {
  candidateIdOf,
  formatDate,
  isDistilledSkill,
  REQUIREMENT_KINDS,
  skillMeta,
  type Skill,
  type SkillCandidateDetail,
  type SkillLifecycleView,
} from './skill-model';

/** Emoji in a hairline tile; a monogram when the skill declares none. */
export function SkillGlyph({ skill, size = 'md' }: { skill: Skill; size?: 'md' | 'lg' }) {
  const meta = skillMeta(skill);
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg border border-line-strong bg-sunken',
        size === 'md' ? 'size-9 text-[17px]' : 'size-11 text-[21px]',
      )}
    >
      {meta.emoji ?? <span className="d-display text-[19px] text-ink-3">{skill.name.replace(/^distilled-/, '').charAt(0).toUpperCase()}</span>}
    </span>
  );
}

/** Eligibility badge + the unmet requirements as mono chips (bins/env/config/os). */
export function Eligibility({ skill, chips = true }: { skill: Skill; chips?: boolean }) {
  const meta = skillMeta(skill);
  const missing = REQUIREMENT_KINDS.flatMap((kind) => (meta.missing[kind] ?? []).map((value) => ({ kind, value })));
  return (
    <>
      {meta.eligible === true && (
        <Badge tone="ok" dot>
          Ready
        </Badge>
      )}
      {meta.eligible === false && (
        <Badge tone="warn" dot>
          Needs setup
        </Badge>
      )}
      {chips && missing.length > 0 && (
        <ul aria-label="Missing requirements" className="flex basis-full flex-wrap gap-1">
          {missing.map(({ kind, value }) => (
            <li key={`${kind}:${value}`}>
              <Chip className="border-warn/30 text-[10.5px] text-warn" title={`Missing ${kind}`}>
                <span className="text-ink-4">{kind}</span>
                {value}
              </Chip>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function SkillCard({
  skill,
  selected,
  detailRegionId,
  inspectRef,
  onSelect,
  candidate,
  candidateCurrent,
  lifecycle,
  candidateMutation,
  candidateLocked,
  onCandidateAction,
  onRetryCandidate,
  onResync,
  togglePending,
  toggleError,
  onToggle,
}: {
  skill: Skill;
  selected: boolean;
  detailRegionId: string;
  inspectRef: Ref<HTMLButtonElement>;
  onSelect: () => void;
  candidate: SkillCandidateDetail | null;
  candidateCurrent: boolean;
  lifecycle: SkillLifecycleView;
  candidateMutation: SkillCandidateMutation | null;
  candidateLocked: boolean;
  onCandidateAction: (action: SkillCandidateAction) => void;
  onRetryCandidate: () => void;
  onResync: () => void;
  togglePending: boolean;
  toggleError: boolean;
  onToggle: () => void;
}) {
  const meta = skillMeta(skill);
  const distilled = isDistilledSkill(skill);
  const candidateId = candidateIdOf(skill);
  const improvement = projectImprovementScore(skill.improvement_score);
  const sourceLabel = distilled ? 'distilled' : (meta.source ?? null);

  return (
    <Panel
      as="li"
      interactive
      onClick={onSelect}
      className={cn(
        'group relative flex cursor-pointer flex-col gap-2.5 p-3.5',
        selected && 'border-accent-line bg-raised shadow-[0_0_0_1px_var(--d-accent-line)]',
      )}
    >
      <div className="flex items-start gap-3">
        <SkillGlyph skill={skill} />
        <div className="min-w-0 flex-1">
          <h3 className="flex min-w-0 items-center gap-2 text-[13.5px] font-semibold text-ink">
            <button
              type="button"
              ref={inspectRef}
              aria-label={`Inspect skill: ${skill.name}`}
              aria-pressed={selected}
              aria-controls={detailRegionId}
              onClick={(event) => {
                event.stopPropagation();
                onSelect();
              }}
              className="min-w-0 max-w-full cursor-pointer truncate rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
            >
              {skill.name}
            </button>
          </h3>
          {meta.category && (
            <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10.5px] text-ink-3">
              <StatusDot tone={skill.enabled ? 'ok' : 'muted'} />
              <span>{meta.category}</span>
            </div>
          )}
        </div>
        {distilled && candidateId ? (
          (candidate?.status === 'candidate' || candidate?.status === 'staged') && (
            <CandidateActions
              candidate={candidate}
              current={candidateCurrent}
              locked={candidateLocked}
              onAction={onCandidateAction}
              mode="compact"
            />
          )
        ) : (
          <SkillToggle enabled={skill.enabled} pending={togglePending} disabled={distilled} onToggle={onToggle} />
        )}
      </div>

      <p className="line-clamp-2 text-[12.5px] leading-relaxed text-ink-2">{skill.description}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        {sourceLabel && <Chip>{sourceLabel}</Chip>}
        <Eligibility skill={skill} />
        {distilled &&
          (lifecycle.verdict === 'known' ? (
            <Badge tone={lifecycle.status === 'promoted' ? 'ok' : lifecycle.status === 'rejected' ? 'error' : 'accent'} dot>
              {lifecycle.status}
            </Badge>
          ) : lifecycle.verdict === 'stale' ? (
            <span className="text-[11.5px] text-warn">{lifecycle.label}</span>
          ) : (
            <span className="flex flex-col items-start gap-0.5">
              <span
                role={lifecycle.verdict === 'pending' ? 'status' : undefined}
                className={lifecycle.verdict === 'pending' ? 'text-[11.5px] text-ink-3' : 'text-[11.5px] text-warn'}
              >
                {lifecycle.label}
              </span>
              {lifecycle.verdict === 'failed' && lifecycle.status !== null && (
                <span className="font-mono text-[10px] text-ink-3">
                  mirrored: {lifecycle.status} (may be stale)
                </span>
              )}
              {lifecycle.verdict === 'absent' && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onResync();
                  }}
                  className="text-[11px] underline underline-offset-2"
                >
                  Resync candidates
                </button>
              )}
            </span>
          ))}
      </div>

      {candidateMutation?.phase === 'write-failed' && candidateId && (
        <Notice label={`Candidate lifecycle: ${skill.name}`} onRetry={onRetryCandidate}>
          Could not update candidate lifecycle. Showing the last confirmed state.
        </Notice>
      )}
      {candidateMutation?.phase === 'read-failed' && candidateId && (
        <Notice label={`Candidate lifecycle: ${skill.name}`} tone="warn" onRetry={onRetryCandidate}>
          The lifecycle write completed, but its status could not be confirmed. Showing the last confirmed state.
        </Notice>
      )}
      {!distilled && toggleError && (
        <Notice onRetry={onToggle} retryDisabled={togglePending}>
          Could not update skill enablement. Showing last confirmed state: {skill.enabled ? 'enabled' : 'disabled'}.
        </Notice>
      )}

      <div className="mt-auto flex items-center gap-3 border-t border-line pt-2 font-mono text-[10.5px] text-ink-3">
        <span>v{skill.version}</span>
        {improvement.text && <span title={improvement.basis ?? undefined}>score {improvement.text}</span>}
        <span className="ml-auto">{formatDate(skill.updated_at)}</span>
      </div>
    </Panel>
  );
}
