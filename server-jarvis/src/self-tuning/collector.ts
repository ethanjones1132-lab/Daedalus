import { SelfTuningStore, type AgentRun, type StageRun } from "./store";

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

  completeAgentRun(runId: string, finalOutput: string, durationMs: number, toolCallsCount: number, tokenCount: number): void {
    this.store.updateAgentRun(runId, {
      completed: 1,
      final_output: finalOutput,
      duration_ms: durationMs,
      tool_calls_count: toolCallsCount,
      token_count: tokenCount,
    });
  }

  submitUserRating(runId: string, rating: number): void {
    this.store.updateUserRating(runId, rating);
  }
}
export const outcomeCollector = new SessionOutcomeCollector();
