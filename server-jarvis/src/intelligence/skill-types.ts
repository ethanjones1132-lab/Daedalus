import type { TaskType } from "../orchestration/coordinator";
import type { TurnRequirement } from "../orchestration/turn-requirements";

export type SkillCandidateStatus = "candidate" | "promoted" | "rejected";

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
  | "manual";

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