import type { JarvisConfig } from "../config";
import { registerFilesystemBundle } from "../filesystem-bundle";
import { createToolRuntime, makeExecutionContext, toolResultModelText } from "../tool-runtime";
import type { HarnessSensorBatch } from "./controller";
import type { HarnessMakerTool } from "./inkling-maker";

const PROJECT_TOOLS = new Set(["read_file", "list_directory", "glob", "grep", "edit_file", "write_file"]);

/** Compose the maker's tool list. DD-181 can add its code-mode tool here. */
export function createHarnessMakerTools(input: {
  config: JarvisConfig;
  projectRoot: string;
  signal: AbortSignal;
  runSensors: () => Promise<HarnessSensorBatch>;
}): HarnessMakerTool[] {
  const { config, projectRoot, signal } = input;
  if (!config.tools.enabled) return [];
  const runtime = createToolRuntime();
  registerFilesystemBundle(runtime);
  const ctx = makeExecutionContext("agent", {
    ...config, jarvis_path: projectRoot,
    tools: { ...config.tools, sandbox_mode: "strict", allowed_roots: [] },
  }, {
    workspace_path: projectRoot, signal,
    // The explicitly started Harness already authorizes its maker to edit its
    // project, as with the existing delegate. Only these scoped filesystem
    // tools are exposed. A model cannot select a root or dispatch a shell.
    skip_approval_gate: true,
  });
  const tools = runtime.listTools().filter(({ function: { name } }) => PROJECT_TOOLS.has(name))
    .map(({ function: definition }): HarnessMakerTool => ({
      definition,
      execute: async (args) => {
        const result = await runtime.execute({ id: crypto.randomUUID(), name: definition.name, arguments: args }, ctx);
        return { ok: !result.is_error, output: toolResultModelText(result) };
      },
    }));

  tools.push({
    definition: {
      name: "run_sensors", description: "Run this Harness's configured sensor checks and return their real results.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    execute: async () => {
      const batch = await input.runSensors();
      // A nonzero counter is useful evidence and does not mean dispatch failed.
      return { ok: batch.sensors.every(({ status }) => status !== "failed" && status !== "unapproved"),
        output: JSON.stringify(batch) };
    },
  });
  return tools;
}
