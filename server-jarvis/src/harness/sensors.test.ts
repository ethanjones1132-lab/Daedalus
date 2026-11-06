import { describe, expect, test } from "bun:test";
import { manifestHash, type HarnessManifest } from "./manifest";
import { HarnessStore } from "./store";
import { runSensors, type SensorSpawn } from "./sensors";

function manifest(...sensors: HarnessManifest["sensors"]): HarnessManifest {
  return {
    schema_version: 1, id: "bugfix", project_root: "/workspace/project", project_kind: "typescript",
    purpose: "bug_fix", template_family: "typescript_node",
    guides: { rules: [], brief_template: "", skills: [], references: [], banned_defaults: [] },
    maker_agent_id: "maker", checker: { enabled: true, agent_id: "checker", rubric: "independent" },
    sensors, loop: { max_rounds: 5, abort_on_no_progress: true }, approval: { required_for_new_commands: true },
  };
}

function sensor(id: string, command_id = "bun_test", baseline: number | undefined = 4) {
  return { id, kind: "command" as const, command_id, args: [], timeout_ms: 30, zero_threshold: 0,
    failure_message: "checks remain", required: true, ...(baseline === undefined ? {} : { baseline }) };
}

function setup(item: HarnessManifest) {
  const store = new HarnessStore({ dbPath: ":memory:" });
  for (const command_id of new Set(item.sensors.flatMap((entry) => entry.command_id ? [entry.command_id] : []))) {
    store.recordApproval({ command_id, project_root: item.project_root, manifest_hash: manifestHash(item), decision: "approved" });
  }
  return store;
}

describe("runSensors", () => {
  test("runs approved sensors sequentially and reports all-zero", async () => {
    const item = manifest(sensor("tests"), sensor("types", "bun_typecheck"));
    const store = setup(item);
    const order: string[] = [];
    const spawn: SensorSpawn = async ({ executable, args }) => {
      order.push(`${executable} ${args.join(" ")}`);
      return { stdout: "errors: 0", stderr: "", exitCode: 0 };
    };
    const result = await runSensors({ manifest: item, store, spawn, now: () => 100 });
    expect(order).toEqual(["bun test", "bun run typecheck"]);
    expect(result.all_zero).toBe(true);
    expect(result.counter_vector).toEqual({ tests: 0, types: 0 });
    expect(store.getRun(result.run_id)?.rounds[0]?.sensor_results).toHaveLength(2);
  });

  test("reports a nonzero counter and baseline improvement without calling it green", async () => {
    const item = manifest(sensor("tests"));
    const result = await runSensors({ manifest: item, store: setup(item), spawn: async () => ({ stdout: "errors: 2", stderr: "", exitCode: 1 }) });
    expect(result.sensors[0]).toMatchObject({ status: "nonzero", counter: 2, improved: true });
    expect(result.all_zero).toBe(false);
  });

  test("treats parse failure and timeout as failures, never zero", async () => {
    const item = manifest(sensor("parse"), sensor("timeout", "bun_typecheck"));
    const store = setup(item);
    const result = await runSensors({ manifest: item, store, spawn: async ({ args }) => {
      if (args[0] === "test") return { stdout: "not a counter", stderr: "", exitCode: 0 };
      return new Promise(() => {});
    } });
    expect(result.sensors.map(({ status }) => status)).toEqual(["failed", "failed"]);
    expect(result.sensors[1]?.reason).toMatch(/timed out/);
    expect(result.all_zero).toBe(false);
  });

  test("abort stops subsequent commands", async () => {
    const item = manifest(sensor("first"), sensor("second", "bun_typecheck"));
    const store = setup(item);
    const abort = new AbortController();
    let calls = 0;
    const spawn: SensorSpawn = async ({ signal }) => {
      calls++;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        abort.abort();
      });
    };
    const result = await runSensors({ manifest: item, store, spawn, signal: abort.signal });
    expect(calls).toBe(1);
    expect(result.sensors.map(({ status }) => status)).toEqual(["failed", "failed"]);
  });

  test("does not spawn unapproved or hash-invalidated commands", async () => {
    const item = manifest(sensor("tests"));
    const store = new HarnessStore({ dbPath: ":memory:" });
    store.recordApproval({ command_id: "bun_test", project_root: item.project_root, manifest_hash: "stale-hash", decision: "approved" });
    let calls = 0;
    const result = await runSensors({ manifest: item, store, spawn: async () => { calls++; return { stdout: "errors: 0", stderr: "", exitCode: 0 }; } });
    expect(calls).toBe(0);
    expect(result.sensors[0]?.status).toBe("unapproved");
  });

  test("reports missing baseline as not_applicable, not green", async () => {
    const missingBaseline = sensor("tests");
    delete missingBaseline.baseline;
    const item = manifest(missingBaseline);
    let calls = 0;
    const result = await runSensors({ manifest: item, store: setup(item), spawn: async () => { calls++; return { stdout: "errors: 0", stderr: "", exitCode: 0 }; } });
    expect(calls).toBe(0);
    expect(result.counter_vector.tests).toBe("not_applicable");
    expect(result.sensors[0]).toMatchObject({ status: "not_applicable", reason: "sensor has no stored baseline" });
    expect(result.all_zero).toBe(false);
  });
});
