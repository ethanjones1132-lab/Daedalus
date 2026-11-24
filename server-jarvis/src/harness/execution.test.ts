import { describe, expect, test } from "bun:test";
import { runHarness } from "./controller";
import { createHarnessExecution, type HarnessAgentRef, type HarnessExecutionDeps, type HarnessMakerTurn, type HarnessModelCall } from "./execution";
import { manifestHash, type HarnessManifest } from "./manifest";
import { handleHarnessRequest, type HarnessExecution } from "./routes";
import type { SensorSpawn } from "./sensors";
import { HarnessStore } from "./store";
import type { OrchestratorAgent } from "../orchestration/agent-pool";

const ROOT = "/workspace/harness-fixture";

const AGENTS: OrchestratorAgent[] = [
  {
    id: "executor-agent", provider: "opencode_go", model_id: "executor-model",
    capabilities: { code: 8, reasoning: 7, speed: 6, cost: 5, json_reliability: 7 },
    default_for: ["executor"], enabled: true,
  },
  {
    id: "reviewer-agent", provider: "opencode_go", model_id: "reviewer-model",
    capabilities: { code: 7, reasoning: 8, speed: 6, cost: 5, json_reliability: 7 },
    default_for: ["reviewer"], enabled: true,
  },
];

function fixtureManifest(overrides: Partial<HarnessManifest> = {}): HarnessManifest {
  return {
    schema_version: 1, id: "fix-typecheck", project_root: ROOT, project_kind: "typescript_node",
    purpose: "bug_fix", template_family: "typescript_node",
    guides: {
      rules: ["Report verification evidence honestly."], brief_template: "Fix the failing typecheck",
      skills: [], references: [], banned_defaults: ["Never claim a check passed unless its runtime result confirms it."],
    },
    maker_agent_id: "maker",
    checker: { enabled: true, agent_id: "independent-checker", rubric: "Review the diff independently" },
    sensors: [{
      id: "typecheck", kind: "command", command_id: "bun_typecheck", args: [], timeout_ms: 5_000,
      zero_threshold: 0, failure_message: "Typecheck must report zero errors", required: true, baseline: 2,
    }],
    loop: { max_rounds: 3, abort_on_no_progress: true },
    approval: { required_for_new_commands: true },
    ...overrides,
  };
}

interface HarnessFixtureOptions {
  manifest: HarnessManifest;
  /** Errors the scripted maker removes per round; 0 is a maker that changes nothing. */
  fixPerRound?: number;
  initialErrors?: number;
  checkerAnswer?: string;
  diff?: string;
  narrative?: string;
  deps?: Partial<HarnessExecutionDeps>;
}

function setupHarness(options: HarnessFixtureOptions) {
  const state = {
    errors: options.initialErrors ?? 2,
    spawns: [] as string[],
    makerTurns: [] as Array<{ prompt: string; round: number; agent: HarnessAgentRef }>,
    checkerPrompts: [] as Array<{ prompt: string; agent: HarnessAgentRef }>,
  };
  const store = new HarnessStore({ dbPath: ":memory:" });
  for (const commandId of new Set(options.manifest.sensors.flatMap((sensor) => sensor.command_id ? [sensor.command_id] : []))) {
    store.recordApproval({
      command_id: commandId, project_root: options.manifest.project_root,
      manifest_hash: manifestHash(options.manifest), decision: "approved",
    });
  }

  const spawn: SensorSpawn = async ({ executable, args }) => {
    state.spawns.push(`${executable} ${args.join(" ")}`);
    if (executable === "git") {
      if (args.includes("status")) return { stdout: " M src/index.ts", stderr: "", exitCode: 0 };
      return { stdout: options.diff ?? "+const fixed = true;", stderr: "", exitCode: 0 };
    }
    return { stdout: `errors: ${state.errors}`, stderr: "", exitCode: state.errors === 0 ? 0 : 1 };
  };

  const runMakerTurn: HarnessMakerTurn = async ({ prompt, round, agent }) => {
    state.makerTurns.push({ prompt, round, agent });
    const fixPerRound = options.fixPerRound ?? 1;
    state.errors = Math.max(0, state.errors - fixPerRound);
    return { ok: true, narrative: options.narrative ?? "maker narrative" };
  };

  const callModel: HarnessModelCall = async ({ prompt, agent }) => {
    state.checkerPrompts.push({ prompt, agent });
    return { text: options.checkerAnswer ?? "ACCEPT\nEvidence matches the brief." };
  };

  const execution = createHarnessExecution({
    store,
    agents: AGENTS,
    spawn,
    runMakerTurn,
    callModel,
    now: () => 0,
    ...options.deps,
  });
  return { state, store, execution };
}

