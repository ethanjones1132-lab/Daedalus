/**
 * Server-side execution boundaries for a harness run (routes.ts's
 * `HarnessExecution`). The loop itself stays in `runHarness`; this module only
 * supplies the sensors, maker, checker and admission boundaries.
 *
 * The built-in maker uses the llama.cpp tool loop. Named pool Agents and
 * opt-in fallback use `ExecutorDelegateRuntime.run`. The shared delegate
 * resolver pins an "auto" model before each delegated turn launches the CLI.
 *
 * Every boundary that reaches the outside world — command spawn, executor turn,
 * model call, clock — is injected so tests run with fakes: no network, GPU or
 * real model.
 */

import { execFile } from "child_process";
import { loadConfig, type JarvisConfig } from "../config";
import { makeCallModel } from "../eval/call-model";
import { OrchestrationAdmissionController } from "../orchestration/admission-controller";
import {
  DEFAULT_ORCHESTRATOR_AGENTS,
  type OrchestratorAgent,
} from "../orchestration/agent-pool";
import { resolveAvailableDelegateModel } from "../orchestration/delegate-model-resolve";
import {
  enumerateDelegateModelCandidates,
  getBenchedDelegateModels,
} from "../orchestration/delegate-model-select";
import { renderHarnessGuides } from "../orchestration/harness-guides";
import { parseReviewerVerdict } from "../orchestration/stage-output";
import { resolveHarnessAgent, agentFamily, modelFamily, type HarnessAgentRef } from "./agents";
import { getHarnessCommand } from "./commands";
import type { HarnessAdmission, HarnessControllerInput, HarnessMakerFailure, HarnessSensorBatch } from "./controller";
import { INKLING_MAKER_ID, recordHarnessMakerEvent, runInklingMaker, type HarnessMakerRequest } from "./inkling-maker";
import { createHarnessMakerTools } from "./maker-tools";
import type { HarnessManifest } from "./manifest";
import type { HarnessExecution } from "./routes";
import { runSensors, type SensorSpawn, type SensorSpawnResult } from "./sensors";
import type {
  HarnessRound,
  HarnessSensorResult,
  HarnessStore,
} from "./store";

/** Upper bound for the diff handed to the checker, so one huge change cannot fill the window. */
export const HARNESS_DIFF_MAX_CHARS = 8_000;

export type { HarnessAgentRef } from "./agents";

export interface HarnessMakerTurnInput {
  cwd: string;
  prompt: string;
  agent: HarnessAgentRef;
  round: number;
  signal: AbortSignal;
  /**
   * The delegate config this turn must launch with. Its
   * `claude_cli.delegate.model` is always a concrete id: an "auto" pin was
   * resolved and probed before the turn reached this boundary.
   */
  config: JarvisConfig;
}

/**
 * One maker round: an executor tool loop for a turn. `ok: false` fails the
 * round; the optional failure fields carry the delegate's real cause through
 * to the run's `maker_failed` stop.
 */
export type HarnessMakerTurn = (
  input: HarnessMakerTurnInput,
) => Promise<{ ok: boolean; narrative?: string; cost_usd?: number } & HarnessMakerFailure>;

export interface HarnessModelCallInput {
  prompt: string;
  agent: HarnessAgentRef;
  signal: AbortSignal;
  /**
   * Model families the checker's fallback cascade must never use. `runChecker`
   * supplies the resolved maker's family so a pinned independent checker stays
   * independent even when its provider call fails and the cascade advances.
   */
  excludeFamilies?: readonly string[];
}

/** One agent call (the checker). Never a tool loop. */
export type HarnessModelCall = (input: HarnessModelCallInput) => Promise<{ text: string }>;

/** The config source and launch probe the maker's delegate resolution needs. */
export interface HarnessMakerDelegate {
  /** Fresh config for this turn; an "auto" delegate model is resolved from it. */
  config: () => JarvisConfig;
  /** Launch readiness for one candidate config (already pinned to its model). */
  isAvailable: (config: JarvisConfig) => Promise<boolean>;
}

