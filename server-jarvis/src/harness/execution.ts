/**
 * Server-side execution boundaries for a harness run (routes.ts's
 * `HarnessExecution`). The loop itself stays in `runHarness`; this module only
 * supplies the sensors, maker, checker and admission boundaries.
 *
 * Maker entry point reused (not copied): `ExecutorDelegateRuntime.run` —
 * `productionExecutorDelegateRuntime` → `runClaudeDelegate` in
 * `orchestration/claude-delegate.ts`, injected here as `deps.runMakerTurn`.
 * Why this one: it is the orchestration layer's single-stage executor for one
 * turn. It takes one prompt, runs the bounded tool loop inside the delegate
 * process, confines itself to the allowed root and returns typed evidence
 * (`ok`, `narrative`, `toolCalls`), and it is already a constructor-injected
 * dependency of `PipelineExecutor` (`ExecutorDelegateRuntime`), so the harness
 * reuses it through the same seam instead of opening a second executor. The
 * alternatives do not fit a single stage: `PipelineExecutor.runExecutorStage`
 * is private to a full planner/executor/reviewer/synthesizer turn, and
 * index.ts's native tool loop is inline in `streamJarvis`.
 *
 * The resolved maker/checker agent is carried on every call so DD-151 can bind
 * the pool's maker (Inkling) without changing this contract. Nothing here binds
 * a model or changes a pool default.
 *
 * Every boundary that reaches the outside world — command spawn, executor turn,
 * model call, clock — is injected so tests run with fakes: no network, GPU or
 * real model.
 */

import { execFile } from "child_process";
import { OrchestrationAdmissionController } from "../orchestration/admission-controller";
import {
  AgentPool,
  DEFAULT_ORCHESTRATOR_AGENTS,
  type OrchestratorAgent,
} from "../orchestration/agent-pool";
import { renderHarnessGuides } from "../orchestration/harness-guides";
import { parseReviewerVerdict } from "../orchestration/stage-output";
import { getHarnessCommand } from "./commands";
import type { HarnessAdmission, HarnessControllerInput, HarnessSensorBatch } from "./controller";
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

/** The pool identity of the agent a harness stage runs as. */
export interface HarnessAgentRef {
  id: string;
  provider: OrchestratorAgent["provider"];
  model_id: string;
}

export interface HarnessMakerTurnInput {
  cwd: string;
  prompt: string;
  agent: HarnessAgentRef;
  round: number;
  signal: AbortSignal;
}

/** One maker round: an executor tool loop for a turn. `ok: false` fails the round. */
export type HarnessMakerTurn = (
  input: HarnessMakerTurnInput,
) => Promise<{ ok: boolean; narrative?: string }>;

export interface HarnessModelCallInput {
  prompt: string;
  agent: HarnessAgentRef;
  signal: AbortSignal;
}

/** One agent call (the checker). Never a tool loop. */
export type HarnessModelCall = (input: HarnessModelCallInput) => Promise<{ text: string }>;

export interface HarnessExecutionDeps {
  /** Approval lookup, bound to (command_id, project root, manifest hash). */
  store: Pick<HarnessStore, "findApproval">;
  /** The single-stage executor tool loop reused for a maker round. */
  runMakerTurn: HarnessMakerTurn;
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
          exitCode: typeof code === "number" ? code : 1,
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
 * A named pool id wins; the template's generic ids ("maker",
 * "independent-checker") are roles, so they resolve through the pool's stage
 * default (executor for the maker, reviewer for the checker).
 */
function resolveAgent(
  agents: readonly OrchestratorAgent[],
  agentId: string,
  stage: "executor" | "reviewer",
): OrchestratorAgent | undefined {
  const pool = new AgentPool([...agents]);
  return pool.enabled().find((agent) => agent.id === agentId) ?? pool.pickFor(stage, "general");
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

/** Working-tree diff of the run's project root, bounded for the checker prompt. */
async function collectRunDiff(
  spawn: SensorSpawn,
  cwd: string,
  signal: AbortSignal,
  maxChars: number,
): Promise<string> {
  const sections: string[] = [];
  const status = await safeSpawn(spawn, {
    executable: "git",
    args: ["--no-pager", "status", "--porcelain"],
    cwd,
    signal,
  });
  if (status?.exitCode === 0 && status.stdout.trim()) {
    sections.push(`Changed paths:\n${status.stdout.trim()}`);
  }
  const diff = await safeSpawn(spawn, {
    executable: "git",
    args: ["--no-pager", "diff", "--no-color", "--no-ext-diff", "HEAD"],
    cwd,
    signal,
  });
  if (diff?.exitCode === 0 && diff.stdout.trim()) sections.push(diff.stdout.trim());
  if (signal.aborted) throw new Error("harness aborted");
  const text = sections.join("\n\n");
  if (!text) return "(no tracked changes were found in the project root)";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[diff truncated]` : text;
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

/** Build the server's harness execution boundaries from injected dependencies. */
export function createHarnessExecution(deps: HarnessExecutionDeps): HarnessExecution {
  const spawn = deps.spawn ?? defaultSpawn;
  const agents = deps.agents ?? DEFAULT_ORCHESTRATOR_AGENTS;
  const briefValues = deps.briefValues ?? {};
  const diffMaxChars = deps.diffMaxChars ?? HARNESS_DIFF_MAX_CHARS;
  // The controller passes the same manifest object to both hooks for a run, so
  // each run's last sensor failures follow the run rather than a global key.
  const latestFailures = new WeakMap<HarnessManifest, string[]>();

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

  const runMaker: HarnessControllerInput["runMaker"] = async ({ manifest, round, signal }) => {
    const agent = resolveAgent(agents, manifest.maker_agent_id, "executor");
    if (!agent) {
      throw new Error(`no executor agent is available for harness maker "${manifest.maker_agent_id}"`);
    }
    const prompt = makerPrompt(manifest, round, latestFailures.get(manifest) ?? [], briefValues);
    const turn = await deps.runMakerTurn({
      cwd: manifest.project_root,
      prompt,
      agent: agentRef(agent),
      round,
      signal,
    });
    return turn.ok ? {} : { failed: true };
  };

  // The controller and manifest validation already refuse a checker equal to the
  // maker; that rule is untouched here.
  const runChecker: HarnessControllerInput["runChecker"] = async ({ manifest, signal }) => {
    const agent = resolveAgent(agents, manifest.checker.agent_id, "reviewer");
    if (!agent) {
      throw new Error(`no reviewer agent is available for harness checker "${manifest.checker.agent_id}"`);
    }
    const diff = await collectRunDiff(spawn, manifest.project_root, signal, diffMaxChars);
    const answer = await deps.callModel({
      prompt: checkerPrompt(manifest, diff, briefValues),
      agent: agentRef(agent),
      signal,
    });
    return { passed: parseReviewerVerdict(answer.text) === "accept" };
  };

  return {
    sensors,
    runMaker,
    runChecker,
    admission: deps.admission ?? backgroundAdmission(),
  };
}
