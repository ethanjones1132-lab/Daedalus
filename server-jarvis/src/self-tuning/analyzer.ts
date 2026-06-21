import { SelfTuningStore, type AgentRun, type StageRun } from "./store";
import { BUILTIN_MODES } from "../orchestration/modes";

export interface TuningSuggestion {
  proposal_type: "temperature" | "prune_mode" | "restrict_tools" | "skip_planner";
  task_type: string;
  current_value: string;
  proposed_value: string;
  rationale: string;
}

export class OutcomeAnalyzer {
  constructor(private store: SelfTuningStore = new SelfTuningStore()) {}

  analyze(taskType: string): TuningSuggestion[] {
    const suggestions: TuningSuggestion[] = [];
    const runs = this.store.getAgentRuns().filter((r) => r.task_type === taskType && r.completed === 1);
    if (runs.length < 3) {
      return suggestions;
    }

    const ratings = runs.map((r) => r.user_rating).filter((r): r is number => r !== undefined && r !== null);
    const avgRating = ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;

    const allStageRuns: StageRun[] = [];
    for (const run of runs) {
      allStageRuns.push(...this.store.getStageRuns(run.id));
    }

    const totalStages = allStageRuns.length;
    const stageErrors = totalStages > 0
      ? allStageRuns.filter((stage) => stage.had_error === 1).length / totalStages
      : 0;

    if (avgRating !== null && avgRating < 3) {
      suggestions.push(this.temperatureSuggestion(taskType, "Average rating is below 3.0; lower executor temperature for more deterministic output."));
    }

    if (stageErrors > 0.2) {
      suggestions.push(this.temperatureSuggestion(taskType, "Stage error rate exceeds 20%; lower executor temperature to reduce unstable outputs."));
    }

    if (avgRating !== null && avgRating < 2.5 && stageErrors > 0.3) {
      suggestions.push({
        proposal_type: "restrict_tools",
        task_type: taskType,
        current_value: "full tool set",
        proposed_value: "read-only/search tools only",
        rationale: "Low rating plus high stage error rate suggests the current task benefits from a narrower tool surface.",
      });
    }

    return dedupeSuggestions(suggestions);
  }

  private temperatureSuggestion(taskType: string, rationale: string): TuningSuggestion {
    const current = Number(BUILTIN_MODES.executor.temperature ?? 0.4);
    const proposed = Math.max(0.1, current - 0.1);
    return {
      proposal_type: "temperature",
      task_type: taskType,
      current_value: String(current),
      proposed_value: String(proposed),
      rationale,
    };
  }
}

function dedupeSuggestions(suggestions: TuningSuggestion[]): TuningSuggestion[] {
  const seen = new Set<string>();
  const deduped: TuningSuggestion[] = [];
  for (const suggestion of suggestions) {
    const key = `${suggestion.proposal_type}:${suggestion.task_type}:${suggestion.proposed_value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(suggestion);
  }
  return deduped;
}
