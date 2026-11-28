import { expect, test } from "bun:test";
import type { HarnessControllerInput, HarnessSensorBatch } from "./controller";
import { runEngine, type EngineControl, type EngineInput } from "./engine";
import { installConsultantTools } from "./escalation";
import { registerHarness, type HarnessModule } from "./module";
import { HarnessStore } from "./store";

const zero: HarnessSensorBatch = {
  counter_vector: { tests: 0 },
  sensors: [{ sensor_id: "tests", status: "zero", counter: 0, exit_code: 0 }],
};
const failing: HarnessSensorBatch = {
  counter_vector: { tests: 3 },
  sensors: [{ sensor_id: "tests", status: "nonzero", counter: 3, exit_code: 1 }],
};

function setup(overrides: Partial<HarnessControllerInput> = {}) {
  const store = new HarnessStore({ dbPath: ":memory:" });
  const input: EngineInput = {
    manifest: {
      schema_version: 1, id: "bugfix", project_root: "/workspace/project", project_kind: "typescript",
      purpose: "bug_fix", template_family: "typescript_node",
      guides: { rules: [], brief_template: "", skills: [], references: [], banned_defaults: [] },
      maker_agent_id: "maker", checker: { enabled: true, agent_id: "checker", rubric: "independent" },
      sensors: [{ id: "tests", kind: "command", command_id: "bun_test", args: [], timeout_ms: 1000,
        zero_threshold: 0, failure_message: "tests fail", required: true }],
      loop: { max_rounds: 5, abort_on_no_progress: false }, approval: { required_for_new_commands: true },
    },
    store, admission: { acquire: async () => ({ release() {} }) },
    runMaker: async () => ({}), runChecker: async () => ({ passed: true }), sensors: async () => zero,
    initial: { id: "worker" },
    ...overrides,
  };
  return { input, store };
}

function registerTestHarness(id: string, overrides: Partial<HarnessModule> = {}) {
  registerHarness({
    id, version: "1.0.0", description: "Engine test harness", good_for: [], bad_for: [], params_schema: {},
    limits: { max_rounds: 5 }, beforeRound: () => ({ instructions: "" }),
    afterSensors: () => ({ kind: "continue" }), ...overrides,
  });
}

test("worker reproduces today's loop", async () => {
  let checks = 0;
  let calls = 0;
  const { input, store } = setup({
    sensors: async () => ++calls === 2 ? zero : failing,
    runChecker: async () => { checks++; return { passed: true }; },
  });
  const result = await runEngine(input);
  expect(result).toMatchObject({ stop_reason: "passed", rounds: 2 });
  expect(checks).toBe(1);
  expect(store.getRun(result.run_id)?.rounds.map((round) => round.counter_vector)).toEqual([{ tests: 3 }, { tests: 0 }]);

  const capped = setup({ sensors: async () => failing });
  capped.input.manifest.loop.max_rounds = 2;
  expect(await runEngine(capped.input)).toMatchObject({ stop_reason: "max_rounds", rounds: 2 });
});

test("run budget caps total rounds across switches including the switch at round 14", async () => {
  registerTestHarness("round-budget");
  let control!: EngineControl;
  const { input, store } = setup({
    sensors: async () => failing,
    runMaker: async ({ round }) => {
      if ([4, 9, 14].includes(round)) {
        control.switch(round === 9 ? "worker" : "round-budget", { round }, `switch at round ${round}`);
      }
      if (round === 15) expect(control.state().budget_left.max_rounds).toBe(0);
    },
  });
  const result = await runEngine({ ...input, onControl: (value) => { control = value; } });
  expect(result).toMatchObject({ stop_reason: "run_budget", rounds: 15 });
  expect(store.getRun(result.run_id)?.rounds).toHaveLength(15);
  expect(store.getRun(result.run_id)?.events.filter((event) => event.event_type === "switch")
    .map((event) => event.payload)).toMatchObject([
    { reason: "switch at round 4" }, { reason: "switch at round 9" }, { reason: "switch at round 14" },
  ]);
});

test("switch applies at the next round boundary", async () => {
  const seen: string[] = [];
  registerTestHarness("round-boundary", {
    beforeRound: (state) => {
      seen.push(`before ${state.round}: ${state.attached.id}`);
      return { instructions: "" };
    },
  });
  let control!: EngineControl;
  const { input } = setup({
    sensors: async () => control.state().round === 1 ? failing : zero,
    runMaker: async ({ round }) => {
      if (round === 1) control.switch("round-boundary", {}, "different policy");
      seen.push(`maker ${round}: ${control.state().attached.id}`);
    },
  });
  expect(await runEngine({ ...input, onControl: (value) => { control = value; } }))
    .toMatchObject({ stop_reason: "passed", rounds: 2 });
  expect(seen).toEqual(["maker 1: worker", "before 2: round-boundary", "maker 2: round-boundary"]);
});

