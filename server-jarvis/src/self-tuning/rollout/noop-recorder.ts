import type { StageRunRecorder } from "../../orchestration/pipeline";

/**
 * Telemetry sink for Phase-D rollouts: records nothing.
 *
 * A CMA-ES campaign runs thousands of fixture rollouts. Those are synthetic
 * evaluations, not real turns — writing them to the production evidence store
 * would swamp `agent_runs`/`stage_runs` with rows that then poison every
 * downstream aggregate (model health, no-tool rates, the benchmark itself).
 *
 * This is the FIRST of two guards. It covers the collector the rollout wires
 * explicitly. The second guard (`NODE_ENV=test` in the rollout entrypoint)
 * covers lazily-constructed module-singleton stores this one cannot reach —
 * see `rollout-runner.ts`. Neither is sufficient alone.
 */
export const noopRecorder: StageRunRecorder = {
  recordStageRun: () => {},
  recordDirective: () => {},
  recordModelAttribution: () => {},
};
