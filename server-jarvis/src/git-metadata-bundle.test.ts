import { describe, expect, test } from "bun:test";
import { defaultConfig } from "./config";
import { getToolsForMode } from "./orchestration/modes";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import { registerGitMetadataBundle } from "./git-metadata-bundle";

const repoRoot = "C:\\Projects\\home-base-recovered";

describe("git metadata bundle", () => {
  test("reports the checked-out SHA without accepting a command string", async () => {
    const runtime = createToolRuntime();
    registerGitMetadataBundle(runtime);
    const ctx = makeExecutionContext("agent", defaultConfig(), {
      workspace_path: repoRoot,
      skip_approval_gate: true,
    });

    const result = await runtime.execute({
      id: "git-head",
      name: "git_metadata",
      arguments: { include: ["head"] },
    }, ctx);

    expect(result.is_error).toBe(false);
    expect(result.output).toMatch(/[0-9a-f]{40}/);

    const commandAttempt = await runtime.execute({
      id: "git-command",
      name: "git_metadata",
      arguments: { command: "status --porcelain" },
    }, ctx);
    expect(commandAttempt.is_error).toBe(false);
    expect(commandAttempt.output).toContain("git_metadata_invalid_arguments");
  });

  test("workspace_read executor receives git_metadata but not shell_execute", () => {
    const runtime = createToolRuntime();
    registerGitMetadataBundle(runtime);
    const names = getToolsForMode("executor", runtime.listTools(), "read_only")
      .map((tool) => tool.function.name);

    expect(names).toContain("git_metadata");
    expect(names).not.toContain("shell_execute");
    expect(names).not.toContain("bash");
  });
});