test("passed requires full sensors and checker", async () => {
  registerTestHarness("evidence-gate", {
    beforeRound: ({ round }) => ({ instructions: "", skip_checker: round === 1, sensor_ids: round === 2 ? [] : undefined }),
  });
  let checks = 0;
  const { input } = setup({ runChecker: async () => { checks++; return { passed: true }; } });
  expect(await runEngine({ ...input, initial: { id: "evidence-gate" } }))
    .toMatchObject({ stop_reason: "passed", rounds: 3 });
  expect(checks).toBe(1);

  input.manifest.checker.enabled = false;
  expect(await runEngine(input)).toMatchObject({ stop_reason: "max_rounds", rounds: 5 });
  expect(checks).toBe(1);
});

test("a switch preserves elapsed time and cloud spend", async () => {
  registerTestHarness("cloud-budget");
  let time = 0;
  let control!: EngineControl;
  const { input } = setup({
    now: () => time,
    sensors: async () => failing,
    runMaker: async ({ round }) => {
      if (round === 1) {
        expect(control.state().budget_left).toEqual({ max_rounds: 14, max_ms: 1_800_000, max_cloud_usd: 0.50 });
        control.chargeCloud(0.40);
        time += 100;
        control.switch("cloud-budget", null, "switch after spend");
      } else {
        expect(control.state().budget_left.max_ms).toBe(1_799_900);
        expect(control.state().budget_left.max_cloud_usd).toBeCloseTo(0.10);
        control.chargeCloud(0.10);
      }
    },
  });
  expect(await runEngine({ ...input, onControl: (value) => { control = value; } }))
    .toMatchObject({ stop_reason: "run_budget", rounds: 2 });
});

test.each([
  { manifestCap: 0.3, secondCost: 0.12, remaining: 0.10, reason: "budget_exceeded" },
  { manifestCap: 0.8, secondCost: 0.30, remaining: 0.30, reason: "run_budget" },
])("reported maker costs across a switch use the stricter cap ($reason)", async ({ manifestCap, secondCost, remaining, reason }) => {
  const id = `reported-cloud-${reason}`;
  registerTestHarness(id);
  let control!: EngineControl;
  const { input, store } = setup({
    sensors: async () => failing,
    runMaker: async ({ round }) => {
      if (round === 1) {
        control.switch(id, null, "retry after the first charge");
        return { cost_usd: 0.20 };
      }
      expect(control.state().attached.id).toBe(id);
      expect(control.state().budget_left.max_cloud_usd).toBeCloseTo(remaining);
      expect(() => control.chargeCloud(remaining + 0.01)).toThrow(/cloud budget/);
      return { cost_usd: secondCost };
    },
  });
  input.manifest.max_cost_usd = manifestCap;
  const result = await runEngine({ ...input, onControl: (value) => { control = value; } });
  expect(result).toMatchObject({ stop_reason: reason, rounds: 2 });
  const run = store.getRun(result.run_id);
  expect(run?.cost_usd).toBeCloseTo(0.20 + secondCost);
  const stopped = run?.events.find((event) => event.event_type === "stopped");
  expect(stopped?.payload).toMatchObject({ stop_reason: reason, rounds: 2, cost_usd: run?.cost_usd });
});

test("checker spend past the cap stops with the budget reason and makes no further model call", async () => {
  let makers = 0;
  let checks = 0;
  const { input, store } = setup({
    runMaker: async () => { makers++; return { cost_usd: 0.05 }; },
    runChecker: async () => { checks++; return { passed: true, cost_usd: 0.60 }; },
  });
  input.manifest.max_cost_usd = 0.5;
  const result = await runEngine(input);
  // The checker's own spend is charged at the call site, so a verdict that
  // crossed the cap settles on the existing budget reason, not `passed`.
  expect(result).toMatchObject({ stop_reason: "budget_exceeded", rounds: 1 });
  expect(makers).toBe(1);
  expect(checks).toBe(1);
  const run = store.getRun(result.run_id);
  expect(run?.cost_usd).toBeCloseTo(0.65);
  const stopped = run?.events.find((event) => event.event_type === "stopped");
  expect(stopped?.payload).toMatchObject({ stop_reason: "budget_exceeded", rounds: 1, cost_usd: run?.cost_usd });
});

