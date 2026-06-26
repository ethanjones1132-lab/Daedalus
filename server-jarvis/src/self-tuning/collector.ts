import { SelfTuningStore, type AgentRun, type StageRun, type ConductorDirectiveRow } from "./store";

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

  /**
   * Record a conductor directive (reroute / abort / inject / continue) so the
   * run stays auditable and replayable despite the live conductor's
   * non-determinism. Safe to call with no agent_run_id (a best-effort empty
   * id is used); will swallow DB errors and log.
   */
  recordDirective(directive: Omit<ConductorDirectiveRow, "created_at">): void {
    try {
      this.store.insertConductorDirective(directive as ConductorDirectiveRow);
    } catch (e) {
      console.error("[SessionOutcomeCollector] recordDirective failed:", e);
    }
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
