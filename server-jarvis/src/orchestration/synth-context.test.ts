import { describe, test, expect } from "bun:test";
import { buildSynthesizerContext, buildSynthesizerContextFromStageState } from "./synth-context";
import type { PipelineStageState } from "./stage-output";
import { countTokens } from "../tokens";

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

  test("keeps synthesis payload bounded while preserving the latest request and write evidence", () => {
    const state: PipelineStageState = {
      executor: {
        ok: true,
        narrative: "executor narrative",
        toolCalls: Array.from({ length: 20 }, (_, index) => ({
          name: index === 19 ? "write_file" : "read_file",
          arguments: { path: `src/file-${index}.ts` },
          output: index === 19 ? "success" : "x".repeat(1_000),
          is_error: false,
          duration_ms: 1,
        })),
      },
    };
    const request = `Create the release artifact and verify it. ${"details ".repeat(800)}`;
    const context = buildSynthesizerContextFromStageState(request, state);
    expect(countTokens(context)).toBeLessThanOrEqual(6_000);
    expect(context).toContain(request.slice(0, 80));
    expect(context).toContain("write_file");
    expect(context).toContain("success");
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

  test("adds an authoritative executed-tool ledger that cannot be confused with the plan", () => {
    const state: PipelineStageState = {
      plan: { ok: true, narrative: "List the root, read README.md, then inspect Editor.cpp." },
      executor: {
        ok: true,
        narrative: "Finished the requested inspection.",
        toolCalls: [
          { name: "read_file", arguments: { path: "src/PluginProcessor.h" }, output: "header", is_error: false, duration_ms: 3 },
          { name: "read_file", arguments: { path: "src/PluginProcessor.cpp" }, output: "source", is_error: false, duration_ms: 4 },
        ],
      },
    };

    const context = buildSynthesizerContextFromStageState("audit the repo", state);
    expect(context).toContain("Executed Tool Ledger (authoritative)");
    expect(context).toContain("Only entries in this ledger actually executed");
    const ledger = (context.split("Executed Tool Ledger (authoritative)")[1] ?? "")
      .split("\n\nExecutor Activity")[0];
    expect(ledger).toContain("read_file {\"path\":\"src/PluginProcessor.h\"}");
    expect(ledger).toContain("read_file {\"path\":\"src/PluginProcessor.cpp\"}");
    expect(ledger).not.toContain("README.md");
    expect(ledger).not.toContain("Editor.cpp");
  });
});

// ── 2026-07-18 23:23 fabrication incident ──
// A misrouted work order ("begin complete and total implementation of phase 1")
// reached a synthesizer-only route and streamed a fully fabricated
// "## Changes Made" report with invented diffs — zero tools had executed. The
// synthesizer context must carry an authoritative no-execution contract on any
// non-conversational turn where nothing ran, so the model cannot honestly-
// looking claim performed work.
describe("no-execution fence (2026-07-18 23:23 fabrication incident)", () => {
  test("zero-tool non-conversational turns get the authoritative no-execution contract", () => {
    const context = buildSynthesizerContextFromStageState(
      "begin complete and total implementation of phase 1",
      {},
    );
    expect(context).toContain("No-Execution Contract (authoritative)");
    expect(context).toContain("Zero tools ran this turn");
  });

  test("speculative planner/reviewer turns without execution also get the fence", () => {
    const out = buildSynthesizerContext("Create a plan for phase 1", {
      plan: "1. Smooth parameters. 2. Clamp gain.",
      executorSummary: "No execution stage executed. Planner and reviewer ran speculatively without tool execution.",
      reviewerFeedback: "Plan looks coherent.",
      rewriterSummary: "No rewriting stage executed.",
    });
    expect(out).toContain("No-Execution Contract (authoritative)");
  });

  test("conversational turns stay fence-free (no scaffolding)", () => {
    const out = buildSynthesizerContext("Hey buddy, how are you?", {
      plan: "",
      executorSummary: "No execution stage executed.",
      reviewerFeedback: "No review stage executed.",
      rewriterSummary: "No rewriting stage executed.",
    });
    expect(out).toBe("User Request: Hey buddy, how are you?");
  });

  test("turns with executed tools never get the fence", () => {
    const state: PipelineStageState = {
      executor: {
        ok: true,
        narrative: "Read the header file.",
        toolCalls: [
          { name: "read_file", arguments: { path: "src/PluginProcessor.h" }, output: "header", is_error: false, duration_ms: 2 },
        ],
      },
    };
    const context = buildSynthesizerContextFromStageState("audit the repo", state);
    expect(context).not.toContain("No-Execution Contract");
  });
});

