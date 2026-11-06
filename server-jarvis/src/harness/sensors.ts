import { getHarnessCommand } from "./commands";
import { manifestHash, validateManifest, type HarnessManifest, type HarnessSensor } from "./manifest";
import type { HarnessStore } from "./store";

export type SensorStatus = "zero" | "nonzero" | "failed" | "not_applicable" | "unapproved";

export interface SensorSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Spawn a catalog command directly (never through a shell) in the project root. */
export type SensorSpawn = (input: {
  executable: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
}) => Promise<SensorSpawnResult>;

export interface SensorRunResult {
  counter_vector: Record<string, number | null | "not_applicable">;
  sensors: Array<{
    sensor_id: string;
    status: SensorStatus;
    counter: number | null;
    baseline: number | null;
    improved: boolean | null;
    reason?: string;
  }>;
  run_id: string;
  round_id: string;
  all_zero: boolean;
}

interface SensorStore extends Pick<HarnessStore, "findApproval" | "createRun" | "appendRound" | "appendSensorResult"> {}

function normalizedStatus(status: SensorStatus): "passed" | "failed" | "not_applicable" {
  if (status === "zero") return "passed";
  if (status === "not_applicable") return status;
  return "failed";
}

/** Execute one bounded, sequential sensor pass using only server-owned commands. */
export async function runSensors(input: {
  manifest: HarnessManifest;
  store: SensorStore;
  spawn: SensorSpawn;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<SensorRunResult> {
  const { manifest, store, spawn, signal } = input;
  // Kept injectable for a stable call contract with the harness runner; timeout
  // enforcement uses timers while approval/result timestamps remain store-owned.
  void input.now;
  const validation = validateManifest(manifest);
  if (!validation.ok) throw new Error(`Invalid harness manifest: ${validation.errors.join("; ")}`);
  const hash = manifestHash(manifest);
  const run = store.createRun({ project_root: manifest.project_root, manifest_id: manifest.id, manifest_hash: hash });
  const sensors: SensorRunResult["sensors"] = [];
  const counterVector: SensorRunResult["counter_vector"] = {};
  const records: Array<{ sensor: HarnessSensor; status: SensorStatus; counter: number | null; exitCode: number | null; stdout: string; stderr: string }> = [];

  for (const sensor of manifest.sensors) {
    let status: SensorStatus;
    let counter: number | null = null;
    let reason: string | undefined;
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let improved: boolean | null = null;

    if (sensor.kind === "unavailable") {
      status = "not_applicable";
      reason = "sensor is marked unavailable";
    } else if (sensor.baseline === undefined) {
      status = "not_applicable";
      reason = "sensor has no stored baseline";
    } else if (signal?.aborted) {
      status = "failed";
      reason = "sensor run aborted before execution";
    } else {
      const command = sensor.command_id ? getHarnessCommand(sensor.command_id) : undefined;
      if (!command) {
        status = "failed";
        reason = "sensor command is not in the server-owned catalog";
      } else {
        const approval = store.findApproval(command.command_id, manifest.project_root, hash);
        if (approval?.decision !== "approved") {
          status = "unapproved";
          reason = approval?.decision === "denied" ? "command approval was denied" : "matching command approval is required";
        } else {
          const controller = new AbortController();
          let timedOut = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const onAbort = () => controller.abort();
          signal?.addEventListener("abort", onAbort, { once: true });
          try {
            const timeout = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
                reject(new Error("sensor timed out"));
              }, sensor.timeout_ms);
            });
            const aborted = new Promise<never>((_, reject) => {
              if (signal?.aborted) reject(new Error("sensor run aborted"));
              else signal?.addEventListener("abort", () => reject(new Error("sensor run aborted")), { once: true });
            });
            const result = await Promise.race([spawn({
              executable: command.executable,
              args: [...command.fixed_args, ...sensor.args],
              cwd: manifest.project_root,
              signal: controller.signal,
            }), timeout, aborted]);
            stdout = result.stdout;
            stderr = result.stderr;
            exitCode = result.exitCode;
            const parsed = command.parse(stdout, stderr, exitCode);
            if (!parsed.ok) {
              status = "failed";
              reason = parsed.error;
            } else {
              counter = parsed.counter;
              improved = counter < sensor.baseline;
              status = exitCode === 0 && counter === 0 && counter <= sensor.zero_threshold ? "zero" : "nonzero";
              if (status === "nonzero") reason = sensor.failure_message;
            }
          } catch (error) {
            status = "failed";
            reason = timedOut ? `sensor timed out after ${sensor.timeout_ms}ms` :
              signal?.aborted ? "sensor run aborted" : error instanceof Error ? error.message : String(error);
          } finally {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
          }
        }
      }
    }

    const vectorValue = status === "not_applicable" ? "not_applicable" : counter;
    counterVector[sensor.id] = vectorValue;
    sensors.push({ sensor_id: sensor.id, status, counter, baseline: sensor.baseline ?? null, improved, ...(reason ? { reason } : {}) });
    records.push({ sensor, status, counter, exitCode, stdout, stderr });
  }

  const round = store.appendRound({ run_id: run.id, round_number: 1, counter_vector: counterVector });
  for (const record of records) store.appendSensorResult({ run_id: run.id, round_id: round.id, sensor_id: record.sensor.id,
    status: normalizedStatus(record.status), counter: record.counter, exit_code: record.exitCode, stdout: record.stdout, stderr: record.stderr });

  return { counter_vector: counterVector, sensors, run_id: run.id, round_id: round.id,
    all_zero: sensors.length > 0 && sensors.every((sensor) => sensor.status === "zero") };
}
