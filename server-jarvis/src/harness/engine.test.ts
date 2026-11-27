import { expect, test } from "bun:test";
import type { HarnessControllerInput, HarnessSensorBatch } from "./controller";
import { runEngine, type EngineControl, type EngineInput } from "./engine";
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