test("checker spend under the cap leaves the run passed and still records the spend", async () => {
  let makers = 0;
  const { input, store } = setup({
    runMaker: async () => { makers++; return { cost_usd: 0.05 }; },
    runChecker: async () => ({ passed: true, cost_usd: 0.10 }),
  });
  input.manifest.max_cost_usd = 0.5;
  const result = await runEngine(input);
  expect(result).toMatchObject({ stop_reason: "passed", rounds: 1 });
  expect(makers).toBe(1);
  expect(store.getRun(result.run_id)?.cost_usd).toBeCloseTo(0.15);
});

test("an already-reached cap prevents the next checker call", async () => {
  let makers = 0;
  let checks = 0;
  const { input, store } = setup({
    runMaker: async () => { makers++; return {}; },
    sensors: async () => ({ ...zero, cost_usd: 0.6 }),
    runChecker: async () => { checks++; return { passed: true }; },
  });
  input.manifest.max_cost_usd = 0.5;
  const result = await runEngine(input);
  expect(result).toMatchObject({ stop_reason: "budget_exceeded", rounds: 1 });
  expect(makers).toBe(1);
  // The checker is the next model call and never starts once the sensor pass
  // has already spent past the cap.
  expect(checks).toBe(0);
  expect(store.getRun(result.run_id)?.cost_usd).toBeCloseTo(0.6);
});

test("a sensor pass that reports its own spend is charged and stops before the next model call", async () => {
  let makers = 0;
  const { input, store } = setup({
    sensors: async () => ({ ...failing, cost_usd: 0.6 }),
    runMaker: async () => { makers++; return {}; },
  });
  input.manifest.max_cost_usd = 0.5;
  const result = await runEngine(input);
  expect(result).toMatchObject({ stop_reason: "budget_exceeded", rounds: 1 });
  // Round two's maker is the next model call and never starts.
  expect(makers).toBe(1);
  expect(store.getRun(result.run_id)?.cost_usd).toBeCloseTo(0.6);
});

test("a zero cloud budget does not stop the run for budget before its first round", async () => {
  let makers = 0;
  let control!: EngineControl;
  const { input, store } = setup({
    // Failing sensors keep the run going round after round, so a zero cap is
    // tested across the boundary where the old guard read "at the cap".
    sensors: async () => failing,
    runMaker: async () => { makers++; },
  });
  input.budget = { max_cloud_usd: 0 };
  const result = await runEngine({ ...input, onControl: (value) => { control = value; } });
  expect(result).toMatchObject({ stop_reason: "max_rounds", rounds: 5 });
  expect(makers).toBe(5);
  expect(control.state().budget_left.max_cloud_usd).toBe(0);
  expect(store.getRun(result.run_id)?.cost_usd).toBe(0);
});

test("a zero-budget run refuses a maker's reported cloud spend and labels the run cloud-budget exhausted", async () => {
  const { input, store } = setup({
    runMaker: async ({ budget_left }) => {
      expect(budget_left?.max_cloud_usd).toBe(0);
      return { cost_usd: 0.25 };
    },
  });
  input.budget = { max_cloud_usd: 0 };
  const result = await runEngine(input);
  expect(result).toMatchObject({ stop_reason: "passed", rounds: 1 });

  const run = store.getRun(result.run_id);
  // The turn's report is mirrored on the round, but the ledger is not raised.
  expect(run?.events.find((event) => event.event_type === "round_metrics")?.payload)
    .toEqual({ round: 1, cost_usd: 0.25 });
  expect(run?.cost_usd).toBe(0);
  const stopped = run?.events.find((event) => event.event_type === "stopped");
  expect(stopped?.payload).toMatchObject({ stop_reason: "passed", rounds: 1, cloud_budget: "exhausted" });
  expect((stopped?.payload as { cost_usd?: number }).cost_usd).toBeUndefined();
});

