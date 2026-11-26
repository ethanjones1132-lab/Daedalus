import { DEFAULT_ORCHESTRATOR_AGENTS, type OrchestratorAgent } from "../orchestration/agent-pool";
import { agentFamily, resolveHarnessAgent } from "./agents";
import { manifestHash, validateManifest, type HarnessManifest } from "./manifest";
import type { HarnessRoundInput, HarnessSensorResultInput, HarnessStore } from "./store";

export type HarnessStopReason = "passed" | "max_rounds" | "cancelled" | "approval_denied" | "no_progress" | "maker_failed" | "checker_rejected" | "deadline" | "run_failed";

export interface HarnessRunResult {
  run_id: string;
  stop_reason: HarnessStopReason;
  rounds: number;
  /**
   * True when an aborted step outlived the bounded settle wait. The stop payload
   * carries the same fact so a stored record never reads as a clean settle.
   */
  abandoned?: boolean;
}

/** How long an aborted step gets to return before the run records it as abandoned. */
const DEFAULT_ABANDON_WAIT_MS = 2000;

/**
 * The longest deadline this controller can schedule: 2^31-1 ms (~24.8 days),
 * the largest delay a `setTimeout` represents. A longer delay overflows the
 * timer, which then fires on the next tick and aborts the run instantly. A
 * manifest asking for more than this gets this documented maximum instead of
 * an immediate abort; a zero, negative or non-finite deadline is still rejected.
 */
export const MAX_DEADLINE_MS = 2 ** 31 - 1;

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
  store: Pick<HarnessStore, "createRun" | "appendRound" | "appendSensorResult" | "appendEvent">;
  sensors: (input: { manifest: HarnessManifest; signal: AbortSignal }) => Promise<HarnessSensorBatch>;
  runMaker: (input: { manifest: HarnessManifest; round: number; signal: AbortSignal }) => Promise<{ failed?: boolean; continue?: boolean } | void>;
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

/**
 * Waits for steps abandoned by an abort, no longer than `ceilingMs`. Resolves
 * true when a step is still running and must be recorded as abandoned.
 */
