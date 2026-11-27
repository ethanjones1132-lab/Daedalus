import { expect, test } from "bun:test";
import type { HarnessSensorBatch } from "./controller";
import {
  assessEscalation, ESCALATION_ORDER, installConsultantTools, resetEscalation, type EscalationStep,
} from "./escalation";
import { runEngine, type EngineControl, type EngineInput } from "./engine";
import type { HarnessManifest } from "./manifest";
import { registerHarness, type EngineState } from "./module";
import { HarnessStore } from "./store";

let runSeq = 0;
function nextRun(prefix: string): string {
  runSeq++;
  return `${prefix}-${runSeq}`;
}

const failing: HarnessSensorBatch = {
  counter_vector: { tests: 3 },
  sensors: [{ sensor_id: "tests", status: "nonzero", counter: 3, exit_code: 1 }],
};
const toolError: HarnessSensorBatch = {
  counter_vector: { tests: 1 },
  sensors: [{ sensor_id: "tests", status: "failed", counter: 1, exit_code: null }],
};

/** A hand-built EngineState, exactly the shape the engine's `state()` clones. */
function state(runId: string, round: number, batch: HarnessSensorBatch, attached = "worker"): EngineState {
  return {
    run_id: runId,
    round,
    attached: { id: attached, version: "1.0.0", hash: "test-hash", params: null },
    budget_left: { max_rounds: 15 - round, max_ms: 1_800_000, max_cloud_usd: 0.5 },
    last_sensors: batch,
    history: [],
  };
}

function manifest(): HarnessManifest {
  return {
    schema_version: 1, id: "escalation-fixture", project_root: "/workspace/escalation-fixture",
    project_kind: "typescript_node", purpose: "bug_fix", template_family: "typescript_node",
    guides: { rules: [], brief_template: "Fix the failing tests", skills: [], references: [], banned_defaults: [] },
    maker_agent_id: "maker",
    // A full green pass is the checker's business; these fixtures never reach it.
    checker: { enabled: false, agent_id: "checker", rubric: "" },
    sensors: [{ id: "tests", kind: "command", command_id: "bun_test", args: [], timeout_ms: 1_000,
      zero_threshold: 0, failure_message: "tests fail", required: true }],
    loop: { max_rounds: 5, abort_on_no_progress: false },
    approval: { required_for_new_commands: true },
  };
}

function engineSetup(overrides: Partial<EngineInput> = {}) {
  const store = new HarnessStore({ dbPath: ":memory:" });
  const input: EngineInput = {
    manifest: manifest(),
    store,
    admission: { acquire: async () => ({ release() {} }) },
    sensors: async () => failing,
    runMaker: async () => ({}),
    runChecker: async () => ({ passed: true }),
    initial: { id: "worker" },
    escalation: true,
    budget: { max_rounds: 5 },
    ...overrides,
  };
  return { input, store };
}

test("nudge first: two unchanged vectors suggest retry without forcing it", () => {
  const run = nextRun("nudge");
  resetEscalation(run);
  // One vector is a baseline, not a trend.
  expect(assessEscalation(state(run, 1, failing))).toEqual({ signal: null, next: null, force: false });
  expect(assessEscalation(state(run, 2, failing)))
    .toEqual({ signal: "no_progress_2", next: "retry", force: false });
});

test("force after one more round: the persisted signal records a forced_switch", async () => {
  let control!: EngineControl;
  const { input, store } = engineSetup();
  const result = await runEngine({ ...input, onControl: (value) => { control = value; } });

  expect(control).toBeDefined();
  expect(result).toMatchObject({ stop_reason: "harness_stop" });
  const events = store.getRun(result.run_id)?.events ?? [];
  const forced = events.filter((event) => event.event_type === "forced_switch");
  expect(forced).toHaveLength(1);
  expect(forced[0]?.payload).toMatchObject({
    kind: "forced_switch",
    harness_id: "planner",
    detail: { from: { id: "retry" } },
  });
  // The advisory step that preceded it was a suggestion, not a forced switch.
  const nudges = events.filter((event) => event.event_type === "suggest_switch" &&
    (event.payload as { escalation?: unknown } | undefined)?.escalation !== undefined);
  expect(nudges).toHaveLength(1);
  expect(nudges[0]?.payload).toMatchObject({ id: "retry", escalation: { signal: "no_progress_2", force: false } });
});

