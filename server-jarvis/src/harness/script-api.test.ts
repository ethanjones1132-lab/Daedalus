import { expect, test } from "bun:test";
import type { HarnessSensorBatch } from "./controller";
import { runEngine, type EngineInput } from "./engine";
import { registerHarness } from "./module";
import { runScript } from "./sandbox";
import { createHarnessScriptApi, type HarnessScriptApi } from "./script-api";
import { HarnessStore } from "./store";

const target = "script-api-target";
registerHarness({
  id: target, version: "1.0.0", description: "Script test harness", good_for: ["tests"], bad_for: [],
  params_schema: {}, limits: { max_rounds: 2 }, beforeRound: () => ({ instructions: "" }),
  afterSensors: () => ({ kind: "continue" }),
});

function setup(runMaker: (api: HarnessScriptApi, round: number) => Promise<void>) {
  const store = new HarnessStore({ dbPath: ":memory:" });
  let api!: HarnessScriptApi;
  let checks = 0;
  const input: EngineInput = {
    manifest: {
      schema_version: 1, id: "script", project_root: "/workspace/project", project_kind: "typescript",
      purpose: "bug_fix", template_family: "typescript_node",
      guides: { rules: [], brief_template: "", skills: [], references: [], banned_defaults: [] },
      maker_agent_id: "maker", checker: { enabled: true, agent_id: "checker", rubric: "independent" },
      sensors: [{ id: "tests", kind: "command", command_id: "bun_test", args: [], timeout_ms: 1000,
        zero_threshold: 0, failure_message: "tests fail", required: true }],
      loop: { max_rounds: 5, abort_on_no_progress: false }, approval: { required_for_new_commands: true },
    },
    store, initial: { id: "worker" }, admission: { acquire: async () => ({ release() {} }) },
    onControl: (control) => { api = createHarnessScriptApi(control); },
    runMaker: ({ round }) => runMaker(api, round),
    runChecker: async () => ({ passed: true }),
    sensors: async (): Promise<HarnessSensorBatch> => ++checks === 1
      ? { counter_vector: { tests: 1 }, sensors: [{ sensor_id: "tests", status: "nonzero", counter: 1, exit_code: 1 }] }
      : { counter_vector: { tests: 0 }, sensors: [{ sensor_id: "tests", status: "zero", counter: 0, exit_code: 0 }] },
  };
  return { input, store };
}

test("a switch from a script is recorded with the maker's reason and takes effect next round", async () => {
  const { input, store } = setup(async (api, round) => {
    if (round === 1) {
      expect(await runScript(`
        const selected = harness.describe(${JSON.stringify(target)});
        harness.switch(selected.id, { focus: "tests" }, "focus the failing check");
        return harness.state().attached.id;
      `, api)).toEqual({ ok: true, value: "worker" });
    } else {
      expect(api.state().attached.id).toBe(target);
      expect(api.state().attached.params).toEqual({ focus: "tests" });
    }
  });
  const result = await runEngine(input);
  expect(result).toMatchObject({ stop_reason: "passed", rounds: 2 });
  expect(store.getRun(result.run_id)?.events.find((event) => event.event_type === "switch")?.payload)
    .toMatchObject({ kind: "switch", harness_id: target, reason: "focus the failing check" });
});

test("unknown harness ids fail inside the script without queuing a change", async () => {
  const { input, store } = setup(async (api, round) => {
    if (round === 1) {
      expect(await runScript('harness.attach("nope", {}, "try a different harness");', api))
        .toMatchObject({ ok: false, error: expect.stringMatching(/Unknown harness.*nope/) });
    }
    expect(api.state().attached.id).toBe("worker");
  });
  const result = await runEngine(input);
  expect(result).toMatchObject({ stop_reason: "passed", rounds: 2 });
  expect(store.getRun(result.run_id)?.events.filter((event) => event.event_type === "attach")).toHaveLength(1);
});

test("CPU and memory errors leave the engine able to finish subsequent rounds", async () => {
  const { input } = setup(async (api, round) => {
    if (round !== 1) return;
    expect(await runScript("while (true) {}", api, { cpu_ms: 30 }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/CPU.*cap/) });
    expect(await runScript("const a = []; while (true) a.push(new Array(262144).fill(0));", api, { mem_mb: 2 }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/memory.*cap/i) });
  });
  expect(await runEngine(input)).toMatchObject({ stop_reason: "passed", rounds: 2 });
});

test("catalogue descriptions are data and spawn and request report unavailable", async () => {
  const { input } = setup(async (api, round) => {
    if (round !== 1) return;
    expect(await runScript(`
      return [harness.list().some(entry => entry.id === "worker"), typeof harness.describe("worker").beforeRound];
    `, api)).toEqual({ ok: true, value: [true, "undefined"] });
    for (const method of ["spawn", "request"]) {
      expect(await runScript(`harness.${method}({});`, api))
        .toMatchObject({ ok: false, error: expect.stringMatching(/not available yet/) });
    }
  });
  expect(await runEngine(input)).toMatchObject({ stop_reason: "passed", rounds: 2 });
});
