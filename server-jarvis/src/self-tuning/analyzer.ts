import { SelfTuningStore, type AgentRun, type StageRun, type TuningProposal } from "./store";

export interface TuningSuggestion {
  proposal_type: string; // "temperature" | "prune_mode" | "restrict_tools" | "skip_planner"
  task_type: string;
  current_value: string;
  proposed_value: string;
  rationale: string;
}

export class OutcomeAnalyzer {
  private store = new SelfTuningStore();

  analyze(taskType: string): TuningSuggestion[] {
    const suggestions: TuningSuggestion[] = [];
    const runs = this.store.getAgentRuns().filter((r) => r.task_type === taskType && r.completed === 1);
    if (runs.length < 3) {
      // Need at least 3 completed runs for a task type to make statistical recommendations
      return suggestions;
    }

    const ratings = runs.map((r) => r.user_rating).filter((r): r is number => r !== undefined && r !== null);
    const avgRating = ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;

    // Retrieve all stage runs for these agent runs
    const allStageRuns: StageRun[] = [];
    for (const run of runs) {
      allStageRuns.push(...this.store.getStageRuns(run.id));
    }

    // 1. Temperature Tuning heuristic
    // If average rating is low (< 3.0 out of 5), or if stage error rate is high (> 20%),
    // suggest lowering temperature of the executor/reviewer to make output more deterministic.
    const stageErrors = allStageRuns