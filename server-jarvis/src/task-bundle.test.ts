import { describe, test, expect } from "bun:test";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import { registerTaskBundle, registerTaskControlBundle } from "./task-bundle";
import { defaultConfig } from "./config";

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
});
