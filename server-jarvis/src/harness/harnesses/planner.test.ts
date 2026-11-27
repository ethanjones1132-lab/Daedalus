import { expect, test } from "bun:test";
import { defaultConfig } from "../../config";
import type { HarnessSensorBatch } from "../controller";
import { runEngine, type EngineControl, type EngineInput } from "../engine";
import { createHarnessExecution } from "../execution";
import type { HarnessManifest } from "../manifest";
import { HarnessStore } from "../store";

const ROOT = "/workspace/planner-fixture";
const zero: HarnessSensorBatch = {
  counter_vector: { typecheck: 0 },
  sensors: [{ sensor_id: "typecheck", status: "zero", counter: 0, exit_code: 0 }],
};

function fixtureManifest(overrides: Partial<HarnessManifest> = {}): HarnessManifest {
  return {
    schema_version: 1, id: "plan-then-work", project_root: ROOT, project_kind: "typescript_node",
    purpose: "feature", template_family: "typescript_node",
    guides: { rules: ["Report verification evidence honestly."], brief_template: "Build the feature",
      skills: [], references: [], banned_defaults: [] },
    maker_agent_id: "maker",
    checker: { enabled: true, agent_id: "independent-checker", rubric: "Review the plan and work" },
    sensors: [{ id: "typecheck", kind: "command", command_id: "bun_typecheck", args: [], timeout_ms: 5_000,
      zero_threshold: 0, failure_message: "Typecheck must report zero errors", required: true }],
    loop: { max_rounds: 5, abort_on_no_progress: false },
    approval: { required_for_new_commands: true },
    ...overrides,
  };
}

function engineInput(overrides: Partial<EngineInput> = {}) {
  const store = new HarnessStore({ dbPath: ":memory:" });
  const input: EngineInput = {
    manifest: fixtureManifest(),
    store,
    admission: { acquire: async () => ({ release() {} }) },
    sensors: async () => zero,
    runMaker: async () => ({}),
    runChecker: async () => ({ passed: true }),
    initial: { id: "planner" },
    ...overrides,
  };
  return { input, store };
}

test("planner hands off to worker after its read-only round", async () => {
  let control!: EngineControl;
  const seen: Array<{ id: string; read_only: boolean | undefined }> = [];
  const policies: string[] = [];
  let checks = 0;
  const { input, store } = engineInput({
    runMaker: async ({ read_only }) => {
      seen.push({ id: control.state().attached.id, read_only });
    },
    runChecker: async () => { checks++; return { passed: true }; },
  });
  const result = await runEngine({
    ...input,
    onControl: (value) => { control = value; },
    onRound: (policy) => { policies.push(policy.instructions); },
  });

  expect(result).toMatchObject({ stop_reason: "passed", rounds: 2 });
  expect(seen).toEqual([
    { id: "planner", read_only: true },
    { id: "worker", read_only: undefined },
  ]);
  // The planning round is never sent to the checker.
  expect(checks).toBe(1);
  expect(policies[0]).toContain("Plan only");
  expect(policies[1]).toBe("");

  const run = store.getRun(result.run_id);
  expect(run?.events.find((event) => event.event_type === "suggest_switch")?.payload)
    .toMatchObject({ id: "worker", round: 1 });
  expect(run?.events.find((event) => event.event_type === "switch")?.payload)
    .toMatchObject({ reason: "plan drafted; hand off to the worker for implementation",
      detail: { from: { id: "planner" }, attached: { id: "worker" } } });
});

test("the planner's real maker tools exclude every mutator and keep the read tools", async () => {
  const bodies: string[] = [];
  const config = defaultConfig();
  config.tools.enabled = true;
  const execution = createHarnessExecution({
    store: new HarnessStore({ dbPath: ":memory:" }),
    // No named "maker" agent: the run uses the local inkling maker, whose
    // composed tool list is the actual runtime surface the model can dispatch.
    agents: [],
    getConfig: () => config,
    makerDelegate: {
      config: () => { throw new Error("a read-only planner must not resolve the delegate"); },
      isAvailable: async () => { throw new Error("a read-only planner must not probe the delegate"); },
    },
    runMakerTurn: async () => { throw new Error("a read-only planner must not dispatch the delegate turn"); },
    requestMaker: async (_url, init) => {
      bodies.push(String(init.body));
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ action: "finish", summary: "plan" }) } }],
      });
    },
    callModel: async () => ({ text: "ACCEPT" }),
  });
  const fixture = engineInput({
    manifest: fixtureManifest({ checker: { enabled: false, agent_id: "independent-checker", rubric: "" }, loop: { max_rounds: 1, abort_on_no_progress: false } }),
    ...execution,
    // Only the maker boundary comes from the real execution wiring; sensors and
    // the checker are scripted so this test observes the tool lists alone.
    sensors: async () => zero,
    runChecker: async () => ({ passed: true }),
  });
  const result = await runEngine(fixture.input);

  expect(result).toMatchObject({ stop_reason: "max_rounds", rounds: 2 });
  expect(bodies).toHaveLength(2);

  const names = (body: string): string[] => {
    const request = JSON.parse(body) as { messages: Array<{ content: string }> };
    const line = request.messages[0]!.content.split("\n").find((value) => value.startsWith("Available tools: "));
    expect(line).toBeDefined();
    return (JSON.parse(line!.slice("Available tools: ".length)) as Array<{ name: string }>).map((tool) => tool.name);
  };

  const planned = names(bodies[0]!);
  expect([...planned].sort()).toEqual(["glob", "grep", "list_directory", "read_file"]);
  for (const mutator of ["edit_file", "write_file", "multi_edit", "apply_patch", "shell", "bash", "run_sensors"]) {
    expect(planned).not.toContain(mutator);
  }

  // The worker's own round is not read-only, so the restriction is the
  // planner's authority and not a global strip.
  const worked = names(bodies[1]!);
  expect(worked).toContain("edit_file");
  expect(worked).toContain("write_file");
});