export interface HarnessExecutionDeps {
  /** Approval lookup, bound to (command_id, project root, manifest hash). */
  store: Pick<HarnessStore, "findApproval">;
  /** The single-stage executor tool loop reused for a maker round. */
  runMakerTurn: HarnessMakerTurn;
  /**
   * Resolves the delegate model before the maker's CLI launch. Required so an
   * unresolved "auto" can never reach the command line.
   */
  makerDelegate: HarnessMakerDelegate;
  /** Read current llama.cpp settings when a new local run starts. */
  getConfig?: () => JarvisConfig;
  requestMaker?: HarnessMakerRequest;
  /** The agent call used for the checker. */
  callModel: HarnessModelCall;
  /** Direct command spawn; defaults to execFile with no shell. */
  spawn?: SensorSpawn;
  /** Orchestrator pool agents; defaults to the shipped pool. */
  agents?: readonly OrchestratorAgent[];
  /** Admission boundary; defaults to the server's background admission controller. */
  admission?: HarnessAdmission;
  /** Values for the manifest brief template (a stored template normally has none left). */
  briefValues?: Record<string, string>;
  now?: () => number;
  diffMaxChars?: number;
}

const CHECKER_VERDICT_INSTRUCTION =
  "Answer with ACCEPT or REJECT on the first line, then the reason.";

/** Direct spawn: executable plus argv, never a shell string. */
const defaultSpawn: SensorSpawn = ({ executable, args, cwd, signal }) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("sensor spawn aborted"));
      return;
    }
    let onAbort = () => {};
    const child = execFile(
      executable,
      args,
      { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(new Error("sensor spawn aborted"));
          return;
        }
        const code: unknown = error?.code;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: error ? (typeof code === "number" ? code : 1) : 0,
        });
      },
    );
    onAbort = () => { child.kill(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });

function agentRef(agent: OrchestratorAgent): HarnessAgentRef {
  return { id: agent.id, provider: agent.provider, model_id: agent.model_id };
}

/**
 * The checker's single model call through the shared `makeCallModel` wiring,
 * pinned to the agent resolved from the manifest rather than a fixed role.
 * `excludeFamilies` carries the maker's family so no maker-family entry can
 * enter the checker's fallback cascade.
 */
export function createCheckerModelCall(
  cfg: JarvisConfig,
  agent: HarnessAgentRef,
  options: { excludeFamilies?: readonly string[] } = {},
): HarnessModelCall {
  const callModel = makeCallModel(cfg, "reviewer", {
    agent,
    ...(options.excludeFamilies ? { excludeFamilies: options.excludeFamilies } : {}),
  });
  return async ({ prompt, signal }) => {
    const answer = await callModel([{ role: "user", content: prompt }], { stageAbort: signal });
    return { text: answer.content ?? "" };
  };
}

function spawnKey(executable: string, args: readonly string[]): string {
  return `${executable}\u0000${args.join("\u0000")}`;
}

/**
 * runSensors owns its own run/round evidence. The harness controller owns the
 * run here, so the pass writes into this scratch run instead of the real store;
 * only approvals are read from the real store.
 */
function scratchSensorStore(
  manifest: HarnessManifest,
  approvals: Pick<HarnessStore, "findApproval">,
): Pick<HarnessStore, "findApproval" | "createRun" | "appendRound" | "appendSensorResult"> {
  const createdAt = new Date(0).toISOString();
  const run = {
    id: "harness-sensor-pass",
    project_root: manifest.project_root,
    manifest_id: manifest.id,
    manifest_hash: "",
    status: "scratch",
    cost_usd: 0,
    created_at: createdAt,
    rounds: [],
    events: [],
  };
  return {
    findApproval: (commandId, projectRoot, hash) => approvals.findApproval(commandId, projectRoot, hash),
    createRun: () => run,
    appendRound: (input): HarnessRound => ({
      ...input,
      id: input.id ?? "harness-sensor-round",
      created_at: createdAt,
      sensor_results: [],
    }),
    appendSensorResult: (input): HarnessSensorResult => ({
      ...input,
      id: input.id ?? "harness-sensor-result",
      stdout_truncated: false,
      stderr_truncated: false,
      created_at: createdAt,
    }),
  };
}

