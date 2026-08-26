import { describe, test, expect } from "bun:test";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import { registerTaskBundle, registerTaskControlBundle } from "./task-bundle";
import { defaultConfig } from "./config";
import {
  DEFAULT_BG_COMMAND_TIMEOUT_MS,
  MAX_BG_COMMAND_TIMEOUT_MS,
  MIN_BG_COMMAND_TIMEOUT_MS,
  resolveBackgroundCommandTimeoutMs,
  toolTaskGet,
  toolTaskStop,
} from "./agent-tools";

function makeRuntime() {
  const rt = createToolRuntime();
  registerTaskBundle(rt);
  return rt;
}
function ctx() {
  const cfg = defaultConfig();
  cfg.tools.enabled = true;
  return makeExecutionContext("chat", cfg);
}
function call(name: string, args: Record<string, unknown>) {
  return { id: `t-${name}`, name, arguments: args };
}

describe("task bundle", () => {
  test("registers all 7 task tools", () => {
    const names = makeRuntime().listTools().map((t) => t.function.name).sort();
    expect(names).toEqual([
      "agent", "run_background_command", "task_create",
      "task_get", "task_list", "task_output", "task_stop",
    ]);
  });

  test("task-control registration is the non-spawning subset for delegate MCP", () => {
    const rt = createToolRuntime();
    registerTaskControlBundle(rt);
    expect(rt.listTools().map((t) => t.function.name).sort()).toEqual([
      "task_get", "task_list", "task_output", "task_stop",
    ]);
  });

  test("only the process-spawning tools are dangerous + approval-required", () => {
    const defs = Object.fromEntries(makeRuntime().listTools().map((d) => [d.function.name, d]));
    for (const n of ["run_background_command", "agent", "task_create"]) {
      expect(defs[n].dangerous).toBe(true);
      expect(defs[n].requires_approval).toBe(true);
    }
    for (const n of ["task_list", "task_get", "task_output", "task_stop"]) {
      expect(defs[n].dangerous).toBe(false);
      expect(defs[n].requires_approval).toBe(false);
    }
  });

  test("task_list executes without spawning anything", async () => {
    const result = await makeRuntime().execute(call("task_list", {}), ctx());
    expect(result.is_error).toBe(false);
    expect(typeof result.output).toBe("string");
  });

  test("task_get without an id is rejected by runtime validation", async () => {
    const result = await makeRuntime().execute(call("task_get", {}), ctx());
    expect(result.is_error).toBe(true);
    expect(result.error).toContain("Missing required argument");
  });

  test("run_background_command schema advertises timeout_ms", () => {
    const def = makeRuntime().listTools().find((t) => t.function.name === "run_background_command");
    expect(def).toBeDefined();
    const props = def!.function.parameters.properties as Record<string, unknown>;
    expect(props.timeout_ms).toBeDefined();
  });
});

describe("resolveBackgroundCommandTimeoutMs", () => {
  test("defaults to 5 minutes when omitted", () => {
    expect(resolveBackgroundCommandTimeoutMs(undefined)).toBe(DEFAULT_BG_COMMAND_TIMEOUT_MS);
    expect(resolveBackgroundCommandTimeoutMs("nope")).toBe(DEFAULT_BG_COMMAND_TIMEOUT_MS);
  });

  test("clamps below the floor and above the ceiling", () => {
    expect(resolveBackgroundCommandTimeoutMs(0)).toBe(MIN_BG_COMMAND_TIMEOUT_MS);
    expect(resolveBackgroundCommandTimeoutMs(-50)).toBe(MIN_BG_COMMAND_TIMEOUT_MS);
    expect(resolveBackgroundCommandTimeoutMs(MAX_BG_COMMAND_TIMEOUT_MS + 1)).toBe(
      MAX_BG_COMMAND_TIMEOUT_MS,
    );
  });

  test("honors an in-range request", () => {
    expect(resolveBackgroundCommandTimeoutMs(15_000)).toBe(15_000);
  });
});

describe("run_background_command timeout (live)", () => {
  test("kills a non-terminating child within the requested timeout_ms", async () => {
    // Regression for the 65-minute Phase-D hang: a model-spawned infinite
    // loop through run_background_command must not outlive timeout_ms.
    const runtime = makeRuntime();
    const context = ctx();
    // PowerShell path so Windows hosts do not depend on bash being on PATH.
    const hang = `node -e "setInterval(()=>{}, 1000)"`;
    const started = await runtime.execute(
      call("run_background_command", {
        command: hang,
        powershell: true,
        timeout_ms: 1_500,
        description: "hang-for-timeout-test",
      }),
      context,
    );
    expect(started.is_error).toBe(false);
    expect(String(started.output)).toMatch(/Task ID: (bg_\w+)/);
    expect(String(started.output)).toContain("Timeout: 1500ms");
    const idMatch = String(started.output).match(/Task ID: (bg_\w+)/);
    expect(idMatch).toBeTruthy();
    const taskId = idMatch![1]!;

    // Wait past the timeout + a little slack for process reaping.
    await new Promise((r) => setTimeout(r, 4_000));

    const status = await toolTaskGet({ id: taskId });
    // Stop if still running so we do not leak across tests.
    if (status.includes("running")) {
      await toolTaskStop({ id: taskId });
    }
    expect(status).toMatch(/failed|stopped/);
    if (status.includes("failed")) {
      expect(status.toLowerCase()).toMatch(/timeout|timed out/);
    }
  }, 15_000);
});
