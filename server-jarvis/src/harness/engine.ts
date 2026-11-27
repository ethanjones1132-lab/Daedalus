import { DEFAULT_ORCHESTRATOR_AGENTS, type OrchestratorAgent } from "../orchestration/agent-pool";
import { agentFamily, modelFamily, resolveHarnessAgent } from "./agents";
import type {
  HarnessControllerInput,
  HarnessMakerFailure,
  HarnessRunResult,
  HarnessSensorBatch,
  HarnessStopReason,
} from "./controller";
import { manifestHash, validateManifest, type HarnessManifest } from "./manifest";
import { getHarness, type EngineEvent, type EngineState, type HarnessRoundPolicy, type RunBudget } from "./module";
import type { HarnessRoundInput, HarnessSensorResultInput } from "./store";

export const DEFAULT_RUN_BUDGET: Readonly<RunBudget> = Object.freeze({
  max_rounds: 15, max_ms: 1_800_000, max_cloud_usd: 0.50,
});
const DEFAULT_ABANDON_WAIT_MS = 2000;
/** Largest timeout representable by setTimeout. Greater finite requests are clamped. */
export const MAX_DEADLINE_MS = 2 ** 31 - 1;

export interface EngineControl {
  state(): EngineState;
  attach(id: string, params: unknown, reason: string): void;
  switch(id: string, params: unknown, reason: string): void;
  /** Charge trusted cloud work before dispatch when its cost is absent from the maker result. */
  chargeCloud(usd: number): void;
}

export interface EngineInput extends HarnessControllerInput {
  budget?: Partial<RunBudget>;
  initial: { id: string; params?: unknown };
  onControl?: (control: EngineControl) => void;
  onRound?: (policy: HarnessRoundPolicy, state: EngineState) => void;
  /** Preserve the shipped, non-switchable controller's limits and event contract. */
  legacyWorker?: boolean;
}

function attachment(id: string, params: unknown) {
  const { module, hash } = getHarness(id);
  const metadata: EngineState["attached"] = { id, version: module.version, hash, params: structuredClone(params ?? null) };
  return { module, metadata };
}

function runBudget(input: EngineInput): RunBudget {
  const configured = input.budget;
  const budget = {
    max_rounds: configured?.max_rounds ?? DEFAULT_RUN_BUDGET.max_rounds,
    max_ms: configured?.max_ms ?? DEFAULT_RUN_BUDGET.max_ms,
    max_cloud_usd: configured?.max_cloud_usd ?? DEFAULT_RUN_BUDGET.max_cloud_usd,
  };
  if (!Number.isSafeInteger(budget.max_rounds) || budget.max_rounds < 1) {
    throw new Error("Run max_rounds must be a positive safe integer");
  }
  if (!Number.isFinite(budget.max_ms) || budget.max_ms <= 0) throw new Error("Run max_ms must be a positive finite duration");
  if (!Number.isFinite(budget.max_cloud_usd) || budget.max_cloud_usd < 0) {
    throw new Error("Run max_cloud_usd must be a non-negative finite amount");
  }
  return budget;
}

/** Settle aborted steps for at most the configured wait before recording the result. */
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
      signal.removeEventListener("abort", onAbort); reject(error);
    });
  });
}

function isPassingSensorResult(result: HarnessSensorBatch["sensors"][number]): boolean {
  return result.status === "zero" && Number.isInteger(result.counter) && result.counter === 0 && result.exit_code === 0;
}

function vectorImproved(previous: HarnessRoundInput["counter_vector"], current: HarnessRoundInput["counter_vector"]): boolean {
  const comparable = Object.keys(current).filter((key) => typeof previous[key] === "number" && typeof current[key] === "number");
  return comparable.length > 0 && comparable.every((key) => (current[key] as number) <= (previous[key] as number)) &&
    comparable.some((key) => (current[key] as number) < (previous[key] as number));
}

export interface HarnessPreCreateInput {
  manifest: HarnessManifest;
  agents?: readonly OrchestratorAgent[];
  localMakerModel?: (input: { manifest: HarnessManifest; signal: AbortSignal }) => string | undefined;
  signal?: AbortSignal;
}

/**
 * The refusals that must land before a run record exists: manifest validity and
 * the checker's independence from the maker. Shared with the start route so a
 * refused start can answer 400 with this reason instead of a 202 whose run_id
 * never becomes readable. Returns the refusal message, or undefined to start.
 */
