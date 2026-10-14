import { describe, expect, it } from 'vitest';
import { decodeSkillCandidateEvaluation } from './SkillLearningPage';
const hash = 'a'.repeat(64);
function projection(digest: string) {
  return { candidate_id: 'candidate-1', current_status: 'candidate', current_version: 1, count: 1, evaluations: [{ report_hash: digest, record_hash: digest, manifest_hash: digest, decision: 'accepted', generated_at: '2026-10-14T00:00:00Z', candidate: { id: 'candidate-1', content_digest: digest, artifact_digest: digest }, coverage: { planned_task_count: 1, seeds_per_task: 1, arms_per_block: 2, planned_block_count: 1, planned_outcome_count: 2, observed_outcome_count: 2, missing_outcome_count: 0 }, criteria: [], reasons: [], observed_status: 'candidate', observed_version: 1, content_match: true, stale: false }] };
}
describe('canonical learning evaluation digest contract', () => {
  it('retains the sha256-prefixed digests returned by the proof endpoint for exact promote and rollback requests', () => {
    const digest = `sha256:${hash}`;
    const decoded = decodeSkillCandidateEvaluation(projection(digest));
    expect(decoded?.evaluations[0]).toMatchObject({ report_hash: digest, record_hash: digest, manifest_hash: digest, candidate: { content_digest: digest, artifact_digest: digest } });
  });
  it('keeps legacy bare digests readable', () => expect(decodeSkillCandidateEvaluation(projection(hash))).not.toBeNull());
  it.each(['sha256:short', `sha512:${hash}`, `${hash}0`])('rejects malformed digest %s without inventing evidence', digest => expect(decodeSkillCandidateEvaluation(projection(digest))).toBeNull());
});
