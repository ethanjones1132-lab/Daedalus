import { describe, expect, test } from "bun:test";
import type { OrchestratorAgent } from "../orchestration/agent-pool";
import { defaultConfig } from "../config";
import { createHarnessExecution, type HarnessMakerTurn } from "./execution";
import { HarnessStore } from "./store";
import { handleHarnessRequest, type HarnessExecution } from "./routes";
import { recordHarnessMakerEvent } from "./inkling-maker";
import { HARNESS_TEMPLATES, instantiateHarnessTemplate } from "./templates";
import { validateManifest, type HarnessManifest } from "./manifest";
import type { EngineControl } from "./engine";

const ROOT = "/known/project";
function manifest(id = "bug-fix", root = ROOT): HarnessManifest {
  return {
    schema_version: 1, id, project_root: root, project_kind: "typescript_node", purpose: "bug_fix", template_family: "typescript_node",
    guides: { rules: ["Be precise"], brief_template: "{{task}}", skills: [], references: [], banned_defaults: [] },
    maker_agent_id: "maker", checker: { enabled: true, agent_id: "checker", rubric: "Review independently" },
    sensors: [{ id: "typecheck", kind: "command", command_id: "bun_typecheck", args: [], timeout_ms: 1000, zero_threshold: 0,
      failure_message: "must pass", required: true }],
    loop: { max_rounds: 5, abort_on_no_progress: true }, approval: { required_for_new_commands: true },
  };
}

