import { resolve } from "path";
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "./config";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import { registerGitDiffBundle } from "./git-diff-bundle";

const repoRoot = resolve(import.meta.dir, "../..");

describe("git diff bundle", () => {
  test("returns changed-file information for the active workspace", async () => {
    const runtime = createToolRuntime();
    registerGitDiffBundle(runtime);
    const ctx = makeExecutionContext("agent", defaultConfig(), {
      workspace_path: repoRoot,
      skip_approval_gate: true,
    });

    const result = await runtime.execute({
      id: "git-diff-stat",
      name: "git_diff",
      arguments: { mode: "stat" },
    }, ctx);

    expect(result.is_error).toBe(false);
    expect(result.output).toContain('"workspace"');
    expect(result.output).toContain(repoRoot.replace(/\\/g, "\\\\"));
  });

  test("rejects a non-repository workspace clearly", async () => {
    const runtime = createToolRuntime();
    registerGitDiffBundle(runtime);
    const ctx = makeExecutionContext("agent", defaultConfig(), {
      workspace_path: require("os").tmpdir(),
      skip_approval_gate: true,
    });

    const result = await runtime.execute({
      id: "git-diff-missing",
      name: "git_diff",
      arguments: { mode: "names" },
    }, ctx);

    expect(result.is_error).toBe(false);
    expect(result.output).toContain("git_diff_not_a_repository");
  });
});