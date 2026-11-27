import { expect, test } from "bun:test";
import type { HarnessSensorBatch } from "../controller";
import { runEngine, type EngineInput } from "../engine";
import type { HarnessManifest } from "../manifest";
import { HarnessStore } from "../store";

const ROOT = "/workspace/retry-fixture";

function sensor(id: string, counter: number): HarnessSensorBatch["sensors"][number] {
  return counter === 0
    ? { sensor_id: id, status: "zero", counter: 0, exit_code: 0 }
    : { sensor_id: id, status: "nonzero", counter, exit_code: 1 };
}

function batch(a: number, b: number): HarnessSensorBatch {
  return { counter_vector: { a, b }, sensors: [sensor("a", a), sensor("b", b)] };
}

const manifest: HarnessManifest = {
  schema_version: 1, id: "retry-sensors", project_root: ROOT, project_kind: "typescript_node",
  purpose: "bug_fix", template_family: "typescript_node",
  guides: { rules: [], brief_template: "Fix the failing sensors", skills: [], references: [], banned_defaults: [] },
  maker_agent_id: "maker",
  checker: { enabled: true, agent_id: "independent-checker", rubric: "Verify the full sensor pass" },
  sensors: ["a", "b"].map((id) => ({
    id, kind: "command" as const, command_id: "bun_typecheck", args: [], timeout_ms: 5_000,
    zero_threshold: 0, failure_message: `${id} must pass`, required: true,
  })),
  loop: { max_rounds: 5, abort_on_no_progress: false },
  approval: { required_for_new_commands: true },
};

test("retry focuses exactly one failing sensor per round", async () => {
  const store = new HarnessStore({ dbPath: ":memory:" });
  const policies: Array<{ round: number; sensor_ids: string[] | undefined; skip_checker: boolean | undefined }> = [];
  let makers = 0;
  let checks = 0;
  const batches = [batch(1, 1), batch(0, 1), batch(0, 0)];
  const input: EngineInput = {
    manifest,
    store,
    admission: { acquire: async () => ({ release() {} }) },
    initial: { id: "retry" },
    sensors: async () => batches.shift() ?? batch(0, 0),
    runMaker: async () => { makers++; },
    runChecker: async () => { checks++; return { passed: true }; },
  };
  const result = await runEngine({
    ...input,
    onRound: (policy) => {
      policies.push({ round: policies.length + 1, sensor_ids: policy.sensor_ids, skip_checker: policy.skip_checker });
    },
  });

  expect(result).toMatchObject({ stop_reason: "passed", rounds: 4 });
  expect(makers).toBe(4);
  expect(policies).toEqual([
    { round: 1, sensor_ids: undefined, skip_checker: undefined },
    { round: 2, sensor_ids: ["a"], skip_checker: true },
    { round: 3, sensor_ids: ["b"], skip_checker: true },
    { round: 4, sensor_ids: undefined, skip_checker: undefined },
  ]);
  // The focused rounds never reach the checker.
  expect(checks).toBe(1);
});

test("retry cannot pass on a focused round even when that sensor is green", async () => {
  const store = new HarnessStore({ dbPath: ":memory:" });
  const seen: Array<{ round: number; sensor_ids: string[] | undefined }> = [];
  let checks = 0;
  // Round 1 exposes both failures. Round 2 is focused on "a" and that sensor is
  // now green, but "b" is still failing. Round 3 is focused on "b" and every
  // sensor is green, yet the round is still partial; only the full round 4 pass
  // may go to the checker.
  const batches = [batch(1, 1), batch(0, 1), batch(0, 0)];
  const input: EngineInput = {
    manifest,
    store,
    admission: { acquire: async () => ({ release() {} }) },
    initial: { id: "retry" },
    sensors: async () => batches.shift() ?? batch(0, 0),
    runMaker: async () => {},
    runChecker: async () => { checks++; return { passed: true }; },
  };
  const result = await runEngine({
    ...input,
    onRound: (policy, state) => { seen.push({ round: state.round, sensor_ids: policy.sensor_ids }); },
  });

  expect(result).toMatchObject({ stop_reason: "passed", rounds: 4 });
  expect(seen.map(({ sensor_ids }) => sensor_ids)).toEqual([undefined, ["a"], ["b"], undefined]);
  expect(checks).toBe(1);
  const run = store.getRun(result.run_id);
  const verdicts = run?.events.filter((event) => event.event_type === "checker_verdict") ?? [];
  expect(verdicts).toHaveLength(1);
  expect(verdicts[0]?.payload).toMatchObject({ round: 4, passed: true });
});
