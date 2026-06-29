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
  | "missing_signals";

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
  /**
   * Why the promotion pass declined this candidate. Only set when
   * `status === "rejected"`. Human-readable so it can surface in the UI
   * diagnostic and in the eval report. Stable, machine-typed via
   * `SkillRejectionReason`.
   */
  rejection_reason?: SkillRejectionReason;
  rejection_detail?: string;
  created_at: string;
  updated_at: string;
}

export interface DistilledSkill extends SkillCandidate {
  enabled: boolean;
}