import { describe, test, expect } from "bun:test";
import { tmpdir } from "os";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import { registerShellBundle } from "./shell-bundle";
import { defaultConfig } from "./config";

function makeRuntime() {
  const rt = createToolRuntime();
  registerShellBundle(rt);
  return rt;
}

function makeCtx() {
  const cfg = defaultConfig();
  cfg.jarvis_path = tmpdir();
  cfg.tools.enabled = true;
  cfg.tools.sandbox_mode = "off";
  return makeExecutionContext("chat", cfg);
}

describe("ShellBundle", () => {
  test("registers a dangerous, approval-required bash tool", () => {
    const def = makeRuntime().listTools().find((t) => t.function.name === "bash")!;
    expect(def).toBeDefined();
    expect(def.dangerous).toBe(true);
    expect(def.requires_approval).toBe(true);
  });

  test("executes a command and returns stdout", async () => {
    const result = await makeRuntime().execute(
      { id: "t", name: "bash", arguments: { command: "echo hi" } },
      makeCtx(),
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("hi");
  });
});
