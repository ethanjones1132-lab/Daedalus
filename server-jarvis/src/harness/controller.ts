import { manifestHash, validateManifest, type HarnessManifest } from "./manifest";
import type { HarnessRoundInput, HarnessSensorResultInput, HarnessStore } from "./store";

export type HarnessStopReason = "passed" | "max_rounds" | "cancelled" | "approval_denied" | "no_progress" | "maker_failed" | "checker_rejected" | "deadline";

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
  signal?: AbortSignal;
  now?: () => number;
  /** Maximum total elapsed time, including admission wait. Defaults to 30 minutes. */
  deadline_ms?: number;
  admission: HarnessAdmission;
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

function vectorImproved(previous: HarnessRoundInput["counter_vector"] | undefined, current: HarnessRoundInput["counter_vector"]): boolean {
  if (!previous) return false;
  const comparable = Object.keys(current).filter((key) => typeof previous[key] === "number" && typeof current[key] === "number");
  return comparable.length > 0 && comparable.every((key) => (current[key] as number) <= (previous[key] as number)) &&
    comparable.some((key) => (current[key] as number) < (previous[key] as number));
}

/** Runs a maker/sensor/checker loop with app-owned durable evidence and injected execution boundaries. */
export async function runHarness(input: HarnessControllerInput): Promise<{ run_id: string; stop_reason: HarnessStopReason; rounds: number }> {
  const checked = validateManifest(input.manifest);
  if (!checked.ok) throw new Error(`Invalid harness manifest: ${checked.errors.join("; ")}`);
  if (input.manifest.checker.enabled && input.manifest.checker.agent_id === input.manifest.maker_agent_id) {
    throw new Error("checker agent must differ from maker agent");
  }
  const now = input.now ?? Date.now;
  const startedAt = now();
  const deadlineAt = startedAt + (input.deadline_ms ?? 30 * 60 * 1000);
  if (!Number.isFinite(deadlineAt) || deadlineAt <= startedAt) throw new Error("deadline_ms must be a positive finite duration");
  const run = input.store.createRun({ project_root: input.manifest.project_root, manifest_id: input.manifest.id, manifest_hash: manifestHash(input.manifest) });
  const abort = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let reason: HarnessStopReason = "max_rounds";
  let rounds = 0;
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
      try { maker = await waitWithAbort(input.runMaker({ manifest: input.manifest, round: roundNumber, signal: abort.signal }), abort.signal); }
      catch { reason = input.signal?.aborted ? "cancelled" : now() >= deadlineAt ? "deadline" : "maker_failed"; break; }
      if (input.signal?.aborted || abort.signal.aborted || now() >= deadlineAt) { reason = input.signal?.aborted ? "cancelled" : "deadline"; break; }
      if (maker?.failed) { reason = "maker_failed"; break; }
      let batch: HarnessSensorBatch;
      try { batch = await waitWithAbort(input.sensors({ manifest: input.manifest, signal: abort.signal }), abort.signal); }
      catch { reason = input.signal?.aborted ? "cancelled" : now() >= deadlineAt ? "deadline" : "no_progress"; break; }
      if (input.signal?.aborted || abort.signal.aborted || now() >= deadlineAt) { reason = input.signal?.aborted ? "cancelled" : "deadline"; break; }
      const round = input.store.appendRound({ run_id: run.id, round_number: roundNumber, counter_vector: batch.counter_vector });
      for (const result of batch.sensors) {
        const isZero = result.status === "zero" && Number.isInteger(result.counter) && result.counter === 0 && result.exit_code === 0;
        const status: HarnessSensorResultInput["status"] = isZero ? "passed" : result.status === "not_applicable" ? "not_applicable" : "failed";
        input.store.appendSensorResult({ run_id: run.id, round_id: round.id, sensor_id: result.sensor_id, status,
          counter: result.counter, exit_code: result.exit_code ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
      }
      const required = input.manifest.sensors.filter((sensor) => sensor.required);
      const allRequiredZero = required.length > 0 && required.every((sensor) => {
        const result = batch.sensors.find((entry) => entry.sensor_id === sensor.id);
        return result?.status === "zero" && Number.isInteger(result.counter) && result.counter === 0 && result.exit_code === 0;
      });
      if (allRequiredZero) {
        if (input.manifest.checker.enabled) {
          try {
            const checkedByAgent = await waitWithAbort(input.runChecker({ manifest: input.manifest, signal: abort.signal }), abort.signal);
            if (input.signal?.aborted || abort.signal.aborted || now() >= deadlineAt) { reason = input.signal?.aborted ? "cancelled" : "deadline"; break; }
            reason = checkedByAgent.passed ? "passed" : "checker_rejected";
          } catch { reason = input.signal?.aborted ? "cancelled" : now() >= deadlineAt ? "deadline" : "checker_rejected"; }
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
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    input.signal?.removeEventListener("abort", onAbort);
    lease?.release();
    input.store.appendEvent({ run_id: run.id, event_type: "stopped", payload: { stop_reason: reason, rounds } });
  }
  return { run_id: run.id, stop_reason: reason, rounds };
}
