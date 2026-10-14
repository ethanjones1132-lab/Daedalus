import { ArrowUpRight } from 'lucide-react';
import { Badge, Button, Chip, EmptyState, Meter, Panel, StatusLine } from '../../design';
import type { SkillCandidateAction, SkillCandidateMutation } from '../../domain/skill-candidate-operation-state';
import { skillCandidateMutationLocked } from '../../domain/skill-candidate-operation-state';
import { CandidateActions } from './CandidateActions';
import { Notice } from './Notice';
import { PerformanceReadout } from './PerformanceReadout';
import { useCandidatePerformance } from './skill-hooks';
import { formatDate, PROMOTE_EVAL_GATE, type Skill, type SkillCandidateDetail } from './skill-model';

const STATUS_ORDER: Record<SkillCandidateDetail['status'], number> = { candidate: 0, staged: 1, promoted: 2, rejected: 3, rolled_back: 4 };
const STATUS_TONE = { candidate: 'accent', staged: 'info', promoted: 'ok', rejected: 'error', rolled_back: 'warn' } as const;

function Numeral({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-[64px] flex-col gap-0.5">
      <span className="d-label">{label}</span>
      <span className="d-display tabular text-[26px] leading-none text-ink">{value}</span>
    </div>
  );
}

function PromotedPerformance({ candidateId }: { candidateId: string }) {
  const performance = useCandidatePerformance(candidateId);
  if (!performance.view) return null;
  return <PerformanceReadout view={performance.view} performance={performance.performance} onRetry={performance.retry} />;
}

function CandidateRow({
  candidate,
  skill,
  current,
  mutation,
  onAction,
  onRetry,
  onOpenSkill,
}: {
  candidate: SkillCandidateDetail;
  skill: Skill | null;
  current: boolean;
  mutation: SkillCandidateMutation | null;
  onAction: (action: SkillCandidateAction) => void;
  onRetry: () => void;
  onOpenSkill: () => void;
}) {
  const locked = skillCandidateMutationLocked(mutation);
  const evalScore = candidate.eval_score;
  return (
    <Panel as="li" className="flex flex-col gap-3 p-4" aria-label={`Candidate: ${candidate.name}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-[13.5px] font-semibold text-ink">{candidate.name}</h3>
            <Badge tone={STATUS_TONE[candidate.status]} dot>
              {candidate.status}
            </Badge>
            {!current && <span className="text-[11.5px] text-warn">previous observation; may be stale</span>}
          </div>
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink-2">{candidate.description}</p>
          {candidate.trigger.task_types.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="d-label">Triggers on</span>
              {candidate.trigger.task_types.map((t) => (
                <Chip key={t}>{t}</Chip>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-start gap-5">
          <Numeral label="Confidence" value={candidate.confidence.toFixed(2)} />
          <div className="flex w-[104px] flex-col gap-1.5">
            <Numeral label="Eval" value={evalScore === undefined ? '—' : evalScore.toFixed(2)} />
            <Meter
              value={evalScore === undefined ? null : evalScore * 100}
              tone={evalScore !== undefined && evalScore >= PROMOTE_EVAL_GATE ? 'ok' : 'warn'}
              label={evalScore === undefined ? 'Eval not run' : `Eval score ${Math.round(evalScore * 100)} of 100, gate 75`}
            />
          </div>
        </div>
      </div>

      {candidate.status === 'promoted' && <PromotedPerformance candidateId={candidate.id} />}
      {candidate.status === 'rejected' && candidate.rejection_reason && (
        <p className="text-[12px] text-ink-3">
          Rejected: {candidate.rejection_reason}
          {candidate.rejection_detail ? ` — ${candidate.rejection_detail}` : ''}
        </p>
      )}
      {candidate.eval_missed && candidate.eval_missed.length > 0 && (
        <p className="text-[12px] text-ink-3">Missed: {candidate.eval_missed.join('; ')}</p>
      )}

      {mutation?.phase === 'write-failed' && (
        <Notice label={`Candidate lifecycle: ${candidate.name}`} onRetry={onRetry}>
          Could not update candidate lifecycle. Showing the last confirmed state.
        </Notice>
      )}
      {mutation?.phase === 'read-failed' && (
        <Notice label={`Candidate lifecycle: ${candidate.name}`} tone="warn" onRetry={onRetry}>
          The lifecycle write completed, but its status could not be confirmed. Showing the last confirmed state.
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
        <CandidateActions candidate={candidate} current={current} locked={locked} onAction={onAction} mode="full" />
        <div className="ml-auto flex items-center gap-3 font-mono text-[10.5px] text-ink-3">
          <span>updated {formatDate(candidate.updated_at)}</span>
          {skill && (
            <Button size="xs" variant="ghost" icon={<ArrowUpRight aria-hidden="true" />} onClick={onOpenSkill}>
              Open skill
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}

export function CandidatesTab({
  candidates,
  loading,
  current,
  skillByCandidate,
  mutations,
  onAction,
  onRetry,
  onOpenSkill,
}: {
  candidates: Record<string, SkillCandidateDetail> | null;
  loading: boolean;
  current: boolean;
  skillByCandidate: Record<string, Skill>;
  mutations: Record<string, SkillCandidateMutation | undefined>;
  onAction: (skillName: string, candidateId: string, action: SkillCandidateAction) => void;
  onRetry: (skillName: string, candidateId: string) => void;
  onOpenSkill: (skill: Skill) => void;
}) {
  if (candidates === null) {
    return loading ? (
      <StatusLine>Reading distilled skill candidates…</StatusLine>
    ) : (
      <EmptyState compact title="Candidate observations are unavailable." description="Retry from the Skill candidates panel below." />
    );
  }
  const rows = Object.values(candidates).sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || Date.parse(b.updated_at) - Date.parse(a.updated_at),
  );
  if (rows.length === 0) {
    return current ? (
      <EmptyState
        title="No distilled skills yet"
        description="Jarvis distils reusable skills from successful Session turns. They appear here to be evaluated, promoted or rejected."
      />
    ) : null;
  }
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((candidate) => {
        const skill = skillByCandidate[candidate.id] ?? null;
        const name = skill?.name ?? candidate.name;
        return (
          <CandidateRow
            key={candidate.id}
            candidate={candidate}
            skill={skill}
            current={current}
            mutation={mutations[candidate.id] ?? null}
            onAction={(action) => onAction(name, candidate.id, action)}
            onRetry={() => onRetry(name, candidate.id)}
            onOpenSkill={() => skill && onOpenSkill(skill)}
          />
        );
      })}
    </ul>
  );
}
