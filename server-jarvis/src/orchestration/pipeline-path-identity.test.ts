import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import { PipelineExecutor } from "./pipeline";
import { SessionOutcomeCollector, SelfTuningStore } from "../self-tuning/mod";

describe("PipelineExecutor path identity", () => {
  test("deflects equivalent workspace read paths without changing the runtime arguments", async () => {
    const runtime = createToolRuntime();
    const executedPaths: string[] = [];
    runtime.register({
      type: "function",
      function: {
        name: "read_file",
        description: "read a file",
        parameters: { type: "object", properties: {}, required: [] },
      },
      requires_approval: false,
      dangerous: false,
    }, async (args) => {
      executedPaths.push(String(args.path));
      return "implementation plan";
    });

    const workspaceRoot = "C:\\Projects\\Jarvis";
    const responses = [
      { content: "", tool_calls: [{ id: "relative", name: "read_file", arguments: { path: "IMPLEMENTATION_PLAN.md" } }] },
      { content: "", tool_calls: [{ id: "absolute", name: "read_file", arguments: { path: "C:\\Projects\\Jarvis\\IMPLEMENTATION_PLAN.md" } }] },
      { content: "", tool_calls: [{ id: "forward", name: "read_file", arguments: { path: "C:/Projects/Jarvis/IMPLEMENTATION_PLAN.md" } }] },
      { content: "read complete" },
    ];
    let responseIndex = 0;
    const executor = new PipelineExecutor(
      async () => responses[responseIndex++]!,
      runtime,
      makeExecutionContext("agent", defaultConfig(), { workspace_path: workspaceRoot }),
      new SessionOutcomeCollector(new SelfTuningStore(":memory:")),
    );

    await executor.execute(
      "Read IMPLEMENTATION_PLAN.md",
      ["executor"],
      "path-identity",
      () => {},
      { executionProfile: "read_only" },
    );

    expect(executedPaths).toEqual(["IMPLEMENTATION_PLAN.md"]);
  });
});