export function harnessPreCreateRefusal(input: HarnessPreCreateInput): string | undefined {
  const checked = validateManifest(input.manifest);
  if (!checked.ok) return `Invalid harness manifest: ${checked.errors.join("; ")}`;
  const { manifest } = input;
  if (!manifest.checker.enabled) return undefined;
  const makerAgentId = manifest.maker_agent_id;
  const checkerAgentId = manifest.checker.agent_id;
  if (checkerAgentId === makerAgentId) return "checker agent must differ from maker agent";
  const agents = input.agents ?? DEFAULT_ORCHESTRATOR_AGENTS;
  const checker = resolveHarnessAgent(agents, checkerAgentId, "reviewer");
  const localModel = input.localMakerModel?.({ manifest, signal: input.signal ?? new AbortController().signal });
  const maker = localModel === undefined ? resolveHarnessAgent(agents, makerAgentId, "executor") : undefined;
  const makerFamily = localModel !== undefined ? modelFamily(localModel) : maker ? agentFamily(maker) : "";
  const checkerFamily = checker ? agentFamily(checker) : "";
  if (makerFamily && checkerFamily && makerFamily === checkerFamily) {
    return `Invalid harness manifest: checker agent "${checkerAgentId}" and maker agent "${makerAgentId}" ` +
      `resolve to the same model family "${makerFamily}"`;
  }
  return undefined;
}

