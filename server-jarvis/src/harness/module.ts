import { createHash } from "node:crypto";
import type { HarnessSensorBatch } from "./controller";
import { planner } from "./harnesses/planner";
import { retry } from "./harnesses/retry";
import { worker } from "./harnesses/worker";

export interface RunBudget { max_rounds: number; max_ms: number; max_cloud_usd: number }

export interface HarnessLimits { max_rounds: number; max_ms?: number; max_cloud_usd?: number }

export interface EngineState {
  run_id: string;
  round: number;
  attached: { id: string; version: string; hash: string; params: unknown };
  budget_left: RunBudget;
  last_sensors?: HarnessSensorBatch;
  history: EngineEvent[];
}

export type HarnessDecision = { kind: "continue" } | { kind: "stop"; reason: string } |
  { kind: "suggest_switch"; id: string; why: string };

export interface HarnessRoundPolicy { instructions: string; sensor_ids?: string[]; skip_checker?: boolean }

/**
 * The workspace authority a harness may exercise. Declared by the app-owned
 * module, never by a prompt, and enforced where the maker's tools are composed.
 */
export type HarnessToolAccess = "read_only" | "read_write";

export interface HarnessModule {
  id: string;
  version: string;
  description: string;
  good_for: string[];
  bad_for: string[];
  params_schema: Record<string, unknown>;
  limits: HarnessLimits;
  /** Absent means read_write, preserving every module written before this field. */
  tool_access?: HarnessToolAccess;
  onAttach?(state: EngineState): void;
  beforeRound(state: EngineState): HarnessRoundPolicy;
  afterSensors(state: EngineState, results: HarnessSensorBatch): HarnessDecision;
  spawnPolicy?(state: EngineState): { allowed: boolean; max_helpers: number };
  onDetach?(state: EngineState): void;
}

export type EngineEvent = {
  at: number;
  kind: "attach" | "switch" | "forced_switch" | "spawn" | "stop" | "request";
  harness_id?: string;
  reason: string;
  detail?: unknown;
};

type RegisteredHarness = { module: HarnessModule; hash: string };
const registry = new Map<string, RegisteredHarness>();

function copy(module: HarnessModule): HarnessModule {
  const { onAttach, beforeRound, afterSensors, spawnPolicy, onDetach, ...metadata } = module;
  return { ...structuredClone(metadata), onAttach, beforeRound, afterSensors, spawnPolicy, onDetach };
}

/** Registers a trusted, app-owned module. External source requires the sandbox and gate. */
export function registerHarness(module: HarnessModule): void {
  const { id, version, limits } = module;
  if (!id.trim() || !version.trim()) throw new Error("harness id and version are required");
  if (registry.has(id)) throw new Error(`Harness already registered: ${id}`);
  if (!Number.isInteger(limits.max_rounds) || limits.max_rounds < 1 || limits.max_rounds > 5) {
    throw new Error("harness max_rounds must be an integer from 1 through 5");
  }
  if (limits.max_ms !== undefined && (!Number.isFinite(limits.max_ms) || limits.max_ms <= 0)) {
    throw new Error("harness max_ms must be a positive finite duration");
  }
  if (limits.max_cloud_usd !== undefined && (!Number.isFinite(limits.max_cloud_usd) || limits.max_cloud_usd < 0)) {
    throw new Error("harness max_cloud_usd must be a non-negative finite amount");
  }
  const registered = copy(module);
  const hash = createHash("sha256").update(JSON.stringify(registered, (_, value) =>
    typeof value === "function" ? Function.prototype.toString.call(value) : value)).digest("hex");
  registry.set(id, { module: registered, hash });
}

export function catalogue(): HarnessModule[] {
  return Array.from(registry.values(), ({ module }) => copy(module));
}

export function getHarness(id: string): RegisteredHarness {
  const found = registry.get(id);
  if (!found) throw new Error(`Unknown harness: ${id}`);
  return { module: copy(found.module), hash: found.hash };
}

registerHarness(worker);
registerHarness(planner);
registerHarness(retry);
