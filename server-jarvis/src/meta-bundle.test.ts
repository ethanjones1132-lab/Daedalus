import { describe, test, expect } from "bun:test";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import { registerMetaBundle } from "./meta-bundle";
import { registerFilesystemBundle } from "./filesystem-bundle";
import { defaultConfig } from "./config";

function ctx() {
  const cfg = defaultConfig();
  cfg.tools.enabled = true;
  return makeExecutionContext("chat", cfg);
}

function call(name: string, args: Record<string, unknown>) {
  return { id: `t-${name}`, name, arguments: args };
}

describe("meta bundle", () => {
  test("todo_write acknowledges the number of items", async () => {
    const rt = createToolRuntime();
    registerMetaBundle(rt);
    const result = await rt.execute(call("todo_write", { todos: [{}, {}] }), ctx());
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("2 items");
  });

  test("tools_enum lists the tools registered in the runtime", async () => {
    const rt = createToolRuntime();
    registerFilesystemBundle(rt);
    registerMetaBundle(rt);
    const result = await rt.execute(call("tools_enum", {}), ctx());
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("read_file");
    expect(result.output).toContain("todo_write");
    expect(result.output).toContain("tools_enum");
  });
});
