import type { DelegateInterventionInput } from "../orchestration/delegate-intervention-policy";
import type { ExecutorProgressInput } from "../orchestration/executor-progress-policy";

export type PolicyRolloutStep =
  | { kind: "canary_draw"; canaryActive: boolean }
  | { kind: "executor_progress"; input: ExecutorProgressInput }
  | { kind: "delegate_intervention"; input: DelegateInterventionInput }
  | { kind: "reroute_admission"; applied: number }
  | { kind: "dead_tool"; tool: string; failures: string[] };

export interface PolicyRolloutFixture {
  id: string;
  steps: readonly PolicyRolloutStep[];
}

export const POLICY_ROLLOUT_FIXTURES: readonly PolicyRolloutFixture[] = [{
  id: "completion_integrity_mixed",
  steps: [
    { kind: "canary_draw", canaryActive: true },
    {
      kind: "executor_progress",
      input: {
        writeIntent: true,
        emittedToolCalls: false,
        successfulWrites: 0,
        consecutiveNoToolTurns: 1,
        stageRemainingMs: 60_000,
        anyToolCallThisStage: true,
        executorTurns: 10,
        noToolTurns: 4,
      },
    },
    {
      kind: "delegate_intervention",
      input: {
        intervention: { kind: "force_write", note: "Apply the requested write now." },
        successfulReads: 2,
        successfulWrites: 0,
        failedWrites: 2,
        policyDenied: false,
        elapsedMs: 20_000,
        stageRemainingMs: 50_000,
        explorationLimitMs: 40_000,
        nativeFallbackReserveMs: 15_000,
      },
    },
    { kind: "reroute_admission", applied: 2 },
    {
      kind: "dead_tool",
      tool: "grep",
      failures: ["executable not found", "executable not found"],
    },
  ],
}];
