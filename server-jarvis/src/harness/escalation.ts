import type { HarnessSensorBatch } from "./controller";
import type { EngineState } from "./module";

/**
 * The stuck signals the engine can observe after a round's sensors. A signal is
 * evidence that the run is not moving, not a verdict about the task: the ladder
 * below is how the run responds to that evidence.
 */
export type StuckSignal = "no_progress_2" | "same_failure_repeat" | "self_reported_stuck" | "tool_errors" | "half_budget_failing";

/**
 * The escalation ladder, in order. `worker` is the base rung: the run starts
 * there and only the engine's own boundary applies a later rung. Orchestration
 * is deliberately absent - a stuck harness can ask for a retry, a planner or a
 * consultation, never a larger fleet.
 */
export type EscalationStep = "worker" | "retry" | "planner" | "consult" | "stop_report";

export const ESCALATION_ORDER: readonly EscalationStep[] = Object.freeze([
  "worker", "retry", "planner", "consult", "stop_report",
] as const);

export interface EscalationAssessment {
  signal: StuckSignal | null;
  next: EscalationStep | null;
  force: boolean;
}

/**
 * The assessment plus the human-readable cause the engine records. Kept off
 * `assessEscalation`'s return value so the pinned shape stays three fields:
 * the reason belongs to the event trail, not to the ladder's contract.
 */
export interface EscalationPlan extends EscalationAssessment {
  reason?: string;
}

type CounterVector = NonNullable<EngineState["last_sensors"]>["counter_vector"];

/**
 * DD-152's consultant tools. Declared structurally so this module does not
 * depend on DD-152's concrete implementation: when the tools are installed, the
 * ladder's `consult` rung can use them; when they are absent, the ladder falls
 * through to `stop_report` instead of pretending a consultation happened.
 */
export interface ConsultantTools {
  consult(input: { state: EngineState; signal: StuckSignal }): Promise<{ report: string; cost_usd?: number }>;
}

export type Consultation = Awaited<ReturnType<ConsultantTools["consult"]>>;

let consultantTools: ConsultantTools | undefined;

/** Install (or clear) DD-152's consultant tools for the lifetime of this process. */
export function installConsultantTools(tools: ConsultantTools | undefined): void {
  consultantTools = tools;
}

/** True when this build carries DD-152's consultant tools. */
export function consultantToolsAvailable(): boolean {
  return consultantTools !== undefined;
}

/** One bounded consultation. Throws when the ladder has no consultant to use. */
export async function runConsultation(state: EngineState, signal: StuckSignal): Promise<Consultation> {
  if (!consultantTools) throw new Error("consultant tools are unavailable");
  return consultantTools.consult({ state, signal });
}

/**
 * What the ladder remembers about one run. `EngineState` carries only the
 * current round, so the previous vector and whether a switch was already
 * suggested have to live beside the run rather than in the state a module sees.
 */
interface EscalationTrack {
  previous?: HarnessSensorBatch;
  signal?: StuckSignal;
  /** A switch to the next rung was recommended for this signal. */
  suggested: boolean;
  /** The highest rung this signal has already reached on this run. */
  rung: number;
  /** The round the last assessment looked at, so "one round later" is a real round. */
  assessedRound?: number;
  /** The consult rung was used for this signal. */
  consulted: boolean;
  /** The maker turn said it could not proceed. */
  selfReported: boolean;
}

const tracks = new Map<string, EscalationTrack>();

function track(runId: string): EscalationTrack {
  let found = tracks.get(runId);
  if (!found) {
    found = { suggested: false, rung: 0, consulted: false, selfReported: false };
    tracks.set(runId, found);
  }
  return found;
}

/** Forget a run's escalation memory. Called when its engine loop settles. */
export function resetEscalation(runId: string): void {
  tracks.delete(runId);
}

/**
 * Record the maker's own statement that it cannot continue this round. The
 * engine consumes the maker's `continue: false` here; the ladder treats it as
 * the `self_reported_stuck` signal rather than inventing one from sensor data.
 */
export function reportSelfReportedStuck(runId: string): void {
  track(runId).selfReported = true;
}

/** Mark that this run already spent its consult rung on the current signal. */
export function noteConsultation(runId: string): void {
  track(runId).consulted = true;
}

function failingSensorIds(batch: HarnessSensorBatch | undefined): string[] {
  if (!batch) return [];
  return batch.sensors
    .filter((sensor) => sensor.status === "nonzero" || sensor.status === "failed")
    .map((sensor) => sensor.sensor_id)
    .sort();
}