test("a zero-budget run refuses the consultation before it is bought and records the exhausted budget", async () => {
  let consults = 0;
  installConsultantTools({
    consult: async ({ signal }) => { consults++; return { report: `advice on ${signal}`, cost_usd: 0.05 }; },
  });
  try {
    const { input, store } = setup({
      // The planner rung puts the ladder one step from consult, and the maker's
      // own `continue: false` is the stuck signal that would trigger it.
      runMaker: async () => ({ continue: false }),
    });
    input.initial = { id: "planner" };
    input.escalation = true;
    input.budget = { max_cloud_usd: 0 };
    const result = await runEngine(input);

    expect(result).toMatchObject({ stop_reason: "run_budget", rounds: 1 });
    // The consultant is never called and its spend is never booked.
    expect(consults).toBe(0);
    const run = store.getRun(result.run_id);
    expect(run?.cost_usd).toBe(0);
    const events = run?.events ?? [];
    // No request event: a refused call has no report and no verdict.
    expect(events.some((event) => event.event_type === "request")).toBe(false);
    const stopped = events.find((event) => event.event_type === "stopped");
    expect(stopped?.payload).toMatchObject({ stop_reason: "run_budget", rounds: 1, cloud_budget: "exhausted" });
    expect((stopped?.payload as { cost_usd?: number }).cost_usd).toBeUndefined();
  } finally {
    installConsultantTools(undefined);
  }
});

test("a positive cloud budget still consults and charges the reported spend", async () => {
  let consults = 0;
  installConsultantTools({
    consult: async ({ signal }) => { consults++; return { report: `advice on ${signal}`, cost_usd: 0.05 }; },
  });
  try {
    const { input, store } = setup({ runMaker: async () => ({ continue: false }) });
    input.initial = { id: "planner" };
    input.escalation = true;
    input.budget = { max_cloud_usd: 0.10 };
    const result = await runEngine(input);

    expect(consults).toBe(1);
    const run = store.getRun(result.run_id);
    expect(run?.cost_usd).toBeCloseTo(0.05);
    expect(run?.events.find((event) => event.event_type === "request")?.payload)
      .toMatchObject({ detail: { escalation: { step: "consult" }, report: expect.stringContaining("advice on") } });
  } finally {
    installConsultantTools(undefined);
  }
});

test("chargeCloud allows no charge on a zero cap and still charges under a positive cap", async () => {
  let zeroControl!: EngineControl;
  const zeroRun = setup({
    runMaker: async () => { expect(() => zeroControl.chargeCloud(0.01)).toThrow(/cloud budget/); },
  });
  zeroRun.input.budget = { max_cloud_usd: 0 };
  const zeroResult = await runEngine({ ...zeroRun.input, onControl: (value) => { zeroControl = value; } });
  expect(zeroResult).toMatchObject({ stop_reason: "passed", rounds: 1 });
  expect(zeroRun.store.getRun(zeroResult.run_id)?.cost_usd).toBe(0);

  let paidControl!: EngineControl;
  const paidRun = setup({ runMaker: async () => { paidControl.chargeCloud(0.40); } });
  paidRun.input.budget = { max_cloud_usd: 0.50 };
  const paidResult = await runEngine({ ...paidRun.input, onControl: (value) => { paidControl = value; } });
  expect(paidResult).toMatchObject({ stop_reason: "passed", rounds: 1 });
  expect(paidRun.store.getRun(paidResult.run_id)?.cost_usd).toBeCloseTo(0.40);
});

test("a positive cloud cap still stops once the cap is reached, on the same budget reason", async () => {
  let makers = 0;
  const { input, store } = setup({
    sensors: async () => failing,
    runMaker: async () => { makers++; return { cost_usd: 0.05 }; },
  });
  input.budget = { max_cloud_usd: 0.05 };
  const result = await runEngine(input);
  expect(result).toMatchObject({ stop_reason: "run_budget", rounds: 1 });
  expect(makers).toBe(1);
  const run = store.getRun(result.run_id);
  expect(run?.cost_usd).toBeCloseTo(0.05);
  const stopped = run?.events.find((event) => event.event_type === "stopped");
  expect(stopped?.payload).toMatchObject({ stop_reason: "run_budget", rounds: 1, cost_usd: 0.05 });
  expect(stopped?.payload).not.toMatchObject({ cloud_budget: "exhausted" });
});

