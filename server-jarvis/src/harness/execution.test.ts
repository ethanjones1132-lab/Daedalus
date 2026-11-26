import { describe, expect, test } from "bun:test";
import { runHarness } from "./controller";
import { createCheckerModelCall, createHarnessExecution, type HarnessAgentRef, type HarnessExecutionDeps, type HarnessMakerTurn, type HarnessModelCall } from "./execution";
import { defaultConfig, type JarvisConfig } from "../config";
import { clearOpenRouterCache } from "../openrouter";
import { manifestHash, type HarnessManifest } from "./manifest";
import { handleHarnessRequest, type HarnessExecution } from "./routes";
import type { SensorSpawn } from "./sensors";
import { HarnessStore } from "./store";
import { instantiateHarnessTemplate } from "./templates";
import type { OrchestratorAgent } from "../orchestration/agent-pool";

const ROOT = "/workspace/harness-fixture";

/** The commit the run started from, as the fake `git rev-parse HEAD` reports it. */
const RUN_BASE = "0123456789abcdef0123456789abcdef01234567";

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

/** An OpenRouter config whose reviewer cascade is exactly the supplied pool. */
function checkerCascadeConfig(agents: OrchestratorAgent[]): JarvisConfig {
  const cfg = defaultConfig();
  cfg.active_backend = "openrouter";
  cfg.openrouter.api_key = "test-or-key";
  cfg.openrouter.base_url = "https://openrouter.ai/api/v1";
  cfg.openrouter.model = "cohere/north-mini-code:free";
  cfg.openrouter.max_retries = 0;
  cfg.orchestrator.agents = agents;
  return cfg;
}

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
  /** Seed an approved row for every sensor command (default true). */
  autoApprove?: boolean;
}