function setup(execution?: HarnessExecution) {
  const store = new HarnessStore({ dbPath: ":memory:" });
  const request = (path: string, method = "GET", body?: unknown) => handleHarnessRequest(new Request(`http://local${path}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }), { store, resolveKnownProjectRoot: (root) => root === ROOT || root === "/alias" ? ROOT : root === "/other" ? "/other" : null,
    ...(execution ? { execution } : {}) });
  return { store, request };
}
const payload = async (response: Response | null) => response!.json();

const zeroBatch = {
  counter_vector: { typecheck: 0 },
  sensors: [{ sensor_id: "typecheck", status: "zero" as const, counter: 0, exit_code: 0 }],
};

function execution(overrides: Partial<HarnessExecution> = {}): HarnessExecution {
  return {
    admission: { acquire: async () => ({ release() {} }) },
    runMaker: async () => ({}),
    runChecker: async () => ({ passed: true }),
    sensors: async () => zeroBatch,
    ...overrides,
  };
}

/** A maker that stays in flight until the run is cancelled. */
const waitingMaker: HarnessExecution["runMaker"] = async ({ signal }) => {
  if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  return {};
};

/** A live execution whose maker turn records every prompt it receives. */
const promptAgents: OrchestratorAgent[] = [
  {
    // The named Inkling maker: a pool id that is merely "maker" must not
    // displace the local llama.cpp maker.
    id: "maker", provider: "opencode_go", model_id: "Inkling-2-Mini-UD-IQ3_XXS.gguf",
    capabilities: { code: 8, reasoning: 7, speed: 6, cost: 5, json_reliability: 7 },
    default_for: ["executor"], enabled: true,
  },
  {
    id: "checker", provider: "opencode_go", model_id: "reviewer-model",
    capabilities: { code: 7, reasoning: 8, speed: 6, cost: 5, json_reliability: 7 },
    default_for: ["reviewer"], enabled: true,
  },
];

function captureMakerPrompts(makerTurn: HarnessMakerTurn) {
  const prompts: string[] = [];
  const execution = createHarnessExecution({
    store: new HarnessStore({ dbPath: ":memory:" }),
    agents: promptAgents,
    // Diff/base probes stay offline; a prompt is recorded before any evidence.
    spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    runMakerTurn: async (input) => {
      prompts.push(input.prompt);
      return makerTurn(input);
    },
    makerDelegate: {
      config: () => {
        const config = defaultConfig();
        config.claude_cli.delegate.model = "minimax-m3";
        return config;
      },
      isAvailable: async () => true,
    },
    callModel: async () => ({ text: "ACCEPT\nThe diff matches the brief." }),
  });
  return { prompts, execution };
}

describe("harness routes", () => {
  test("lists templates, each validated when bound to a canonical project root", async () => {
    expect((await payload(await setup().request("/harness/templates"))).templates).toHaveLength(HARNESS_TEMPLATES.length);
    for (const template of HARNESS_TEMPLATES) expect(validateManifest(instantiateHarnessTemplate(template.id, ROOT)).ok).toBe(true);
    expect(HARNESS_TEMPLATES.find((item) => item.id === "release_prep")?.sensors.every((sensor) => sensor.kind === "unavailable")).toBe(true);
  });

  test("resolves only app-known project roots and creates a manifest from a template", async () => {
    const { request } = setup();
    expect((await request("/harness/projects/resolve", "POST", { root: "/alias" }))?.status).toBe(200);
    expect((await payload(await request("/harness/manifests/from-template", "POST", { template_id: "typescript_node_bug_fix", project_root: ROOT, expected_revision: 0 }))).revision).toBe(1);
    expect((await request("/harness/projects/resolve", "POST", { root: "/unknown" }))?.status).toBe(404);
    expect((await request("/harness/manifests/from-template", "POST", { template_id: "typescript_node_bug_fix", project_root: "/unknown", expected_revision: 0 }))?.status).toBe(404);
  });

  test("creates, lists, gets, and updates manifests; stale revisions return 409", async () => {
    const { request } = setup();
    const created = await request("/harness/manifests", "POST", { manifest: manifest(), expected_revision: 0 });
    expect(created?.status).toBe(201);
    expect((await payload(await request(`/harness/manifests?project_root=${encodeURIComponent(ROOT)}`))).manifests).toHaveLength(1);
    expect((await payload(await request(`/harness/manifests/bug-fix?project_root=${encodeURIComponent(ROOT)}`))).revision).toBe(1);
    const updated = manifest(); updated.guides.rules = ["Updated"];
    expect((await request("/harness/manifests/bug-fix", "PUT", { manifest: updated, expected_revision: 1 }))?.status).toBe(200);
    expect((await request("/harness/manifests/bug-fix", "PUT", { manifest: updated, expected_revision: 1 }))?.status).toBe(409);
  });

  test("records an approval only for a known root, catalogued command, stored hash, and valid decision", async () => {
    const { store, request } = setup();
    const created = await payload(await request("/harness/manifests/from-template", "POST",
      { template_id: "typescript_node_bug_fix", project_root: ROOT, expected_revision: 0 }));
    const storedHash: string = created.manifest_hash;
    const base = { project_root: ROOT, manifest_id: created.manifest.id, manifest_hash: storedHash, command_id: "bun_typecheck" };

    expect((await request("/harness/approvals", "POST", { ...base, command_id: "arbitrary_shell", decision: "approved" }))?.status).toBe(400);
    expect((await request("/harness/approvals", "POST", { ...base, decision: "maybe" }))?.status).toBe(400);
    expect((await request("/harness/approvals", "POST", { ...base, manifest_hash: "0".repeat(64), decision: "approved" }))?.status).toBe(400);
    expect((await request("/harness/approvals", "POST", { ...base, project_root: "/unknown", decision: "approved" }))?.status).toBe(404);
    expect((await request("/harness/approvals", "POST", { ...base, manifest_id: "not-a-manifest", decision: "approved" }))?.status).toBe(404);
    // A rejected request writes nothing.
    expect(store.findApproval("bun_typecheck", ROOT, storedHash)).toBeUndefined();
    expect(store.findApproval("arbitrary_shell", ROOT, storedHash)).toBeUndefined();

    const recorded = await request("/harness/approvals", "POST", { ...base, decision: "approved" });
    expect(recorded?.status).toBe(201);
    const { approval } = await payload(recorded);
    expect(approval).toMatchObject({ command_id: "bun_typecheck", project_root: ROOT, manifest_hash: storedHash, decision: "approved" });
    expect(typeof approval.id).toBe("string");
    expect(typeof approval.decided_at).toBe("string");
    expect(approval).not.toHaveProperty("secret");
    expect(store.findApproval("bun_typecheck", ROOT, storedHash)?.decision).toBe("approved");

    // A denial is recorded against the same binding and is not turned into an approval.
    expect((await request("/harness/approvals", "POST", { ...base, decision: "denied" }))?.status).toBe(201);
    expect(store.findApproval("bun_typecheck", ROOT, storedHash)?.decision).toBe("denied");
  });

  test("returns validator errors for invalid manifests and refuses unknown roots", async () => {
    const { request } = setup();
    const bad = { ...manifest(), sensors: [{ ...manifest().sensors[0], command_id: "arbitrary_shell" }] };
    const response = await request("/harness/manifests", "POST", { manifest: bad, expected_revision: 0 });
    expect(response?.status).toBe(400);
    expect((await payload(response)).errors).toContain("sensors[0].command_id is unknown");
    expect((await request("/harness/manifests", "POST", { manifest: manifest("x", "/unknown"), expected_revision: 0 }))?.status).toBe(404);
  });

  test("previews rendered guides for stored and inline manifests", async () => {
    const { request } = setup();
    await request("/harness/manifests", "POST", { manifest: manifest(), expected_revision: 0 });
    const preview = await payload(await request("/harness/guides/preview", "POST", { project_root: ROOT, manifest_id: "bug-fix", brief_values: { task: "Fix it" } }));
    expect(preview.guides_rendered).toBe(true);
    expect(preview.text).toContain("Fix it");
    expect((await request("/harness/guides/preview", "POST", { project_root: "/unknown", manifest_id: "bug-fix" }))?.status).toBe(404);
  });

  test("lists run history by project root and scopes individual run reads", async () => {
    const { store, request } = setup();
    const one = store.createRun({ project_root: ROOT, manifest_id: "m", manifest_hash: "hash" });
    store.createRun({ project_root: "/other", manifest_id: "m", manifest_hash: "hash" });
    const history = await payload(await request(`/harness/runs?project_root=${encodeURIComponent(ROOT)}`));
    expect(history.runs.map((run: { id: string }) => run.id)).toEqual([one.id]);
    expect((await request(`/harness/runs/${one.id}?project_root=${encodeURIComponent(ROOT)}`))?.status).toBe(200);
    expect((await request(`/harness/runs/${one.id}?project_root=%2Fother`))?.status).toBe(404);
  });

  test("starts a run through the controller and reads it back through the run routes", async () => {
    const { request } = setup(execution());
    expect((await request("/harness/manifests", "POST", { manifest: manifest(), expected_revision: 0 }))?.status).toBe(201);
    const started = await request("/harness/runs", "POST", { project_root: ROOT, manifest_id: "bug-fix", brief_values: { task: "Fix the bug" } });
    expect(started?.status).toBe(202);
    const { run_id } = await payload(started);
    expect(typeof run_id).toBe("string");
    const history = await payload(await request(`/harness/runs?project_root=${encodeURIComponent(ROOT)}`));
    expect(history.runs.map((run: { id: string }) => run.id)).toContain(run_id);
    const read = await payload(await request(`/harness/runs/${run_id}?project_root=${encodeURIComponent(ROOT)}`));
    expect(read.run.id).toBe(run_id);
    expect((await request(`/harness/runs/${run_id}?project_root=%2Fother`))?.status).toBe(404);
  });

  test("the start route carries onControl through to a suggested planner handoff", async () => {
    let control!: EngineControl;
    const attachedAtMaker: Array<{ round: number; id: string; cloudBudget: number }> = [];
    const { store, request } = setup(execution({
      onControl: (value) => {
        control = value;
        // Reserve through the engine's existing run ledger before the queued
        // planner round can dispatch.
        value.chargeCloud(0.05);
        value.switch("planner", {}, "start planner through the control seam");
      },
      runMaker: async ({ round, budget_left }) => {
        attachedAtMaker.push({
          round,
          id: control.state().attached.id,
          cloudBudget: budget_left?.max_cloud_usd ?? -1,
        });
        return {};
      },
    }));
    const item = manifest();
    item.checker.enabled = false;
    await request("/harness/manifests", "POST", { manifest: item, expected_revision: 0 });

    const started = await request("/harness/runs", "POST",
      { project_root: ROOT, manifest_id: item.id, brief_values: { task: "Plan then work" } });
    expect(started?.status).toBe(202);
    const { run_id } = await payload(started);

    for (let attempt = 0; attempt < 200 && !store.getRun(run_id)?.events.some((event) => event.event_type === "stopped"); attempt++) {
      await Bun.sleep(5);
    }
    const run = store.getRun(run_id);
    // The checker is off here, so the worker keeps looping to max_rounds; what
    // this pins is the handoff: the seam starts the planner and the recorded
    // switch then puts every later round on the worker.
    expect(attachedAtMaker.slice(0, 2)).toEqual([
      { round: 1, id: "planner", cloudBudget: 0.45 },
      { round: 2, id: "worker", cloudBudget: 0.45 },
    ]);
    expect(attachedAtMaker.slice(2).every((entry) => entry.id === "worker")).toBe(true);
    expect(run?.cost_usd).toBeCloseTo(0.05);
    expect(run?.events.find((event) => event.event_type === "suggest_switch")?.payload)
      .toMatchObject({ id: "worker", round: 1 });
    const switches = run?.events.filter((event) => event.event_type === "switch").map((event) => event.payload) ?? [];
    expect(switches[0]).toMatchObject({ reason: "start planner through the control seam" });
    expect(switches.some((payload) => payload.reason === "plan drafted; hand off to the worker for implementation"
      && payload.detail?.attached?.id === "worker")).toBe(true);
  });

  test("a start without onControl retains the legacy fixed-worker behavior", async () => {
    const attached: string[] = [];
    const { store, request } = setup(execution({ runMaker: async () => { attached.push("worker"); return {}; } }));
    const item = manifest();
    item.checker.enabled = false;
    await request("/harness/manifests", "POST", { manifest: item, expected_revision: 0 });

    const { run_id } = await payload(await request("/harness/runs", "POST",
      { project_root: ROOT, manifest_id: item.id, brief_values: { task: "Keep legacy behavior" } }));
    for (let attempt = 0; attempt < 200 && !store.getRun(run_id)?.events.some((event) => event.event_type === "stopped"); attempt++) {
      await Bun.sleep(5);
    }

    expect(attached).toEqual(["worker"]);
    expect(store.getRun(run_id)?.events.filter((event) => event.event_type === "switch")).toHaveLength(0);
  });

  test("an onControl failure settles as a recorded run_failed result", async () => {
    const { store, request } = setup(execution({
      onControl: () => { throw new Error("control registration failed"); },
    }));
    const item = manifest();
    await request("/harness/manifests", "POST", { manifest: item, expected_revision: 0 });

    const { run_id } = await payload(await request("/harness/runs", "POST",
      { project_root: ROOT, manifest_id: item.id, brief_values: { task: "Fail control registration" } }));
    for (let attempt = 0; attempt < 200 && !store.getRun(run_id)?.events.some((event) => event.event_type === "stopped"); attempt++) {
      await Bun.sleep(5);
    }
    expect(store.getRun(run_id)?.events.find((event) => event.event_type === "stopped")?.payload)
      .toMatchObject({ stop_reason: "run_failed", error: "control registration failed" });
  });

  test("fills a run's brief template from brief_values in that run's maker prompt", async () => {
    const { prompts, execution: live } = captureMakerPrompts(async () => ({ ok: true }));
    const { request } = setup(live);
    expect((await request("/harness/manifests", "POST", { manifest: manifest(), expected_revision: 0 }))?.status).toBe(201);

    const started = await request("/harness/runs", "POST",
      { project_root: ROOT, manifest_id: "bug-fix", brief_values: { task: "Fix the flaky login test" } });
    expect(started?.status).toBe(202);

    for (let attempt = 0; attempt < 200 && prompts.length === 0; attempt++) await Bun.sleep(5);
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).toContain("Fix the flaky login test");
      expect(prompt).not.toContain("{{task}}");
    }
  });

  test("refuses a start whose brief template still has an unfilled placeholder and creates no run", async () => {
    const { store, request } = setup(execution());
    expect((await request("/harness/manifests", "POST", { manifest: manifest(), expected_revision: 0 }))?.status).toBe(201);

    for (const briefValues of [undefined, { other: "not the task" }] as const) {
      const response = await request("/harness/runs", "POST",
        { project_root: ROOT, manifest_id: "bug-fix", ...(briefValues ? { brief_values: briefValues } : {}) });
      expect(response?.status).toBe(400);
      expect(String((await payload(response)).error)).toContain("task");
    }
    expect(store.listRuns(ROOT)).toHaveLength(0);
  });

  test("two concurrent runs see only their own brief_values", async () => {
    const bothMakersStarted = Promise.withResolvers<void>();
    let startedMakers = 0;
    const { prompts, execution: live } = captureMakerPrompts(async () => {
      if (++startedMakers === 2) bothMakersStarted.resolve();
      // Overlap the two maker turns, but never let a run that never starts its
      // second maker hang the suite: the assertions below fail instead.
      await Promise.race([bothMakersStarted.promise, Bun.sleep(500)]);
      return { ok: true };
    });
    const { request } = setup(live);
    const alpha = manifest("alpha-run");
    alpha.guides.rules = ["ALPHA-RUN"];
    const beta = manifest("beta-run");
    beta.guides.rules = ["BETA-RUN"];

    const [alphaStart, betaStart] = await Promise.all([
      request("/harness/runs", "POST", { project_root: ROOT, manifest: alpha, brief_values: { task: "ALPHA-TASK" } }),
      request("/harness/runs", "POST", { project_root: ROOT, manifest: beta, brief_values: { task: "BETA-TASK" } }),
    ]);
    expect(alphaStart?.status).toBe(202);
    expect(betaStart?.status).toBe(202);

    await bothMakersStarted.promise;
    const alphaPrompt = prompts.find((prompt) => prompt.includes("ALPHA-RUN"));
    const betaPrompt = prompts.find((prompt) => prompt.includes("BETA-RUN"));
    expect(alphaPrompt).toBeDefined();
    expect(betaPrompt).toBeDefined();
    expect(alphaPrompt).toContain("ALPHA-TASK");
    expect(alphaPrompt).not.toContain("BETA-TASK");
    expect(betaPrompt).toContain("BETA-TASK");
    expect(betaPrompt).not.toContain("ALPHA-TASK");
  }, 3_000);

  test("refuses a same-family maker/checker from the live config pool instead of the shipped defaults", async () => {
    const item = manifest();
    item.maker_agent_id = "go-deepseek-v4-flash";
    item.checker.agent_id = "or-ling-flash";
    // The shipped pool resolves these ids to DeepSeek and Ling, so a route that
    // ignored the live config would start the run. The live pool below is the
    // one the run's models actually come from, and both ids are DeepSeek there.
    const liveAgents: OrchestratorAgent[] = [
      {
        id: "go-deepseek-v4-flash", provider: "opencode_go", model_id: "deepseek-v4-flash",
        capabilities: { code: 0.9, reasoning: 0.86, speed: 0.82, cost: 0.85, json_reliability: 0.9 },
        default_for: ["executor"], enabled: true,
      },
      {
        id: "or-ling-flash", provider: "openrouter", model_id: "deepseek-v4-pro",
        capabilities: { code: 0.93, reasoning: 0.9, speed: 0.7, cost: 0.7, json_reliability: 0.85 },
        default_for: ["reviewer"], enabled: true,
      },
    ];
    const live = createHarnessExecution({
      store: new HarnessStore({ dbPath: ":memory:" }),
      agents: liveAgents,
      runMakerTurn: async () => ({ ok: true }),
      callModel: async () => ({ text: "ACCEPT\nLooks independent." }),
    });
    const { store, request } = setup(live);
    await request("/harness/manifests", "POST", { manifest: item, expected_revision: 0 });

    const started = await request("/harness/runs", "POST", { project_root: ROOT, manifest_id: item.id, brief_values: { task: "Fix the bug" } });

    // A refused start answers 400 with the engine's reason. A 202 here would
    // hand back a run_id that no GET route can ever find.
    expect(started?.status).toBe(400);
    const refusal = await payload(started);
    expect(refusal).not.toHaveProperty("run_id");
    expect(String(refusal.error)).toMatch(/same model family/);
    expect(String(refusal.error)).toContain(item.maker_agent_id);
    expect(String(refusal.error)).toContain(item.checker.agent_id);
    expect(store.listRuns(ROOT)).toHaveLength(0);
  });

  test("persists asynchronous maker events under the run ID returned by each start", async () => {
    const bothMakersStarted = Promise.withResolvers<void>();
    const bothEventsRecorded = Promise.withResolvers<void>();
    let startedMakers = 0;
    let recordedEvents = 0;
    const { request } = setup(execution({ runMaker: async ({ manifest, round }) => {
      if (++startedMakers === 2) bothMakersStarted.resolve();
      await bothMakersStarted.promise;
      recordHarnessMakerEvent({ event_type: "maker_tool_refused", payload: { round, tool: manifest.id, reason: "no_op" } });
      if (++recordedEvents === 2) bothEventsRecorded.resolve();
      return {};
    } }));
    const starts = await Promise.all(["read_file", "edit_file"].map(async (tool) => {
      const started = await request("/harness/runs", "POST", { project_root: ROOT, manifest: manifest(tool), brief_values: { task: "Fix the bug" } });
      expect(started?.status).toBe(202);
      const { run_id } = await payload(started);
      return { run_id, tool };
    }));

    await bothEventsRecorded.promise;
    for (const { run_id, tool } of starts) {
      const { run } = await payload(await request(`/harness/runs/${run_id}?project_root=${encodeURIComponent(ROOT)}`));
      expect(run.events.filter((event: { event_type: string }) => event.event_type === "maker_tool_refused")).toMatchObject([
        { run_id, event_type: "maker_tool_refused", payload: { round: 1, tool, reason: "no_op" } },
      ]);
    }
  }, 3_000);

  test("cancels an in-flight run and settles it with the existing cancelled stop reason", async () => {
    const { request } = setup(execution({ runMaker: waitingMaker }));
    await request("/harness/manifests", "POST", { manifest: manifest(), expected_revision: 0 });
    const { run_id } = await payload(await request("/harness/runs", "POST", { project_root: ROOT, manifest_id: "bug-fix", brief_values: { task: "Fix the bug" } }));
    const cancelled = await request(`/harness/runs/${run_id}/cancel`, "POST", { project_root: ROOT });
    expect(cancelled?.status).toBe(200);
    expect((await payload(cancelled)).stop_reason).toBe("cancelled");
    const read = await payload(await request(`/harness/runs/${run_id}?project_root=${encodeURIComponent(ROOT)}`));
    const stops = read.run.events.filter((event: { event_type: string }) => event.event_type === "stopped");
    expect(stops.map((event: { payload: { stop_reason: string } }) => event.payload.stop_reason)).toEqual(["cancelled"]);
  });

  test("settles a crashed run as run_failed and never as a normal round cap", async () => {
    const { store, request } = setup(execution());
    await request("/harness/manifests", "POST", { manifest: manifest(), expected_revision: 0 });
    store.appendRound = () => { throw new Error("disk full"); };
    const { run_id } = await payload(await request("/harness/runs", "POST", { project_root: ROOT, manifest_id: "bug-fix", brief_values: { task: "Fix the bug" } }));
    let stoppedReason: string | undefined;
    for (let attempt = 0; attempt < 200 && !stoppedReason; attempt++) {
      await Bun.sleep(5);
      const stopped = (store.getRun(run_id)?.events ?? []).find((event) => event.event_type === "stopped");
      if (stopped && typeof stopped.payload === "object" && stopped.payload !== null && "stop_reason" in stopped.payload) {
        stoppedReason = (stopped.payload as { stop_reason?: string }).stop_reason;
      }
    }
    expect(stoppedReason).toBe("run_failed");
    expect(stoppedReason).not.toBe("max_rounds");
  });

  test("refuses unknown and already-cancelled run ids without touching the stored run", async () => {
    const { request } = setup(execution({ runMaker: waitingMaker }));
    await request("/harness/manifests", "POST", { manifest: manifest(), expected_revision: 0 });
    const { run_id } = await payload(await request("/harness/runs", "POST", { project_root: ROOT, manifest_id: "bug-fix", brief_values: { task: "Fix the bug" } }));
    expect((await request(`/harness/runs/${crypto.randomUUID()}/cancel`, "POST", { project_root: ROOT }))?.status).toBe(404);
    expect((await request(`/harness/runs/${run_id}/cancel`, "POST", { project_root: ROOT }))?.status).toBe(200);
    expect((await request(`/harness/runs/${run_id}/cancel`, "POST", { project_root: ROOT }))?.status).toBe(409);
    const read = await payload(await request(`/harness/runs/${run_id}?project_root=${encodeURIComponent(ROOT)}`));
    expect(read.run.id).toBe(run_id);
    expect(read.run.events.filter((event: { event_type: string }) => event.event_type === "stopped")).toHaveLength(1);
    const history = await payload(await request(`/harness/runs?project_root=${encodeURIComponent(ROOT)}`));
    expect(history.runs.filter((run: { id: string }) => run.id === run_id)).toHaveLength(1);
  });
});