test("a failed maker turn records its delegate cause on the maker_failed stop", async () => {
  const { input, store } = setup({
    runMaker: async () => ({
      failed: true,
      errorCode: "delegate_timeout",
      terminalStatus: "timed_out",
      failureDetail: "delegate exceeded its 900000ms budget",
    }),
  });
  const result = await runEngine(input);
  expect(result.stop_reason).toBe("maker_failed");
  expect(result.rounds).toBe(1);

  const events = store.getRun(result.run_id)?.events ?? [];
  const stopped = events.find((event) => event.event_type === "stopped");
  expect(stopped?.payload).toEqual({
    stop_reason: "maker_failed", rounds: 1,
    errorCode: "delegate_timeout", terminalStatus: "timed_out",
    failureDetail: "delegate exceeded its 900000ms budget",
  });
  const stop = events.find((event) => event.event_type === "stop");
  expect((stop?.payload as { detail?: Record<string, unknown> } | undefined)?.detail).toMatchObject({
    stop_reason: "maker_failed", abandoned: false,
    errorCode: "delegate_timeout", terminalStatus: "timed_out",
    failureDetail: "delegate exceeded its 900000ms budget",
  });
});

test("a failed maker turn without a cause keeps the stop payload unchanged", async () => {
  const { input, store } = setup({ runMaker: async () => ({ failed: true }) });
  const result = await runEngine(input);
  expect(result.stop_reason).toBe("maker_failed");
  expect(store.getRun(result.run_id)?.events.find((event) => event.event_type === "stopped")?.payload)
    .toEqual({ stop_reason: "maker_failed", rounds: 1 });
});

test("a maker that throws records the thrown message on the maker_failed stop", async () => {
  const { input, store } = setup({
    runMaker: async () => { throw new Error("delegate lane crashed before its first turn"); },
  });
  const result = await runEngine(input);
  expect(result.stop_reason).toBe("maker_failed");
  expect(result.rounds).toBe(1);

  const events = store.getRun(result.run_id)?.events ?? [];
  const stopped = events.find((event) => event.event_type === "stopped");
  expect(stopped?.payload).toEqual({
    stop_reason: "maker_failed", rounds: 1,
    failureDetail: "delegate lane crashed before its first turn",
  });
  const stop = events.find((event) => event.event_type === "stop");
  expect((stop?.payload as { detail?: Record<string, unknown> } | undefined)?.detail).toMatchObject({
    stop_reason: "maker_failed", abandoned: false,
    failureDetail: "delegate lane crashed before its first turn",
  });
});

test("a longer caller deadline does not extend the switchable engine's wall budget", async () => {
  let admittedUntil: number | undefined;
  const { input } = setup({
    now: () => 100,
    deadline_ms: 3_000_000_000,
    admission: { acquire: async ({ deadlineAt }) => { admittedUntil = deadlineAt; return { release() {} }; } },
  });
  expect(await runEngine(input)).toMatchObject({ stop_reason: "passed", rounds: 1 });
  expect(admittedUntil).toBe(100 + 1_800_000);
});

test("each round's round_metrics mirrors its maker turn's usage without charging it twice", async () => {
  let call = 0;
  const { input, store } = setup({
    sensors: async () => ++call === 1 ? failing : zero,
    runMaker: async () => ({ cost_usd: 0.07, tool_calls: 4 }),
  });
  const result = await runEngine(input);
  expect(result.stop_reason).toBe("passed");
  expect(result.rounds).toBe(2);

  const run = store.getRun(result.run_id);
  // The round rows keep the counter vectors they always carried.
  expect(run?.rounds.map((round) => round.counter_vector)).toEqual([{ tests: 3 }, { tests: 0 }]);
  // One metrics event per stored round, carrying exactly what the turn reported.
  expect(run?.events.filter((event) => event.event_type === "round_metrics").map((event) => event.payload)).toEqual([
    { round: 1, tool_calls: 4, cost_usd: 0.07 },
    { round: 2, tool_calls: 4, cost_usd: 0.07 },
  ]);
  // The events mirror the spend; they never re-charge it.
  expect(run?.cost_usd).toBeCloseTo(0.07 * 2);
  // The stop record keeps its existing shape.
  expect(run?.events.find((event) => event.event_type === "stopped")?.payload)
    .toMatchObject({ stop_reason: "passed", rounds: 2 });
});

test("a round from a maker turn that reports no usage records no invented numbers", async () => {
  const { input, store } = setup({ runMaker: async () => ({}) });
  const result = await runEngine(input);
  expect(result.stop_reason).toBe("passed");

  const run = store.getRun(result.run_id);
  expect(run?.rounds).toHaveLength(1);
  const metrics = run?.events.filter((event) => event.event_type === "round_metrics") ?? [];
  expect(metrics).toHaveLength(1);
  // No zero tool-call count, no zero cost, no token fields: only the round.
  expect(metrics[0]?.payload).toEqual({ round: 1 });
  expect(run?.cost_usd).toBe(0);
});