function commandForSensor(
  manifest: HarnessManifest,
  sensorId: string,
): { executable: string; fixedArgs: readonly string[]; args: string[] } | undefined {
  const sensor = manifest.sensors.find((entry) => entry.id === sensorId);
  if (!sensor || sensor.kind !== "command" || !sensor.command_id) return undefined;
  const command = getHarnessCommand(sensor.command_id);
  return command
    ? { executable: command.executable, fixedArgs: command.fixed_args, args: sensor.args }
    : undefined;
}

/** Adapt `runSensors` to the batch the controller expects, without inventing any command. */
async function runSensorBatch(input: {
  manifest: HarnessManifest;
  signal: AbortSignal;
  store: Pick<HarnessStore, "findApproval">;
  spawn: SensorSpawn;
  now?: () => number;
}): Promise<HarnessSensorBatch> {
  const { manifest } = input;
  const uncatalogued = manifest.sensors.filter(
    (sensor) => sensor.kind === "command" && !getHarnessCommand(sensor.command_id ?? ""),
  );
  if (uncatalogued.length > 0) {
    // H1: a command outside the server-owned catalog is never spawned. Such a
    // manifest cannot pass validateManifest either, so no approval can be bound
    // to its hash; refuse the whole pass and execute nothing.
    return {
      counter_vector: Object.fromEntries(manifest.sensors.map((sensor) => [sensor.id, null])),
      sensors: manifest.sensors.map((sensor) => ({
        sensor_id: sensor.id,
        status: "unapproved" as const,
        counter: null,
        exit_code: null,
      })),
    };
  }

  // runSensors spawns each sensor at most once, in manifest order. Capturing by
  // (executable, argv) recovers the exit code and output for the batch evidence.
  const captured = new Map<string, SensorSpawnResult>();
  const recordingSpawn: SensorSpawn = async (spawnInput) => {
    const result = await input.spawn(spawnInput);
    captured.set(spawnKey(spawnInput.executable, spawnInput.args), result);
    return result;
  };

  const pass = await runSensors({
    manifest,
    store: scratchSensorStore(manifest, input.store),
    spawn: recordingSpawn,
    now: input.now,
    signal: input.signal,
  });

  return {
    counter_vector: pass.counter_vector,
    sensors: pass.sensors.map((entry) => {
      const command = commandForSensor(manifest, entry.sensor_id);
      const attempt = command
        ? captured.get(spawnKey(command.executable, [...command.fixedArgs, ...command.args]))
        : undefined;
      return {
        sensor_id: entry.sensor_id,
        status: entry.status,
        counter: entry.counter,
        exit_code: attempt?.exitCode ?? null,
        stdout: attempt?.stdout ?? "",
        // Real stderr when the command ran; otherwise runSensors' reason, so a
        // refused or skipped sensor still carries its evidence into the store.
        stderr: attempt?.stderr || entry.reason || "",
      };
    }),
  };
}

function failureLines(batch: HarnessSensorBatch, manifest: HarnessManifest): string[] {
  return batch.sensors
    .filter((entry) => entry.status !== "zero" && entry.status !== "not_applicable")
    .map((entry) => {
      const sensor = manifest.sensors.find((item) => item.id === entry.sensor_id);
      const detail = entry.status === "unapproved"
        ? "not approved for this manifest hash"
        : sensor?.failure_message ?? entry.status;
      const counter = entry.counter === null ? "" : `, counter ${entry.counter}`;
      return `${entry.sensor_id} (${entry.status}${counter}): ${detail}`;
    });
}

function makerPrompt(
  manifest: HarnessManifest,
  round: number,
  failures: readonly string[],
  briefValues: Record<string, string>,
): string {
  const guides = renderHarnessGuides({
    rules: manifest.guides.rules.join("\n"),
    briefTemplate: manifest.guides.brief_template,
    briefValues,
    skills: manifest.guides.skills,
    references: manifest.guides.references,
    bannedDefaults: manifest.guides.banned_defaults,
    role: "maker",
  });
  const status = failures.length > 0
    ? `Latest sensor failures:\n${failures.map((line) => `- ${line}`).join("\n")}`
    : "No sensor results yet: this is the first round, so make the brief true.";
  return [guides.text, `Harness round ${round} of ${manifest.loop.max_rounds}.`, status].join("\n\n");
}

