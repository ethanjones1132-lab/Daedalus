import { loadPrompt } from "./prompt-loader";
import { BUILTIN_MODES, getToolsForMode } from "./modes";
import type { ToolRuntime, ExecutionContext } from "../tool-runtime";
import type { CallModelFn } from "./router";
import { outcomeCollector } from "../self-tuning/mod";

export interface PipelineProgressState {
  stage: "planner" | "executor" | "reviewer" | "rewriter" | "synthesizer";
  status: "running" | "done" | "failed";
  output?: string;
}