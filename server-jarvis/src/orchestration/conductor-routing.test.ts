import { describe, expect, test } from "bun:test";
import { extractConductorRoutingJson, stripGemmaThinkingArtifacts } from "./conductor-routing";

describe("conductor-routing", () => {
  test("extractConductorRoutingJson prefers route_pipeline tool call arguments", () => {
    const json = extractConductorRoutingJson({
      role: "assistant",
      content: "",
      tool_calls: [{
        function: {
          name: "route_pipeline",
          arguments: {
            task_type: "debug",
            pipeline: ["planner", "executor", "synthesizer"],
            topology: "linear",
            context: {
              needs_workspace_inspection: true,
              needs_memory: true,
              estimated_complexity: "high",
            },
            coordinator_rationale: "Needs tools.",
          },
        },
      }],
    });

    const parsed = JSON.parse(json);
    expect(parsed.task_type).toBe("debug");
    expect(parsed.pipeline).toEqual(["planner", "executor", "synthesizer"]);
  });

  test("extractConductorRoutingJson falls back to structured content", () => {
    const json = extractConductorRoutingJson({
      role: "assistant",
      content: '{"task_type":"general","pipeline":["synthesizer"],"topology":"linear","context":{"needs_workspace_inspection":false,"needs_memory":true,"estimated_complexity":"low"},"coordinator_rationale":"ok"}',
    });
    expect(JSON.parse(json).pipeline).toEqual(["synthesizer"]);
  });

  test("extractConductorRoutingJson preserves worker_instructions from tool calls", () => {
    const json = extractConductorRoutingJson({
      role: "assistant",
      content: "",
      tool_calls: [{
        function: {
          name: "route_pipeline",
          arguments: {
            task_type: "general",
            pipeline: ["executor", "synthesizer"],
            topology: "linear",
            context: {
              needs_workspace_inspection: true,
              needs_memory: true,
              estimated_complexity: "medium",
            },
            coordinator_rationale: "File read required.",
            worker_instructions: {
              executor: "Start with read_file on README.md.",
            },
          },
        },
      }],
    });

    const parsed = JSON.parse(json);
    expect(parsed.worker_instructions.executor).toContain("README.md");
  });

  test("stripGemmaThinkingArtifacts removes thinking channel blocks", () => {
    const cleaned = stripGemmaThinkingArtifacts(
      '<|channel>thought\nreasoning here<channel|>{"task_type":"general","pipeline":["synthesizer"],"topology":"linear","context":{"needs_workspace_inspection":false,"needs_memory":true,"estimated_complexity":"low"},"coordinator_rationale":"ok"}',
    );
    expect(cleaned.startsWith("{")).toBe(true);
    expect(cleaned).not.toContain("thought");
  });
});