import { SelfTuningStore, type AgentRun, type ConductorDirectiveRow, type StageRun } from "./store";

export class SessionOutcomeCollector {
  private store: SelfTuningStore;

  constructor(store?: SelfTuningStore) {
    this.store = store || new SelfTuningStore();
  }

  startAgentRun(runId: string, sessionId: string, request: string, taskType: string, pipeline: string[]): void {
    const run: AgentRun = {
      id: runId,
      session_id: sessionId,
      user_request: request,
      task_type: taskType,
      pipeline: JSON.stringify(pipeline),
      completed: 0,
    };
    this.store.insertAgentRun(run);
  }

  recordStageRun(stage: StageRun): void {
    this.store.insertStageRun(stage);
  }

  recordDirective(directive: Omit<ConductorDirectiveRow, "created_at">): void {
    try {
      this.store.insertConductorDirective(directive);
    } catch (e) {
      console.error("[SessionOutcomeCollector] recordDirective failed:", e);
    }
  }

  completeAgentRun(
    runId: string,
    finalOutput: string,
    durationMs: number,
    toolCallsCount: number,
    tokenCount: number,
    // Truthful run outcome. `completed:1` only means the run FINISHED — the
    // `outcome` column records whether it actually succeeded. A failed/degraded/
    // partial run must NOT be silently indistinguishable from a successful one.
    // `partial` is persisted truthfully (T0.2); reward/learning maps it to
    // degraded at the reward boundary only.
    outcome: "success" | "degraded" | "failed" | "partial" = "success",
  ): void {
    this.store.updateAgentRun(runId, {
      completed: 1,
      final_output: finalOutput,
      duration_ms: durationMs,
      tool_calls_count: toolCallsCount,
      token_count: tokenCount,
      outcome,
    });
  }

  submitUserRating(runId: string, rating: number): void {
    this.store.updateUserRating(runId, rating);
  }
}
export const outcomeCollector = new SessionOutcomeCollector();
