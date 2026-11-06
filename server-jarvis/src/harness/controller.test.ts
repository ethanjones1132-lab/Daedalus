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
});