function routeRequest(store: HarnessStore, execution?: HarnessExecution) {
  return (path: string, method = "GET", body?: unknown) =>
    handleHarnessRequest(
      new Request(`http://local${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }),
      {
        store,
        resolveKnownProjectRoot: (root) => root === ROOT ? ROOT : null,
        ...(execution ? { execution } : {}),
      },
    );
}

describe("harness execution", () => {
  test("(a) POST start runs the supplied execution and answers 202, not 503", async () => {
    const manifest = fixtureManifest();
    const { store, execution } = setupHarness({ manifest });
    store.saveManifest(manifest, 0);
    const request = routeRequest(store, execution);

    const started = await request("/harness/runs", "POST", { project_root: ROOT, manifest_id: manifest.id });
    expect(started?.status).toBe(202);
    const { run_id } = await started!.json() as { run_id: string };

    let run = store.getRun(run_id);
    for (let attempt = 0; attempt < 100 && !run?.events.some((event) => event.event_type === "stopped"); attempt++) {
      await Bun.sleep(5);
      run = store.getRun(run_id);
    }
    expect(run?.rounds.length).toBeGreaterThan(0);
    expect(run?.events.filter((event) => event.event_type === "stopped")).toHaveLength(1);
  });

  test("a server built without an execution still answers 503", async () => {
    const manifest = fixtureManifest();
    const { store } = setupHarness({ manifest });
    store.saveManifest(manifest, 0);

    const response = await routeRequest(store)("/harness/runs", "POST", { project_root: ROOT, manifest_id: manifest.id });
    expect(response?.status).toBe(503);
    expect((await response!.json()).error).toBe("harness_execution_unavailable");
  });

  test("(b) a scripted maker that fixes the fixture drives sensors to zero and settles passed", async () => {
    const manifest = fixtureManifest();
    const { state, store, execution } = setupHarness({ manifest });

    const result = await runHarness({
      manifest, store, run_id: "run-fix",
      sensors: execution.sensors, runMaker: execution.runMaker, runChecker: execution.runChecker, admission: execution.admission,
    });
    expect(result.stop_reason).toBe("passed");
    expect(result.rounds).toBe(2);

    const run = store.getRun("run-fix");
    expect(run?.rounds.map((round) => round.round_number)).toEqual([1, 2]);
    expect(run?.rounds.map((round) => round.counter_vector)).toEqual([{ typecheck: 1 }, { typecheck: 0 }]);
    expect(run?.rounds.map((round) => round.sensor_results.map((item) => item.status))).toEqual([["failed"], ["passed"]]);
    expect(run?.events.at(-1)?.payload).toEqual({ stop_reason: "passed", rounds: 2 });

    // Each round's maker brief carries the guides, the round number, and the
    // failures the previous sensor pass observed.
    expect(state.makerTurns.map((turn) => turn.round)).toEqual([1, 2]);
    expect(state.makerTurns[0]?.prompt).toContain("Fix the failing typecheck");
    expect(state.makerTurns[0]?.prompt).toContain("No sensor results yet");
    expect(state.makerTurns[1]?.prompt).toContain("Harness round 2 of 3.");
    expect(state.makerTurns[1]?.prompt).toContain("typecheck (nonzero, counter 1)");
    expect(state.makerTurns[0]?.agent.model_id).toBe("executor-model");
  });

  test("(c) a scripted maker that changes nothing settles no_progress", async () => {
    const manifest = fixtureManifest();
    const { store, execution } = setupHarness({ manifest, fixPerRound: 0 });

    const result = await runHarness({
      manifest, store, run_id: "run-no-progress",
      sensors: execution.sensors, runMaker: execution.runMaker, runChecker: execution.runChecker, admission: execution.admission,
    });
    expect(result.stop_reason).toBe("no_progress");
    expect(result.rounds).toBe(1);

    const run = store.getRun("run-no-progress");
    expect(run?.rounds).toHaveLength(1);
    expect(run?.rounds[0]?.sensor_results[0]).toMatchObject({ sensor_id: "typecheck", status: "failed", counter: 2 });
    expect(run?.events.at(-1)?.payload).toEqual({ stop_reason: "no_progress", rounds: 1 });
  });

  test("(d) a sensor whose command_id is not in HARNESS_COMMANDS is never spawned and is unapproved", async () => {
    const manifest = fixtureManifest({
      sensors: [{ ...fixtureManifest().sensors[0]!, command_id: "arbitrary_shell" }],
    });
    const { state, execution } = setupHarness({ manifest });

    const batch = await execution.sensors({ manifest, signal: new AbortController().signal });

    expect(state.spawns).toEqual([]);
    expect(batch.sensors).toEqual([{ sensor_id: "typecheck", status: "unapproved", counter: null, exit_code: null }]);
  });

  test("(e) the checker receives the brief, rubric and diff but not the maker transcript", async () => {
    const manifest = fixtureManifest();
    const { state, store, execution } = setupHarness({
      manifest, initialErrors: 0, narrative: "MAKER-TRANSCRIPT-SECRET",
    });

    const result = await runHarness({
      manifest, store, run_id: "run-checker",
      sensors: execution.sensors, runMaker: execution.runMaker, runChecker: execution.runChecker, admission: execution.admission,
    });
    expect(result.stop_reason).toBe("passed");

    expect(state.checkerPrompts).toHaveLength(1);
    const checker = state.checkerPrompts[0]!;
    expect(checker.prompt).toContain("Fix the failing typecheck");
    expect(checker.prompt).toContain("Review the diff independently");
    expect(checker.prompt).toContain("+const fixed = true;");
    expect(checker.prompt).not.toContain("MAKER-TRANSCRIPT-SECRET");
    expect(checker.prompt).not.toContain(state.makerTurns[0]!.prompt);
    expect(checker.agent.model_id).toBe("reviewer-model");
  });

  test("a checker that does not accept settles checker_rejected", async () => {
    const manifest = fixtureManifest();
    const { store, execution } = setupHarness({ manifest, initialErrors: 0, checkerAnswer: "REJECT\nNot verified." });

    const result = await runHarness({
      manifest, store, run_id: "run-rejected",
      sensors: execution.sensors, runMaker: execution.runMaker, runChecker: execution.runChecker, admission: execution.admission,
    });
    expect(result.stop_reason).toBe("checker_rejected");
  });
});
