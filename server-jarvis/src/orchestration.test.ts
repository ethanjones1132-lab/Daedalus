import { describe, test, expect } from "bun:test";
import { BUILTIN_MODES, getToolsForMode } from "./orchestration/modes";
import { loadPrompt } from "./orchestration/prompt-loader";
import { PredictiveRouter } from "./orchestration/router";
import { PipelineExecutor } from "./orchestration/pipeline";
import { createToolRuntime } from "./tool-runtime";
import type { ToolDefinition, ToolCall, ToolResult } from "./tool-types";
import type { JarvisConfig, ExecutionContext } from "./tool-runtime";

describe("Orchestration & Routing Tests", () => {
  test("loadPrompt finds router.md", () => {
    const prompt = loadPrompt("router.md");
    expect(prompt).toContain("You are a task classifier");
  });

  test("loadPrompt finds mode prompts", () => {
    expect(loadPrompt("modes/planner.md")).toContain("planning agent");
    expect(loadPrompt("modes/executor.md")).toContain("execution agent");
    expect(loadPrompt("modes/reviewer.md")).toContain("review agent");
    expect(loadPrompt("modes/rewriter.md")).toContain("rewriting agent");
    expect(loadPrompt("modes/synthesizer.md")).toContain("communication and synthesis agent");
  });

  test("getToolsForMode filters correctly", () => {
    const dummyTools: ToolDefinition[] = [
      {
        type: "function",
        function: { name: "read_file", description: "read", parameters: { type: "object", properties: {}, required: [] } },
        requires_approval: false,