function setupHarness(options: HarnessFixtureOptions) {
  const state = {
    errors: options.initialErrors ?? 2,
    spawns: [] as string[],
    makerTurns: [] as Array<{ prompt: string; round: number; agent: HarnessAgentRef }>,
    checkerPrompts: [] as Array<{ prompt: string; agent: HarnessAgentRef }>,
  };
  const store = new HarnessStore({ dbPath: ":memory:" });
  if (options.autoApprove ?? true) for (const commandId of new Set(options.manifest.sensors.flatMap((sensor) => sensor.command_id ? [sensor.command_id] : []))) {
    store.recordApproval({
      command_id: commandId, project_root: options.manifest.project_root,
      manifest_hash: manifestHash(options.manifest), decision: "approved",
    });
  }

  const spawn: SensorSpawn = async ({ executable, args }) => {
    state.spawns.push(`${executable} ${args.join(" ")}`);
    if (executable === "git") {
      if (args.includes("rev-parse")) return { stdout: `${RUN_BASE}\n`, stderr: "", exitCode: 0 };
      if (args.includes("status")) return { stdout: " M src/index.ts", stderr: "", exitCode: 0 };
      if (args.includes("ls-files")) return { stdout: "", stderr: "", exitCode: 0 };
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

  test("a commit made after the run started appears in the checker's diff", async () => {
    const manifest = fixtureManifest();
    const committedDiff = "+const fromCommit = true;";
    const spawns: string[] = [];
    const spawn: SensorSpawn = async ({ executable, args }) => {
      spawns.push(`${executable} ${args.join(" ")}`);
      if (executable !== "git") return { stdout: "errors: 0", stderr: "", exitCode: 0 };
      if (args.includes("rev-parse")) return { stdout: `${RUN_BASE}\n`, stderr: "", exitCode: 0 };
      if (args.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      if (args.includes("ls-files")) return { stdout: "", stderr: "", exitCode: 0 };
      if (args.includes(`${RUN_BASE}..HEAD`)) return { stdout: committedDiff, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const { state, store, execution } = setupHarness({ manifest, initialErrors: 0, deps: { spawn } });

    const result = await runHarness({
      manifest, store, run_id: "run-committed",
      sensors: execution.sensors, runMaker: execution.runMaker, runChecker: execution.runChecker, admission: execution.admission,
    });
    expect(result.stop_reason).toBe("passed");
    expect(state.checkerPrompts).toHaveLength(1);
    expect(state.checkerPrompts[0]!.prompt).toContain(committedDiff);
    expect(spawns).toContain(`git --no-pager diff --no-color --no-ext-diff ${RUN_BASE}..HEAD`);
  });

  test("an untracked new file's content appears in the checker's diff, not only its path", async () => {
    const manifest = fixtureManifest();
    const untrackedFile = "src/new-file.ts";
    const content = "+export const added = true;";
    const spawn: SensorSpawn = async ({ executable, args }) => {
      if (executable !== "git") return { stdout: "errors: 0", stderr: "", exitCode: 0 };
      if (args.includes("rev-parse")) return { stdout: `${RUN_BASE}\n`, stderr: "", exitCode: 0 };
      if (args.includes("status")) return { stdout: `?? ${untrackedFile}`, stderr: "", exitCode: 0 };
      if (args.includes("ls-files")) return { stdout: `${untrackedFile}\u0000`, stderr: "", exitCode: 0 };
      if (args.includes("--no-index")) {
        return {
          stdout: `diff --git a/dev/null b/${untrackedFile}\n--- /dev/null\n+++ b/${untrackedFile}\n${content}`,
          stderr: "",
          exitCode: 1,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const { state, store, execution } = setupHarness({ manifest, initialErrors: 0, deps: { spawn } });

    const result = await runHarness({
      manifest, store, run_id: "run-untracked",
      sensors: execution.sensors, runMaker: execution.runMaker, runChecker: execution.runChecker, admission: execution.admission,
    });
    expect(result.stop_reason).toBe("passed");
    expect(state.checkerPrompts).toHaveLength(1);
    expect(state.checkerPrompts[0]!.prompt).toContain(`Untracked file: ${untrackedFile}`);
    expect(state.checkerPrompts[0]!.prompt).toContain(content);
  });

  test("a git failure during evidence collection records an error and cannot settle passed", async () => {
    const manifest = fixtureManifest();
    const noChangesSentence = "(no tracked changes were found in the project root)";
    const spawn: SensorSpawn = async ({ executable, args }) => {
      if (executable !== "git") return { stdout: "errors: 0", stderr: "", exitCode: 0 };
      if (args.includes("rev-parse")) return { stdout: `${RUN_BASE}\n`, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
    };
    const { state, store, execution } = setupHarness({ manifest, initialErrors: 0, deps: { spawn } });

    await expect(execution.runChecker({ manifest, signal: new AbortController().signal }))
      .rejects.toThrow(/harness evidence collection failed.*git status --porcelain/);

    const result = await runHarness({
      manifest, store, run_id: "run-git-failure",
      sensors: execution.sensors, runMaker: execution.runMaker, runChecker: execution.runChecker, admission: execution.admission,
    });
    // A checker that throws produced no verdict: DD-192 settles it as
    // run_failed with the thrown message, never as a legitimate rejection.
    expect(result.stop_reason).toBe("run_failed");
    const stopped = store.getRun(result.run_id)?.events.filter((event) => event.event_type === "stopped") ?? [];
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.payload).toMatchObject({ stop_reason: "run_failed", rounds: 1 });
    expect(String((stopped[0]?.payload as { error?: unknown } | undefined)?.error))
      .toMatch(/harness evidence collection failed/);
    expect(state.checkerPrompts).toHaveLength(0);
    expect(state.checkerPrompts.some((checker) => checker.prompt.includes(noChangesSentence))).toBe(false);
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

  test("a checker that refuses to ACCEPT does not settle passed", async () => {
    const manifest = fixtureManifest();
    const { state, store, execution } = setupHarness({
      manifest, initialErrors: 0, checkerAnswer: "I cannot ACCEPT it",
    });

    const result = await runHarness({
      manifest, store, run_id: "run-checker-refused",
      sensors: execution.sensors, runMaker: execution.runMaker, runChecker: execution.runChecker, admission: execution.admission,
    });
    expect(state.checkerPrompts).toHaveLength(1);
    expect(result.stop_reason).toBe("checker_rejected");
    expect(result.stop_reason).not.toBe("passed");
  });

  test("the checker model call runs on the resolved agent, not the reviewer stage default", async () => {
    const cfg = defaultConfig();
    cfg.active_backend = "openrouter";
    cfg.openrouter.api_key = "test-or-key";
    cfg.openrouter.base_url = "https://openrouter.ai/api/v1";
    cfg.openrouter.max_retries = 0;
    cfg.orchestrator.agents = [{
      id: "reviewer-default", provider: "openrouter", model_id: "nvidia/nemotron-3-ultra-550b-a55b:free",
      capabilities: { code: 0.8, reasoning: 0.95, speed: 0.55, cost: 1, json_reliability: 0.88 },
      default_for: ["reviewer"], enabled: true,
    }];
    const requestedModels: string[] = [];
    const originalFetch = globalThis.fetch;
    clearOpenRouterCache();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return Response.json({ data: [] });
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      if (typeof body.model === "string") requestedModels.push(body.model);
      return Response.json({ choices: [{ message: { content: "ACCEPT\nIndependent review." } }] });
    }) as typeof fetch;

    try {
      const call = createCheckerModelCall(cfg, {
        id: "checker-agent", provider: "openrouter", model_id: "google/gemma-4-31b-it:free",
      });
      const answer = await call({ prompt: "Review the diff.", signal: new AbortController().signal });

      expect(answer.text).toContain("ACCEPT");
      expect(requestedModels[0]).toBe("google/gemma-4-31b-it:free");
    } finally {
      globalThis.fetch = originalFetch;
      clearOpenRouterCache();
    }
  });

  test("a pinned checker rejects rather than accepting a maker-family fallback", async () => {
    const cfg = checkerCascadeConfig([{
      id: "maker-family-reviewer", provider: "openrouter", model_id: "deepseek/deepseek-v4-flash:free",
      capabilities: { code: 0.9, reasoning: 0.95, speed: 0.6, cost: 1, json_reliability: 0.9 },
      default_for: ["reviewer"], enabled: true,
    }]);
    const requestedModels: string[] = [];
    const originalFetch = globalThis.fetch;
    clearOpenRouterCache();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return Response.json({ data: [] });
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      if (typeof body.model === "string") requestedModels.push(body.model);
      if (body.model === "google/gemma-4-31b-it:free") {
        return new Response("checker unavailable", { status: 400 });
      }
      return Response.json({ choices: [{ message: { content: "MAKER FAMILY ANSWER" } }] });
    }) as typeof fetch;

    try {
      const call = createCheckerModelCall(
        cfg,
        { id: "checker-agent", provider: "openrouter", model_id: "google/gemma-4-31b-it:free" },
        { excludeFamilies: ["deepseek"] },
      );
      await expect(call({ prompt: "Review the diff.", signal: new AbortController().signal }))
        .rejects.toThrow();
      expect(requestedModels).toContain("google/gemma-4-31b-it:free");
      expect(requestedModels).not.toContain("deepseek/deepseek-v4-flash:free");
    } finally {
      globalThis.fetch = originalFetch;
      clearOpenRouterCache();
    }
  });

  test("a pinned checker falls through only to a non-maker-family pool entry", async () => {
    const cfg = checkerCascadeConfig([
      {
        id: "maker-family-reviewer", provider: "openrouter", model_id: "deepseek/deepseek-v4-flash:free",
        capabilities: { code: 0.9, reasoning: 0.95, speed: 0.6, cost: 1, json_reliability: 0.9 },
        default_for: ["reviewer"], enabled: true,
      },
      {
        id: "independent-fallback", provider: "openrouter", model_id: "qwen/qwen3-coder:free",
        capabilities: { code: 0.7, reasoning: 0.7, speed: 0.7, cost: 1, json_reliability: 0.7 },
        default_for: [], enabled: true,
      },
    ]);
    const requestedModels: string[] = [];
    const originalFetch = globalThis.fetch;
    clearOpenRouterCache();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return Response.json({ data: [] });
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      if (typeof body.model === "string") requestedModels.push(body.model);
      if (body.model === "google/gemma-4-31b-it:free") {
        return new Response("checker unavailable", { status: 400 });
      }
      if (body.model === "deepseek/deepseek-v4-flash:free") {
        return Response.json({ choices: [{ message: { content: "MAKER FAMILY ANSWER" } }] });
      }
      return Response.json({ choices: [{ message: { content: "ACCEPT\nIndependent review." } }] });
    }) as typeof fetch;

    try {
      const call = createCheckerModelCall(
        cfg,
        { id: "checker-agent", provider: "openrouter", model_id: "google/gemma-4-31b-it:free" },
        { excludeFamilies: ["deepseek"] },
      );
      const answer = await call({ prompt: "Review the diff.", signal: new AbortController().signal });

      expect(answer.text).toContain("ACCEPT");
      expect(requestedModels).toContain("qwen/qwen3-coder:free");
      expect(requestedModels).not.toContain("deepseek/deepseek-v4-flash:free");
    } finally {
      globalThis.fetch = originalFetch;
      clearOpenRouterCache();
    }
  });

  test("the checker call carries the maker's model family", async () => {
    const manifest = fixtureManifest();
    const seen: Array<readonly string[] | undefined> = [];
    const { execution } = setupHarness({
      manifest,
      initialErrors: 0,
      deps: {
        callModel: async ({ excludeFamilies }) => {
          seen.push(excludeFamilies);
          return { text: "ACCEPT\nIndependent review." };
        },
      },
    });

    await execution.runChecker({ manifest, signal: new AbortController().signal });

    // The maker resolves to `executor-model` ("executor" family); the checker
    // must receive that family on the call so its cascade can exclude it.
    expect(seen).toEqual([["executor"]]);
  });

  test("(f) a saved template with a route-recorded approval runs its baseline-free sensor and settles passed", async () => {
    const manifest = instantiateHarnessTemplate("typescript_node_bug_fix", ROOT)!;
    expect(manifest.sensors[0]?.baseline).toBeUndefined();
    // No auto-approved row: the route below is the only writer.
    const { state, store, execution } = setupHarness({ manifest, autoApprove: false, initialErrors: 0, deps: { briefValues: { task: "Fix the failing typecheck" } } });
    store.saveManifest(manifest, 0);
    const approved = await routeRequest(store)("/harness/approvals", "POST", {
      project_root: ROOT, manifest_id: manifest.id, manifest_hash: manifestHash(manifest),
      command_id: "bun_typecheck", decision: "approved",
    });
    expect(approved?.status).toBe(201);

    const result = await runHarness({
      manifest, store, run_id: "run-template",
      sensors: execution.sensors, runMaker: execution.runMaker, runChecker: execution.runChecker, admission: execution.admission,
    });
    expect(result.stop_reason).toBe("passed");
    expect(result.rounds).toBe(1);
    expect(state.spawns).toContain("bun run typecheck");
    const run = store.getRun("run-template");
    expect(run?.rounds[0]?.counter_vector).toEqual({ typecheck: 0 });
    expect(run?.rounds[0]?.sensor_results[0]).toMatchObject({ sensor_id: "typecheck", status: "passed", counter: 0, exit_code: 0 });
  });

  test("(g) a template run without an approval still settles approval_denied and spawns nothing", async () => {
    const manifest = instantiateHarnessTemplate("typescript_node_bug_fix", ROOT)!;
    const { state, store, execution } = setupHarness({ manifest, autoApprove: false, deps: { briefValues: { task: "Fix the failing typecheck" } } });
    store.saveManifest(manifest, 0);

    const result = await runHarness({
      manifest, store, run_id: "run-template-unapproved",
      sensors: execution.sensors, runMaker: execution.runMaker, runChecker: execution.runChecker, admission: execution.admission,
    });
    expect(result.stop_reason).toBe("approval_denied");
    expect(result.rounds).toBe(1);
    expect(state.spawns.filter((command) => command.startsWith("bun "))).toEqual([]);
  });

  test("(h) with the approval flag off, a template run needs no approval row and still reaches the checker", async () => {
    const manifest = instantiateHarnessTemplate("typescript_node_bug_fix", ROOT)!;
    manifest.approval.required_for_new_commands = false;
    const { state, store, execution } = setupHarness({ manifest, autoApprove: false, initialErrors: 0, deps: { briefValues: { task: "Fix the failing typecheck" } } });
    store.saveManifest(manifest, 0);

    const result = await runHarness({
      manifest, store, run_id: "run-template-open",
      sensors: execution.sensors, runMaker: execution.runMaker, runChecker: execution.runChecker, admission: execution.admission,
    });
    expect(result.stop_reason).toBe("passed");
    expect(state.spawns).toContain("bun run typecheck");
    expect(store.findApproval("bun_typecheck", ROOT, manifestHash(manifest))).toBeUndefined();
  });
});
