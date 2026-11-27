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

/** The per-run values that fill a manifest's brief template. */
export type HarnessBriefValues = Record<string, string>;

export interface HarnessMakerInput {
  manifest: HarnessManifest;
  round: number;
  signal: AbortSignal;
  /**
   * Values this run's brief is filled from, owned by the run rather than the
   * execution boundary, so concurrent runs never share a brief.
   */
  briefValues?: HarnessBriefValues;
}

export interface HarnessCheckerInput {
  manifest: HarnessManifest;
  signal: AbortSignal;
  /** This run's brief values, paired with the maker turn's for the same run. */
  briefValues?: HarnessBriefValues;
}

/**
 * Why a failed maker turn stopped. Carried with the turn result so a
 * `maker_failed` stop records the delegate's real cause instead of only the
 * stop reason. Every field is optional: a turn that fails without a known
 * cause, and every successful turn, records exactly what it did before.
 */
export interface HarnessMakerFailure {
  /** Stable delegate failure code, e.g. `delegate_timeout`. */
  errorCode?: string;
  /** The delegate's terminal status, e.g. `timed_out`. */
  terminalStatus?: string;
  /** Bounded exception/detail text for the failure. */
  failureDetail?: string;
}

/**
 * Who actually produced a checker verdict. The checker's cascade can advance
 * past the pinned agent, so this is the model that answered, not the one the
 * manifest requested. Every field is optional: a boundary that cannot know
 * records nothing rather than inventing a model name.
 */
export interface HarnessCheckerModel {
  /** The cascade entry's model id that answered the call. */
  model_id?: string;
  /** The provider that served it. */
  provider?: string;
  /** True when the cascade replaced the requested checker model. */
  fallback_used?: boolean;
}

export interface HarnessCheckerVerdict {
  /** The verdict. The only decision field. */
  passed: boolean;
  /** The model that reviewed, when the boundary can report it. */
  model?: HarnessCheckerModel;
}

export interface HarnessControllerInput {
  manifest: HarnessManifest;
  store: Pick<HarnessStore, "createRun" | "appendRound" | "appendSensorResult" | "appendEvent" | "addRunCost">;
  sensors: (input: { manifest: HarnessManifest; signal: AbortSignal }) => Promise<HarnessSensorBatch>;
  runMaker: (input: HarnessMakerInput) =>
    Promise<({ failed?: boolean; continue?: boolean; cost_usd?: number } & HarnessMakerFailure) | void>;
  /** The actual model for a maker that runs outside the delegate pool. */
  localMakerModel?: (input: { manifest: HarnessManifest; signal: AbortSignal }) => string | undefined;
  runChecker: (input: HarnessCheckerInput) => Promise<HarnessCheckerVerdict>;
  /** Agent pool used to resolve the maker/checker model families. Defaults to the shipped pool. */
  agents?: readonly OrchestratorAgent[];
  /** Pre-generated run id so a caller can address the run before the loop settles. */
  run_id?: string;
  /** Values for this run's brief template, threaded into its maker and checker prompts. */
  briefValues?: HarnessBriefValues;
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
