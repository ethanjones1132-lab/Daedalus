// server-jarvis/src/orchestration/stage-output.test.ts
import { describe, expect, test } from "bun:test";
import {
  renderExecutorSummary,
  renderPlanSummary,
  renderReviewerSummary,
  renderRewriterSummary,
  type ExecutorStageOutput,
  type PlannerStageOutput,
  type ReviewerStageOutput,
  type RewriterStageOutput,
} from "./stage-output";

describe("stage-output renderers", () => {
  test("renderPlanSummary returns the sentinel when no planner ran", () => {
    expect(renderPlanSummary(undefined)).toBe("No planning stage executed.");
  });

  test("renderPlanSummary returns the narrative when present", () => {
    const plan: PlannerStageOutput = { ok: true, narrative: "Step 1: read config.ts" };
    expect(renderPlanSummary(plan)).toBe("Step 1: read config.ts");
  });

  test("renderExecutorSummary returns the sentinel when no executor ran", () => {
    expect(renderExecutorSummary(undefined)).toBe("No execution stage executed.");
  });

  test("renderExecutorSummary includes narrative and tool call results", () => {
    const executor: ExecutorStageOutput = {
      ok: true,
      narrative: "Read the config file.",
      toolCalls: [
        { name: "read_file", arguments: { path: "config.ts" }, output: "export const x = 1;", is_error: false, duration_ms: 12 },
      ],
    };
    const rendered = renderExecutorSummary(executor);
    expect(rendered).toContain("[Executor]: Read the config file.");
    expect(rendered).toContain('<jarvis_internal_tool_result name="read_file">');
    expect(rendered).toContain("[Tool Call Result (read_file)]");
    expect(rendered).toContain("export const x = 1;");
    expect(rendered).toContain("</jarvis_internal_tool_result>");
  });

  test("renderExecutorSummary truncates long tool output with a length marker", () => {
    const longOutput = "x".repeat(1500);
    const executor: ExecutorStageOutput = {
      ok: true,
      narrative: "",
      toolCalls: [{ name: "read_file", arguments: {}, output: longOutput, is_error: false, duration_ms: 1 }],
    };
    const rendered = renderExecutorSummary(executor);
    expect(rendered).toContain("more chars, truncated");
    expect(rendered.length).toBeLessThan(longOutput.length);
  });

  test("renderExecutorSummary marks failed tool calls", () => {
    const executor: ExecutorStageOutput = {
      ok: true,
      narrative: "",
      toolCalls: [{ name: "read_file", arguments: {}, output: "not found", is_error: true, duration_ms: 1 }],
    };
    expect(renderExecutorSummary(executor)).toContain("[Tool Call Result (read_file)] FAILED");
  });

  test("renderReviewerSummary returns the sentinel when no reviewer ran", () => {
    expect(renderReviewerSummary(undefined)).toBe("No review stage executed.");
  });

  test("renderReviewerSummary returns feedback when present", () => {
    const reviewer: ReviewerStageOutput = { ok: true, feedback: "Looks complete.", hasIssues: false };
    expect(renderReviewerSummary(reviewer)).toBe("Looks complete.");
  });

  test("renderRewriterSummary returns the sentinel when no rewriter ran", () => {
    expect(renderRewriterSummary(undefined)).toBe("No rewriting stage executed.");
  });

  test("renderRewriterSummary includes narrative and tool calls", () => {
    const rewriter: RewriterStageOutput = {
      ok: true,
      narrative: "Patched the login handler.",
      toolCalls: [{ name: "edit_file", arguments: { path: "login.ts" }, output: "ok", is_error: false, duration_ms: 5 }],
    };
    const rendered = renderRewriterSummary(rewriter);
    expect(rendered).toContain("[Rewriter]: Patched the login handler.");
    expect(rendered).toContain("[Tool Call Result (edit_file)]");
  });

  test("renderExecutorSummary returns an empty string, not the sentinel, for a stage that ran but produced no narrative and no tool calls", () => {
    const executor: ExecutorStageOutput = { ok: true, narrative: "", toolCalls: [] };
    const rendered = renderExecutorSummary(executor);
    expect(rendered).toBe("");
    expect(rendered).not.toBe("No execution stage executed.");
  });

  test("renderRewriterSummary returns an empty string, not the sentinel, for a stage that ran but produced no narrative and no tool calls", () => {
    const rewriter: RewriterStageOutput = { ok: true, narrative: "", toolCalls: [] };
    const rendered = renderRewriterSummary(rewriter);
    expect(rendered).toBe("");
    expect(rendered).not.toBe("No rewriting stage executed.");
  });

  test("ToolCallRecord.error_code round-trips through renderExecutorSummary without affecting rendered text", () => {
    const executor: ExecutorStageOutput = {
      ok: false,
      narrative: "Tried to call an unknown tool.",
      toolCalls: [
        {
          name: "nonexistent_tool",
          arguments: {},
          output: "Unknown tool: nonexistent_tool",
          is_error: true,
          error_code: "unknown_tool",
          duration_ms: 3,
        },
      ],
    };
    const rendered = renderExecutorSummary(executor);
    expect(rendered).toContain("[Executor]: Tried to call an unknown tool.");
    expect(rendered).toContain("[Tool Call Result (nonexistent_tool)] FAILED");
    expect(rendered).toContain("Unknown tool: nonexistent_tool");
    expect(executor.toolCalls[0]?.error_code).toBe("unknown_tool");
  });
});