function hasToolError(batch: HarnessSensorBatch | undefined): boolean {
  return batch?.sensors.some((sensor) => sensor.status === "failed") ?? false;
}

function sameVector(a: CounterVector, b: CounterVector): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return false;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/** Half of the run's round budget is gone: the remaining rounds need a different approach. */
function halfBudgetUsed(state: EngineState): boolean {
  const total = state.round + state.budget_left.max_rounds;
  return total > 0 && state.round * 2 >= total;
}

/**
 * The most specific signal the round's evidence supports. Order matters:
 * a maker's own report is authoritative, an executing sensor that failed is a
 * tool problem, and only then is a comparison with the previous round made.
 */
function detectSignal(state: EngineState, memory: EscalationTrack): StuckSignal | null {
  if (memory.selfReported) return "self_reported_stuck";
  const batch = state.last_sensors;
  if (!batch) return null;
  if (hasToolError(batch)) return "tool_errors";
  const failing = failingSensorIds(batch);
  if (failing.length === 0) return null;
  const previous = memory.previous;
  if (previous && sameVector(previous.counter_vector, batch.counter_vector)) return "no_progress_2";
  if (previous) {
    const before = failingSensorIds(previous);
    if (before.length > 0 && before.join("\u0000") === failing.join("\u0000")) return "same_failure_repeat";
  }
  if (halfBudgetUsed(state)) return "half_budget_failing";
  return null;
}

/**
 * Which rung the run is on. An unfamiliar harness is treated as the base rung:
 * the ladder's own harnesses are the only rungs it can advance to, and a module
 * the ladder does not know must not be mistaken for a later step.
 */
function rungOf(id: string): number {
  const index = ESCALATION_ORDER.indexOf(id as EscalationStep);
  if (index < 0) return 0;
  return Math.min(index, ESCALATION_ORDER.length - 3);
}

/**
 * The step after the current rung. `consult` is only returned when DD-152's
 * tools are actually installed; otherwise the ladder falls through to
 * `stop_report` and says why, rather than recording a consultation it never had.
 */
function nextStep(rung: number, memory: EscalationTrack, signal: StuckSignal): { next: EscalationStep; rung: number; reason?: string } {
  if (rung < 2) return { next: ESCALATION_ORDER[rung + 1] as EscalationStep, rung: rung + 1 };
  if (!memory.consulted) {
    if (consultantToolsAvailable()) {
      return { next: "consult", rung, reason: `stuck signal "${signal}" persisted; consult DD-152's tools before stopping` };
    }
    return {
      next: "stop_report", rung,
      reason: `stuck signal "${signal}" persisted; DD-152 consultant tools are not available, so the ladder stops with a report`,
    };
  }
  return {
    next: "stop_report", rung,
    reason: `stuck signal "${signal}" persisted after a consultation; the ladder stops with a report`,
  };
}

/**
 * Assess one round's stuck evidence and the next rung. The first observation of
 * a signal returns an advisory step (`force: false`); when the same signal is
 * still present one round after that step was suggested, the next step is
 * forced (`force: true`). The ladder never returns `orchestration`.
 */
export function assessEscalationPlan(state: EngineState): EscalationPlan {
  const memory = track(state.run_id);
  const signal = detectSignal(state, memory);
  const persisted = signal !== null && memory.signal === signal &&
    memory.assessedRound !== undefined && state.round > memory.assessedRound;
  memory.assessedRound = state.round;
  if (!signal) {
    memory.signal = undefined;
    memory.suggested = false;
    memory.rung = 0;
    memory.consulted = false;
    memory.previous = state.last_sensors;
    return { signal: null, next: null, force: false };
  }

  // A new signal starts its own ladder; a persistent one never moves backwards
  // just because a module or script handed the run to an earlier harness.
  if (memory.signal !== signal) {
    memory.rung = 0;
    memory.consulted = false;
  }
  const force = persisted && memory.suggested;
  const rung = Math.max(rungOf(state.attached.id), memory.rung);
  const step = nextStep(rung, memory, signal);
  if (step.next !== "stop_report") memory.suggested = true;
  memory.rung = Math.max(memory.rung, step.rung);
  memory.signal = signal;
  memory.previous = state.last_sensors;
  return { signal, next: step.next, force, ...(step.reason !== undefined ? { reason: step.reason } : {}) };
}

/** The pinned three-field assessment. Reasons stay in `assessEscalationPlan`. */
export function assessEscalation(state: EngineState): EscalationAssessment {
  const plan = assessEscalationPlan(state);
  return { signal: plan.signal, next: plan.next, force: plan.force };
}