async function waitForAbandoned(pending: Set<Promise<unknown>>, ceilingMs: number): Promise<boolean> {
  if (pending.size === 0) return false;
  const settled = Promise.allSettled([...pending]).then(() => true as const);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ceilingMs); });
  try { return (await Promise.race([settled, expired])) === false; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

function waitWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("harness aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("harness aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function isPassingSensorResult(result: HarnessSensorBatch["sensors"][number]): boolean {
  return result.status === "zero" && Number.isInteger(result.counter) && result.counter === 0 && result.exit_code === 0;
}

function vectorImproved(previous: HarnessRoundInput["counter_vector"] | undefined, current: HarnessRoundInput["counter_vector"]): boolean {
  if (!previous) return false;
  const comparable = Object.keys(current).filter((key) => typeof previous[key] === "number" && typeof current[key] === "number");
  return comparable.length > 0 && comparable.every((key) => (current[key] as number) <= (previous[key] as number)) &&
    comparable.some((key) => (current[key] as number) < (previous[key] as number));
}

/** Runs a maker/sensor/checker loop with app-owned durable evidence and injected execution boundaries. */
export async function runHarness(input: HarnessControllerInput): Promise<HarnessRunResult> {
  const checked = validateManifest(input.manifest);
  if (!checked.ok) throw new Error(`Invalid harness manifest: ${checked.errors.join("; ")}`);
  if (input.manifest.checker.enabled) {
    const makerAgentId = input.manifest.maker_agent_id;
    const checkerAgentId = input.manifest.checker.agent_id;
    if (checkerAgentId === makerAgentId) {
      throw new Error("checker agent must differ from maker agent");
    }
    const agents = input.agents ?? DEFAULT_ORCHESTRATOR_AGENTS;
    const maker = resolveHarnessAgent(agents, makerAgentId, "executor");
    const checker = resolveHarnessAgent(agents, checkerAgentId, "reviewer");
    const makerFamily = maker ? agentFamily(maker) : "";
    const checkerFamily = checker ? agentFamily(checker) : "";
    if (makerFamily && checkerFamily && makerFamily === checkerFamily) {
      throw new Error(
        `Invalid harness manifest: checker agent "${checkerAgentId}" and maker agent "${makerAgentId}" ` +
        `resolve to the same model family "${makerFamily}"`,
      );
    }
  }
  const now = input.now ?? Date.now;
  const startedAt = now();
  const requestedDeadlineMs = input.deadline_ms ?? 30 * 60 * 1000;
  if (!Number.isFinite(requestedDeadlineMs) || requestedDeadlineMs <= 0) throw new Error("deadline_ms must be a positive finite duration");
  // Clamp before scheduling so a request beyond the timer's range becomes the
  // documented maximum rather than overflowing setTimeout into an instant abort.
  const deadlineAt = startedAt + Math.min(requestedDeadlineMs, MAX_DEADLINE_MS);
  if (!Number.isFinite(deadlineAt) || deadlineAt <= startedAt) throw new Error("deadline_ms must be a positive finite duration");
  const abandonWaitMs = input.abandon_wait_ms ?? DEFAULT_ABANDON_WAIT_MS;
  if (!Number.isFinite(abandonWaitMs) || abandonWaitMs < 0) throw new Error("abandon_wait_ms must be a non-negative finite duration");
  const run = input.store.createRun({ id: input.run_id, project_root: input.manifest.project_root,
    manifest_id: input.manifest.id, manifest_hash: manifestHash(input.manifest) });
  const abort = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let reason: HarnessStopReason = "max_rounds";
  let rounds = 0;
  let abandoned = false;
  let failure: string | undefined;
  // Aborting rejects the wait at each step but leaves the maker/sensor/checker
  // promise in flight. Track it so the finally can wait for it (bounded) before
  // it frees the admission lease and claims the run stopped.
  const pending = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    const forget = () => { pending.delete(work); };
    work.then(forget, forget);
    return work;
  };
  const onAbort = () => abort.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) abort.abort();
  deadlineTimer = setTimeout(() => abort.abort(), Math.max(0, deadlineAt - now()));
  let lease: { release(): void } | undefined;
  try {
    if (abort.signal.aborted) reason = input.signal?.aborted ? "cancelled" : "deadline";
    else {
      try { lease = await input.admission.acquire({ workClass: "background", signal: abort.signal, deadlineAt }); }
      catch { reason = input.signal?.aborted ? "cancelled" : now() >= deadlineAt ? "deadline" : "approval_denied"; }
    }
    const baselines = Object.fromEntries(input.manifest.sensors.filter((sensor) => sensor.baseline !== undefined)
      .map((sensor) => [sensor.id, sensor.baseline!]));
    let previous: HarnessRoundInput["counter_vector"] | undefined = Object.keys(baselines).length ? baselines : undefined;
    if (lease) for (let roundNumber = 1; roundNumber <= input.manifest.loop.max_rounds; roundNumber++) {
      rounds = roundNumber;
      if (input.signal?.aborted || abort.signal.aborted || now() >= deadlineAt) { reason = input.signal?.aborted ? "cancelled" : "deadline"; break; }
      let maker: Awaited<ReturnType<typeof input.runMaker>>;
      try { maker = await waitWithAbort(track(input.runMaker({ manifest: input.manifest, round: roundNumber, signal: abort.signal })), abort.signal); }
      catch { reason = input.signal?.aborted ? "cancelled" : now() >= deadlineAt ? "deadline" : "maker_failed"; break; }
      if (input.signal?.aborted || abort.signal.aborted || now() >= deadlineAt) { reason = input.signal?.aborted ? "cancelled" : "deadline"; break; }
      if (maker?.failed) { reason = "maker_failed"; break; }
      let batch: HarnessSensorBatch;
      try { batch = await waitWithAbort(track(input.sensors({ manifest: input.manifest, signal: abort.signal })), abort.signal); }
      catch (error) {
        // Only an abort or an elapsed deadline is a clean stop; a sensor that
        // throws is a broken run, and its message is the failure evidence.
        if (input.signal?.aborted) reason = "cancelled";
        else if (now() >= deadlineAt) reason = "deadline";
        else { reason = "run_failed"; failure = error instanceof Error ? error.message : String(error); }
        break;
      }
      if (input.signal?.aborted || abort.signal.aborted || now() >= deadlineAt) { reason = input.signal?.aborted ? "cancelled" : "deadline"; break; }
      const round = input.store.appendRound({ run_id: run.id, round_number: roundNumber, counter_vector: batch.counter_vector });
      for (const result of batch.sensors) {
        const isZero = isPassingSensorResult(result);
        const status: HarnessSensorResultInput["status"] = isZero ? "passed" : result.status === "not_applicable" ? "not_applicable" : "failed";
        input.store.appendSensorResult({ run_id: run.id, round_id: round.id, sensor_id: result.sensor_id, status,
          counter: result.counter, exit_code: result.exit_code ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
      }
      // A round settles only on complete evidence: every sensor the manifest asked
      // for must have reported, and every reported sensor must have passed. Optional
      // sensors (`required: false`) are in that set, so one failing optional sensor
      // cannot pass silently. The one exemption is a sensor the manifest itself
      // declares unavailable: its `not_applicable` result is a known evidence gap,
      // not a check that was silently skipped. (A command sensor skipped as
      // `not_applicable` — e.g. no stored baseline — does block.)
      const declaredSensors = new Map(input.manifest.sensors.map((sensor) => [sensor.id, sensor] as const));
      const blocking = batch.sensors.filter((result) => {
        if (isPassingSensorResult(result)) return false;
        return result.status !== "not_applicable" || declaredSensors.get(result.sensor_id)?.kind !== "unavailable";
      });
      const reported = new Set(batch.sensors.map((result) => result.sensor_id));
      const missing = input.manifest.sensors.filter((sensor) => !reported.has(sensor.id));
      const evidenceComplete = blocking.length === 0 && missing.length === 0;
      // A manifest with no required sensors (and none at all, like generic_audit)
      // has no computational gate of its own, so the checker is what settles it.
      // With no enabled checker, only a passing required sensor may settle a pass;
      // otherwise nothing claims one and the loop works on or exhausts its rounds.
      const hasPassingRequiredSensor = input.manifest.sensors.some((sensor) => {
        if (!sensor.required) return false;
        const result = batch.sensors.find((entry) => entry.sensor_id === sensor.id);
        return result !== undefined && isPassingSensorResult(result);
      });
      const settleReady = evidenceComplete && (input.manifest.checker.enabled || hasPassingRequiredSensor);
      if (settleReady) {
        if (input.manifest.checker.enabled) {
          try {
            const checkedByAgent = await waitWithAbort(track(input.runChecker({ manifest: input.manifest, signal: abort.signal })), abort.signal);
            if (input.signal?.aborted || abort.signal.aborted || now() >= deadlineAt) { reason = input.signal?.aborted ? "cancelled" : "deadline"; break; }
            reason = checkedByAgent.passed ? "passed" : "checker_rejected";
          } catch (error) {
            // A checker that throws produced no verdict; that is a failed run,
            // not a rejection. Abort and deadline keep their own reasons.
            if (input.signal?.aborted) reason = "cancelled";
            else if (now() >= deadlineAt) reason = "deadline";
            else { reason = "run_failed"; failure = error instanceof Error ? error.message : String(error); }
          }
        } else reason = "passed";
        break;
      }
      const denied = batch.sensors.some((result) => result.status === "unapproved");
      if (denied) { reason = "approval_denied"; break; }
      const unchanged = previous !== undefined && !vectorImproved(previous, batch.counter_vector);
      if (input.manifest.loop.abort_on_no_progress && unchanged) { reason = "no_progress"; break; }
      previous = batch.counter_vector;
      if (roundNumber === input.manifest.loop.max_rounds) reason = "max_rounds";
    }
  } catch (error) {
    // A store write or another round-body throw is a failed run, not a cap.
    reason = "run_failed";
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    input.signal?.removeEventListener("abort", onAbort);
    abandoned = await waitForAbandoned(pending, abandonWaitMs);
    lease?.release();
    input.store.appendEvent({ run_id: run.id, event_type: "stopped", payload: {
      stop_reason: reason, rounds, ...(abandoned ? { abandoned: true } : {}), ...(failure !== undefined ? { error: failure } : {}),
    } });
  }
  return { run_id: run.id, stop_reason: reason, rounds, ...(abandoned ? { abandoned: true } : {}) };
}
