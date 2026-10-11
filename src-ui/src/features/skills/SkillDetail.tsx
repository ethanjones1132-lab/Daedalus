import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RotateCcw, X } from 'lucide-react';
import {
  AlertLine,
  Badge,
  Chip,
  EmptyState,
  IconButton,
  Panel,
  StatusDot,
  StatusLine,
  Tabs,
  useToast,
  Button,
} from '../../design';
import type { SkillCandidateAction, SkillCandidateMutation } from '../../domain/skill-candidate-operation-state';
import { skillCandidateMutationLocked } from '../../domain/skill-candidate-operation-state';
import { CandidateActions } from './CandidateActions';
import { Eligibility, SkillGlyph } from './SkillCard';
import { Notice } from './Notice';
import { PerformanceReadout } from './PerformanceReadout';
import { SkillMarkdown } from './SkillMarkdown';
import { SkillToggle } from './SkillToggle';
import { useCandidatePerformance } from './skill-hooks';
import {
  formatDate,
  isDistilledSkill,
  REQUIREMENT_KINDS,
  skillMeta,
  type Skill,
  type SkillCandidateDetail,
  type SkillRevision,
} from './skill-model';

type DetailTab = 'body' | 'revisions';

function Requirements({ skill }: { skill: Skill }) {
  const meta = skillMeta(skill);
  const rows = REQUIREMENT_KINDS.map((kind) => ({
    kind,
    required: meta.requires[kind] ?? [],
    missing: new Set(meta.missing[kind] ?? []),
  })).filter((row) => row.required.length > 0 || row.missing.size > 0);
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-line bg-sunken/60 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="d-label">Requirements</span>
        <Eligibility skill={skill} chips={false} />
      </div>
      <dl className="grid grid-cols-[56px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        {rows.map((row) => {
          const all = Array.from(new Set([...row.required, ...row.missing]));
          return (
            <div key={row.kind} className="contents">
              <dt className="pt-0.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">{row.kind}</dt>
              <dd className="flex flex-wrap gap-1">
                {all.map((value) => (
                  <Chip
                    key={value}
                    className={row.missing.has(value) ? 'border-warn/30 text-warn' : undefined}
                    title={row.missing.has(value) ? 'Missing' : 'Satisfied'}
                  >
                    {value}
                  </Chip>
                ))}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

export function SkillDetail({
  skill,
  regionId,
  candidateDetail,
  candidateCurrent,
  candidateMutation,
  onCandidateAction,
  onRetryCandidate,
  onClose,
  onToggle,
  togglePending,
  toggleError,
  onChanged,
}: {
  skill: Skill;
  regionId: string;
  candidateDetail: SkillCandidateDetail | null;
  candidateCurrent: boolean;
  candidateMutation: SkillCandidateMutation | null;
  onCandidateAction: (action: SkillCandidateAction) => void;
  onRetryCandidate: () => void;
  onClose: () => void;
  onToggle: (skill: Skill) => void;
  togglePending: boolean;
  toggleError: boolean;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>('body');
  const [revisions, setRevisions] = useState<SkillRevision[] | null>(null);
  const [loadingRevs, setLoadingRevs] = useState(false);
  const [revError, setRevError] = useState<string | null>(null);
  const { success, error: toastError } = useToast();
  const distilled = isDistilledSkill(skill);
  const meta = skillMeta(skill);
  const candidateActionLocked = skillCandidateMutationLocked(candidateMutation);

  const performanceCandidateId = candidateDetail?.status === 'promoted' ? candidateDetail.id : null;
  const performance = useCandidatePerformance(performanceCandidateId);

  const loadRevisions = useCallback(async () => {
    setLoadingRevs(true);
    setRevError(null);
    try {
      const revs = await invoke<SkillRevision[]>('skill_revisions_list', {
        skillId: skill.id,
        limit: 50,
      });
      setRevisions(revs);
    } catch (e) {
      setRevError(String(e));
    } finally {
      setLoadingRevs(false);
    }
  }, [skill.id]);

  useEffect(() => {
    if (tab === 'revisions' && revisions === null) void loadRevisions();
  }, [tab, revisions, loadRevisions]);

  const restore = useCallback(
    async (rev: SkillRevision) => {
      try {
        await invoke<boolean>('skill_restore_revision', { revisionId: rev.id });
        success(`Restored ${skill.name} to v${rev.version}`, 'Revision restored');
        await loadRevisions();
        onChanged();
      } catch (e) {
        toastError(String(e), 'Restore failed');
      }
    },
    [skill.name, loadRevisions, onChanged, success, toastError],
  );

  return (
    <Panel
      as="section"
      ticks
      role="region"
      id={regionId}
      aria-label={`Skill details: ${skill.name}`}
      className="d-rise flex max-h-[calc(100vh-7rem)] min-h-0 flex-col gap-4 overflow-y-auto"
    >
      <div className="flex items-start gap-3">
        <SkillGlyph skill={skill} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot tone={skill.enabled ? 'ok' : 'muted'} />
            <h2 className="d-display min-w-0 truncate text-[24px] leading-tight text-ink">{skill.name}</h2>
            <Badge tone="neutral">v{skill.version}</Badge>
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{skill.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {meta.source && <Chip>{distilled ? 'distilled' : meta.source}</Chip>}
            {meta.category && meta.category !== (distilled ? 'distilled' : meta.source) && <Chip>{meta.category}</Chip>}
            <Eligibility skill={skill} chips={false} />
          </div>
        </div>
        <IconButton aria-label="Close" onClick={onClose} className="-mr-1.5 -mt-1">
          <X aria-hidden="true" />
        </IconButton>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {distilled ? (
          candidateDetail && (
            <CandidateActions
              candidate={candidateDetail}
              current={candidateCurrent}
              locked={candidateActionLocked}
              onAction={onCandidateAction}
              mode="full"
            />
          )
        ) : (
          <SkillToggle enabled={skill.enabled} pending={togglePending} onToggle={() => onToggle(skill)} />
        )}
      </div>

      {candidateMutation?.phase === 'write-failed' && (
        <Notice role="status" label="Candidate lifecycle status" onRetry={onRetryCandidate}>
          Could not update candidate lifecycle. Showing the last confirmed state.
        </Notice>
      )}
      {candidateMutation?.phase === 'read-failed' && (
        <Notice role="status" label="Candidate lifecycle status" tone="warn" onRetry={onRetryCandidate}>
          The lifecycle write completed, but its status could not be confirmed. Showing the last confirmed state.
        </Notice>
      )}
      {!distilled && toggleError && (
        <Notice onRetry={() => onToggle(skill)} retryDisabled={togglePending}>
          Could not update skill enablement. Showing last confirmed state: {skill.enabled ? 'enabled' : 'disabled'}.
        </Notice>
      )}

      <Requirements skill={skill} />

      {candidateDetail && (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-sunken/60 px-3 py-2.5 text-[12.5px]">
          {!candidateCurrent && (
            <p className="text-warn">Previous lifecycle observation; it may be stale. Actions are unavailable.</p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="d-label">Confidence</span>
            <Badge tone="neutral">{candidateDetail.confidence.toFixed(2)}</Badge>
            {candidateDetail.eval_score !== undefined && (
              <>
                <span className="d-label">Eval score</span>
                <Badge tone={candidateDetail.eval_score >= 0.75 ? 'ok' : 'warn'}>{candidateDetail.eval_score.toFixed(2)}</Badge>
              </>
            )}
            {candidateDetail.status === 'rejected' && candidateDetail.rejection_reason && (
              <>
                <span className="d-label">Rejected</span>
                <Badge tone="error">{candidateDetail.rejection_reason}</Badge>
              </>
            )}
            {candidateDetail.promoted_at && (
              <>
                <span className="d-label">Promoted</span>
                <span className="text-ink-2">{formatDate(candidateDetail.promoted_at)}</span>
              </>
            )}
          </div>
          {candidateDetail.rejection_detail && <p className="text-ink-3">{candidateDetail.rejection_detail}</p>}
          {candidateDetail.eval_missed && candidateDetail.eval_missed.length > 0 && (
            <p className="text-ink-3">Missed: {candidateDetail.eval_missed.join('; ')}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-ink-3">
            {candidateDetail.source_session_id && <span>session {candidateDetail.source_session_id}</span>}
            {candidateDetail.source_run_ids.length > 0 && <span>runs {candidateDetail.source_run_ids.join(', ')}</span>}
          </div>
          {candidateDetail.status === 'promoted' && performance.view && (
            <PerformanceReadout
              view={performance.view}
              performance={performance.performance}
              onRetry={performance.retry}
              className="mt-1 border-t border-line pt-2.5"
            />
          )}
        </div>
      )}

      <div>
        <Tabs<DetailTab>
          aria-label="Skill detail tabs"
          idBase={`${regionId}-tabs`}
          size="sm"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'body', label: 'Body' },
            { id: 'revisions', label: 'Revisions' },
          ]}
        />
        <div
          role="tabpanel"
          id={`${regionId}-tabs-panel-${tab}`}
          aria-labelledby={`${regionId}-tabs-tab-${tab}`}
          className="pt-4"
        >
          {tab === 'body' ? (
            skill.body ? (
              <SkillMarkdown content={skill.body} />
            ) : (
              <EmptyState compact title="This skill has no stored body." />
            )
          ) : loadingRevs ? (
            <StatusLine>Loading revisions…</StatusLine>
          ) : revError ? (
            <AlertLine onRetry={() => void loadRevisions()}>{revError}</AlertLine>
          ) : !revisions || revisions.length === 0 ? (
            <EmptyState compact title="No revision history for this skill yet." />
          ) : (
            <ol className="relative ml-1.5 flex flex-col gap-3 border-l border-line pl-4">
              {revisions.map((rev) => (
                <li key={rev.id} className="relative">
                  <span
                    aria-hidden="true"
                    className="absolute -left-[21px] top-[5px] size-2 rounded-full border border-line-strong bg-canvas"
                  />
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12.5px] font-medium text-ink">
                      v{rev.version}
                      <span className="ml-2 font-mono text-[10.5px] text-ink-3">{formatDate(rev.created_at)}</span>
                    </span>
                    <Button size="xs" variant="secondary" icon={<RotateCcw aria-hidden="true" />} onClick={() => void restore(rev)}>
                      Restore
                    </Button>
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-ink-2">{rev.change_reason || 'No reason recorded.'}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </Panel>
  );
}