// synthesize-context pin: prioritizeExecutorFindings is a private helper that
// reorders an executor summary so trailing Findings/Result/Summary/Answer blocks
// surface BEFORE the raw tool-log noise. This matters because the executor
// summary is token-budgeted (2_600 tokens); a model that puts findings at the
// end of a long tool-log block would have them truncated off the visible
// synthesizer context if this reordering did not exist. The 4 cases below pin
// the four observable branches of `prioritizeExecutorFindings` through the
// public buildSynthesizerContextFromStageState API so a future refactor of the
// regex or the leading-prefix test cannot silently break which side of the
// budget findings occupy.
describe("prioritizeExecutorFindings contract (reorders Findings blocks to top)", () => {
  test("a summary that already starts with Findings is left untouched", () => {
    const state: PipelineStageState = {
      executor: {
        ok: true,
        narrative: "Findings: file X imports file Y.",
        toolCalls: [],
      },
    };
    const context = buildSynthesizerContextFromStageState("explain X", state);
    const executorSection = context.split("Executor Activity:\n")[1]?.split("\n\n")[0] ?? "";
    // The narrative remains the first thing the synthesizer sees; no
    // "Tool log (truncated):" reordering label is introduced.
    expect(executorSection).toContain("Findings: file X imports file Y.");
    expect(executorSection).not.toContain("Tool log (truncated):");
  });

  test("a trailing Findings block is promoted to the top of the executor section", () => {
    // The model produces a summary where Findings: appears AFTER a long raw
    // tool-log prefix in the same paragraph (no leading heading). The
    // reordering branch must find the Findings heading, split the summary,
    // and put Findings: text first.
    const longPrefix = "Raw tool log: ".repeat(80);
    const narrative = `${longPrefix}\n\nFindings: a.ts and b.ts both use Y.`;
    const state: PipelineStageState = {
      executor: {
        ok: true,
        narrative,
        toolCalls: [
          { name: "read_file", arguments: { path: "a.ts" }, output: "aaa", is_error: false, duration_ms: 1 },
          { name: "read_file", arguments: { path: "b.ts" }, output: "bbb", is_error: false, duration_ms: 1 },
        ],
      },
    };
    const context = buildSynthesizerContextFromStageState("diagnose the repo", state);
    // The findings text must appear in the executor section.
    expect(context).toContain("Findings: a.ts and b.ts both use Y.");
    // The "Tool log (truncated):" reordering label is present — that's the
    // observable signal that the reordering branch fired (otherwise no
    // label is emitted and findings stay buried under tool output).
    expect(context).toContain("Tool log (truncated):");
    // The findings block must come BEFORE the tool log label in the
    // executor section — this is the actual "prioritize findings" promise.
    const executorSection = context.split("Executor Activity:\n")[1]?.split("\n\nOriginal Plan")[0] ?? "";
    const findingsIdx = executorSection.indexOf("Findings: a.ts and b.ts both use Y.");
    const toolLogIdx = executorSection.indexOf("Tool log (truncated):");
    expect(findingsIdx).toBeGreaterThanOrEqual(0);
    expect(toolLogIdx).toBeGreaterThan(findingsIdx);
  });

  test("a Result: / Summary: / Answer: heading also triggers the reorder", () => {
    const state: PipelineStageState = {
      executor: {
        ok: true,
        narrative: "Did a bunch of work.",
        toolCalls: [
          { name: "read_file", arguments: { path: "x" }, output: "x", is_error: false, duration_ms: 1 },
        ],
      },
    };
    // Use the "direct" path (buildSynthesizerContext) with a hand-shaped
    // executor summary that ends with an Answer: heading, so we don't have
    // to wedge it into the structured-state narrative field.
    const executorSummary = "[Executor]: Did a bunch of work.\n\n[Tool Call] read_file path=x\n\nAnswer: the file is short.";
    const context = buildSynthesizerContext("explain x", {
      plan: "",
      executorSummary,
      reviewerFeedback: "No review stage executed.",
      rewriterSummary: "No rewriting stage executed.",
    });
    expect(context).toContain("Answer: the file is short.");
    expect(context).toContain("Tool log (truncated):");
  });

  test("a summary with no Findings/Result/Summary/Answer heading is left alone", () => {
    const state: PipelineStageState = {
      executor: {
        ok: true,
        narrative: "Plain prose about what the executor did.",
        toolCalls: [
          { name: "read_file", arguments: { path: "x" }, output: "x", is_error: false, duration_ms: 1 },
        ],
      },
    };
    const context = buildSynthesizerContextFromStageState("describe x", state);
    // No reordering label is introduced; the narrative flows through.
    expect(context).not.toContain("Tool log (truncated):");
    expect(context).toContain("Plain prose about what the executor did.");
  });
});