test("forced harness holds this round: a script switch in the same round is deferred to the next boundary", async () => {
  registerHarness({
    id: "escalation-script-target", version: "1.0.0", description: "Script switch target",
    good_for: [], bad_for: [], params_schema: {}, limits: { max_rounds: 1 },
    beforeRound: () => ({ instructions: "" }), afterSensors: () => ({ kind: "continue" }),
  });
  installConsultantTools({ consult: async ({ signal }) => ({ report: `advice on ${signal}` }) });
  try {
    let control!: EngineControl;
    const attached: string[] = [];
    const { input } = engineSetup({
      budget: { max_rounds: 5 },
      runMaker: async ({ round }) => {
        attached.push(control.state().attached.id);
        // The script asks for its own harness in the same round the ladder
        // detects the persisted signal and forces the planner.
        if (round === 3) control.switch("escalation-script-target", {}, "script wants a different harness");
      },
    });
    const result = await runEngine({ ...input, onControl: (value) => { control = value; } });

    expect(attached).toEqual([
      "worker",
      "worker",
      "retry",
      // The forced planner holds this round; the script's switch waited.
      "planner",
      "escalation-script-target",
    ]);
    // The forced attachment is the one that took the boundary, and the ladder
    // never replaced it with the script's request inside that round.
    expect(result.rounds).toBe(5);
  } finally {
    installConsultantTools(undefined);
  }
});

test("consult step uses DD-152 consultant tools within budget; absent tools stop with a clear reason", async () => {
  installConsultantTools({ consult: async ({ signal }) => ({ report: `second opinion on ${signal}`, cost_usd: 0.05 }) });
  try {
    const { input, store } = engineSetup({
      initial: { id: "planner" },
      budget: { max_rounds: 2 },
      // The maker's own `continue: false` is a self-reported stuck signal that
      // survives the next round, so the ladder reaches and then leaves consult.
      runMaker: async () => ({ continue: false }),
    });
    const result = await runEngine(input);
    // The consultation happened; when the signal survives the next round the
    // ladder stops rather than consulting forever or inventing another rung.
    expect(result).toMatchObject({ stop_reason: "harness_stop", rounds: 2 });
    const events = store.getRun(result.run_id)?.events ?? [];
    const request = events.find((event) => event.event_type === "request");
    expect(request?.payload).toMatchObject({
      kind: "request",
      harness_id: "planner",
      detail: { escalation: { signal: "self_reported_stuck", step: "consult" }, report: expect.stringContaining("second opinion") },
    });
    // The consultation is a real model call: its reported spend is charged.
    expect(store.getRun(result.run_id)?.cost_usd).toBeCloseTo(0.05);
  } finally {
    installConsultantTools(undefined);
  }

  const { input, store } = engineSetup({
    initial: { id: "planner" }, budget: { max_rounds: 2 }, runMaker: async () => ({ continue: false }),
  });
  const stopped = await runEngine(input);
  expect(stopped).toMatchObject({ stop_reason: "harness_stop" });
  const stop = store.getRun(stopped.run_id)?.events.find((event) => event.event_type === "stop");
  expect((stop?.payload as { reason?: string } | undefined)?.reason).toContain("DD-152 consultant tools are not available");
  expect(store.getRun(stopped.run_id)?.events.some((event) => event.event_type === "request")).toBe(false);
});

test("never escalates into orchestration", () => {
  expect(ESCALATION_ORDER).toEqual(["worker", "retry", "planner", "consult", "stop_report"]);
  expect(ESCALATION_ORDER).not.toContain("orchestration");

  const batches = [failing, failing, toolError, failing];
  for (const attached of ["worker", "retry", "planner", "orchestration"]) {
    const run = nextRun(`orchestration-${attached}`);
    resetEscalation(run);
    const seen: EscalationStep[] = [];
    for (const [index, batch] of batches.entries()) {
      const plan = assessEscalation(state(run, index + 1, batch, attached));
      if (plan.next !== null) seen.push(plan.next);
      // The ladder may only name its own rungs, whatever harness it is attached to.
      if (plan.next !== null) expect(ESCALATION_ORDER).toContain(plan.next);
      expect(plan.next as string | null).not.toBe("orchestration");
    }
    expect(seen.length).toBeGreaterThan(0);
  }
});
