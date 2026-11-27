import type { JarvisConfig } from "../config";
import { registerFilesystemBundle } from "../filesystem-bundle";
import { createToolRuntime, makeExecutionContext, toolResultModelText } from "../tool-runtime";
import type { HarnessSensorBatch } from "./controller";
import type { HarnessMakerTool } from "./inkling-maker";

const PROJECT_TOOLS = new Set(["read_file", "list_directory", "glob", "grep", "edit_file", "write_file"]);
/** Everything that can change the workspace through the scoped filesystem tools. */
const MUTATING_PROJECT_TOOLS = new Set(["edit_file", "write_file"]);
const READ_ONLY_PROJECT_TOOLS = new Set([...PROJECT_TOOLS].filter((name) => !MUTATING_PROJECT_TOOLS.has(name)));

export interface HarnessMakerToolOptions {
  config: JarvisConfig;
  projectRoot: string;
  signal: AbortSignal;
  runSensors: () => Promise<HarnessSensorBatch>;
  /**
   * Read-only workspace authority, declared by the attached harness module.
   * The composer removes every mutating tool before a model can select one,
   * and the dispatch wrapper refuses one even if it is reached.
   */
  read_only?: boolean;
}

/** Compose the maker's tool list. DD-181 can add its code-mode tool here. */
export function createHarnessMakerTools(input: HarnessMakerToolOptions): HarnessMakerTool[] {
  const { config, projectRoot, signal } = input;
  const readOnly = input.read_only === true;
  if (!config.tools.enabled) return [];
  const allowed = readOnly ? READ_ONLY_PROJECT_TOOLS : PROJECT_TOOLS;
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
  const tools = runtime.listTools().filter(({ function: { name } }) => allowed.has(name))
    .map(({ function: definition }): HarnessMakerTool => ({
      definition,
      execute: async (args) => {
        if (readOnly && MUTATING_PROJECT_TOOLS.has(definition.name)) {
          return { ok: false, output: `${definition.name} is not available to a read-only harness round.` };
        }
        const result = await runtime.execute({ id: crypto.randomUUID(), name: definition.name, arguments: args }, ctx);
        return { ok: !result.is_error, output: toolResultModelText(result) };
      },
    }));

  // Sensor runs are not a workspace-mutating tool, but a read-only planning
  // round has no use for them: the engine runs the manifest's sensors after the
  // round anyway, so the planner's surface stays reads only.
  if (!readOnly) {
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
  }
  return tools;
}
