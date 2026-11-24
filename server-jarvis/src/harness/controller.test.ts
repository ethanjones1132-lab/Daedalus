import { describe, expect, test } from "bun:test";
import { HarnessStore } from "./store";
import { runHarness, type HarnessSensorBatch, type HarnessStopReason } from "./controller";
import type { HarnessManifest } from "./manifest";

function manifest(): HarnessManifest {
  return {
    schema_version: 1, id: "bugfix", project_root: "/workspace/project", project_kind: "typescript",
    purpose: "bug_fix", template_family: "typescript_node",
    guides: { rules: [], brief_template: "", skills: [], references: [], banned_defaults: [] },
    maker_agent_id: "maker", checker: { enabled: true, agent_id: "checker", rubric: "independent" },
    sensors: [{ id: "tests", kind: "command", command_id: "bun_test", args: [], timeout_ms: 1000,
      zero_threshold: 0, failure_message: "tests fail", required: true }],
    loop: { max_rounds: 5, abort_on_no_progress: true }, approval: { required_for_new_commands: true },
  };
}

const zero: HarnessSensorBatch = { counter_vector: { tests: 0 }, sensors: [{ sensor_id: "tests", status: "zero", counter: 0, exit_code: 0 }] };
const failing = (count: number): HarnessSensorBatch => ({ counter_vector: { tests: count }, sensors: [{ sensor_id: "tests", status: "nonzero", counter: count, exit_code: 1 }] });

function deps(overrides: Partial<Parameters<typeof runHarness>[0]> = {}) {
  const store = new HarnessStore({ dbPath: ":memory:" });
  const item = manifest();
  let sensorCalls = 0;
  const input: Parameters<typeof runHarness>[0] = {
    manifest: item, store, admission: { acquire: async () => ({ release() {} }) },
    runMaker: async () => ({}), runChecker: async () => ({ passed: true }), sensors: async () => { sensorCalls++; return zero; },
    ...overrides,
  };
  return { input, store, get sensorCalls() { return sensorCalls; } };
}

async function resultWithReason(reason: HarnessStopReason, overrides: Partial<Parameters<typeof runHarness>[0]> = {}) {
  const setup = deps(overrides);
  const result = await runHarness(setup.input);
  expect(result.stop_reason).toBe(reason);
  expect(setup.store.getRun(result.run_id)?.events.filter((event) => event.event_type === "stopped" &&
    (event.payload as { stop_reason?: string }).stop_reason === reason)).toHaveLength(1);
  return { ...setup, result };
}