function checkerPrompt(
  manifest: HarnessManifest,
  diff: string,
  briefValues: Record<string, string>,
): string {
  const guides = renderHarnessGuides({
    rules: manifest.guides.rules.join("\n"),
    briefTemplate: manifest.guides.brief_template,
    briefValues,
    skills: manifest.guides.skills,
    references: manifest.guides.references,
    bannedDefaults: manifest.guides.banned_defaults,
    role: "checker",
    rubric: manifest.checker.rubric,
  });
  return [guides.text, `[Harness diff]\n${diff}`, CHECKER_VERDICT_INSTRUCTION].join("\n\n");
}

async function safeSpawn(
  spawn: SensorSpawn,
  input: { executable: string; args: string[]; cwd: string; signal: AbortSignal },
): Promise<SensorSpawnResult | undefined> {
  try {
    return await spawn(input);
  } catch {
    return undefined;
  }
}

/** The commit HEAD pointed at when the run's first maker turn began. */
interface RunDiffBase {
  commit?: string;
  error?: string;
}

/** A failed git call while reading evidence; never reported as "no changes". */
interface CollectedRunDiff {
  text: string;
  errors: string[];
}

/** Cap on untracked files read one-by-one, so a large untracked tree stays bounded. */
const UNTRACKED_DIFF_FILE_LIMIT = 20;