export async function runEngine(input: EngineInput): Promise<HarnessRunResult> {
  const { manifest, store, legacyWorker } = input;
  const abort = new AbortController();
  const refusal = harnessPreCreateRefusal({
    manifest,
    ...(input.agents ? { agents: input.agents } : {}),
    ...(input.localMakerModel ? { localMakerModel: input.localMakerModel } : {}),
    signal: abort.signal,
  });
  if (refusal) throw new Error(refusal);
  const now = input.now ?? Date.now;
  const startedAt = now();
  const budget = runBudget(input);
  if (input.deadline_ms !== undefined && (!Number.isFinite(input.deadline_ms) || input.deadline_ms <= 0)) {
    throw new Error("deadline_ms must be a positive finite duration");
  }
  const callerDeadline = Math.min(input.deadline_ms ?? Infinity, MAX_DEADLINE_MS);
  const engineDeadline = Math.min(budget.max_ms, MAX_DEADLINE_MS);
  const deadlineMs = legacyWorker ? Math.min(input.deadline_ms ?? DEFAULT_RUN_BUDGET.max_ms, MAX_DEADLINE_MS) :
    Math.min(callerDeadline, engineDeadline);
  const deadlineAt = startedAt + deadlineMs;
  if (!Number.isFinite(deadlineAt) || deadlineAt <= startedAt) throw new Error("deadline_ms must be a positive finite duration");
  const deadlineReason = legacyWorker || (input.deadline_ms !== undefined && callerDeadline <= engineDeadline) ? "deadline" : "run_budget";
  const manifestCap = manifest.max_cost_usd ?? Infinity;
  const cloudCap = legacyWorker ? manifestCap : Math.min(manifestCap, budget.max_cloud_usd);
  const cloudStopReason = legacyWorker || manifestCap <= budget.max_cloud_usd ? "budget_exceeded" : "run_budget";
  const abandonWaitMs = input.abandon_wait_ms ?? DEFAULT_ABANDON_WAIT_MS;
  if (!Number.isFinite(abandonWaitMs) || abandonWaitMs < 0) throw new Error("abandon_wait_ms must be a non-negative finite duration");
  let attached = attachment(input.initial.id, input.initial.params);
  let queued: { attachment: typeof attached; kind: "attach" | "switch"; reason: string } | undefined;
  const run = store.createRun({ id: input.run_id, project_root: manifest.project_root, manifest_id: manifest.id, manifest_hash: manifestHash(manifest) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut: HarnessStopReason | undefined;
  let reason: HarnessStopReason = "max_rounds";
  let detail: string | undefined;
  let failure: string | undefined;
  /** The failed maker turn's own cause, when it carried one. */
  let makerFailure: HarnessMakerFailure | undefined;
  let abandoned = false;
  let active = false;
  let rounds = 0;
  let attachedRounds = 0;
  let attachedAt = startedAt;
  let cloudSpent = 0;
  let attachedSpend = 0;
  let lastSensors: HarnessSensorBatch | undefined;
  const history: EngineEvent[] = [];
  const budgetLeft = (): RunBudget => ({
    max_rounds: Math.max(0, budget.max_rounds - rounds),
    max_ms: Math.max(0, deadlineAt - now()),
    max_cloud_usd: Math.max(0, cloudCap - cloudSpent),
  });
  const state = (): EngineState => structuredClone({
    run_id: run.id, round: rounds, attached: attached.metadata, last_sensors: lastSensors, history, budget_left: budgetLeft(),
  });
  const record = (kind: EngineEvent["kind"], why: string, extra?: object) => {
    if (legacyWorker) return;
    const event: EngineEvent = { at: now(), kind, harness_id: attached.metadata.id, reason: why,
      detail: { attached: structuredClone(attached.metadata), budget_left: budgetLeft(), round: rounds, ...extra } };
    store.appendEvent({ run_id: run.id, event_type: kind, payload: event });
    history.push(event);
  };
  const queue = (kind: "attach" | "switch", id: string, params: unknown, why: string) => {
    if (legacyWorker) throw new Error("The fixed worker cannot switch harnesses");
    if (!active || elapsedStop()) throw new Error("Harness run is not active");
    if (typeof why !== "string" || !why.trim()) throw new Error("Harness selection requires a reason");
    queued = { attachment: attachment(id, params), kind, reason: why };
  };
  const addCost = (usd: number) => {
    cloudSpent = store.addRunCost({ run_id: run.id, cost_usd: usd });
    attachedSpend += usd;
  };
  const control: EngineControl = {
    state,
    attach: (...args) => queue("attach", ...args),
    switch: (...args) => queue("switch", ...args),
    chargeCloud(usd) {
      if (!active || elapsedStop()) throw new Error("Harness run is not active");
      if (!Number.isFinite(usd) || usd < 0) throw new Error("Cloud charge must be a non-negative finite amount");
      if (cloudSpent + usd > cloudCap) throw new Error("Charge exceeds the run cloud budget");
      if (attachedSpend + usd > (attached.module.limits.max_cloud_usd ?? Infinity)) {
        throw new Error("Charge exceeds the attachment cloud budget");
      }
      if (usd > 0) addCost(usd);
    },
  };
  const attachmentDeadline = () => attachedAt + (attached.module.limits.max_ms ?? Infinity);
  const armDeadline = () => {
    if (timer !== undefined) clearTimeout(timer);
    const at = Math.min(deadlineAt, attachmentDeadline());
    timer = setTimeout(() => {
      timedOut = deadlineAt <= attachmentDeadline() ? deadlineReason : "harness_stop";
      abort.abort();
    }, Math.min(MAX_DEADLINE_MS, Math.max(0, at - now())));
  };
  const elapsedStop = (): HarnessStopReason | undefined => {
    if (input.signal?.aborted) return "cancelled";
    if (timedOut) return timedOut;
    if (now() >= deadlineAt) return deadlineReason;
    if (now() >= attachmentDeadline()) return "harness_stop";
  };
  const spendStop = (): HarnessStopReason | undefined => {
    const attachmentCap = attached.module.limits.max_cloud_usd;
    if (cloudSpent > 0 && cloudSpent >= cloudCap) return cloudStopReason;
    if (attachedSpend > 0 && attachmentCap !== undefined && attachedSpend >= attachmentCap) return "harness_stop";
  };
  const roundStop = () => elapsedStop() ?? (legacyWorker ? undefined : spendStop());
  const stepFailure = (error: unknown): HarnessStopReason => {
    const stopped = elapsedStop();
    if (stopped) return stopped;
    failure = error instanceof Error ? error.message : String(error);
    return "run_failed";
  };
  const pending = new Set<Promise<unknown>>();
  const wait = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    const forget = () => { pending.delete(work); };
    work.then(forget, forget);
    return waitWithAbort(work, abort.signal);
  };
  const onAbort = () => abort.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) abort.abort();
  armDeadline();

  let lease: { release(): void } | undefined;
  let detach: (() => void) | undefined;
  try {
    active = true;
    record("attach", "initial harness");
    attached.module.onAttach?.(state());
    detach = () => attached.module.onDetach?.(state());
    input.onControl?.(control);
    const beforeAdmission = elapsedStop();
    if (beforeAdmission) reason = beforeAdmission;
    else {
      try {
        const admission = input.admission.acquire({ workClass: "background", signal: abort.signal,
          deadlineAt: Math.min(deadlineAt, attachmentDeadline()) }).then((acquired) => {
          if (abort.signal.aborted) acquired.release();
          else lease = acquired;
        });
        await wait(admission);
      }
      catch { reason = elapsedStop() ?? "approval_denied"; }
    }
    const baselines = Object.fromEntries(manifest.sensors.filter((sensor) => sensor.baseline !== undefined)
      .map((sensor) => [sensor.id, sensor.baseline!]));
    let previous: HarnessRoundInput["counter_vector"] | undefined = Object.keys(baselines).length ? baselines : undefined;
    const declaredSensors = new Map(manifest.sensors.map((sensor) => [sensor.id, sensor] as const));

    while (lease) {
      // The existing controller applies the manifest dollar cap only when a further round could run.
      if (legacyWorker && attachedRounds >= manifest.loop.max_rounds) break;
      const stop = elapsedStop() ?? spendStop();
      if (stop) { reason = stop; break; }
      if (rounds >= budget.max_rounds) { reason = "run_budget"; break; }
      if (queued) {
        const change = queued;
        queued = undefined;
        const previousDetach = detach;
        detach = undefined;
        previousDetach?.();
        const from = attached.metadata;
        attached = change.attachment;
        attachedRounds = 0;
        attachedAt = now();
        attachedSpend = 0;
        armDeadline();
        record(change.kind, change.reason, { from });
        attached.module.onAttach?.(state());
        detach = () => attached.module.onDetach?.(state());
      }
      if (attachedRounds >= Math.min(manifest.loop.max_rounds, attached.module.limits.max_rounds)) break;
      rounds++;
      attachedRounds++;
      const policy = attached.module.beforeRound(state());
      const focus = policy.sensor_ids === undefined ? undefined : new Set(policy.sensor_ids);
      if (focus && [...focus].some((id) => !declaredSensors.has(id))) throw new Error("Harness selected an undeclared sensor");
      input.onRound?.(structuredClone(policy), state());
      const beforeMaker = roundStop();
      if (beforeMaker) { reason = beforeMaker; break; }
      let maker: Awaited<ReturnType<typeof input.runMaker>>;
      try {
        maker = await wait(input.runMaker({
          manifest, round: rounds, signal: abort.signal,
          ...(input.briefValues !== undefined ? { briefValues: input.briefValues } : {}),
        }));
      } catch { reason = elapsedStop() ?? "maker_failed"; break; }
      const roundCost = maker?.cost_usd;
      if (typeof roundCost === "number" && Number.isFinite(roundCost) && roundCost > 0) addCost(roundCost);
      const afterMaker = elapsedStop();
      if (afterMaker) { reason = afterMaker; break; }
      if (maker?.failed) {
        reason = "maker_failed";
        // The delegate's real cause, never a replacement for `maker_failed`:
        // `delegate_timeout` stays visible as its own code.
        makerFailure = {
          ...(maker.errorCode !== undefined ? { errorCode: maker.errorCode } : {}),
          ...(maker.terminalStatus !== undefined ? { terminalStatus: maker.terminalStatus } : {}),
          ...(maker.failureDetail !== undefined ? { failureDetail: maker.failureDetail } : {}),
        };
        break;
      }
      const exhausted = legacyWorker ? undefined : spendStop();
      if (exhausted) { reason = exhausted; break; }

      let batch: HarnessSensorBatch;
      try { batch = await wait(input.sensors({ manifest, signal: abort.signal })); }
      catch (error) { reason = stepFailure(error); break; }
      const afterSensors = roundStop();
      if (afterSensors) { reason = afterSensors; break; }
      lastSensors = batch;
      const round = store.appendRound({ run_id: run.id, round_number: rounds, counter_vector: batch.counter_vector });
      for (const result of batch.sensors) {
        const status: HarnessSensorResultInput["status"] = isPassingSensorResult(result) ? "passed" :
          result.status === "not_applicable" ? "not_applicable" : "failed";
        store.appendSensorResult({ run_id: run.id, round_id: round.id, sensor_id: result.sensor_id, status,
          counter: result.counter, exit_code: result.exit_code ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
      }
      if (batch.sensors.some((result) => result.status === "unapproved")) { reason = "approval_denied"; break; }
      const focused = focus ? {
        sensors: batch.sensors.filter((result) => focus.has(result.sensor_id)),
        counter_vector: Object.fromEntries(Object.entries(batch.counter_vector).filter(([id]) => focus.has(id))),
      } : batch;
      const decision = attached.module.afterSensors(state(), structuredClone(focused));
      if (decision.kind === "stop") { reason = "harness_stop"; detail = decision.reason; break; }
      if (decision.kind === "suggest_switch") {
        store.appendEvent({ run_id: run.id, event_type: "suggest_switch", payload: { ...decision, round: rounds } });
      }

      // Approvals bind the full manifest hash. A focus can narrow policy evidence,
      // while the sensor execution boundary still receives the original manifest.
      // Optional checks are evidence too. Only manifest-declared unavailable checks can be N/A.
      const evidenceComplete = (!focus || focus.size === declaredSensors.size) &&
        batch.sensors.every((result) => isPassingSensorResult(result) ||
          (result.status === "not_applicable" && declaredSensors.get(result.sensor_id)?.kind === "unavailable")) &&
        manifest.sensors.every((sensor) => batch.sensors.some((result) => result.sensor_id === sensor.id));
      if (evidenceComplete && manifest.checker.enabled && !policy.skip_checker) {
        try {
          // The trusted execution boundary owns model selection and the independent verdict.
          const verdict = await wait(input.runChecker({
            manifest, signal: abort.signal,
            ...(input.briefValues !== undefined ? { briefValues: input.briefValues } : {}),
          }));
          // Who reviewed, not just whether it passed. A checker cascade can
          // advance past the manifest's agent, so the event pairs the requested
          // agent with the model that actually answered. An unreported identity
          // stays null instead of borrowing the requested name.
          store.appendEvent({ run_id: run.id, event_type: "checker_verdict", payload: {
            round: rounds,
            passed: verdict.passed,
            requested_agent_id: manifest.checker.agent_id,
            model: verdict.model?.model_id ? {
              model_id: verdict.model.model_id,
              ...(verdict.model.provider !== undefined ? { provider: verdict.model.provider } : {}),
              fallback_used: verdict.model.fallback_used === true,
            } : null,
            ...(verdict.model?.model_id ? {} : { model_identity: "unavailable" }),
          } });
          reason = roundStop() ?? (verdict.passed ? "passed" : "checker_rejected");
        } catch (error) { reason = stepFailure(error); }
        break;
      }
      if (legacyWorker && evidenceComplete && !manifest.checker.enabled && manifest.sensors.some((sensor) =>
        sensor.required && batch.sensors.some((result) => sensor.id === result.sensor_id && isPassingSensorResult(result)))) {
        reason = "passed";
        break;
      }
      if (rounds >= budget.max_rounds) { reason = "run_budget"; break; }
      if (!queued && (legacyWorker || !evidenceComplete) && manifest.loop.abort_on_no_progress && previous &&
        !vectorImproved(previous, batch.counter_vector)) {
        reason = "no_progress";
        break;
      }
      previous = batch.counter_vector;
    }
  } catch (error) {
    reason = "run_failed";
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    abandoned = await waitForAbandoned(pending, abandonWaitMs);
    lease?.release();
    try { detach?.(); }
    catch (error) {
      reason = "run_failed";
      failure ??= error instanceof Error ? error.message : String(error);
    }
    record("stop", detail ?? reason, { stop_reason: reason, abandoned, ...(makerFailure ?? {}) });
    store.appendEvent({ run_id: run.id, event_type: "stopped", payload: {
      stop_reason: reason, rounds, ...(cloudSpent > 0 ? { cost_usd: cloudSpent } : {}),
      ...(abandoned ? { abandoned: true } : {}), ...(failure !== undefined ? { error: failure } : {}),
      ...(makerFailure ?? {}),
    } });
  }
  return { run_id: run.id, stop_reason: reason, rounds, ...(abandoned ? { abandoned: true } : {}) };
}
