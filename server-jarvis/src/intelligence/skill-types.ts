import type { TaskType } from "../orchestration/coordinator";
import type { TurnRequirement } from "../orchestration/turn-requirements";

/**
 * Candidate lifecycle status. `staged` means the exact frozen candidate passed
 * the independent learning-transfer acceptance gate and is eligible for a
 * separate, explicit promotion action, but is deliberately inactive:
 * `skill-resolver.ts` only ever resolves `promoted` candidates. `rolled_back`
 * is the terminal deactivation of a previously promoted candidate and may only
 * be produced by the evidence-bound accepted-decision rollback transition.
 */
export type SkillCandidateStatus = "candidate" | "staged" | "promoted" | "rejected" | "rolled_back";

export interface SkillTrigger {
  task_types: TaskType[];
  requirements: TurnRequirement[];
  signals: string[];
}

export type SkillRejectionReason =
  | "below_eval_delta"
  | "wrong_status"
  | "low_confidence"
  | "suspicious_paths"
  | "body_length_out_of_range"
  | "missing_signals"
  | "eval_failed"
  | "manual"
  | "transfer_gate_failed";

export interface SkillCandidate {
  id: string;
  name: string;
  description: string;
  trigger: SkillTrigger;
  body: string;
  source_run_ids: string[];
  source_session_id?: string;
  confidence: number;
  status: SkillCandidateStatus;
  lifecycle_version?: number;
  eval_score?: number;
  /** Rubric items missed on the most recent judge run. Only meaningful after a `POST .../eval` or `.../promote` call. */
  eval_missed?: string[];
  /**
   * Why the promotion pass declined this candidate. Only set when
   * `status === "rejected"`. Human-readable so it can surface in the UI
   * diagnostic and in the eval report. Stable, machine-typed via
   * `SkillRejectionReason`.
   */
  rejection_reason?: SkillRejectionReason;
  rejection_detail?: string;
  /** ISO 8601 timestamp set when status transitions to "promoted"; cleared on demote. */
  promoted_at?: string;
  /** Hash of the ordered tool names invoked in the source run's stages; feeds the grounding rubric. */
  tool_sequence_digest?: string;
  created_at: string;
  updated_at: string;
}

export interface DistilledSkill extends SkillCandidate {
  enabled: boolean;
}