function describeGitFailure(label: string, result: SensorSpawnResult | undefined): string {
  if (!result) return `${label} could not be run`;
  const detail = result.stderr.trim() || result.stdout.trim();
  return `${label} exited ${result.exitCode}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
}

/** HEAD at run start, so commits made by the run are part of the checker's evidence. */
async function captureRunBase(
  spawn: SensorSpawn,
  cwd: string,
  signal: AbortSignal,
): Promise<RunDiffBase> {
  const head = await safeSpawn(spawn, {
    executable: "git",
    args: ["--no-pager", "rev-parse", "HEAD"],
    cwd,
    signal,
  });
  if (!head) return { error: "git rev-parse HEAD could not be run" };
  if (head.exitCode !== 0) return { error: describeGitFailure("git rev-parse HEAD", head) };
  const commit = head.stdout.trim();
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) {
    return { error: "git rev-parse HEAD did not print a commit hash" };
  }
  return { commit };
}

/**
 * Content of files git does not track yet. `status --porcelain` only names
 * them (and collapses a new directory to one entry), so each file is diffed
 * against the null device, bounded by the same prompt budget as the tracked diff.
 */
async function collectUntrackedDiff(
  spawn: SensorSpawn,
  cwd: string,
  signal: AbortSignal,
  maxChars: number,
  usedChars: number,
): Promise<{ sections: string[]; errors: string[] }> {
  const listed = await safeSpawn(spawn, {
    executable: "git",
    args: ["--no-pager", "ls-files", "--others", "--exclude-standard", "-z"],
    cwd,
    signal,
  });
  if (!listed) return { sections: [], errors: ["git ls-files --others could not be run"] };
  if (listed.exitCode !== 0) {
    return { sections: [], errors: [describeGitFailure("git ls-files --others", listed)] };
  }
  const paths = listed.stdout.split("\u0000").filter((path) => path.length > 0);
  const sections: string[] = [];
  const errors: string[] = [];
  let used = usedChars;
  for (let index = 0; index < paths.length; index++) {
    if (used >= maxChars) break;
    if (index >= UNTRACKED_DIFF_FILE_LIMIT) {
      sections.push(`[${paths.length - index} more untracked files omitted]`);
      break;
    }
    const path = paths[index]!;
    const content = await safeSpawn(spawn, {
      executable: "git",
      args: [
        "--no-pager", "diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", path,
      ],
      cwd,
      signal,
    });
    // `--no-index` exits 1 when the two inputs differ, which is the normal case here.
    if (!content) {
      errors.push(`git diff --no-index for untracked "${path}" could not be run`);
      continue;
    }
    if (content.exitCode !== 0 && content.exitCode !== 1) {
      errors.push(describeGitFailure(`git diff --no-index for untracked "${path}"`, content));
      continue;
    }
    if (!content.stdout.trim()) continue;
    const section = `Untracked file: ${path}\n${content.stdout.trim()}`;
    sections.push(section);
    used += section.length + 2;
  }
  return { sections, errors };
}

/**
 * Evidence for the checker: changed paths, the working-tree diff, the committed
 * range since the run began, and the content of untracked files. Bounded for the
 * checker prompt. A git call that fails is returned as an error, not folded into
 * an empty-diff sentence.
 */
async function collectRunDiff(
  spawn: SensorSpawn,
  cwd: string,
  signal: AbortSignal,
  maxChars: number,
  base: RunDiffBase | undefined,
): Promise<CollectedRunDiff> {
  const sections: string[] = [];
  const errors: string[] = [];
  if (base?.error) errors.push(base.error);
  const status = await safeSpawn(spawn, {
    executable: "git",
    args: ["--no-pager", "status", "--porcelain"],
    cwd,
    signal,
  });
  if (!status) errors.push("git status --porcelain could not be run");
  else if (status.exitCode !== 0) errors.push(describeGitFailure("git status --porcelain", status));
  else if (status.stdout.trim()) sections.push(`Changed paths:\n${status.stdout.trim()}`);
  const diff = await safeSpawn(spawn, {
    executable: "git",
    args: ["--no-pager", "diff", "--no-color", "--no-ext-diff", "HEAD"],
    cwd,
    signal,
  });
  if (!diff) errors.push("git diff HEAD could not be run");
  else if (diff.exitCode !== 0) errors.push(describeGitFailure("git diff HEAD", diff));
  else if (diff.stdout.trim()) sections.push(diff.stdout.trim());
  if (base?.commit) {
    const committed = await safeSpawn(spawn, {
      executable: "git",
      args: ["--no-pager", "diff", "--no-color", "--no-ext-diff", `${base.commit}..HEAD`],
      cwd,
      signal,
    });
    if (!committed) errors.push(`git diff ${base.commit}..HEAD could not be run`);
    else if (committed.exitCode !== 0) {
      errors.push(describeGitFailure(`git diff ${base.commit}..HEAD`, committed));
    } else if (committed.stdout.trim()) {
      sections.push(`Committed since run start:\n${committed.stdout.trim()}`);
    }
  }
  const untracked = await collectUntrackedDiff(spawn, cwd, signal, maxChars, sections.join("\n\n").length);
  sections.push(...untracked.sections);
  errors.push(...untracked.errors);
  if (signal.aborted) throw new Error("harness aborted");
  const text = sections.join("\n\n");
  if (errors.length > 0) return { text, errors };
  if (!text) return { text: "(no tracked changes were found in the project root)", errors };
  return { text: text.length > maxChars ? `${text.slice(0, maxChars)}\n[diff truncated]` : text, errors };
}

function backgroundAdmission(): HarnessAdmission {
  const controller = new OrchestrationAdmissionController();
  return {
    acquire: async (input) => {
      const lease = await controller.acquire({
        workClass: input.workClass,
        signal: input.signal,
        deadlineAt: input.deadlineAt,
      });
      return { release: () => lease.release() };
    },
  };
}

/**
 * Resolve the maker's delegate config before a turn launches the CLI. A
 * concrete pin passes through untouched (existing behaviour); "auto" or an
 * empty pin is enumerated through the shared selection rules and probed, so the
 * runtime only ever receives a concrete, available id. When nothing is
 * available the turn fails with the tried ids instead of launching "auto".
 */
async function resolveMakerDelegateConfig(maker: HarnessMakerDelegate): Promise<JarvisConfig> {
  const config = maker.config();
  const configured = config.claude_cli.delegate.model.trim();
  if (configured && configured.toLowerCase() !== "auto") return config;
  const candidates = enumerateDelegateModelCandidates({
    configuredModel: config.claude_cli.delegate.model,
    thrashCount: 0,
    hasOpenCodeGoKey: Boolean(config.opencode_go.api_key?.trim()),
    proxyAvailable: true,
    benchedModels: getBenchedDelegateModels(),
  });
  const resolved = await resolveAvailableDelegateModel({
    config,
    candidates,
    isAvailable: maker.isAvailable,
  });
  const resolution = resolved.resolution;
  if (!resolution) {
    throw new Error(
      `no delegate model is available for the harness maker (tried: ${resolved.tried.join(", ")})`,
    );
  }
  return resolution.config;
}

/** Keep only the failure fields a failed turn actually knows; never add empty keys. */
function makerFailureOf(result: HarnessMakerFailure): HarnessMakerFailure {
  return {
    ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    ...(result.terminalStatus !== undefined ? { terminalStatus: result.terminalStatus } : {}),
    ...(result.failureDetail !== undefined ? { failureDetail: result.failureDetail } : {}),
  };
}

/** Build the server's harness execution boundaries from injected dependencies. */
export function createHarnessExecution(deps: HarnessExecutionDeps): HarnessExecution {
  const spawn = deps.spawn ?? defaultSpawn;
  const agents = deps.agents ?? DEFAULT_ORCHESTRATOR_AGENTS;
  const getConfig = deps.getConfig ?? loadConfig;
  const hasNamedMaker = agents.some((agent) => agent.enabled && agent.id === INKLING_MAKER_ID);
  const localRuns = new WeakMap<AbortSignal, { config: JarvisConfig; useDelegate: boolean; delegateFamilies: Set<string> }>();
  const defaultBriefValues = deps.briefValues ?? {};
  const diffMaxChars = deps.diffMaxChars ?? HARNESS_DIFF_MAX_CHARS;
  // The controller passes the same manifest object to both hooks for a run, so
  // each run's last sensor failures follow the run rather than a global key.
  const latestFailures = new WeakMap<HarnessManifest, string[]>();
  // Same keying for the commit the run started from. The first maker turn is the
  // earliest execution hook the run reaches, so HEAD is sampled there (before the
  // maker changes anything) and the checker diffs that range on top of HEAD.
  const runBases = new WeakMap<HarnessManifest, RunDiffBase>();

  function localMakerFor(manifest: HarnessManifest, signal: AbortSignal) {
    if (manifest.maker_agent_id !== INKLING_MAKER_ID || hasNamedMaker) return undefined;
    const current = localRuns.get(signal);
    if (current) return current;
    const run = { config: getConfig(), useDelegate: false, delegateFamilies: new Set<string>() };
    localRuns.set(signal, run);
    return run;
  }

  const sensors: HarnessControllerInput["sensors"] = async ({ manifest, signal }) => {
    const batch = await runSensorBatch({
      manifest,
      signal,
      store: deps.store,
      spawn,
      ...(deps.now ? { now: deps.now } : {}),
    });
    latestFailures.set(manifest, failureLines(batch, manifest));
    return batch;
  };

  const runMaker: HarnessControllerInput["runMaker"] = async ({ manifest, round, signal, briefValues }) => {
    const local = localMakerFor(manifest, signal);
    const prompt = makerPrompt(manifest, round, latestFailures.get(manifest) ?? [], briefValues ?? defaultBriefValues);
    if (local && !local.useDelegate) {
      if (round === 1 && manifest.checker.enabled) {
        runBases.set(manifest, await captureRunBase(spawn, manifest.project_root, signal));
      }
      const { config } = local;
      recordHarnessMakerEvent({ event_type: "maker_selected", payload: { round, provider: "llama_cpp", model_id: config.llama_cpp.model } });
      const turn = await runInklingMaker({
        backend: config.llama_cpp, prompt, round, signal,
        tools: createHarnessMakerTools({
          config, projectRoot: manifest.project_root, signal,
          runSensors: () => runSensorBatch({ manifest, signal, store: deps.store, spawn, now: deps.now }),
        }),
        request: deps.requestMaker,
        recordEvent: recordHarnessMakerEvent,
      });
      if (turn.ok) return { cost_usd: 0 };
      if (!turn.unavailable || !config.orchestrator.allow_cloud_helpers || signal.aborted) return { failed: true, cost_usd: 0 };
    }

    const agent = resolveHarnessAgent(agents, manifest.maker_agent_id, "executor");
    if (!agent) {
      throw new Error(`no executor agent is available for harness maker "${manifest.maker_agent_id}"`);
    }
    // Resolve before the first side effect of the turn so a missing model is a
    // clear failure, not a CLI launch with "--model auto". The message is also
    // logged because the controller records only the maker_failed stop reason.
    const config = await resolveMakerDelegateConfig(deps.makerDelegate).catch((error) => {
      console.error(
        `[Harness] maker delegate resolution failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    });
    if (local) {
      // The checker must stay independent if the local maker hands the task
      // off to the delegate. Check before the delegate can produce edits.
      const families = [agentFamily(agent), modelFamily(config.claude_cli.delegate.model)].filter(Boolean);
      if (manifest.checker.enabled) {
        const checker = resolveHarnessAgent(agents, manifest.checker.agent_id, "reviewer");
        if (checker && families.includes(agentFamily(checker))) {
          throw new Error(`checker agent "${checker.id}" shares a model family with the maker delegate`);
        }
      }
      for (const family of families) local.delegateFamilies.add(family);
      if (!local.useDelegate) {
        local.useDelegate = true;
        recordHarnessMakerEvent({ event_type: "maker_fallback", payload: { round, provider: "claude_cli", reason: "llama_cpp_unavailable" } });
      }
    } else if (round === 1 && manifest.checker.enabled) {
      runBases.set(manifest, await captureRunBase(spawn, manifest.project_root, signal));
    }
    const turn = await deps.runMakerTurn({
      cwd: manifest.project_root,
      prompt,
      agent: agentRef(agent),
      round,
      signal,
      config,
    });
    const cost = typeof turn.cost_usd === "number" ? { cost_usd: turn.cost_usd } : {};
    return turn.ok ? cost : { failed: true, ...makerFailureOf(turn), ...cost };
  };

  // The controller and manifest validation already refuse a checker equal to the
  // maker; that rule is untouched here.
  const runChecker: HarnessControllerInput["runChecker"] = async ({ manifest, signal, briefValues }) => {
    const agent = resolveHarnessAgent(agents, manifest.checker.agent_id, "reviewer");
    if (!agent) {
      throw new Error(`no reviewer agent is available for harness checker "${manifest.checker.agent_id}"`);
    }
    const local = localMakerFor(manifest, signal);
    const maker = local ? undefined : resolveHarnessAgent(agents, manifest.maker_agent_id, "executor");
    const makerFamily = local ? modelFamily(local.config.llama_cpp.model) : maker ? agentFamily(maker) : "";
    const excludeFamilies = [...new Set([makerFamily, ...(local?.delegateFamilies ?? [])].filter(Boolean))];
    const base = runBases.get(manifest);
    runBases.delete(manifest);
    const evidence = await collectRunDiff(spawn, manifest.project_root, signal, diffMaxChars, base);
    // A failed evidence read is not a verdict and must not reach the checker as
    // "nothing changed". Throwing keeps the run off the `passed` path; the
    // controller's own checker-failure handling records that the check failed.
    if (evidence.errors.length > 0) {
      throw new Error(`harness evidence collection failed: ${evidence.errors.join("; ")}`);
    }
    const answer = await deps.callModel({
      prompt: checkerPrompt(manifest, evidence.text, briefValues ?? defaultBriefValues),
      agent: agentRef(agent),
      signal,
      ...(excludeFamilies.length > 0 ? { excludeFamilies } : {}),
    });
    return { passed: parseReviewerVerdict(answer.text) === "accept" };
  };

  return {
    sensors,
    runMaker,
    localMakerModel: ({ manifest, signal }) => localMakerFor(manifest, signal)?.config.llama_cpp.model,
    runChecker,
    admission: deps.admission ?? backgroundAdmission(),
    // The pool resolved above is what the maker and checker actually run on, so
    // the route can carry it into the controller's family check instead of
    // letting the controller fall back to the shipped defaults.
    agents,
  };
}
