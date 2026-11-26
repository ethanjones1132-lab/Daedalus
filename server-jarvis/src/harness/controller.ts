import type { OrchestratorAgent } from "../orchestration/agent-pool";
import { runEngine } from "./engine";
import type { HarnessManifest } from "./manifest";
import type { HarnessRoundInput, HarnessStore } from "./store";

export { MAX_DEADLINE_MS } from "./engine";

export type HarnessStopReason = "passed" | "max_rounds" | "cancelled" | "approval_denied" | "no_progress" | "maker_failed" |
  "checker_rejected" | "deadline" | "run_failed" | "budget_exceeded" | "run_budget" | "harness_stop" | "switch_limit";

export interface HarnessRunResult {
  run_id: string;
  stop_reason: HarnessStopReason;
  rounds: number;
  /** True when an aborted step outlived the bounded settle wait. */
  abandoned?: boolean;
}

export interface HarnessSensorBatch {
  counter_vector: HarnessRoundInput["counter_vector"];
  sensors: Array<{
    sensor_id: string;
    status: "zero" | "nonzero" | "failed" | "not_applicable" | "unapproved";
    counter: number | null;
    exit_code?: number | null;
    stdout?: string;
    stderr?: string;
  }>;
}

export interface HarnessAdmission {
  acquire(input: { workClass: "background"; signal: AbortSignal; deadlineAt: number }): Promise<{ release(): void }>;
}

export interface HarnessControllerInput {
  manifest: HarnessManifest;
  store: Pick<HarnessStore, "createRun" | "appendRound" | "appendSensorResult" | "appendEvent" | "addRunCost">;
  sensors: (input: { manifest: HarnessManifest; signal: AbortSignal }) => Promise<HarnessSensorBatch>;
  runMaker: (input: { manifest: HarnessManifest; round: number; signal: AbortSignal }) => Promise<{ failed?: boolean; continue?: boolean; cost_usd?: number } | void>;
  /** The actual model for a maker that runs outside the delegate pool. */
  localMakerModel?: (input: { manifest: HarnessManifest; signal: AbortSignal }) => string | undefined;
  runChecker: (input: { manifest: HarnessManifest; signal: AbortSignal }) => Promise<{ passed: boolean }>;
  /** Agent pool used to resolve the maker/checker model families. Defaults to the shipped pool. */
  agents?: readonly OrchestratorAgent[];
  /** Pre-generated run id so a caller can address the run before the loop settles. */
  run_id?: string;
  signal?: AbortSignal;
  now?: () => number;
  /** Maximum total elapsed time, including admission wait. Defaults to 30 minutes; clamped to MAX_DEADLINE_MS. */
  deadline_ms?: number;
  /**
   * Bounded wait for a step that was abandoned by an abort, before its lease is
   * released and the stop event is written. Defaults to 2000ms; never unbounded.
   */
  abandon_wait_ms?: number;
  admission: HarnessAdmission;
}

/** Run the fixed worker entry point with the existing controller contract. */
export function runHarness(input: HarnessControllerInput): Promise<HarnessRunResult> {
  return runEngine({ ...input, initial: { id: "worker" }, legacyWorker: true });
}
