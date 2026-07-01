import { describe, test, expect } from "bun:test";
import { buildSynthesizerContext, buildSynthesizerContextFromStageState } from "./synth-context";
import type { PipelineStageState } from "./stage-output";

describe("buildSynthesizerContext", () => {
  test("synthesizer-only turn passes just the user request (no empty scaffolding)", () => {
    const out = buildSynthesizerContext("Hey buddy, how are you?", {
      plan: "",
      executorSummary: "No execution stage executed.",
      reviewerFeedback: "No review stage executed.",
      rewriterSummary: "No rewriting stage executed.",
    });
    expect(out).toBe("User Request: Hey buddy, how are you?");
    expect(out).not.toContain("Executor Activity");
    expect(out).not.toContain("No execution stage executed");
  });

  test("includes only sections for stages that actually produced output", () => {
    const out = buildSynthesizerContext("Summarize the repo", {
      plan: "1. Read README. 2. Summarize.",
      executorSummary: "Read README.md (240 lines).",
      reviewerFeedback: "No review stage executed.",
      rewriterSummary: "No rewriting stage executed.",
    });
    expect(out).toContain("Original Plan:\n1. Read README. 2. Summarize.");
    expect(out).toContain("Executor Activity:\nRead README.md (240 lines).");
    expect(out).not.toContain("Reviewer Feedback");
    expect(out).not.toContain("Rewriter Activity");
  });

  test("keeps stage FAILURES (disclosure) but drops 'not executed' sentinels", () => {
    const out = buildSynthesizerContext("Do the thing", {
      executorSummary: "Executor failed: API 503",
      reviewerFeedback: "No review stage executed.",
    });
    expect(out).toContain("Executor Activity:\nExecutor failed: API 503");
    expect(out).not.toContain("Reviewer Feedback");
  });

  test("strips <think> reasoning blocks leaked into stage output", () => {
    const out = buildSynthesizerContext("Q", {
      executorSummary: "<think>internal planning</think>Ran the build successfully.",
    });
    expect(out).toContain("Ran the build successfully.");
    expect(out).not.toContain("<think>");
    expect(out).not.toContain("internal planning");
  });
});

describe("buildSynthesizerContextFromStageState", () => {
  test("omits sections with no meaningful stage output", () => {
    const state: PipelineStageState = {};
    const context = buildSynthesizerContextFromStageState("hello", state);
    expect(context).toBe("User Request: hello");
  });

  test("renders plan/executor/reviewer/rewriter sections from structured state", () => {
    const state: PipelineStageState = {
      plan: { ok: true, narrative: "Read config.ts first." },
      executor: {
        ok: true,
        narrative: "Read the file.",
        toolCalls: [{ name: "read_file", arguments: { path: "config.ts" }, output: "export const x = 1;", is_error: false, duration_ms: 3 }],
      },
      reviewer: { ok: true, feedback: "Complete.", hasIssues: false },
    };
    const context = buildSynthesizerContextFromStageState("read config.ts", state);
    expect(context).toContain("Original Plan:\nRead config.ts first.");
    expect(context).toContain("Executor Activity:");
    expect(context).toContain("export const x = 1;");
    expect(context).toContain("Reviewer Feedback:\nComplete.");
    expect(context).not.toContain("Rewriter Activity:");
  });
});
