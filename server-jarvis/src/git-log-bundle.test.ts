import { describe, expect, test } from "bun:test";
import { defaultConfig } from "./config";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import { registerGitLogBundle } from "./git-log-bundle";

const repoRoot = "C:\\Projects\\home-base-recovered";

describe("git log bundle", () => {
  test("returns recent commits for the active workspace", async () => {
    const runtime = createToolRuntime();
    registerGitLogBundle(runtime);
    const ctx = makeExecutionContext("agent", defaultConfig(), {
      workspace_path: repoRoot,
      skip_approval_gate: true,
    });

    const result = await runtime.execute({
      id: "git-log",
      name: "git_log",
      arguments: { limit: 5 },
    }, ctx);

    expect(result.is_error).toBe(false);
    expect(result.output).toContain('"commits"');
    expect(result.output).toMatch(/[0-9a-f]{40}/);
  });

  test("rejects a non-repository workspace clearly", async () => {
    const runtime = createToolRuntime();
    registerGitLogBundle(runtime);
    const ctx = makeExecutionContext("agent", defaultConfig(), {
      workspace_path: require("os").tmpdir(),
      skip_approval_gate: true,
    });

    const result = await runtime.execute({
      id: "git-log-missing",
      name: "git_log",
      arguments: {},
    }, ctx);

    expect(result.is_error).toBe(false);
    expect(result.output).toContain("git_log_not_a_repository");
  });
});