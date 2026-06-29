import type { TaskType } from "../orchestration/coordinator";
import type { TurnRequirement } from "../orchestration/turn-requirements";

export type SkillCandidateStatus = "candidate" | "promoted" | "rejected";

export interface SkillTrigger {
  task_types: TaskType[];
  requirements: TurnRequirement[];
  signals: string[];
}

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
  created_at: string;
  updated_at: string;
}

export interface DistilledSkill extends SkillCandidate {
  enabled: boolean;
}