describe("runHarness", () => {
  test("passes on round one and runs checker only after computational zero", async () => {
    let checks = 0;
    const { result, store } = await resultWithReason("passed", { runChecker: async () => { checks++; return { passed: true }; } });
    expect(result.rounds).toBe(1);
    expect(checks).toBe(1);
    expect(store.getRun(result.run_id)?.rounds).toHaveLength(1);
  });

  test("continues improving rounds and passes on round three", async () => {
    let call = 0;
    const { result } = await resultWithReason("passed", { sensors: async () => [failing(4), failing(2), zero][call++]! });
    expect(result.rounds).toBe(3);
  });

  test("stops at the manifest round cap", async () => {
    let call = 0;
    const item = manifest(); item.loop.max_rounds = 2;
    const { result } = await resultWithReason("max_rounds", { manifest: item, sensors: async () => failing(5 - call++) });
    expect(result.rounds).toBe(2);
  });

  test("aborts a repeated counter vector even if maker requests more work", async () => {
    let makers = 0;
    const { result } = await resultWithReason("no_progress", {
      runMaker: async () => { makers++; return { continue: true }; }, sensors: async () => failing(3),
    });
    expect(result.rounds).toBe(2);
    expect(makers).toBe(2);
  });

  test("records cancellation during a maker round", async () => {
    const abort = new AbortController();
    const { result, sensorCalls } = await resultWithReason("cancelled", {
      signal: abort.signal, runMaker: async () => { abort.abort(); return {}; },
    });
    expect(result.rounds).toBe(1);
    expect(sensorCalls).toBe(0);
  });

  test("waits for an aborted maker before releasing the lease and recording the stop", async () => {
    const abort = new AbortController();
    let makerSettled = false;
    let leaseReleased = false;
    let releasedAfterMaker = false;
    let notifyStarted!: () => void;
    const makerStarted = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let finishMaker!: () => void;
    const makerWork = new Promise<void>((resolve) => { finishMaker = resolve; });
    const setup = deps({
      signal: abort.signal,
      admission: { acquire: async () => ({ release() { leaseReleased = true; releasedAfterMaker = makerSettled; } }) },
      runMaker: async () => { notifyStarted(); await makerWork; makerSettled = true; return {}; },
    });
    const run = runHarness(setup.input);
    await makerStarted;
    abort.abort();
    let resolvedEarly = false;
    run.then(() => { resolvedEarly = true; });
    await Bun.sleep(20);
    expect(resolvedEarly).toBe(false);
    expect(leaseReleased).toBe(false);
    finishMaker();
    const result = await run;
    expect(result.stop_reason).toBe("cancelled");
    expect(result.abandoned).toBeUndefined();
    expect(leaseReleased).toBe(true);
    expect(releasedAfterMaker).toBe(true);
    const stopped = setup.store.getRun(result.run_id)?.events.filter((event) => event.event_type === "stopped") ?? [];
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.payload).toEqual({ stop_reason: "cancelled", rounds: 1 });
  });

  test("records the abandoning fact when an aborted maker outlives the bounded wait", async () => {
    const abort = new AbortController();
    let notifyStarted!: () => void;
    const makerStarted = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const setup = deps({
      signal: abort.signal,
      abandon_wait_ms: 25,
      runMaker: async () => { notifyStarted(); await new Promise<void>(() => {}); },
    });
    const run = runHarness(setup.input);
    await makerStarted;
    const startedAt = Date.now();
    abort.abort();
    const result = await run;
    expect(result.stop_reason).toBe("cancelled");
    expect(result.abandoned).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    const stopped = setup.store.getRun(result.run_id)?.events.filter((event) => event.event_type === "stopped") ?? [];
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.payload).toEqual({ stop_reason: "cancelled", rounds: 1, abandoned: true });
  });

  test("records run_failed, never max_rounds, when the store throws mid-round", async () => {
    const setup = deps();
    setup.store.appendRound = () => { throw new Error("disk full"); };
    const result = await runHarness(setup.input);
    expect(result.stop_reason).toBe("run_failed");
    const stopped = setup.store.getRun(result.run_id)?.events.filter((event) => event.event_type === "stopped") ?? [];
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.payload).toEqual({ stop_reason: "run_failed", rounds: 1, error: "disk full" });
  });

  test("records a deadline reached during a maker round", async () => {
    let time = 100;
    const { result, sensorCalls } = await resultWithReason("deadline", {
      now: () => time, deadline_ms: 10, runMaker: async () => { time = 110; return {}; },
    });
    expect(sensorCalls).toBe(0);
    expect(result.rounds).toBe(1);
  });

  test("does not call checker when required sensors fail", async () => {
    let checks = 0;
    await resultWithReason("no_progress", { sensors: async () => failing(1), runChecker: async () => { checks++; return { passed: true }; } });
    expect(checks).toBe(0);
  });

  test("records checker rejection", async () => {
    await resultWithReason("checker_rejected", { runChecker: async () => ({ passed: false }) });
  });

  test("creates the run with a caller-supplied id so it can be addressed while in flight", async () => {
    const setup = deps({ run_id: "run-in-flight" });
    const result = await runHarness(setup.input);
    expect(result.run_id).toBe("run-in-flight");
    expect(setup.store.getRun("run-in-flight")?.id).toBe("run-in-flight");
  });

  test("refuses same-agent checker before creating a run", async () => {
    const setup = deps(); setup.input.manifest.checker.agent_id = "maker";
    await expect(runHarness(setup.input)).rejects.toThrow(/differ from maker/);
  });

  test("records maker failure and admission denial once", async () => {
    await resultWithReason("maker_failed", { runMaker: async () => { throw new Error("failed"); } });
    await resultWithReason("approval_denied", { admission: { acquire: async () => { throw new Error("denied"); } } });
  });

  test("stops when a sensor reports missing command approval", async () => {
    await resultWithReason("approval_denied", { sensors: async () => ({ counter_vector: { tests: null },
      sensors: [{ sensor_id: "tests", status: "unapproved", counter: null }] }) });
  });

  test("a manifest with no required sensors still reaches the checker and settles on its acceptance", async () => {
    const item = manifest(); item.sensors = [];
    let checks = 0;
    const { result } = await resultWithReason("passed", {
      manifest: item,
      sensors: async () => ({ counter_vector: {}, sensors: [] }),
      runChecker: async () => { checks++; return { passed: true }; },
    });
    expect(checks).toBe(1);
    expect(result.rounds).toBe(1);
  });

  test("a manifest with no required sensors settles checker_rejected when the checker rejects", async () => {
    const item = manifest(); item.sensors = [];
    let checks = 0;
    await resultWithReason("checker_rejected", {
      manifest: item,
      sensors: async () => ({ counter_vector: {}, sensors: [] }),
      runChecker: async () => { checks++; return { passed: false }; },
    });
    expect(checks).toBe(1);
  });

  test("a failing optional sensor blocks the pass instead of passing silently", async () => {
    const item = manifest();
    item.sensors = [...item.sensors, { id: "lint", kind: "command", command_id: "bun_typecheck", args: [], timeout_ms: 1000,
      zero_threshold: 0, failure_message: "lint fails", required: false }];
    let checks = 0;
    const { result } = await resultWithReason("no_progress", {
      manifest: item,
      runChecker: async () => { checks++; return { passed: true }; },
      sensors: async () => ({ counter_vector: { tests: 0, lint: 1 }, sensors: [
        { sensor_id: "tests", status: "zero", counter: 0, exit_code: 0 },
        { sensor_id: "lint", status: "nonzero", counter: 1, exit_code: 1 },
      ] }),
    });
    expect(result.stop_reason).not.toBe("passed");
    expect(checks).toBe(0);
  });

  test("an unavailable sensor's not_applicable result does not block a pass", async () => {
    const item = manifest();
    item.sensors = [...item.sensors, { id: "publishing", kind: "unavailable", args: [], timeout_ms: 1,
      zero_threshold: 0, failure_message: "unavailable", required: false }];
    const { result } = await resultWithReason("passed", {
      manifest: item,
      sensors: async () => ({ counter_vector: { tests: 0, publishing: "not_applicable" }, sensors: [
        { sensor_id: "tests", status: "zero", counter: 0, exit_code: 0 },
        { sensor_id: "publishing", status: "not_applicable", counter: null },
      ] }),
    });
    expect(result.rounds).toBe(1);
  });

  test("a command sensor skipped as not_applicable blocks the pass", async () => {
    const item = manifest();
    item.sensors = [...item.sensors, { id: "typecheck", kind: "command", command_id: "bun_typecheck", args: [], timeout_ms: 1000,
      zero_threshold: 0, failure_message: "typecheck has no baseline", required: false }];
    let checks = 0;
    const { result } = await resultWithReason("no_progress", {
      manifest: item,
      runChecker: async () => { checks++; return { passed: true }; },
      sensors: async () => ({ counter_vector: { tests: 0, typecheck: "not_applicable" }, sensors: [
        { sensor_id: "tests", status: "zero", counter: 0, exit_code: 0 },
        { sensor_id: "typecheck", status: "not_applicable", counter: null },
      ] }),
    });
    expect(result.stop_reason).not.toBe("passed");
    expect(checks).toBe(0);
  });
});
