import { Button } from '../../design';
import type { SkillCandidateAction } from '../../domain/skill-candidate-operation-state';
import {
  PROMOTE_BLOCKED_HINT,
  PROMOTE_EVAL_GATE,
  PROMOTE_READY_HINT,
  type SkillCandidateDetail,
} from './skill-model';

/**
 * Lifecycle controls for one distilled candidate. `compact` is the skill-card
 * row (Promote / Reject while still a candidate); `full` is the inspector and
 * the Candidates tab (Run eval, Promote, Reject, Demote). Every control is
 * frozen while a write is in flight or the observation is not current.
 */
export function CandidateActions({
  candidate,
  current,
  locked,
  onAction,
  mode,
}: {
  candidate: SkillCandidateDetail;
  current: boolean;
  locked: boolean;
  onAction: (action: SkillCandidateAction) => void;
  mode: 'compact' | 'full';
}) {
  const passing = candidate.eval_score !== undefined && candidate.eval_score >= PROMOTE_EVAL_GATE;
  const frozen = locked || !current;
  const promoteDisabled = frozen || !passing;
  const act = (action: SkillCandidateAction) => (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onAction(action);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {mode === 'full' && (
        <Button size="xs" variant="secondary" disabled={frozen} onClick={act('eval')}>
          Run eval
        </Button>
      )}
      {candidate.status === 'candidate' && (
        <>
          <Button
            size="xs"
            variant="primary"
            disabled={promoteDisabled}
            onClick={act('promote')}
            title={passing ? PROMOTE_READY_HINT : PROMOTE_BLOCKED_HINT}
          >
            Promote
          </Button>
          <Button size="xs" variant="danger" disabled={frozen} onClick={act('reject')}>
            Reject
          </Button>
        </>
      )}
      {mode === 'full' && candidate.status === 'promoted' && (
        <Button size="xs" variant="secondary" disabled={frozen} onClick={act('demote')}>
          Demote
        </Button>
      )}
    </div>
  );
}
